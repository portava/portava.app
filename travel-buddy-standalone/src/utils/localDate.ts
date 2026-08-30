/**
 * Local-calendar-day helpers.
 *
 * A `timestamptz` / `Date` serialised with `toISOString()` gives the UTC
 * calendar date. That is the WRONG day for most of the world for part of every
 * day — and PERMANENTLY wrong in scrollback, because one local calendar day
 * straddles two UTC days (a Da Nang message at 05:00 local is the previous day
 * in UTC forever). Group and compare by the LOCAL calendar day instead.
 *
 * Both keys are 'YYYY-MM-DD', so lexical string comparison is also chronological.
 */

/** 'YYYY-MM-DD' for the LOCAL calendar day of `d` (an ISO string, epoch ms, or Date). */
export function localDateKey(d: Date | string | number = new Date()): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' for the local calendar day today. */
export function localTodayKey(now: Date = new Date()): string {
  return localDateKey(now);
}
