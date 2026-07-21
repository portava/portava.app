/**
 * Unit tests for fetchCompassHome — verifies the request appends the device's
 * real UTC offset (?tzOffsetMinutes=) so Compass Home time buckets follow the
 * traveler's clock, not the server's.
 *
 * Run via:
 *   node --import tsx/esm --test src/services/__tests__/compass.homeTzOffset.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Env must be set before the service module (and its supabase import) loads,
// so the module is imported lazily in the before() hook below.
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

let fetchCompassHome: typeof import('../compass.ts')['fetchCompassHome'];
let _setTestAuthToken: typeof import('../compass.ts')['_setTestAuthToken'];

let calls: string[] = [];
let failNext = false;

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => {
  if (failNext) { failNext = false; return Promise.reject(new Error('network down')); }
  calls.push(String(url));
  return Promise.resolve(
    new Response(JSON.stringify({ compassEnabled: true, fallback: false }), { status: 200 }),
  );
}) as typeof fetch;

after(() => { globalThis.fetch = realFetch; });

describe('fetchCompassHome tzOffsetMinutes', () => {
  before(async () => {
    const mod = await import('../compass.ts');
    fetchCompassHome = mod.fetchCompassHome;
    _setTestAuthToken = mod._setTestAuthToken;
  });

  beforeEach(() => {
    calls = [];
    failNext = false;
    _setTestAuthToken('test-token');
  });

  it('appends tzOffsetMinutes derived from the device clock', async () => {
    const res = await fetchCompassHome();
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.pathname.endsWith('/api/compass/home'), true);
    const raw = url.searchParams.get('tzOffsetMinutes');
    assert.notEqual(raw, null);
    // +0 normalizes -0 (UTC devices) so strict equality doesn't trip on sign.
    const expected = -new Date().getTimezoneOffset() + 0;
    assert.equal(Number(raw) + 0, expected);
    // Sanity: a plausible UTC offset, integer minutes.
    assert.ok(Number.isInteger(Number(raw)));
    assert.ok(Math.abs(Number(raw)) <= 14 * 60);
  });

  it('still fails gracefully on network errors', async () => {
    failNext = true;
    const res = await fetchCompassHome();
    assert.equal(res.ok, false);
    assert.equal(res.error, 'network_error');
  });
});
