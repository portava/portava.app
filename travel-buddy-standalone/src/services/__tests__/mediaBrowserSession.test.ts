import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaBrowserSessionTransport } from '../mediaBrowserSession.ts';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';

const OWNER = 'a1000000-0000-4000-a000-000000000002';
const OTHER = 'a1000000-0000-4000-a000-000000000003';
const API = 'https://rumazi.com';
const previous = process.env.EXPO_PUBLIC_API_BASE_URL;
const success = (viewerId = OWNER) => new Response(JSON.stringify({ viewerId, ttlSeconds: 90 }), { status: 200 });

describe('same-origin browser media session client', () => {
  before(() => { process.env.EXPO_PUBLIC_API_BASE_URL = API; });
  beforeEach(() => { setDiscoveryViewerFromSession(OWNER); });
  after(() => { setDiscoveryViewerFromSession(null); if (previous === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = previous; });

  it('uses bearer-authenticated installation, same-origin credentials and a bounded shared lease', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => 'owner-token', renew: false,
      fetch: async (url, init) => { requests.push({ url: String(url), init: init! }); return success(); } });
    try {
      assert.deepEqual(await Promise.all([client.ensure(OWNER), client.ensure(OWNER)]), [true, true]);
      assert.equal(await client.ensure(OWNER), true); assert.equal(requests.length, 1);
      assert.equal(requests[0]!.url, `${API}/api/media/file/session`);
      assert.equal(requests[0]!.init.credentials, 'same-origin'); assert.equal(requests[0]!.init.redirect, 'error');
      assert.equal(new Headers(requests[0]!.init.headers).get('authorization'), 'Bearer owner-token');
      assert.doesNotMatch(requests[0]!.url, /owner-token/);
    } finally { client.dispose(); }
  });

  it('refuses cross-origin web, native context and wrong account without sending credentials', async () => {
    let calls = 0;
    for (const origin of ['https://preview.foreign.test', null]) {
      const client = createMediaBrowserSessionTransport({ origin: () => origin, tokenFor: async () => 'token', renew: false, fetch: async () => { calls++; return success(); } });
      assert.equal(await client.ensure(OWNER), false); client.dispose();
    }
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => 'token', renew: false, fetch: async () => { calls++; return success(); } });
    assert.equal(await client.ensure(OTHER), false); client.dispose(); assert.equal(calls, 0);
  });

  it('shares one cookie clear between scope invalidation and explicit logout cleanup', async () => {
    const methods: string[] = [];
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => 'token', renew: false,
      fetch: async (_url, init) => { methods.push(init!.method!); return init!.method === 'DELETE' ? new Response(null, { status: 204 }) : success(); } });
    try {
      assert.equal(await client.ensure(OWNER), true);
      setDiscoveryViewerFromSession(null);
      assert.deepEqual(await Promise.all([client.clear(), client.clear()]), [true, true]);
      assert.deepEqual(methods, ['POST', 'DELETE']);
    } finally { client.dispose(); }
  });

  it('refuses unauthenticated installation and malformed or wrong-owner receipts', async () => {
    for (const body of [{ viewerId: OTHER, ttlSeconds: 90 }, { viewerId: OWNER, ttlSeconds: 3600 }, { viewerId: OWNER, ttlSeconds: 0 }, {}]) {
      const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => 'token', renew: false,
        fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
      assert.equal(await client.ensure(OWNER), false); client.dispose();
    }
    let calls = 0;
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => null, renew: false,
      fetch: async () => { calls++; return success(); } });
    assert.equal(await client.ensure(OWNER), false); assert.equal(calls, 0); client.dispose();
  });

  it('cancels an old account installation and serializes cookie clearing before the next account', async () => {
    const methods: string[] = [];
    let signal: AbortSignal | undefined;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async viewer => `${viewer}-token`, renew: false,
      fetch: async (_url, init) => {
        methods.push(init!.method!);
        if (methods.length === 1) { signal = init!.signal!; began(); return new Promise(() => {}); }
        return init!.method === 'DELETE' ? new Response(null, { status: 204 }) : success(OTHER);
      } });
    try {
      const original = client.ensure(OWNER); await started;
      setDiscoveryViewerFromSession(OTHER);
      const next = client.ensure(OTHER);
      assert.equal(await original, false); assert.equal(await next, true);
      assert.deepEqual(methods, ['POST', 'DELETE', 'POST']); assert.equal(signal?.aborted, true);
    } finally { client.dispose(); }
  });

  it('clears on sign-out without needing a token and refuses stale leases', async () => {
    const calls: RequestInit[] = [];
    let cleared!: () => void;
    const finished = new Promise<void>(resolve => { cleared = resolve; });
    const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: async () => 'token', renew: false,
      fetch: async (_url, init) => { calls.push(init!); if (init!.method === 'DELETE') { cleared(); return new Response(null, { status: 204 }); } return success(); } });
    try {
      assert.equal(await client.ensure(OWNER), true);
      setDiscoveryViewerFromSession(null); await finished;
      assert.equal(await client.ensure(OWNER), false);
      assert.equal(calls.at(-1)!.method, 'DELETE'); assert.equal(new Headers(calls.at(-1)!.headers).get('authorization'), null);
      assert.equal(calls.at(-1)!.credentials, 'same-origin');
    } finally { client.dispose(); }
  });

  it('bounds stalled token, response, and response-body operations', async () => {
    for (const phase of ['token', 'fetch', 'body']) {
      const stalled = () => new Promise<never>(() => {});
      const client = createMediaBrowserSessionTransport({ origin: () => API, tokenFor: phase === 'token' ? stalled : async () => 'token', renew: false, timeoutMs: 20,
        fetch: phase === 'fetch' ? stalled : async () => phase === 'body' ? new Response(new ReadableStream({}), { status: 200 }) : success() });
      try { assert.equal(await client.ensure(OWNER), false, phase); } finally { client.dispose(); }
    }
  });
});
