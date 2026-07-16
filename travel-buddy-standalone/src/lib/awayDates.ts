/**
 * Away-date helpers for buddy profiles.
 *
 * Blocked ranges arrive as ISO YYYY-MM-DD strings. Parsing uses the
 * `T00:00:00` suffix so the Date reflects the local calendar date
 * regardless of runtime timezone (bare `YYYY-MM-DD` parses as UTC
 * midnight and shifts a day back in negative-UTC zones).
 */

export type AwayRange = {
  startDate: string; // ISO YYYY-MM-DD
  endDate: string;   // ISO YYYY-MM-DD (same as startDate for single-day blocks)
};

/** Format a blocked range like "Aug 1–5" or "Jul 30 – Aug 2". */
export function formatAwayRange(range: AwayRange): string {
  const start = new Date(`${range.startDate}T00:00:00`);
  const end = new Date(`${range.endDate}T00:00:00`);
  const fmt = (d: Date) => d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  if (range.startDate === range.endDate) return fmt(start);
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${fmt(start)}–${end.getDate()}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Keep only ranges that haven't fully passed (endDate >= today),
 * sorted by start date ascending. Ranges ending today are included.
 */
export function upcomingAwayRanges<T extends AwayRange>(
  ranges: T[],
  todayIso: string = new Date().toISOString().slice(0, 10),
): T[] {
  return ranges
    .filter(r => r.endDate >= todayIso)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}
