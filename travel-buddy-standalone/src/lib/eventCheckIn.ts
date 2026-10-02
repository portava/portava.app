/**
 * Pure helpers — self check-in window and the host's attendance controls.
 *
 * The server is the authority (`eventCheckInRefusal` in
 * artifacts/api-server/src/routes/events.ts); this mirrors its rule so the
 * app only offers "Check in" when the server will accept it, and says why
 * it is not offered otherwise. Keep the two in step.
 *
 *   opens   1 hour before `startsAt`
 *   closes  2 hours after `endsAt` (or 8 hours after `startsAt` with no end)
 *   states  open / full / waitlist / started only
 *
 * Check-in is a self-report — no GPS proof (decision TM-EV-01,
 * docs/ops/testing-mode-flows.md). The host's confirmation is the
 * trust-bearing signal.
 */

export const CHECKIN_OPENS_BEFORE_START_MS = 60 * 60_000;
export const CHECKIN_GRACE_AFTER_END_MS = 2 * 60 * 60_000;
export const CHECKIN_ASSUMED_DURATION_MS = 6 * 60 * 60_000;

const CHECKIN_STATES = new Set(['open', 'full', 'waitlist', 'started']);

export type CheckInWindow =
  | { status: 'open' }
  | { status: 'not_yet'; opensAt: number }
  | { status: 'closed'; reason: string };

export function checkInWindow(
  state: string | null | undefined,
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  now: number = Date.now(),
): CheckInWindow {
  if (!CHECKIN_STATES.has(String(state ?? ''))) return { status: 'closed', reason: 'Check-in is closed for this event' };
  const startMs = startsAt ? Date.parse(startsAt) : NaN;
  if (Number.isNaN(startMs)) return { status: 'closed', reason: 'This event has no start time yet' };
  const opensAt = startMs - CHECKIN_OPENS_BEFORE_START_MS;
  if (now < opensAt) return { status: 'not_yet', opensAt };
  const endParsed = endsAt ? Date.parse(endsAt) : NaN;
  const endMs = Number.isNaN(endParsed) ? startMs + CHECKIN_ASSUMED_DURATION_MS : endParsed;
  if (now > endMs + CHECKIN_GRACE_AFTER_END_MS) return { status: 'closed', reason: 'Check-in has closed for this event' };
  return { status: 'open' };
}

/**
 * The server accepts attendance confirmation and no-show marking only while the
 * STORED state is `started` or `completed` (routes/events.ts attendance/noshow).
 * The displayed state may already read "Happening now" from the clock while the
 * stored one is still `open` — the start transition is written by the server's
 * scheduler (flag event_start_transition_enabled) — so the controls key off the
 * stored state, and the screen says why they are not live yet.
 */
export function attendanceMarkingOpen(storedState: string | null | undefined): boolean {
  return storedState === 'started' || storedState === 'completed';
}

export type AttendanceMark = 'confirmed' | 'no_show' | 'checked_in' | 'unmarked';

export function attendanceMark(row: {
  checkedInAt: string | null; confirmedAt: string | null; noShowAt: string | null;
}): AttendanceMark {
  // The later of the two host marks wins — both are upserts on the same row
  // and a host may correct a mistake either way.
  const c = row.confirmedAt ? Date.parse(row.confirmedAt) : NaN;
  const n = row.noShowAt ? Date.parse(row.noShowAt) : NaN;
  if (!Number.isNaN(c) || !Number.isNaN(n)) {
    if (Number.isNaN(n)) return 'confirmed';
    if (Number.isNaN(c)) return 'no_show';
    return c >= n ? 'confirmed' : 'no_show';
  }
  return row.checkedInAt ? 'checked_in' : 'unmarked';
}

/**
 * `GET /api/events/:id` returns `myAttendanceState` as the raw
 * `event_attendee_states` row (snake_case); the client type names it in
 * camelCase. Read either spelling so the card is right whichever arrives.
 */
export function readAttendanceTimes(state: unknown): {
  checkedInAt: string | null; confirmedAt: string | null; noShowAt: string | null;
} {
  const s = (state ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string): string | null => {
    const v = s[camel] ?? s[snake];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    checkedInAt: pick('checkedInAt', 'checked_in_at'),
    confirmedAt: pick('confirmedAt', 'confirmed_at'),
    noShowAt:    pick('noShowAt', 'no_show_at'),
  };
}
