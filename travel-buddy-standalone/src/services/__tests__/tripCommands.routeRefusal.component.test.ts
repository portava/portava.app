/**
 * POST /trips/:tripId/commands — a refusal the ROUTE makes before the kernel
 * (an invalid §9.3 field, not a member, a Trust restriction, a read-only
 * record) is a refusal with the server's words, not "couldn't reach the trip".
 * The kernel's own refusals, a 503, a 401, a retryable answer and an
 * unreadable body keep their meanings.
 *
 * Only `fetch` is faked (and the Supabase-backed modules, which cannot load
 * under jest). The real issueTripCommand reads the responses.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive — the real module creates the Supabase client.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { issueTripCommand } from '../tripCommands.ts';

function answer(status: number, body: unknown) {
  globalThis.fetch = jest.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}
const send = () => issueTripCommand('aaaaaaaa-0000-4000-8000-0000000000a2', { type: 'CREATE_PROPOSAL', payload: { proposal_type: 'other' }, idempotencyKey: 'k1' });

beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://portava.test'; });

it('a 4xx the route answered with an error code is a refusal carrying that code and message', async () => {
  answer(400, { error: 'invalid_payload', message: 'rationale must be text' });
  expect(await send()).toEqual({ ok: false, kind: 'refused', status: 400, reason: 'invalid_payload', detail: 'rationale must be text', currentVersion: null, expectedVersion: null });
  answer(403, { error: 'trust_restriction', message: 'You cannot propose changes on this trip right now.', restrictionTypes: ['x'] });
  expect(await send()).toMatchObject({ ok: false, kind: 'refused', status: 403, reason: 'trust_restriction', detail: 'You cannot propose changes on this trip right now.' });
  answer(403, { error: 'forbidden', message: 'Not a trip member' });
  expect(await send()).toMatchObject({ kind: 'refused', reason: 'forbidden', detail: 'Not a trip member' });
});

it('the kernel\'s own refusal keeps its reason code', async () => {
  answer(409, { ok: false, error: 'conflict', reason: 'TRIP_STAGE_INVALID_TRANSITION', detail: null, currentVersion: 7, expectedVersion: null });
  expect(await send()).toEqual({ ok: false, kind: 'refused', status: 409, reason: 'TRIP_STAGE_INVALID_TRANSITION', detail: null, currentVersion: 7, expectedVersion: null });
});

it('a 503, a 401, a retryable answer and an unreadable body are NOT refusals — nothing was decided', async () => {
  answer(503, { ok: false, error: 'degraded_unavailable', reason: 'TRIP_KERNEL_UNAVAILABLE' });
  expect(await send()).toEqual({ ok: false, kind: 'unavailable', detail: 'TRIP_KERNEL_UNAVAILABLE' });
  answer(401, { error: 'unauthorized', message: 'token expired' });
  expect(await send()).toMatchObject({ kind: 'unavailable' });
  answer(429, { error: 'rate_limited', message: 'slow down', retryable: true });
  expect(await send()).toMatchObject({ kind: 'unavailable' });
  answer(400, '<html>not json</html>');
  expect(await send()).toEqual({ ok: false, kind: 'unavailable', detail: 'unreadable response (HTTP 400)' });
  answer(500, { error: 'db_error', message: 'boom' });
  expect(await send()).toMatchObject({ kind: 'unavailable' });
});

// Independent verification (wave 5, pass 2): the server does not mark
// rate_limited retryable (lib/http.ts RETRYABLE_CODES), so a limiter on
// /commands would answer 429 WITHOUT `retryable: true`. That is "try again
// later", never a refusal of the command.
it('a 429 is unavailable even when the server does not mark it retryable', async () => {
  answer(429, { error: 'rate_limited', message: 'slow down' });
  expect(await send()).toMatchObject({ ok: false, kind: 'unavailable' });
});
