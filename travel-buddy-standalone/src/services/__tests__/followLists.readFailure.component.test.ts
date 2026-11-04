/**
 * Follow lists — a failed read is a failure, not an empty list.
 *
 * getMyFollowing / getMyFollowers / getUserFollowers / getUserFollowing
 * answered an HTTP error or a network failure with `{ ok: true, data: [] }`,
 * so Followers, Following and the Circle screen said "No followers yet" /
 * "Not following anyone yet" when the read had simply failed.
 *
 *   F1  each of the four answers ok:false on an HTTP error;
 *   F2  each answers ok:false, network_unreachable, on a network failure;
 *   F3  a real empty list is still ok:true with [].
 *
 * Run with: npx jest src/services/__tests__/followLists.readFailure.component.test.ts
 */
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

const follows = require('../follows.ts') as typeof import('../follows.ts');
const { _setTestSupabase, _resetTestSupabase } = require('../apiToken.ts') as typeof import('../apiToken.ts');

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = { access_token: 'tok', expires_at: FAR_FUTURE };
const fakeSupabase = {
  auth: {
    getSession: async () => ({ data: { session } }),
    refreshSession: async () => ({ data: { session } }),
  },
};

const READS: Array<[string, () => ReturnType<typeof follows.getMyFollowing>]> = [
  ['getMyFollowing', () => follows.getMyFollowing()],
  ['getMyFollowers', () => follows.getMyFollowers()],
  ['getUserFollowers', () => follows.getUserFollowers('u-2')],
  ['getUserFollowing', () => follows.getUserFollowing('u-2')],
];

const realFetch = globalThis.fetch;
function respond(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as typeof fetch;
}

beforeEach(() => { _setTestSupabase(fakeSupabase as never); });
afterEach(() => { globalThis.fetch = realFetch; _resetTestSupabase(); });

describe('follow lists — failures are not empty lists', () => {
  it.each(READS)('F1: %s answers ok:false on an HTTP error', async (_name, read) => {
    respond(500, { error: 'db_error' });
    const r = await read();
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.errorKind, 'db_error');
  });

  it.each(READS)('F2: %s answers ok:false on a network failure', async (_name, read) => {
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const r = await read();
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'network_unreachable');
  });

  it.each(READS)('F3: %s still answers a real empty list as ok:true', async (_name, read) => {
    respond(200, { users: [] });
    const r = await read();
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, []);
  });
});
