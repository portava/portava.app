/**
 * resolveAvailabilityChip — pure helper for the Passport header availability chip.
 *
 * Returns null (no chip) when:
 *  - openToMeet is false
 *  - quickStatus is 'busy' (user explicitly set themselves busy)
 *  - all data is absent
 *
 * Secondary context priority:
 *  1. quickStatus (most specific / user-set)
 *  2. active trip window today (city-level only)
 *  3. homeCity (if showHomeCity is true and no trip active)
 */

import type { TripWindow } from '../types/models.ts';

export type QuickStatus = 'free_now' | 'free_tonight' | 'busy' | 'open_to_plans';

export interface AvailabilityChipState {
  primary: string;
  secondary?: string;
}

const QUICK_LABEL: Record<Exclude<QuickStatus, 'busy'>, string> = {
  free_now:      'Free now',
  free_tonight:  'Free tonight',
  open_to_plans: 'Open to plans',
};

function activeTripCity(trips: TripWindow[], nowISO: string): string | null {
  const now = new Date(nowISO).getTime();
  for (const trip of trips) {
    const start = new Date(trip.startDate).getTime();
    const end   = new Date(trip.endDate + 'T23:59:59').getTime();
    if (now >= start && now <= end) {
      // City-level context only — capitalise slug for display
      return trip.citySlug.charAt(0).toUpperCase() + trip.citySlug.slice(1).replace(/-/g, ' ');
    }
  }
  return null;
}

export interface ResolveAvailabilityChipOptions {
  openToMeet: boolean;
  quickStatus: QuickStatus | null | undefined;
  trips: TripWindow[];
  homeCity: string | null | undefined;
  /** When false, homeCity context is hidden (respects privacy settings). */
  showHomeCity: boolean;
  /** ISO date-time string for "now"; defaults to new Date().toISOString() */
  nowISO?: string;
}

export function resolveAvailabilityChip(opts: ResolveAvailabilityChipOptions): AvailabilityChipState | null {
  const { openToMeet, quickStatus, trips, homeCity, showHomeCity } = opts;

  if (!openToMeet) return null;
  // Busy status overrides the open-to-meet toggle — user is explicitly unavailable.
  if (quickStatus === 'busy') return null;

  const nowISO = opts.nowISO ?? new Date().toISOString();
  const primary = 'Open to meet';
  let secondary: string | undefined;

  // 1. Quick status (highest priority — user-set, ephemeral).
  //    'busy' is already handled above (returns null), so any remaining
  //    quickStatus value is safe to look up in QUICK_LABEL.
  if (quickStatus) {
    secondary = QUICK_LABEL[quickStatus as Exclude<QuickStatus, 'busy'>];
  }
  // 2. Active trip window (city-level only, never exact location)
  else {
    const tripCity = activeTripCity(trips, nowISO);
    if (tripCity) {
      secondary = `Traveling in ${tripCity}`;
    }
    // 3. Home city (only when privacy allows)
    else if (showHomeCity && homeCity) {
      secondary = `Local in ${homeCity}`;
    }
  }

  return secondary ? { primary, secondary } : { primary };
}
