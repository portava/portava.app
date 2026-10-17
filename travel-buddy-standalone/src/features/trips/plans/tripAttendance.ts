/**
 * §9.1 attendance on the client — saying you are going, maybe, can't go, are
 * interested, or are leaving a plan (census-trips TR149; populates TR83's
 * `trip_plan_participants`).
 *
 * `trip_plan_participants` has exactly one writer family — JOIN_PLAN,
 * SET_PLAN_ATTENDANCE, LEAVE_PLAN (2772) — and POST /trips/:tripId/commands
 * issues it whatever `trip_kernel_enabled` says. Nothing in the product issued
 * it, so every production plan's attendance was empty although GET
 * /trips/:tripId/structure (no flag) already serves it. This is that writer's
 * client; the commands are built in tripAttendancePayloads.ts (pure).
 *
 * One key per tap (`attendanceKey`); the card keeps the key AND the command,
 * so a retry after an unreachable kernel re-sends THAT command.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';
import { attendanceCommand, type AttendanceState, type OfferedAttendance } from './tripAttendancePayloads.ts';

type Issuer = (tripId: string, cmd: TripCommandRequest) => Promise<TripCommandResult>;
let _testIssuer: Issuer | null = null;
/** Test seam: replace the kernel command client; null restores. */
export function _setTestIssuer(fn: Issuer | null): void { _testIssuer = fn; }

async function issue(tripId: string, cmd: TripCommandRequest): Promise<TripCommandResult> {
  if (_testIssuer) return _testIssuer(tripId, cmd);
  // Lazy: tripCommands.ts reaches lib/supabase.ts, which node:test cannot load.
  const { issueTripCommand } = await import('../../../services/tripCommands.ts');
  return issueTripCommand(tripId, cmd);
}

export type AttendanceResult =
  | { state: 'recorded'; duplicate: boolean }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_AUTH_NOT_CREW: 'only the trip crew can join its plans',
  TRIP_PLAN_NOT_FOUND: 'that plan is no longer on this trip',
  TRIP_PLAN_ATTENDANCE_NOT_FOUND: "you're not on this plan's list any more — read it again",
  TRIP_COMMAND_MALFORMED: "the trip didn't accept that",
  LOCAL_INVALID: 'that plan could not be identified',
  LOCAL_NO_CHANGE: "that's already your answer",
  LOCAL_NOT_ON_PLAN: "you're not on this plan",
};

function toResult(r: TripCommandResult): AttendanceResult {
  if (r.ok) return { state: 'recorded', duplicate: r.duplicate };
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function attendanceKey(planId: string, target: OfferedAttendance | 'leave'): string {
  return intentKey(`attendance:${planId}:${target}`);
}

/** JOIN_PLAN, SET_PLAN_ATTENDANCE or LEAVE_PLAN, whichever moves `current` to `target`. */
export async function setAttendance(
  tripId: string, planId: string, current: AttendanceState | null, target: OfferedAttendance | 'leave', idempotencyKey: string,
): Promise<AttendanceResult> {
  const cmd = attendanceCommand(planId, current, target);
  if (!cmd.ok) return { state: 'refused', reason: cmd.reason, detail: REFUSAL_TEXT[cmd.reason] ?? cmd.reason };
  return toResult(await issue(tripId, { type: cmd.type, payload: cmd.payload, idempotencyKey }));
}
