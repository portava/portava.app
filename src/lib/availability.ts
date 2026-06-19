/**
 * Availability resolver — pure & deterministic.
 *
 * Priority: trip-specific window overrides recurring weekly for that
 * destination + date range. If neither applies, we do NOT assume the user is
 * available — we return 'not_set' / 'open_to_meet' and let the UI avoid
 * over-filtering. No scoring, no guessing.
 */
import type {
  Availability,
  AvailabilityStatus,
  TimeBlock,
  Weekday,
  CityEvent,
  TripWindow,
} from '../types/models';

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function weekdayOf(iso: string): Weekday {
  return WEEKDAYS[new Date(iso).getDay()];
}

function withinTrip(trip: TripWindow, citySlug: string, iso: string): boolean {
  if (trip.citySlug !== citySlug) return false;
  const d = new Date(iso).getTime();
  return d >= new Date(trip.startDate).getTime() && d <= new Date(trip.endDate + 'T23:59:59').getTime();
}

/**
 * Is a given event inside the user's availability?
 * Returns:
 *  - true  : explicitly inside a trip window or weekly block
 *  - false : explicitly outside a window that DOES cover this city/date
 *  - null  : no relevant window set -> "unknown", don't penalize
 */
export function isWithinAvailability(av: Availability | null, ev: CityEvent): boolean | null {
  if (!av) return null;

  // 1. Trip-specific window for this city/date overrides everything.
  const trip = av.trips.find((t) => withinTrip(t, ev.citySlug, ev.startAt));
  if (trip) return trip.blocks.includes(ev.block);

  // 2. Recurring weekly.
  if (av.weekly) {
    const wd = weekdayOf(ev.startAt);
    const blocks = av.weekly.days[wd];
    if (blocks && blocks.length) return blocks.includes(ev.block);
  }

  // 3. Nothing relevant set -> unknown.
  return null;
}

/** Friendly status label for the Availability card. Honest about "not set". */
export function resolveStatus(av: Availability | null, nowISO: string, citySlug?: string): AvailabilityStatus {
  if (!av) return 'not_set';

  if (citySlug) {
    const trip = av.trips.find((t) => withinTrip(t, citySlug, nowISO));
    if (trip) return 'trip_active';
  }

  const block = blockOf(nowISO);
  if (av.weekly) {
    const wd = weekdayOf(nowISO);
    const blocks = av.weekly.days[wd];
    if (blocks?.includes(block)) {
      return block === 'evening' || block === 'late' ? 'open_tonight' : 'usually_free';
    }
    if (Object.keys(av.weekly.days).length > 0) return 'flexible_week';
  }

  if (av.openToMeet) return 'open_to_meet';
  return 'not_set';
}

export function blockOf(iso: string): TimeBlock {
  const h = new Date(iso).getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'late';
}

export const STATUS_LABEL: Record<AvailabilityStatus, string> = {
  open_tonight: 'Open tonight',
  usually_free: 'Usually free now',
  flexible_week: 'Flexible this week',
  trip_active: 'Trip window active',
  not_available: 'Not available',
  open_to_meet: 'Open to meet',
  not_set: 'Availability not set',
};
