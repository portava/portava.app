/**
 * Weekday derivation for the buddy availability grid.
 *
 * Derives the Mon..Sun key from an ISO date string using LOCAL-time date
 * parts. `new Date('YYYY-MM-DD')` parses as UTC midnight, so in negative-UTC
 * timezones a UTC-based derivation shifts every row back one weekday and the
 * reloaded availability grid no longer matches what was saved.
 */

export const WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/**
 * Returns the Mon..Sun key for an ISO date ('YYYY-MM-DD' or a full ISO
 * timestamp — only the date part is used), or undefined for unparseable input.
 * The result depends only on the calendar date, never on the runtime timezone.
 */
export function weekdayKeyFromISODate(isoDate: string): WeekdayKey | undefined {
  if (typeof isoDate !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.slice(0, 10));
  if (!m) return undefined;
  const [yy, mm, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Construct at LOCAL midnight so getDay() reflects the calendar date itself.
  const local = new Date(yy, mm - 1, dd);
  if (Number.isNaN(local.getTime())) return undefined;
  return WEEKDAY_KEYS[(local.getDay() + 6) % 7];
}
