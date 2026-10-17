/**
 * §9.1 attendance on a plan — JOIN_PLAN, SET_PLAN_ATTENDANCE and LEAVE_PLAN
 * (2772) — built and checked in one pure place (census-trips TR149, TR83).
 *
 * WHICH COMMAND, AND WHY
 * ======================
 * All three are self-only: none takes a user id, so the actor can only ever
 * state their own attendance (2772's header). They differ in what must exist:
 *
 *   no row yet          JOIN_PLAN { plan_id, attendance_state }  — creates it.
 *   a row               SET_PLAN_ATTENDANCE { plan_id, attendance_state }
 *                       — the kernel refuses it without a row
 *                       (TRIP_PLAN_ATTENDANCE_NOT_FOUND).
 *   leaving             LEAVE_PLAN { plan_id } — a row in any state but `left`.
 *                       The kernel sets `left` ("who was going and is not any
 *                       more" is a fact §9.1 needs), or removes the row when the
 *                       person was only ever `interested`.
 *
 * `left` is never offered as a state to SET: leaving is its own command with
 * its own rule. A tap for the state the person is already in sends nothing.
 *
 * Pure: imports only pure modules, so the api-server's real-chain suite can run
 * these builders' output through `trip_kernel_execute`.
 */
import { isUuid } from '../planning/tripStructurePayloads.ts';

/** 2771 `trip_plan_participants_attendance_known`, in that order. */
export const ATTENDANCE_STATES = ['interested', 'going', 'maybe', 'cant_go', 'left'] as const;
export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

/** What a person can say about a plan. Order is the order offered. */
export const OFFERED_ATTENDANCE = ['going', 'maybe', 'cant_go', 'interested'] as const;
export type OfferedAttendance = (typeof OFFERED_ATTENDANCE)[number];

export type AttendanceReason = 'LOCAL_INVALID' | 'LOCAL_NO_CHANGE' | 'LOCAL_NOT_ON_PLAN';

export type AttendanceCommand =
  | { ok: true; type: 'JOIN_PLAN' | 'SET_PLAN_ATTENDANCE' | 'LEAVE_PLAN'; payload: Record<string, unknown> }
  | { ok: false; reason: AttendanceReason };

export function isAttendanceState(v: unknown): v is AttendanceState {
  return typeof v === 'string' && (ATTENDANCE_STATES as readonly string[]).includes(v);
}

/**
 * The command that moves the actor's attendance on `planId` from `current`
 * (null: no row) to `target`.
 */
export function attendanceCommand(planId: string, current: AttendanceState | null, target: OfferedAttendance | 'leave'): AttendanceCommand {
  if (!isUuid(planId)) return { ok: false, reason: 'LOCAL_INVALID' };
  if (target === 'leave') {
    return current === null || current === 'left'
      ? { ok: false, reason: 'LOCAL_NOT_ON_PLAN' }
      : { ok: true, type: 'LEAVE_PLAN', payload: { plan_id: planId } };
  }
  if (!(OFFERED_ATTENDANCE as readonly string[]).includes(target)) return { ok: false, reason: 'LOCAL_INVALID' };
  if (current === target) return { ok: false, reason: 'LOCAL_NO_CHANGE' };
  return current === null
    ? { ok: true, type: 'JOIN_PLAN', payload: { plan_id: planId, attendance_state: target } }
    : { ok: true, type: 'SET_PLAN_ATTENDANCE', payload: { plan_id: planId, attendance_state: target } };
}

/**
 * The actor's own state on a plan, from the structure read's attendance rows.
 * null: no row. An unknown state string is null too — it is then treated as
 * "no row", and the kernel's own answer settles it.
 */
export function myAttendance(
  planAttendance: ReadonlyArray<{ planId: string; participants: ReadonlyArray<{ userId: string; attendanceState: string }> }>,
  planId: string,
  userId: string,
): AttendanceState | null {
  const row = planAttendance.find((p) => p.planId === planId)?.participants.find((p) => p.userId === userId);
  return row && isAttendanceState(row.attendanceState) ? row.attendanceState : null;
}

/** How many are going: the server's `goingUserIds`, never re-derived. Null when the plan has no attendance rows read. */
export function goingCount(planAttendance: ReadonlyArray<{ planId: string; goingUserIds: readonly string[] }>, planId: string): number | null {
  const p = planAttendance.find((x) => x.planId === planId);
  return p ? p.goingUserIds.length : null;
}
