import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeClient } from './telegraphCertificationHarness.js';
import { projectLivingCommunity, readLivingCommunityPosts } from '../lib/places/placeLivingCommunity.js';

const PLACE = '10000000-0000-4000-8000-000000000001';
const AUTHOR = '20000000-0000-4000-8000-000000000001';
const VIEWER = '30000000-0000-4000-8000-000000000001';
const POST = '40000000-0000-4000-8000-000000000001';
const MEDIA = '50000000-0000-4000-8000-000000000001';
const ORIGINAL = `post-media/${AUTHOR}/original.jpg`;
const sourcePost = { id: POST, author_id: AUTHOR, canonical_place_id: PLACE, visibility: 'public', status: 'active', post_status: 'published',
  location_privacy_mode: 'none', media_urls: ['https://cdn.example/current.jpg'], content: 'Current caption', updated_at: '2026-01-01T00:00:00Z' };
const stalePost = { id: POST, mediaUrl: 'https://cdn.example/stale.jpg', thumbnailUrl: 'https://cdn.example/stale-thumb.jpg', caption: 'Private old caption' };
const payload = { placeId: PLACE, _officialHeroImageUrl: 'https://provider.example/place.jpg',
  hero: { imageUrl: stalePost.mediaUrl, videoUrl: stalePost.mediaUrl },
  bestOf: { photos: [{ ...stalePost, postId: POST }], videos: [], viewpoints: [], foodNearby: [], experiences: [] },
  buckets: [{ bucket: 'food', posts: [stalePost], postCount: 33 }], timeline: { posts: [stalePost], slice: 'today' },
  rating: { score: 4 }, topContributor: { userId: AUTHOR, displayName: 'Old name', contributionCount: 33 },
};
function fixture(errors: Record<string, { message: string }> = {}) {
  return makeFakeClient({ posts: [{ ...sourcePost }], profiles: [{ id: AUTHOR, account_status: 'active', is_private: false, user_account_states: [] }] }, { errors });
}
function attach(sc: ReturnType<typeof fixture>) {
  sc._store.post_media = [{ id: MEDIA, post_id: POST, user_id: AUTHOR, storage_bucket: 'post-media', storage_path: `${AUTHOR}/original.jpg`, public_url: ORIGINAL,
    thumbnail_url: 'https://cdn.example/thumb.jpg', media_type: 'image', processing_status: 'ready', moderation_status: 'approved', sort_order: 0 }];
  sc._store.media_assets = [{ id: MEDIA, storage_bucket: 'post-media', storage_path: `${AUTHOR}/original.jpg`, public_url: ORIGINAL, owner_user_id: AUTHOR,
    processing_status: 'ready', moderation_status: 'active', visibility: 'inherit' }];
}
describe('Living destination current community sources', () => {
  it('refreshes every cached caption and original, and never serves cached media snapshots', async () => {
    const sc = fixture(); const result = await projectLivingCommunity(sc, payload, VIEWER);
    assert.equal(result.communityStatus, 'ready');
    for (const post of [result.timeline.posts[0], result.buckets[0].posts[0], result.bestOf.photos[0]]) {
      assert.equal(post.caption, 'Current caption'); assert.equal(post.mediaUrl, 'https://cdn.example/current.jpg'); assert.equal(post.thumbnailUrl, null);
    }
    assert.equal(result.hero.imageUrl, 'https://cdn.example/current.jpg'); assert.equal(result.hero.videoUrl, null);
    assert.equal('_officialHeroImageUrl' in result, false);
    assert.equal(result.timeline.posts[0]._updatedAt, undefined);
    assert.equal(payload.timeline.posts[0].caption, 'Private old caption');
  });
  for (const [field, value] of [['visibility', 'private'], ['visibility', 'followers_only'], ['status', 'deleted'], ['post_status', 'pending_delay'], ['location_privacy_mode', 'hidden'], ['canonical_place_id', 'different'], ['deleted_at', '2026-01-01'], ['publish_at', '2099-01-01']] as const) {
    it(`removes all cached appearances after current source ${field}=${value}`, async () => {
      const sc = fixture(); sc._store.posts[0]![field] = value;
      const result = await projectLivingCommunity(sc, payload, VIEWER);
      assert.equal(result.communityStatus, 'ready');
      assert.deepEqual(result.timeline.posts, []); assert.deepEqual(result.buckets[0].posts, []); assert.deepEqual(result.bestOf.photos, []);
      assert.deepEqual(result.hero, { imageUrl: 'https://provider.example/place.jpg', videoUrl: null });
      assert.equal(result.topContributor, null); assert.equal(result.rating, null); assert.equal(result.buckets[0].postCount, null);
    });
  }
  it('preserves the established owner-only view of their withheld place', async () => {
    const sc = fixture(); sc._store.posts[0]!.location_privacy_mode = 'hidden';
    assert.equal((await projectLivingCommunity(sc, payload, AUTHOR)).timeline.posts.length, 1);
  });
  it('rechecks private authors, current restrictions and blocks on warm cache', async () => {
    const sc = fixture(); sc._store.profiles[0]!.is_private = true;
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts.length, 0);
    sc._store.user_follows = [{ follower_id: VIEWER, following_id: AUTHOR }];
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts.length, 1);
    sc._store.profiles[0]!.user_account_states = [{ state: 'suspended', expires_at: null }];
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts.length, 0);
    sc._store.profiles[0]!.user_account_states = [];
    sc._store.blocks = [{ blocker_id: AUTHOR, blocked_id: VIEWER }];
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts.length, 0);
  });
  it('selects a current cleared attachment, preserving the original/thumbnail distinction', async () => {
    const sc = fixture(); attach(sc); const result = await projectLivingCommunity(sc, payload, VIEWER);
    assert.equal(result.bestOf.photos[0].mediaUrl, ORIGINAL);
    assert.equal(result.bestOf.photos[0].thumbnailUrl, 'https://cdn.example/thumb.jpg');
  });
  for (const status of ['processing', 'limited', 'rejected', 'removed', 'owner_deleted']) {
    it(`withholds ${status} canonical bytes even from their owner`, async () => {
      const sc = fixture(); attach(sc); sc._store.media_assets[0]!.moderation_status = status;
      const result = await projectLivingCommunity(sc, payload, AUTHOR);
      assert.deepEqual(result.bestOf.photos, []); assert.equal(result.timeline.posts[0].mediaUrl, null);
      assert.equal(result.hero.imageUrl, 'https://provider.example/place.jpg');
    });
  }
  it('honors asset and per-post attachment privacy before exposing URLs', async () => {
    const sc = fixture(); attach(sc); sc._store.media_assets[0]!.visibility = 'private';
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts[0].mediaUrl, null);
    sc._store.media_assets[0]!.visibility = 'inherit';
    sc._store.media_attachments = [{ media_asset_id: MEDIA, entity_type: 'post', entity_id: POST, visibility_override: 'private' }];
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).timeline.posts[0].mediaUrl, null);
    assert.equal((await projectLivingCommunity(sc, payload, AUTHOR)).timeline.posts[0].mediaUrl, ORIGINAL);
  });
  it('does not fall back to posts.media_urls when an attachment is held', async () => {
    const sc = fixture(); attach(sc); sc._store.post_media[0]!.moderation_status = 'rejected';
    assert.equal((await projectLivingCommunity(sc, payload, AUTHOR)).timeline.posts[0].mediaUrl, null);
  });
  it('retained removal rejects a bare legacy source; explicit appealed clearance can restore it', async () => {
    const sc = fixture(); sc._store.posts[0]!.media_urls = [ORIGINAL];
    sc._store.post_media_moderation_ledger = [{ storage_path: `${AUTHOR}/original.jpg`, verdict: 'rejected' }];
    assert.equal((await projectLivingCommunity(sc, payload, AUTHOR)).timeline.posts[0].mediaUrl, null);
    attach(sc);
    assert.equal((await projectLivingCommunity(sc, payload, AUTHOR)).timeline.posts[0].mediaUrl, ORIGINAL);
  });
  for (const table of ['posts', 'profiles', 'blocks', 'post_media', 'media_assets']) {
    it(`${table} read failure is unavailable, with no cached personal content surviving`, async () => {
      const result = await projectLivingCommunity(fixture({ [table]: { message: 'offline' } }), payload, VIEWER);
      assert.equal(result.communityStatus, 'unavailable'); assert.deepEqual(result.timeline.posts, []); assert.equal(result.topContributor, null);
    });
  }
  it('rejects truncated post-media and canonical policy reads instead of falling back', async () => {
    const sc = makeFakeClient({ posts: [sourcePost], profiles: [{ id: AUTHOR, user_account_states: [] }], post_media: [{ id: 'a', post_id: POST }, { id: 'b', post_id: POST }] }, { maxRows: 1 });
    assert.equal((await projectLivingCommunity(sc, payload, VIEWER)).communityStatus, 'unavailable');
  });
  it('uses a bounded number of batch queries for a 50-post page', async () => {
    const sc = fixture(); sc._store.posts = Array.from({ length: 50 }, (_, i) => ({ ...sourcePost, id: `post-${i}`, media_urls: [`https://cdn.example/${i}.jpg`] }));
    const posts = await readLivingCommunityPosts(sc, sc._store.posts.map(p => p.id), PLACE, VIEWER);
    assert.equal(posts.size, 50);
    assert.ok(sc._observed.selects.length <= 7, `expected batched reads, got ${sc._observed.selects.length}`);
  });
  it('revalidates summary provenance and removes summaries when any source is edited or private', async () => {
    const sc = fixture(); sc._store.posts = [1, 2, 3].map(i => ({ ...sourcePost, id: `summary-${i}` }));
    const summary = { text: 'Community summary', generatedAt: '2026-02-01T00:00:00Z' };
    sc._store.place_ai_summaries = [{ place_id: PLACE, text: summary.text, generated_at: summary.generatedAt, post_ids_used: sc._store.posts.map(p => p.id) }];
    assert.deepEqual((await projectLivingCommunity(sc, { ...payload, aiSummary: summary }, VIEWER)).aiSummary, summary);
    sc._store.posts[0]!.updated_at = '2026-03-01T00:00:00Z';
    assert.equal((await projectLivingCommunity(sc, { ...payload, aiSummary: summary }, VIEWER)).aiSummary, null);
    sc._store.posts[0]!.updated_at = sourcePost.updated_at; sc._store.posts[0]!.visibility = 'private';
    assert.equal((await projectLivingCommunity(sc, { ...payload, aiSummary: summary }, VIEWER)).aiSummary, null);
  });
});
