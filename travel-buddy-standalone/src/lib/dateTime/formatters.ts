/**
 * Date / time formatting helpers used across GlobalCalendarPicker,
 * GlobalTimePicker, DurationPicker, and all forms that store ISO dates.
 */

/** Format a Date for human display: "Jun 22, 2026" */
export function formatDisplayDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Format a Date range for display: "Jun 22–26, 2026" or "Jun 22 – Jul 4, 2026" */
export function formatDisplayDateRange(start: Date, end: Date): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth) {
    const month = start.toLocaleDateString('en-US', { month: 'short' });
    return `${month} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
  }
  if (sameYear) {
    const s = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const e = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${s} – ${e}, ${start.getFullYear()}`;
  }
  return `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
}

/** Format a Date as ISO date string: "2026-06-22" */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse an ISO date string "YYYY-MM-DD" into a local Date (midnight). */
export function fromISODate(s: string): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return isNaN(date.getTime()) ? null : date;
}

/** Format a local time: "6:30 PM" */
export function formatDisplayTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Format local HH:mm string: "18:30" */
export function toHHmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Parse "HH:mm" → Date (today's date at that time) */
export function fromHHmm(s: string): Date | null {
  if (!s || !/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/** Format a duration in seconds into a human label: "3 h", "30 min", "1 h 30 min" */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Strip time off a Date to midnight local time */
export function toMidnight(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}

/** Compare two dates ignoring time */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Return true if `d` is before `ref` (date only, ignoring time) */
export function isBeforeDay(d: Date, ref: Date): boolean {
  return toMidnight(d) < toMidnight(ref);
}

/** Return true if `d` is after `ref` (date only, ignoring time) */
export function isAfterDay(d: Date, ref: Date): boolean {
  return toMidnight(d) > toMidnight(ref);
}

/** Return true if `d` is between `start` and `end` (inclusive, date only) */
export function isBetweenDays(d: Date, start: Date, end: Date): boolean {
  const dn = toMidnight(d).getTime();
  return dn >= toMidnight(start).getTime() && dn <= toMidnight(end).getTime();
}

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
export function monthName(month: number): string { return MONTHS[month] ?? ''; }

/**
 * Format an ISO timestamp as a short relative label for use in feeds and
 * message lists: "just now", "5m", "3h", "2d".
 * Use absolute formatting (formatDisplayDate / formatDisplayTime) in detail
 * screens instead.
 */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!isFinite(diff) || diff < 0) return '';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
