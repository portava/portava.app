/**
 * census-discovery §113 (round 16, lane W11-X2, D-W11X2-134; outside DV-83, census-telegraph): a call the gateway could not
 * check is said as "could not check", never as the viewer's age group or as "for attendees".
 *
 * The gateway now answers an unread event gate `degraded_unavailable` (503, retryable) where it said `age_ineligible` or
 * `not_event_eligible`; the call screen had no copy for it and showed the raw code.
 *
 *   CD1  `degraded_unavailable` → "Calling couldn't be checked right now. Try again in a moment."
 *   CDc  CONTROL: `age_ineligible` and `not_event_eligible` keep their copy
 */
// NOTE: intentionally exhaustive — calls.ts imports the API client chain at module level; spreading requireActual would
// execute that chain and crash (as CallContext.resilience does).
jest.mock('../../services/calls.ts', () => ({
  startCall: jest.fn(), acceptCall: jest.fn(), declineCall: jest.fn(), endCall: jest.fn(), joinCall: jest.fn(),
  leaveCall: jest.fn(), getActiveCall: jest.fn(), startGroupCall: jest.fn(), getCall: jest.fn(), setHandRaised: jest.fn(),
}));
// NOTE: intentionally exhaustive — the real module creates a Supabase client at import time.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: { auth: { getUser: jest.fn() } } }));

import * as ctx from '../CallContext.tsx';

describe('§113: the call screen over a gate the gateway could not check (D-W11X2-134)', () => {
  const copy = (r: string) => (ctx as any).friendlyStartError(r);
  it("CD1 degraded_unavailable → \"could not check\", never the raw code", () => {
    expect(copy('degraded_unavailable')).toBe("Calling couldn't be checked right now. Try again in a moment.");
  });
  it('CDc CONTROL: the verdicts keep their copy', () => {
    expect(copy('age_ineligible')).toBe("This event's voice room isn't available for your age group.");
    expect(copy('not_event_eligible')).toBe('This voice room is for event attendees.');
  });
});
