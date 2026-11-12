import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';
import { loadPostcardCandidates, loadQuickMediaRow } from '../services/wall/WallCandidateLoaders.js';
import { readPreviousReadings } from '../lib/wallMomentRead.js';

const now = Date.parse('2026-11-05T12:00:00Z');
const author = (n: number) => `person-${String(n).padStart(5, '0')}`;
const follows = Array.from({ length: 1234 }, (_, n) => ({ follower_id: 'viewer', following_id: author(n) }));
const profile = { id: author(1233), display_name: 'Last person', account_status: 'active' };
const post = { id: 'post-last', author_id: author(1233), status: 'active', post_status: 'published', visibility: 'public', created_at: new Date(now - 1000).toISOString() };

describe('Wall supplementary sources read beyond 500 follows', () => {
  it('keeps a postcard from the last followed author with bounded query chunks', async () => {
    const chunks: number[] = [];
    const sc = makeFailClosedClient({ rows: {
      passport_postcards: [{ id: 'card-last', post_id: post.id, user_id: profile.id, status: 'active', deleted_at: null, created_at: post.created_at }],
      posts: [post], profiles: [profile],
    }, failOn: (ctx) => {
      if (ctx.table === 'passport_postcards') chunks.push((ctx.filters.find((f) => f.col === 'user_id')?.val as string[]).length);
      return null;
    } });
    const result = await loadPostcardCandidates(sc, 'following', { viewerId: 'viewer', followedCreatorIds: new Set(follows.map((f) => f.following_id)) });
    assert.deepEqual(result.candidates.map((c) => c.canonicalObjectId), [post.id]);
    assert.deepEqual(chunks, [500, 500, 234]);
    assert.notEqual(result.failed, true);
  });

  it('quick media keyset-pages follows and reads media for the last author', async () => {
    const asset = { id: 'asset-last', owner_user_id: profile.id, storage_bucket: 'post-media', storage_path: 'last.jpg', media_type: 'image', visibility: 'public', moderation_status: 'approved', processing_status: 'ready', created_at: post.created_at };
    const sc = makeFailClosedClient({ rows: { user_follows: follows, profiles: [profile], posts: [post], media_assets: [asset], media_attachments: [{ media_asset_id: asset.id, entity_type: 'post', entity_id: post.id }], blocks: [], trip_members: [] } });
    const result = await loadQuickMediaRow(sc, 'viewer', { nowMs: now });
    assert.equal(result.failed, false);
    assert.deepEqual(result.items.map((i) => i.ownerUserId), [profile.id]);
  });

  it('a failed later graph page is reported even when the earlier page is quiet', async () => {
    const sc = makeFailClosedClient({ rows: { user_follows: follows, blocks: [], media_assets: [] }, failOn: (ctx) => ctx.table === 'user_follows' && ctx.filters.some((f) => f.op === 'gt') ? { code: '57014', message: 'timeout' } : null });
    const result = await loadQuickMediaRow(sc, 'viewer', { nowMs: now });
    assert.deepEqual(result, { items: [], failed: true });
  });
});

describe('Wall moment history gives every claim its own window', () => {
  it('frequent crowd readings cannot starve a quieter vibe transition', async () => {
    const base = { subject_id: 'place', privacy_eligible: true, observed_at: new Date(now).toISOString() };
    const rows = Array.from({ length: 45 }, (_, n) => ({ ...base, claim_type: 'crowd.level', value: n, generated_at: new Date(now - n * 1000).toISOString() }));
    rows.push({ ...base, claim_type: 'vibe.state', value: 7, generated_at: new Date(now - 100_000).toISOString() });
    rows.push({ ...base, privacy_eligible: false, claim_type: 'vibe.state', value: 99, generated_at: new Date(now).toISOString() });
    const result = await readPreviousReadings(makeFailClosedClient({ rows: { intel_state_snapshot_versions: rows } }), 'place', ['crowd.level', 'vibe.state']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.readings.length, 21);
    assert.deepEqual(result.readings.filter((r) => r.claimType === 'vibe.state').map((r) => r.value), [7]);
  });
  it('one failed claim read refuses the comparison instead of calling its history empty', async () => {
    const sc = makeFailClosedClient({ failOn: (ctx) => ctx.eq('claim_type') === 'vibe.state' ? { code: '57014', message: 'timeout' } : null });
    assert.deepEqual(await readPreviousReadings(sc, 'place', ['crowd.level', 'vibe.state']), { ok: false, reason: 'error' });
  });
});
