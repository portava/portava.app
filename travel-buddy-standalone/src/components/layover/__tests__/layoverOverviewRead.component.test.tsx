/**
 * census-layover L156 / L294 — `getLayoverOverview`, against the three bodies
 * the server actually sends.
 *
 * `ownedSessionOr` (`artifacts/api-server/src/routes/airport.ts:1869`) already
 * decides which kind of failure a failed overview is:
 *
 *     if (!r.ok)      sendError(res, "degraded_unavailable",
 *                               "Your layover could not be loaded. Please try again.")
 *     if (!r.session) sendError(res, "not_found", "Session not found")
 *
 * — a retryable read failure and a gone-or-not-yours session, with different
 * statuses, different codes and different sentences. `getLayoverOverview`
 * answered `null` to both, and to an offline `fetch` rejection it answered by
 * THROWING, which its one caller did not catch.
 *
 * The screen half is `app/layover/__tests__/layoverDashboard.loadFailure...`.
 * This file is the parsing half and runs the real service module: only `fetch`
 * and the two auth modules beneath it are replaced, so a body the server does
 * not send cannot make these pass.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Case 4 is the control — a 200 must still produce the overview, unchanged.
 * A service that reported every outcome as one reason fails cases 1–3; one
 * that reported success as a failure fails case 4.
 */
import { getLayoverOverview } from '../../../services/layover.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('1. a 404 not_found is GONE, and carries the server\'s own sentence', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse(404, { error: 'not_found', message: 'Session not found' }),
  );

  const res = await getLayoverOverview('sess-1');

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('unreachable — asserted above');
  expect(res.reason).toBe('gone');
  expect(res.message).toBe('Session not found');
  expect(res.retryable).toBe(false);
});

test('2. a 503 degraded_unavailable is RETRYABLE, not a deletion', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse(503, {
      error: 'degraded_unavailable',
      message: 'Your layover could not be loaded. Please try again.',
      retryable: true,
    }),
  );

  const res = await getLayoverOverview('sess-1');

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('unreachable — asserted above');
  expect(res.reason).toBe('unavailable');
  expect(res.message).toBe('Your layover could not be loaded. Please try again.');
  expect(res.retryable).toBe(true);
});

test('3. a rejected fetch is UNREACHABLE — and does not escape as a throw', async () => {
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));

  // The assertion is as much that this RESOLVES as what it resolves to: the
  // caller floats this inside a Promise.all and never caught a rejection.
  const res = await getLayoverOverview('sess-1');

  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('unreachable — asserted above');
  expect(res.reason).toBe('unreachable');
  expect(res.retryable).toBe(true);
});

test('4. a 200 still yields the overview', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse(200, {
      ok: true,
      session: { id: 'sess-1' },
      certification: {}, safeReturn: {}, offlineBundle: null, safeEnvelope: null,
    }),
  );

  const res = await getLayoverOverview('sess-1');

  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('unreachable — asserted above');
  expect(res.overview.session.id).toBe('sess-1');
});

test('5. a 200 whose body says ok:false is a REFUSAL, not an overview', async () => {
  // The route's own envelope carries `ok`, and a body that says false is the
  // server declining — reading it as an overview would render a blank session.
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse(200, { ok: false, featureEnabled: false }),
  );

  const res = await getLayoverOverview('sess-1');

  expect(res.ok).toBe(false);
});
