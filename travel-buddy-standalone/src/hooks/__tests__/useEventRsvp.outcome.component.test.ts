/**
 * Outcome-reporting tests for useEventRsvp().
 *
 * The signal audit (docs/algorithm/signal-audit.md §3a) found that on this tree
 * exactly ONE rank outcome was ever emitted — `save`, from SaveButton — leaving
 * the funnel biased toward passive engagement, which is precisely what the
 * spec's success hierarchy rejects. These tests pin the RSVP side of that fix.
 *
 * The important half of this file is the NEGATIVE cases. Emitting an outcome
 * that should not fire is invisible in the UI and silently corrupts the data
 * that v2 ranking weights get fitted on. A test that only proves 'going' emits
 * would let a later "let's also record maybe" change sail through review.
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: renderHook() is async — always await it. Calling it synchronously
 * returns a Promise with no query methods and surfaces as the misleading
 * "render function has not been called".
 */

import { renderHook, act } from '@testing-library/react-native';
import { useEventRsvp } from '../useEventRsvp.ts';

// ── mocks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual would pull the service's
// supabase/native dependency chain under jest.
jest.mock('../../services/events.ts', () => ({
  rsvpEvent:            jest.fn(),
  leaveEvent:           jest.fn(),
  joinWaitlist:         jest.fn(),
  leaveWaitlist:        jest.fn(),
  acceptWaitlistOffer:  jest.fn(),
  requestToJoinEvent:   jest.fn(),
  joinEventChat:        jest.fn(),
}));

// NOTE: intentionally exhaustive — spreading requireActual would keep the real
// fireRankOutcome, which performs a fetch. These tests assert on the call, not
// on the network, so the module is replaced outright.
jest.mock('../useRankOutcome.ts', () => ({
  fireRankOutcome: jest.fn(),
}));

import {
  rsvpEvent, acceptWaitlistOffer, requestToJoinEvent, joinWaitlist,
} from '../../services/events.ts';
import { fireRankOutcome } from '../useRankOutcome.ts';

const mockRsvp    = rsvpEvent as jest.MockedFunction<any>;
const mockAccept  = acceptWaitlistOffer as jest.MockedFunction<any>;
const mockRequest = requestToJoinEvent as jest.MockedFunction<any>;
const mockWaitlist= joinWaitlist as jest.MockedFunction<any>;
const mockFire    = fireRankOutcome as jest.MockedFunction<any>;

// ── fixtures ──────────────────────────────────────────────────────────────────

const EVENT_ID  = 'evt-outcome-test';
const SESSION   = 'sess-1111-2222';

// Minimal shape — the hook only reads id, myRsvp and counts.going.
const EVENT = { id: EVENT_ID, myRsvp: null, counts: { going: 3 } } as any;

const noopRefresh = async () => {};

beforeEach(() => {
  jest.clearAllMocks();
  mockRsvp.mockResolvedValue({ ok: true, data: {} });
  mockAccept.mockResolvedValue({ ok: true, data: {} });
  mockRequest.mockResolvedValue({ ok: true, data: {} });
  mockWaitlist.mockResolvedValue({ ok: true, data: { position: 2 } });
});

// ── positive cases ────────────────────────────────────────────────────────────

it("RSVP 'going' emits an 'rsvp' outcome on the events surface", async () => {
  const { result } = await renderHook(() =>
    useEventRsvp(EVENT, noopRefresh, undefined, { sessionId: SESSION }),
  );

  await act(async () => { await result.current.handleRsvp('going'); });

  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockFire).toHaveBeenCalledWith(EVENT_ID, 'events', 'rsvp', SESSION);
});

it("accepting a waitlist offer emits 'join' — the strongest rung this hook sees", async () => {
  const { result } = await renderHook(() =>
    useEventRsvp(EVENT, noopRefresh, undefined, { sessionId: SESSION }),
  );

  await act(async () => { await result.current.handleAcceptOffer(); });

  expect(mockFire).toHaveBeenCalledTimes(1);
  expect(mockFire).toHaveBeenCalledWith(EVENT_ID, 'events', 'join', SESSION);
});

it('threads a null sessionId when the event was not reached from a feed', async () => {
  // Deep link / search / notification: no session to attribute to. The outcome
  // must still record so heuristic (user_id, item_id) attribution can work —
  // see signal-audit §3a option 3.
  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleRsvp('going'); });

  expect(mockFire).toHaveBeenCalledWith(EVENT_ID, 'events', 'rsvp', null);
});

// ── negative cases — the part that matters ───────────────────────────────────

it.each(['maybe', 'interested'] as const)(
  "RSVP '%s' emits NOTHING — weaker than a commitment, and the enum cannot say so",
  async (status) => {
    const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

    await act(async () => { await result.current.handleRsvp(status); });

    expect(mockFire).not.toHaveBeenCalled();
  },
);

it("RSVP 'cant_go' emits NOTHING — recording it would invert a negative signal", async () => {
  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleRsvp('cant_go'); });

  expect(mockFire).not.toHaveBeenCalled();
});

it('a FAILED RSVP emits nothing — outcomes follow the API, not the tap', async () => {
  mockRsvp.mockResolvedValue({ ok: false, message: 'nope' });

  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleRsvp('going'); });

  expect(mockFire).not.toHaveBeenCalled();
});

it('a FAILED waitlist-offer acceptance emits nothing', async () => {
  mockAccept.mockResolvedValue({ ok: false, message: 'expired' });

  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleAcceptOffer(); });

  expect(mockFire).not.toHaveBeenCalled();
});

it('requesting to join emits nothing — it awaits host approval, so it is intent, not an outcome', async () => {
  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleRequestJoin('hi'); });

  expect(mockFire).not.toHaveBeenCalled();
});

it('joining the waitlist emits nothing — a queue position is not an event join', async () => {
  const { result } = await renderHook(() => useEventRsvp(EVENT, noopRefresh));

  await act(async () => { await result.current.handleJoinWaitlist(); });

  expect(mockFire).not.toHaveBeenCalled();
});
