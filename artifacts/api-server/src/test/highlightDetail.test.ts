import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/highlights.js';
import { _setTestClient } from '../lib/http.js';
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from './telegraphCertificationHarness.js';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FUTURE = new Date(Date.now() + 3600000).toISOString();
const PAST = new Date(Date.now() - 3600000).toISOString();
const row = (patch: Record<string, unknown> = {}) => ({ id: ID, owner_id: OWNER, visibility: 'public', media_type: 'image/jpeg',
  media_url: `post-media/${OWNER}/highlight.jpg`, caption: 'Private caption', created_at: PAST, expires_at: FUTURE,
  deleted_at: null, archived_at: null, location_name: 'Precise venue', location_city: 'Cebu', location_country: 'Philippines', ...patch });
let server: RouterHarness | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
async function request(patch: Record<string, unknown> = {}, tables: Record<string, any[]> = {}, options: FakeDbOptions = {}, viewer = VIEWER, path = ID) {
  const db = makeFakeClient({ highlights: [row(patch)], profiles: [{ id: OWNER, handle: 'traveler', name: 'Private legal name', account_status: 'active', user_account_states: [] }, { id: VIEWER, account_status: 'active', user_account_states: [] }],
    highlight_projection_policies: [], highlight_resurfacing_preferences: [], blocks: [], circle_memberships: [], trip_members: [], highlight_views: [], highlight_likes: [], ...tables }, options);
  _setTestClient(db, true); server = await startRouter(router);
  return { ...await call(server.base, 'GET', `/highlights/${path}`, viewer), db };
}

test('detail returns the authorized payload with current location precision and identity', async () => {
  const result = await request({}, { highlight_projection_policies: [{ highlight_id: ID, location_precision: 'COUNTRY' }],
    highlight_views: [{ highlight_id: ID, viewer_id: VIEWER }], highlight_likes: [{ highlight_id: ID, user_id: VIEWER }] });
  assert.equal(result.status, 200); assert.equal(result.body.id, ID); assert.equal(result.body.media_url, row().media_url);
  assert.equal(result.body.caption, 'Private caption'); assert.equal(result.body.location_name, null); assert.equal(result.body.location_city, null);
  assert.equal(result.body.location_country, 'Philippines'); assert.notEqual(result.body.author.name, 'Private legal name');
  assert.equal(result.body.viewedByMe, true); assert.equal(result.body.likedByMe, true);
  assert.equal(result.body.viewCount, 1); assert.equal(result.body.likeCount, 1);
  assert.equal(result.db._observed.inserts.length, 0);
});
for (const [name, patch] of Object.entries({ private: { visibility: 'private' }, expired: { expires_at: PAST }, archived: { archived_at: PAST }, deleted: { deleted_at: PAST }, circle: { visibility: 'circle_only' }, trip: { visibility: 'trip_only' } })) {
  test(`saved ID does not bypass ${name}`, async () => { const r = await request(patch); assert.equal(r.status, 404); assert.equal(r.body.caption, undefined); assert.equal(r.body.media_url, undefined); });
}
test('owner can open an active private permanent Highlight', async () => { const r = await request({ visibility: 'private', expires_at: null }, {}, {}, OWNER); assert.equal(r.status, 200); assert.equal(r.body.expires_at, null); });
test('circle member can open the Highlight', async () => { const r = await request({ visibility: 'circle_only' }, { circle_memberships: [{ user_id: OWNER, other_id: VIEWER }] }); assert.equal(r.status, 200); });
for (const reverse of [false, true]) test(`block in direction ${reverse} withholds payload`, async () => {
  const r = await request({}, { blocks: [{ blocker_id: reverse ? OWNER : VIEWER, blocked_id: reverse ? VIEWER : OWNER }] }); assert.equal(r.status, 404); assert.equal(r.body.media_url, undefined);
});
test('withdrawn share consent withholds payload', async () => { const r = await request({}, { highlight_projection_policies: [{ highlight_id: ID, consent_share: false }] }); assert.equal(r.status, 404); });
test('owner keep-private control withholds payload', async () => { const r = await request({}, { highlight_resurfacing_preferences: [{ owner_id: OWNER, control: 'KEEP_PRIVATE_FOREVER', subject_id: ID, active: true }] }); assert.equal(r.status, 404); });
for (const status of ['deleted', 'deactivated', 'pending_deletion']) test(`current author ${status} withholds payload`, async () => {
  const r = await request({}, { profiles: [{ id: OWNER, account_status: status }] }); assert.equal(r.status, 404); });
test('canonical author ban withholds payload', async () => { const r = await request({}, { profiles: [{ id: OWNER, account_status: 'active', user_account_states: [{ state: 'banned', expires_at: null }] }] }); assert.equal(r.status, 404); });
for (const table of ['highlights', 'blocks', 'highlight_projection_policies', 'highlight_resurfacing_preferences', 'highlight_views', 'highlight_likes']) test(`${table} outage remains retryable, not missing`, async () => {
  const r = await request({}, {}, { errors: { [table]: { message: 'database unavailable' } } }); assert.equal(r.status, 503); assert.equal(r.body.error, 'degraded_unavailable'); assert.equal(r.body.media_url, undefined);
});
test('unreadable circle membership remains retryable', async () => { const r = await request({ visibility: 'circle_only' }, {}, { errors: { circle_memberships: { message: 'offline' } } }); assert.equal(r.status, 503); });
test('counts are exact even when row reads are capped', async () => { const r = await request({}, { highlight_views: Array.from({ length: 12 }, (_, i) => ({ highlight_id: ID, viewer_id: i === 11 ? VIEWER : `${i}` })) }, { maxRows: 2 }); assert.equal(r.status, 200); assert.equal(r.body.viewCount, 12); assert.equal(r.body.viewedByMe, true); });
test('payload and its visibility come from one row read', async () => {
  let reads = 0;
  const r = await request({}, {}, { onRead(table, store) { if (table === 'highlights' && ++reads > 2) store.highlights = [row({ visibility: 'private', caption: 'New private body' })]; } });
  assert.equal(r.status, 200); assert.equal(r.body.caption, 'Private caption');
  const payloadReads = r.db._observed.selects.filter(q => q.table === 'highlights' && q.sel.includes('media_url'));
  assert.equal(payloadReads.length, 1); assert.ok(payloadReads[0]!.sel.includes('visibility'));
});
test('post-reference media stays explicit and is not converted into an image', async () => { const r = await request({ media_type: 'application/vnd.portava.post-reference+json', media_url: `portava-post-reference:${ID}` }); assert.equal(r.status, 200); assert.equal(r.body.media_type, 'application/vnd.portava.post-reference+json'); });
test('invalid and missing IDs do not expose payload', async () => { const r = await request({}, {}, {}, VIEWER, 'not-an-id'); assert.equal(r.status, 400); });
