/**
 * useRankOutcome — the served-context gate and the wire body.
 *
 * The discovery surface hands its shared components (PlaceCard,
 * PlaceDetailSheet) a `rankSurface`; components rendered by a surface that
 * served nothing (the Layover map card) hand nothing. This pins the contract
 * that makes that safe:
 *
 *   1. surface null/undefined ⇒ every report is a no-op — no token read, no
 *      fetch. An outcome with no impression to match is not "less precise", it
 *      is noise the server would 404 or, worse, attach to a stale row.
 *   2. surface 'discovery' ⇒ POST /api/rank-events/outcome with EXACTLY
 *      { item_id, surface: 'discovery', outcome } — ids only, no session key
 *      when none was served (GET /discovery returns no session_id).
 *   3. (itemId, outcome) is deduplicated per mount; a different outcome on the
 *      same item still fires, which is what lets tap → save chain.
 *   4. 'trip_add' (migration 2894) goes over the same wire as every other
 *      outcome and through the same gate — it is a value in the existing
 *      envelope, not a second transport.
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: renderHook() is async — always await it.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken imports the Supabase client; only
// freshToken is needed and a fixed token is all these tests require.
jest.mock('../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

import { useRankOutcome } from '../useRankOutcome.ts';
import { freshToken } from '../../services/apiToken.ts';

const mockFreshToken = freshToken as jest.MockedFunction<typeof freshToken>;
const fetchMock = jest.fn(() => Promise.resolve({ ok: true } as Response));

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_BASE  = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  mockFreshToken.mockClear();
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

/** Let the fire-and-forget async IIFE inside fireRankOutcome run to completion. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function postedBody(callIndex = 0): Record<string, unknown> {
  const init = (fetchMock.mock.calls[callIndex] as unknown as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

// ── 1. the gate ───────────────────────────────────────────────────────────────

it.each([null, undefined])('surface %s ⇒ every report is a no-op: no token read, no fetch', async (surface) => {
  const { result } = await renderHook(() => useRankOutcome({ surface }));

  await act(async () => {
    result.current.reportTap('node/1');
    result.current.reportSave('node/1');
    result.current.reportJoin('node/1');
    result.current.reportRsvp('node/1');
    // trip_add is gated exactly like its neighbours: PlanPickerController calls
    // the hook unconditionally and leaves `surface` null for a source that
    // reached it from no served feed, so this must post nothing at all.
    result.current.reportTripAdd('node/1');
  });
  await settle();

  expect(mockFreshToken).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

// ── 2. the wire body ──────────────────────────────────────────────────────────

it("surface 'discovery' ⇒ posts { item_id, surface: 'discovery', outcome } to the outcome route — ids only", async () => {
  const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));

  await act(async () => { result.current.reportTap('node/12345'); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.test/api/rank-events/outcome');
  expect(init.method).toBe('POST');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  expect(postedBody()).toEqual({ item_id: 'node/12345', surface: 'discovery', outcome: 'tap' });
});

it('a served sessionId is echoed; without one the key is absent rather than null', async () => {
  const withSession = await renderHook(() =>
    useRankOutcome({ surface: 'discovery', sessionId: '5e550000-0000-0000-0000-000000000001' }),
  );
  await act(async () => { withSession.result.current.reportSave('db/abc'); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(postedBody(0)).toEqual({
    item_id: 'db/abc', surface: 'discovery', outcome: 'save',
    session_id: '5e550000-0000-0000-0000-000000000001',
  });

  const withoutSession = await renderHook(() => useRankOutcome({ surface: 'discovery', sessionId: null }));
  await act(async () => { withoutSession.result.current.reportSave('db/abc'); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(postedBody(1)).toEqual({ item_id: 'db/abc', surface: 'discovery', outcome: 'save' });
});

// ── 3. dedup ──────────────────────────────────────────────────────────────────

it('dedups (itemId, outcome) per mount, but a stronger outcome on the same item still fires', async () => {
  const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));

  await act(async () => {
    result.current.reportTap('node/1');
    result.current.reportTap('node/1');   // duplicate — dropped
    result.current.reportSave('node/1');  // tap → save must still reach the server
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(postedBody(0).outcome).toBe('tap');
  expect(postedBody(1).outcome).toBe('save');
});

// ── 4. trip_add ───────────────────────────────────────────────────────────────

it("reportTripAdd posts outcome 'trip_add' in the SAME envelope as every other outcome", async () => {
  // The rung PlanPickerController reports when an add to a trip commits. A new
  // transport, a new body shape or a borrowed token ('join') would all show up
  // here: the server's zod enum 400s anything it does not recognise, and a 400
  // is silent to the user because the whole path is fire-and-forget.
  const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));

  await act(async () => { result.current.reportTripAdd('node/12345'); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.test/api/rank-events/outcome');
  expect(init.method).toBe('POST');
  expect(postedBody()).toEqual({
    item_id: 'node/12345', surface: 'discovery', outcome: 'trip_add',
  });
});

it('a save on an item does not suppress its later trip_add — the funnel rungs are distinct keys', async () => {
  // Dedup is keyed on (itemId, outcome). `04` §8's chain is
  // `… → save → trip_add`, so a trip_add following a save on the SAME item is
  // the one transition the chain exists to measure; a dedup key that dropped
  // the outcome half would erase exactly it.
  const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));

  await act(async () => {
    result.current.reportSave('node/1');
    result.current.reportTripAdd('node/1');
    result.current.reportTripAdd('node/1');   // duplicate — dropped
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(postedBody(0).outcome).toBe('save');
  expect(postedBody(1).outcome).toBe('trip_add');
});
