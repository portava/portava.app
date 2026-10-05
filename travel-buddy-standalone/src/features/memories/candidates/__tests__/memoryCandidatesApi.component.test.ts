/**
 * memoryCandidatesApi — the three answers a read can have stay apart:
 * candidates, `not_deployed` (404 feature_disabled), and a failure. A 404 that
 * is NOT feature_disabled is `not_found`, never "not deployed"; a confirm
 * carries an Idempotency-Key so a retry is the same command.
 *
 * Run with: pnpm test:component
 */
// NOTE: intentionally exhaustive — the real module constructs a Supabase client
// whose auto-refresh timer outlives the suite; this file needs only the token.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: () => Promise.resolve('tok') }));

import { listMemoryCandidates, confirmMemoryCandidate, rejectMemoryCandidate, detectMemoryCandidates } from '../memoryCandidatesApi.ts';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}
beforeEach(() => { calls = []; process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
afterEach(() => { globalThis.fetch = realFetch; });

it('404 feature_disabled is not_deployed; a plain 404 is not_found; 503 is unavailable', async () => {
  respond(404, { error: 'feature_disabled', message: 'Memory suggestions are not available yet.' });
  expect(await listMemoryCandidates()).toEqual({ ok: false, kind: 'not_deployed', message: 'Memory suggestions are not available yet.' });
  respond(404, { error: 'not_found', message: 'Suggestion not found' });
  expect((await rejectMemoryCandidate('ep-1') as { kind?: string }).kind).toBe('not_found');
  respond(503, { error: 'degraded_unavailable', message: 'x' });
  expect((await listMemoryCandidates() as { kind?: string }).kind).toBe('unavailable');
});

it('a malformed 200 is unavailable, never an empty inbox', async () => {
  respond(200, { candidates: 'nope' });
  const r = await listMemoryCandidates();
  expect(r.ok).toBe(false);
});

it('confirm sends an Idempotency-Key and reports the Memory; detect sends the trip', async () => {
  respond(200, { ok: true, memoryId: 'mem-1', state: 'confirmed' });
  const r = await confirmMemoryCandidate('ep-1', null, 'op-123');
  expect(r).toEqual({ ok: true, memoryId: 'mem-1' });
  expect((calls[0]!.init!.headers as Record<string, string>)['Idempotency-Key']).toBe('op-123');
  respond(200, { report: { capturesRead: 0, capturesWithoutTime: 0, capturesAlreadyInMemories: 0, candidates: [] } });
  await detectMemoryCandidates('trip-9');
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ tripId: 'trip-9' });
});

it('409 is conflict', async () => {
  respond(409, { error: 'conflict', message: 'This suggestion has already been decided.' });
  expect((await confirmMemoryCandidate('ep-1', null) as { kind?: string }).kind).toBe('conflict');
});
