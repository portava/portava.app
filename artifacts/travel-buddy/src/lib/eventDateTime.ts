/**
 * eventDateTime — pure date/time helpers for the Events system.
 *
 * All composition happens in the device's local time zone (the creator picks
 * wall-clock times for the event city; the resulting Date is serialized as a
 * UTC instant via toISOString, so no silent double-conversion happens).
 *
 * Kept dependency-free so it can be unit-tested with node:test.
 */

export interface DateTimeParts {
  /** 'YYYY-MM-DD' local calendar date, or '' when unset */
  dateStr: string;
  /** 'HH:mm' local wall time, or '' when unset */
  timeStr: string;
}

/** Compose a local-timezone Date from 'YYYY-MM-DD' + 'HH:mm'. Returns null when either part is missing/invalid. */
export function composeLocalDate(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return null;
  const d = new Date(
    parseInt(dm[1], 10), parseInt(dm[2], 10) - 1, parseInt(dm[3], 10),
    parseInt(tm[1], 10), parseInt(tm[2], 10), 0, 0,
  );
  return isNaN(d.getTime()) ? null : d;
}

/** Compose an ISO-8601 UTC instant from local date+time parts, or undefined when incomplete. */
export function composeIso(dateStr: string, timeStr: string): string | undefined {
  const d = composeLocalDate(dateStr, timeStr);
  return d ? d.toISOString() : undefined;
}

/** Split an ISO instant into local-timezone date/time parts (for draft hydration). */
export function splitIso(iso: string): DateTimeParts {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { dateStr: '', timeStr: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Sensible default end for a given start: start + 2 hours.
 * Rolls the calendar date forward when the +2h crosses midnight, so the
 * default never produces an invalid (equal or inverted) start/end pair.
 */
export function defaultEndFor(startDateStr: string, startTimeStr: string): DateTimeParts {
  const start = composeLocalDate(startDateStr, startTimeStr);
  if (!start) return { dateStr: startDateStr, timeStr: '' };
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateStr: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
    timeStr: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
  };
}

export type EventTimesError =
  | { field: 'start'; message: string }
  | { field: 'end'; message: string };

/**
 * Validate the Date & Time step.
 * - Start date AND start time are required.
 * - End is optional; when any end part is present, both parts are required
 *   and the end instant must be strictly after the start instant.
 */
export function validateEventTimes(start: DateTimeParts, end: DateTimeParts): EventTimesError | null {
  if (!start.dateStr) return { field: 'start', message: 'Pick a start date' };
  if (!start.timeStr) return { field: 'start', message: 'Pick a start time' };
  const startDate = composeLocalDate(start.dateStr, start.timeStr);
  if (!startDate) return { field: 'start', message: 'Start date or time is invalid' };
  const hasAnyEnd = !!end.dateStr || !!end.timeStr;
  if (!hasAnyEnd) return null; // start-only events are allowed
  if (!end.dateStr) return { field: 'end', message: 'Pick an end date (or clear the end time)' };
  if (!end.timeStr) return { field: 'end', message: 'Pick an end time (or clear the end date)' };
  const endDate = composeLocalDate(end.dateStr, end.timeStr);
  if (!endDate) return { field: 'end', message: 'End date or time is invalid' };
  if (endDate.getTime() <= startDate.getTime()) {
    return { field: 'end', message: 'End time must be after the start time' };
  }
  return null;
}

// ── Listing date ranges (local-day boundaries, serialized as UTC instants) ────

export function todayRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now);   end.setHours(23, 59, 59, 999);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

export function tomorrowRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const start = new Date(now); start.setDate(now.getDate() + 1); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setHours(23, 59, 59, 999);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

export function weekendRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const day = now.getDay();
  const daysUntilSat = day === 6 ? 0 : (6 - day);
  const sat = new Date(now); sat.setDate(now.getDate() + daysUntilSat); sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1); sun.setHours(23, 59, 59, 999);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

export function next7Range(now = new Date()): { dateFrom: string; dateTo: string } {
  const end = new Date(now); end.setDate(now.getDate() + 7); end.setHours(23, 59, 59, 999);
  return { dateFrom: now.toISOString(), dateTo: end.toISOString() };
}

/**
 * Default "Upcoming" range: everything from the start of the local day onward
 * (no upper bound). Keeps same-day events visible even after their start time
 * has passed for the day, and never hides a later-today event because "now"
 * already moved past midnight UTC.
 */
export function upcomingRange(now = new Date()): { dateFrom: string } {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return { dateFrom: start.toISOString() };
}
