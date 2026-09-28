/**
 * discoveryCardSave — the shared Discovery card's Save as a Telegraph command
 * (census-discovery §95, lane W11-X3; §81.4 routed hunk R1; A21).
 *
 *   S1  server flag OFF (404 feature_disabled): `fallback`, and only the
 *       command was asked — no confirmation is attempted
 *   S2  flag ON: command → confirm-action with the proposed action's id; the
 *       command body is the card's own Save payload
 *   S3  authorize refuses (403 not_member): `refused` with the server's reason,
 *       and nothing is confirmed
 *   S4  a failed confirmation (503) or a compensated one (409) is never `saved`
 *   S5  no session / network down: `failed`, never `fallback` (a flag we could
 *       not read is not a flag that is off)
 *
 * Run with: pnpm test:component (jest: the module chain reaches react-native)
 */
// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo. apiToken's session reads go through
// its own `_setTestSupabase` seam, so the token chain below is the production one.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { saveDiscoveryCardViaTelegraph, discoveryCardCommandBody } from '../discoveryCardSave.ts';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = (token: string | null) => ({
  auth: {
    getSession: () => Promise.resolve({ data: { session: token ? { access_token: token, expires_at: FAR_FUTURE } : null } }),
    refreshSession: () => Promise.resolve({ data: { session: token ? { access_token: token } : null } }),
  },
});

type Call = { url: string; method: string; body: any; auth: string | null };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function serve(responses: Array<{ status: number; body: unknown } | 'throw'>) {
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization ?? null });
    const r = responses[i++];
    if (!r || r === 'throw') throw new Error('network down');
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}

const CARD = { sourceId: '9f1c1c1c-0000-4000-8000-000000000001', sourceType: 'place', title: 'Rooftop', category: 'nightlife', city: 'Lisbon' };
const PROPOSED = { status: 201, body: { commandId: 'cmd-1', proposedActions: [{ id: 'cmd-1_a1', kind: 'discovery_save_place' }] } };

beforeEach(() => { calls = []; _setTestSupabase(session('tok') as any); });
afterEach(() => { globalThis.fetch = realFetch; _resetTestSupabase(); });

describe('S — Save through the Telegraph discovery-card command', () => {
  it('S1 server flag OFF: fallback, and no confirmation is attempted', async () => {
    serve([{ status: 404, body: { error: 'feature_disabled', message: 'Saving places from a conversation is not enabled.' } }]);
    assert.deepEqual(await saveDiscoveryCardViaTelegraph(CARD), { kind: 'fallback' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/telegraph\/commands\/discovery-card$/);
  });

  it('S2 flag ON: command, then confirm-action with the proposed id; the body is the card\'s Save payload', async () => {
    serve([PROPOSED, { status: 200, body: { ok: true, confirmed: true } }]);
    assert.deepEqual(await saveDiscoveryCardViaTelegraph(CARD), { kind: 'saved', message: '"Rooftop" was added to your saved places.' });
    assert.deepEqual(calls.map((c) => [c.method, c.url.replace(/^.*\/api/, '/api')]), [
      ['POST', '/api/telegraph/commands/discovery-card'],
      ['POST', '/api/telegraph/commands/cmd-1/confirm-action'],
    ]);
    assert.deepEqual(calls[0]!.body, { placeId: CARD.sourceId, title: 'Rooftop', category: 'nightlife', type: 'place', city: 'Lisbon' });
    assert.deepEqual(calls[1]!.body, { actionId: 'cmd-1_a1' });
    assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
    assert.deepEqual(discoveryCardCommandBody({ sourceId: 'x', title: '', category: '', sourceType: null, city: null }), { placeId: 'x' });
  });

  it('S3 authorize refuses: `refused` with the server\'s reason, and nothing is confirmed', async () => {
    serve([{ status: 403, body: { error: 'not_member', message: 'This place is no longer available to save.' } }]);
    assert.deepEqual(await saveDiscoveryCardViaTelegraph(CARD), { kind: 'refused', message: 'This place is no longer available to save.' });
    assert.equal(calls.length, 1);
  });

  it('S4 a failed or compensated confirmation is never `saved`', async () => {
    serve([PROPOSED, { status: 503, body: { error: 'degraded_unavailable', message: 'That could not be done right now.' } }]);
    assert.equal((await saveDiscoveryCardViaTelegraph(CARD)).kind, 'failed');
    calls = [];
    serve([PROPOSED, { status: 409, body: { error: 'conflict', message: 'Your authorization for this action changed…', confirmed: false, compensated: true } }]);
    assert.deepEqual(await saveDiscoveryCardViaTelegraph(CARD), { kind: 'failed', message: 'Your authorization for this action changed…' });
    calls = [];
    serve([{ status: 201, body: { commandId: 'cmd-2', proposedActions: [] } }]);
    assert.equal((await saveDiscoveryCardViaTelegraph(CARD)).kind, 'failed');
    assert.equal(calls.length, 1, 'no action proposed: nothing to confirm');
  });

  it('S5 no session or no network: `failed`, never `fallback`', async () => {
    _setTestSupabase(session(null) as any);
    serve([]);
    assert.equal((await saveDiscoveryCardViaTelegraph(CARD)).kind, 'failed');
    assert.equal(calls.length, 0);
    _setTestSupabase(session('tok') as any);
    serve(['throw']);
    assert.equal((await saveDiscoveryCardViaTelegraph(CARD)).kind, 'failed');
  });
});
