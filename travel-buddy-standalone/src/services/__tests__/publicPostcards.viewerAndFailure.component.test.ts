/**
 * getPublicPostcards — sends the viewer's session, and a failed read is a failure.
 *
 * GET /users/:username/passport/postcards takes optional auth and decides
 * follower access, blocks and "is this me" from the viewer. The client sent no
 * Authorization header, so a follower of a followers-only passport was told the
 * wall is private, and a failed read (HTTP 5xx, network) came back as
 * `{ ok: true, data: [] }`: a wall with no postcards.
 *
 *   V1  a session's token is sent as a Bearer header;
 *   V2  no session, no header (anonymous share-link viewers still work);
 *   V3  an HTTP error is ok:false, not an empty wall;
 *   V4  a network failure is ok:false, network_unreachable;
 *   V5  the server's sentinels still come through;
 *   V6  the owner's own postcard read (getMyPassportPostcards) is held to the
 *       same rule: usePassport's snapshot guard (§28.11) only works if a
 *       failure is ok:false.
 *
 * Run with: npx jest src/services/__tests__/publicPostcards.viewerAndFailure.component.test.ts
 */
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

const { getPublicPostcards, getMyPassportPostcards, _setTestAuthToken } = require('../profile.ts') as typeof import('../profile.ts');

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; _setTestAuthToken(null); });

describe('getPublicPostcards — viewer session and failures', () => {
  it('V1: a session token is sent as a Bearer header', async () => {
    _setTestAuthToken('viewer-tok');
    respond(200, { postcards: [] });
    const r = await getPublicPostcards('someone');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://api.test/api/users/someone/passport/postcards');
    assert.deepEqual(calls[0].init?.headers, { Authorization: 'Bearer viewer-tok' });
  });

  it('V2: with no session, no Authorization header is sent', async () => {
    _setTestAuthToken(''); // the test seam's "no token" — '' is falsy, null means "ask Supabase"
    respond(200, { postcards: [] });
    await getPublicPostcards('someone');
    assert.equal(calls[0].init, undefined);
  });

  it('V3: an HTTP error is a failed read, not an empty wall', async () => {
    _setTestAuthToken('viewer-tok');
    respond(500, { error: 'db_error' });
    const r = await getPublicPostcards('someone');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.errorKind, 'db_error');
  });

  it('V4: a network failure is a failed read', async () => {
    _setTestAuthToken('viewer-tok');
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const r = await getPublicPostcards('someone');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.errorKind, 'network_unreachable');
  });

  it("V5: the server's private sentinel still comes through", async () => {
    _setTestAuthToken('viewer-tok');
    respond(200, { private: true, postcards: [] });
    const r = await getPublicPostcards('someone');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.sentinel, 'private');
  });
});

describe("getMyPassportPostcards — the owner's own wall", () => {
  it('V6: an HTTP error or a network failure is ok:false, not an empty wall', async () => {
    _setTestAuthToken('owner-tok');
    respond(503, {});
    const http = await getMyPassportPostcards();
    assert.equal(http.ok, false);

    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const net = await getMyPassportPostcards();
    assert.equal(net.ok, false);
    assert.equal(net.errorKind, 'network_unreachable');

    respond(200, { postcards: [] });
    const empty = await getMyPassportPostcards();
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.data, []);
  });
});
