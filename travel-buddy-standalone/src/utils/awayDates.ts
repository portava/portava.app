/**
 * Away-date helpers for the buddy profile Availability section.
 *
 * A buddy's blocked/vacation ranges come from the public blocked-dates
 * endpoint (getBuddyBlockedDates). These helpers format them for display
 * ("Aug 1–5" / "Jul 30 – Aug 2") and filter to upcoming ranges.
 */
import type { BuddyBlockedRange } from '../services/rentABuddy';

/** Format a blocked range like "Aug 1–5" or "Jul 30 – Aug 2". */
export function formatAwayRange(range: BuddyBlockedRange): string {
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
 * Ranges that are still relevant (end today or later), sorted by start date.
 * `todayIso` defaults to today's date (YYYY-MM-DD) and is injectable for tests.
 */
export function upcomingAwayRanges(
  ranges: BuddyBlockedRange[],
  todayIso: string = new Date().toISOString().slice(0, 10),
): BuddyBlockedRange[] {
  return ranges
    .filter(r => r.endDate >= todayIso)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}
