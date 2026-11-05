/**
 * Collections and passports — a failed read is a failure, not an empty list.
 *
 * getCollections and listMyPassports answered an HTTP error or a network
 * failure with [], so the Saved screen said "No collections yet" (and offered
 * starter chips that made duplicates of collections that exist) and the
 * Passports screen said "No passports yet" when the read had simply failed.
 * readCollections / readMyPassports now say whether the read happened.
 *
 *   C1  each answers ok:false on an HTTP error;
 *   C2  each answers ok:false on a network failure;
 *   C3  a real empty list is still ok:true with [];
 *   C4  a real list comes back as data.
 *
 * Run with: npx jest src/services/__tests__/collectionsAndPassports.readFailure.component.test.ts
 */
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

const collections = require('../collections.ts') as typeof import('../collections.ts');
const passports = require('../entryRequirements.ts') as typeof import('../entryRequirements.ts');
const { _setTestSupabase, _resetTestSupabase } = require('../apiToken.ts') as typeof import('../apiToken.ts');

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = { access_token: 'tok', expires_at: FAR_FUTURE };
const fakeSupabase = {
  auth: {
    getSession: async () => ({ data: { session } }),
    refreshSession: async () => ({ data: { session } }),
  },
};

type Read = () => Promise<{ ok: boolean; data: unknown[] }>;
const READS: Array<[string, Read, string]> = [
  ['readCollections', () => collections.readCollections(), 'collections'],
  ['readMyPassports', () => passports.readMyPassports(), 'passports'],
];

const realFetch = globalThis.fetch;
const urls: string[] = [];
function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => { urls.length = 0; _setTestSupabase(fakeSupabase as never); });
afterEach(() => { globalThis.fetch = realFetch; _resetTestSupabase(); });

describe('collections and passports — failures are not empty lists', () => {
  it.each(READS)('C1: %s answers ok:false on an HTTP error', async (_name, read) => {
    respond(500, { error: 'db_error' });
    const r = await read();
    assert.equal(r.ok, false);
    assert.deepEqual(r.data, []);
    assert.equal(urls.length, 1);
  });

  it.each(READS)('C2: %s answers ok:false on a network failure', async (_name, read) => {
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const r = await read();
    assert.equal(r.ok, false);
    assert.deepEqual(r.data, []);
  });

  it.each(READS)('C3: %s still answers a real empty list as ok:true', async (_name, read, key) => {
    respond(200, { [key]: [] });
    const r = await read();
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, []);
  });

  it.each(READS)('C4: %s returns the list it read', async (_name, read, key) => {
    respond(200, { [key]: [{ id: 'x-1' }] });
    const r = await read();
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [{ id: 'x-1' }]);
  });

  it('listMyPassports (the pickers) still gets the list alone', async () => {
    respond(200, { passports: [{ id: 'p-1' }] });
    assert.deepEqual(await passports.listMyPassports(), [{ id: 'p-1' }]);
    respond(500, {});
    assert.deepEqual(await passports.listMyPassports(), []);
  });
});
