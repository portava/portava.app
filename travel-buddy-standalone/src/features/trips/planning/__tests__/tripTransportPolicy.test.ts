/**
 * TRIP-F16 on the client — §7.4's transport-mode policy, set by the owner.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripTransportPolicy.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripTransportPolicy.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: () => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond()); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('transport policy', () => {
  before(async () => { mod = await import('../tripTransportPolicy.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('PUTs the modes this trip does NOT use, de-duplicated, in the server\'s own vocabulary', async () => {
    respond = () => json({ tripId: 't1', transportPolicy: { disallowedModes: ['drive'], note: null, updatedAt: '2026-09-29T00:00:00Z' } });
    const r = await mod.setTransportPolicy('t1', ['drive', 'drive'], null);
    assert.equal(r.state, 'done');
    if (r.state === 'done') assert.deepEqual(r.data.disallowedModes, ['drive']);
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1/transport-policy');
    assert.equal(calls[0]!.init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { disallowedModes: ['drive'], note: null });
  });

  it('toggling a mode flips it in or out of the disallowed set, and at least one mode must stay allowed', () => {
    assert.deepEqual(mod.toggleMode([], 'walk'), ['walk']);
    assert.deepEqual(mod.toggleMode(['walk'], 'walk'), []);
    assert.deepEqual(mod.toggleMode(['walk', 'drive'], 'transit'), ['walk', 'drive'], 'refuses to disallow every mode');
  });

  it('the gate being off is named, not shown as saved; a non-owner is refused by name', async () => {
    respond = () => json({ error: 'feature_disabled', message: 'Trip operational projections are not enabled' }, 404);
    const off = await mod.setTransportPolicy('t1', ['walk'], null);
    assert.deepEqual(off, { state: 'refused', status: 404, reason: 'feature_disabled', detail: 'Trip operational projections are not enabled' });
    respond = () => json({ error: 'forbidden', message: 'Only the owner', reason: 'TRIP_AUTH_NOT_OWNER' }, 403);
    const f = await mod.setTransportPolicy('t1', ['walk'], null);
    assert.equal(f.state, 'refused');
    if (f.state === 'refused') assert.equal(f.reason, 'TRIP_AUTH_NOT_OWNER');
  });

  it('reads the policy the feasibility response carries, and says when there is none to read', () => {
    assert.deepEqual(mod.policyFromReport({ transportPolicy: { disallowedModes: ['transit', 'bogus'], note: 'no cars', updatedAt: null } }), { disallowedModes: ['transit'], note: 'no cars', updatedAt: null });
    assert.equal(mod.policyFromReport({ transportPolicy: null }), null);
    assert.equal(mod.policyFromReport({}), null);
  });
});
