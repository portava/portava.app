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

import { listMemoryCandidates, confirmMemoryCandidate, rejectMemoryCandidate, detectMemoryCandidates, keepConvergence, dismissConvergence } from '../memoryCandidatesApi.ts';

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

it('every Keep of one candidate carries the SAME key — a second tap or a retry is the same command', async () => {
  respond(200, { ok: true, memoryId: 'mem-1', state: 'confirmed' });
  await confirmMemoryCandidate('ep-7', null);
  await confirmMemoryCandidate('ep-7', null);
  const keys = calls.map((c) => (c.init!.headers as Record<string, string>)['Idempotency-Key']);
  expect(keys).toEqual(['memory-candidate:ep-7', 'memory-candidate:ep-7']);
});

// ── H180: photos for a Memory the owner already has ─────────────────────────

const GROUP = { memoryId: 'mem-1', title: 'Fado night', startsAt: null, endsAt: null, visibility: 'public', attachAudience: 'memory', basis: 'memory_window', photos: [{ assetId: 'a-1', previewUrl: 'post-media/u/p1.jpg', capturedAt: null, state: 'proposed' }] };

it('H180: the inbox carries `convergence`; a server without it is not_deployed; a malformed one is unavailable — the candidates stand either way', async () => {
  respond(200, { candidates: [], convergence: { state: 'ready', groups: [GROUP] } });
  const ready = await listMemoryCandidates() as any;
  expect(ready.ok).toBe(true);
  expect(ready.convergence.state).toBe('ready');
  expect(ready.convergence.groups[0]).toMatchObject({ memoryId: 'mem-1', visibility: 'public', attachAudience: 'memory' });
  respond(200, { candidates: [] });
  expect(((await listMemoryCandidates()) as any).convergence).toEqual({ state: 'not_deployed' });
  respond(200, { candidates: [], convergence: { state: 'ready', groups: [{ ...GROUP, attachAudience: 'everyone' }] } });
  const odd = await listMemoryCandidates() as any;
  expect(odd.ok).toBe(true);
  expect(odd.convergence).toEqual({ state: 'unavailable' });
  respond(200, { candidates: [], convergence: { state: 'unavailable' } });
  expect(((await listMemoryCandidates()) as any).convergence).toEqual({ state: 'unavailable' });
});

it('H180: Add sends the photos and the audience the owner was shown; a changed audience comes back with the audience it is now', async () => {
  respond(200, { ok: true, memoryId: 'mem-1', kept: [{ assetId: 'a-1', itemId: 'i-1', itemAudience: 'memory' }], skipped: [] });
  const r = await keepConvergence('mem-1', ['a-1'], 'public');
  expect(r).toEqual({ ok: true, kept: [{ assetId: 'a-1', itemId: 'i-1', itemAudience: 'memory' }], skipped: [] });
  expect(calls[0]!.url).toBe('https://api.test/api/me/memory-convergence/mem-1/keep');
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ assetIds: ['a-1'], confirmAudience: 'public' });
  respond(409, { error: 'conflict', message: 'Confirm who can see this Memory before adding photos to it.', reason: 'audience_unconfirmed', currentAudience: 'friends_only' });
  expect(await keepConvergence('mem-1', ['a-1'], 'only_me')).toEqual({ ok: false, kind: 'conflict', message: 'Confirm who can see this Memory before adding photos to it.', reason: 'audience_unconfirmed', currentAudience: 'friends_only' });
});

it('H180: Not this Memory sends the photos to dismiss', async () => {
  respond(200, { ok: true, memoryId: 'mem-1', dismissed: ['a-1'], alreadyDismissed: [], refused: [] });
  expect(await dismissConvergence('mem-1', ['a-1'])).toEqual({ ok: true, dismissed: ['a-1'] });
  expect(calls[0]!.url).toBe('https://api.test/api/me/memory-convergence/mem-1/dismiss');
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ assetIds: ['a-1'] });
});
