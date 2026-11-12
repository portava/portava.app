import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeClient } from './telegraphCertificationHarness.js';
import { projectLivingDedup } from '../lib/places/placeLivingDedup.js';

const PLACE = '10000000-0000-4000-8000-000000000001';
const AUTHOR = '20000000-0000-4000-8000-000000000001';
const VIEWER = '30000000-0000-4000-8000-000000000001';
const POST = '40000000-0000-4000-8000-000000000001';
const MEDIA = '50000000-0000-4000-8000-000000000001';
const GROUP = '60000000-0000-4000-8000-000000000001';
const payload = { placeId: PLACE, dedupGroups: [{ groupId: GROUP, memberCount: 999, sampleUrls: [MEDIA, 'https://stale.example/unsafe.jpg'] }] };

function fixture(errors: Record<string, { message: string }> = {}) {
  return makeFakeClient({
    media_dedup_groups: [{ id: GROUP, canonical_place_id: PLACE, member_count: 999, sample_media_ids: [MEDIA] }],
    post_media: [{ id: MEDIA, post_id: POST, user_id: AUTHOR, canonical_place_id: PLACE, media_type: 'image',
      processing_status: 'ready', moderation_status: 'approved', public_url: 'https://cdn.example/original.jpg', thumbnail_url: 'https://cdn.example/thumb.jpg' }],
    posts: [{ id: POST, author_id: AUTHOR, canonical_place_id: PLACE, visibility: 'public', status: 'active', post_status: 'published', location_privacy_mode: 'none' }],
    profiles: [{ id: AUTHOR, is_private: false, account_status: 'active', user_account_states: [] }],
  }, { errors });
}

describe('Living destination dedup samples', () => {
  it('resolves media IDs to current original/thumbnail contracts, never cached IDs/URLs or hidden member counts', async () => {
    const result = await projectLivingDedup(fixture(), payload, VIEWER);
    assert.equal(result.dedupStatus, 'ready');
    assert.deepEqual(result.dedupGroups, [{ groupId: GROUP, memberCount: 1,
      sampleUrls: ['https://cdn.example/thumb.jpg'], samples: [{ mediaId: MEDIA, postId: POST,
        mediaUrl: 'https://cdn.example/original.jpg', thumbnailUrl: 'https://cdn.example/thumb.jpg', mediaType: 'image' }] }]);
    assert.deepEqual(payload.dedupGroups[0].sampleUrls, [MEDIA, 'https://stale.example/unsafe.jpg'], 'does not mutate cached payload');
  });
  it('supports public anonymous reads without querying UUID columns with a fabricated string', async () => {
    assert.equal((await projectLivingDedup(fixture(), payload)).dedupGroups.length, 1);
  });
  for (const [field, value] of [['visibility', 'private'], ['visibility', 'trip_only'], ['visibility', 'followers_only'], ['status', 'deleted'], ['post_status', 'scheduled'], ['location_privacy_mode', 'hidden'], ['canonical_place_id', 'other'], ['deleted_at', '2026-01-01']] as const) {
    it(`withdraws a cached sample when current post ${field}=${value}`, async () => {
      const sc = fixture(); sc._store.posts[0]![field] = value;
      const result = await projectLivingDedup(sc, payload, VIEWER);
      assert.equal(result.dedupStatus, 'ready'); assert.deepEqual(result.dedupGroups, []);
    });
  }
  for (const status of ['flagged', 'rejected', 'limited', 'removed', 'owner_deleted']) {
    it(`withdraws ${status} legacy media`, async () => {
      const sc = fixture(); sc._store.post_media[0]!.moderation_status = status;
      assert.deepEqual((await projectLivingDedup(sc, payload, AUTHOR)).dedupGroups, []);
    });
  }
  it('does not infer an original from a thumbnail or malformed URL', async () => {
    const sc = fixture(); sc._store.post_media[0]!.public_url = MEDIA;
    assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
  });
  it('requires the media attachment author and current place to match the source', async () => {
    const sc = fixture(); sc._store.post_media[0]!.user_id = VIEWER;
    assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
    sc._store.post_media[0]!.user_id = AUTHOR; sc._store.post_media[0]!.canonical_place_id = 'elsewhere';
    assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
  });
  it('rechecks author privacy, approved following, account moderation and both block directions', async () => {
    const sc = fixture(); sc._store.profiles[0]!.is_private = true;
    assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
    sc._store.user_follows = [{ follower_id: VIEWER, following_id: AUTHOR }];
    assert.equal((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups.length, 1);
    sc._store.profiles[0]!.user_account_states = [{ state: 'banned', expires_at: null }];
    assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
    sc._store.profiles[0]!.user_account_states = [];
    for (const [blocker_id, blocked_id] of [[AUTHOR, VIEWER], [VIEWER, AUTHOR]]) {
      sc._store.blocks = [{ blocker_id, blocked_id }];
      assert.deepEqual((await projectLivingDedup(sc, payload, VIEWER)).dedupGroups, []);
    }
  });
  for (const table of ['media_dedup_groups', 'post_media', 'posts', 'profiles', 'blocks']) {
    it(`reports ${table} failure as unavailable instead of claiming no similar photos`, async () => {
      const result = await projectLivingDedup(fixture({ [table]: { message: 'offline' } }), payload, VIEWER);
      assert.equal(result.dedupStatus, 'unavailable'); assert.deepEqual(result.dedupGroups, []);
    });
  }
  it('rechecks canonical asset removal even when an approved legacy row and warm cache remain', async () => {
    const sc = fixture(); const path = `${AUTHOR}/original.jpg`;
    sc._store.post_media[0]!.storage_bucket = 'post-media'; sc._store.post_media[0]!.storage_path = path;
    sc._store.media_assets = [{ id: MEDIA, storage_bucket: 'post-media', storage_path: path, owner_user_id: AUTHOR, moderation_status: 'removed' }];
    assert.deepEqual((await projectLivingDedup(sc, payload, AUTHOR)).dedupGroups, []);
  });
  it('keeps canonical storage keys and lets the existing media relay authorize bytes', async () => {
    const sc = fixture(); const path = `${AUTHOR}/original.jpg`;
    Object.assign(sc._store.post_media[0]!, { storage_bucket: 'post-media', storage_path: path, thumbnail_url: null });
    sc._store.media_assets = [{ id: MEDIA, storage_bucket: 'post-media', storage_path: path, owner_user_id: AUTHOR, moderation_status: 'active' }];
    const result = await projectLivingDedup(sc, payload, AUTHOR);
    assert.equal(result.dedupGroups[0].samples[0].mediaUrl, `post-media/${path}`);
  });
  it('does no extra reads for pages with no dedup groups', async () => {
    const sc = fixture(); await projectLivingDedup(sc, { ...payload, dedupGroups: [] }, VIEWER);
    assert.equal(sc._observed.selects.length, 0);
  });
});
