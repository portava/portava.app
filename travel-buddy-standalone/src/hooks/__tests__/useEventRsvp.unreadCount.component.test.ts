/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19): an RSVP never turns a going count
 * the server could not read into a number.
 *
 * GET /events/:id serves `counts.going: null` when its going read failed and no cached count exists. The optimistic
 * update after an RSVP computed `null + 1`, which JavaScript makes 1, so the screen said "1 going" over an unread count.
 *
 *   UR1  counts.going null, RSVP going → the optimistic update keeps it null
 *   UR0  CONTROL: counts.going 3, RSVP going → 4
 */
import { renderHook, act } from '@testing-library/react-native';
import { useEventRsvp } from '../useEventRsvp.ts';

// NOTE: intentionally exhaustive — requireActual would pull the service's supabase/native dependency chain under jest.
jest.mock('../../services/events.ts', () => ({
  rsvpEvent:            jest.fn(async () => ({ ok: true, data: {} })),
  leaveEvent:           jest.fn(),
  joinWaitlist:         jest.fn(),
  leaveWaitlist:        jest.fn(),
  acceptWaitlistOffer:  jest.fn(),
  requestToJoinEvent:   jest.fn(),
  joinEventChat:        jest.fn(),
}));

// NOTE: intentionally exhaustive — the real module performs a fetch; the outcome is not under test here.
jest.mock('../useRankOutcome.ts', () => ({
  fireRankOutcome: jest.fn(),
}));

async function optimistic(going: number | null) {
  const event = { id: 'e1', myRsvp: null, counts: { going, maybe: 0, interested: 0, cant_go: 0 } } as any;
  let next: any = null;
  const { result } = await renderHook(() => useEventRsvp(event, async () => {}, (u) => { next = u(event); }));
  await act(async () => { await result.current.handleRsvp('going'); });
  return next;
}

describe('census-discovery §117 (B19): an RSVP keeps an unread going count unread', () => {
  it('UR1 counts.going null → stays null after RSVP going', async () => {
    expect((await optimistic(null)).counts.going).toBeNull();
  });
  it('UR0 CONTROL: counts.going 3 → 4 after RSVP going', async () => {
    expect((await optimistic(3)).counts.going).toBe(4);
  });
});
