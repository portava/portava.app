/**
 * Pure utility functions for trip plan data — no React Native deps, fully testable.
 */
import type { TripPlanItem } from '../types/models.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DayBucket {
  key: string;       // ISO date "YYYY-MM-DD" | "__unscheduled__"
  items: TripPlanItem[];
}

// ── Day chip label ────────────────────────────────────────────────────────────

export function dayChipLabel(
  key: string,
  tripStartDate: string | null | undefined,
  now: Date = new Date(),
): string {
  if (key === '__unscheduled__') return 'Unscheduled';
  const d = new Date(key + 'T00:00:00');
  if (isNaN(d.getTime())) return key;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const ms = d.getTime();
  if (ms === today.getTime()) return 'Today';
  if (ms === tomorrow.getTime()) return 'Tomorrow';
  if (tripStartDate) {
    const start = new Date(tripStartDate + 'T00:00:00');
    if (!isNaN(start.getTime())) {
      const dayNum = Math.round((ms - start.getTime()) / 86_400_000) + 1;
      if (dayNum >= 1) return `Day ${dayNum}`;
    }
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Day bucket builder ────────────────────────────────────────────────────────

export function buildBuckets(
  items: TripPlanItem[],
  _tripStartDate: string | null | undefined,
  _tripEndDate: string | null | undefined,
): DayBucket[] {
  const byDay: Map<string, TripPlanItem[]> = new Map();
  const unscheduled: TripPlanItem[] = [];

  for (const item of items) {
    if (item.dayDate) {
      if (!byDay.has(item.dayDate)) byDay.set(item.dayDate, []);
      byDay.get(item.dayDate)!.push(item);
    } else {
      unscheduled.push(item);
    }
  }

  const sorted = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, dayItems]) => ({ key, items: dayItems }));

  if (unscheduled.length > 0) {
    sorted.push({ key: '__unscheduled__', items: unscheduled });
  }

  return sorted;
}

// ── Active day filter ─────────────────────────────────────────────────────────

export function filterByDay(items: TripPlanItem[], activeDay: string): TripPlanItem[] {
  if (activeDay === 'all') return items;
  if (activeDay === '__unscheduled__') return items.filter((i) => !i.dayDate);
  return items.filter((i) => i.dayDate === activeDay);
}
