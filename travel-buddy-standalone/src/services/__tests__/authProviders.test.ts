/**
 * authProviders — the backend's provider switches, read fail-open from
 * GET /auth/v1/settings.
 *
 * Run: node --import tsx --test src/services/__tests__/authProviders.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuthSettings,
  fetchAuthProviderAvailability,
  getAuthProviderAvailability,
  _resetAuthProviderAvailabilityCache,
} from '../authProviders.ts';

const URL_ = 'https://ajrurzioarfkagpuxfnb.supabase.co';
const KEY = 'sb_publishable_test';

function fakeFetch(status: number, body: unknown, calls: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
}

describe('parseAuthSettings', () => {
  it("reads apple, google and email from `external`; production's 2026-11-04 body: Apple off, Google and email on", () => {
    const body = { external: { anonymous_users: false, apple: false, google: true, email: true, phone: false }, disable_signup: false, mailer_autoconfirm: true };
    assert.deepEqual(parseAuthSettings(body), { apple: false, google: true, email: true });
  });

  it('a missing key counts as ON (fail-open), a non-object body is unknown', () => {
    assert.deepEqual(parseAuthSettings({ external: {} }), { apple: true, google: true, email: true });
    assert.equal(parseAuthSettings({}), null);
    assert.equal(parseAuthSettings(null), null);
    assert.equal(parseAuthSettings('nope'), null);
    assert.equal(parseAuthSettings({ external: 'nope' }), null);
  });
});

describe('fetchAuthProviderAvailability', () => {
  it('calls GET {supabaseUrl}/auth/v1/settings with the apikey header and parses the answer', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const out = await fetchAuthProviderAvailability({ fetchImpl: fakeFetch(200, { external: { apple: false, google: true } }, calls), supabaseUrl: `${URL_}/`, anonKey: KEY });
    assert.deepEqual(out, { apple: false, google: true, email: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${URL_}/auth/v1/settings`);
    assert.equal(calls[0].headers.apikey, KEY);
  });

  it('unknown (null) on a non-2xx status, a thrown fetch, a malformed body, or no configured backend', async () => {
    assert.equal(await fetchAuthProviderAvailability({ fetchImpl: fakeFetch(500, {}), supabaseUrl: URL_, anonKey: KEY }), null);
    assert.equal(await fetchAuthProviderAvailability({ fetchImpl: (async () => { throw new Error('Network request failed'); }) as typeof fetch, supabaseUrl: URL_, anonKey: KEY }), null);
    assert.equal(await fetchAuthProviderAvailability({ fetchImpl: fakeFetch(200, { nope: true }), supabaseUrl: URL_, anonKey: KEY }), null);
    assert.equal(await fetchAuthProviderAvailability({ fetchImpl: fakeFetch(200, { external: {} }), supabaseUrl: '', anonKey: KEY }), null);
    assert.equal(await fetchAuthProviderAvailability({ fetchImpl: fakeFetch(200, { external: {} }), supabaseUrl: URL_, anonKey: '' }), null);
  });
});

describe('getAuthProviderAvailability (process cache)', () => {
  beforeEach(() => _resetAuthProviderAvailabilityCache());

  it('fetches once and reuses a successful answer', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const opts = { fetchImpl: fakeFetch(200, { external: { apple: false } }, calls), supabaseUrl: URL_, anonKey: KEY };
    const a = await getAuthProviderAvailability(opts);
    const b = await getAuthProviderAvailability(opts);
    assert.deepEqual(a, { apple: false, google: true, email: true });
    assert.deepEqual(b, a);
    assert.equal(calls.length, 1);
  });

  it('does not remember a failure: the next call asks again', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    assert.equal(await getAuthProviderAvailability({ fetchImpl: fakeFetch(503, {}, calls), supabaseUrl: URL_, anonKey: KEY }), null);
    const again = await getAuthProviderAvailability({ fetchImpl: fakeFetch(200, { external: { google: false } }, calls), supabaseUrl: URL_, anonKey: KEY });
    assert.deepEqual(again, { apple: true, google: false, email: true });
    assert.equal(calls.length, 2);
  });
});
