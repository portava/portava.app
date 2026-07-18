/**
 * Destination grouping utility — aggregates passport content by city.
 *
 * Grouping key: lowercase `city|country` (exact match, not accent-folded).
 * Sources: Memories (city/country), Postcards (locationCity/locationCountry),
 *          Trips (destinationCity/destinationCountry).
 * Stamps are surfaced in the detail view by matching stamp.label (city stamps only).
 */

import type { PassportMemory } from '../services/passportStamps.ts';
import type { PassportStamp, PassportPostcard } from '../types/models.ts';
import type { TripRow } from '../services/trips.ts';

export interface DestinationGroup {
  /** Lowercase grouping key: `city|country`. */
  key: string;
  /** Display-ready city name (preserves original casing). */
  city: string;
  country: string | null;
  memories: PassportMemory[];
  /** City-kind stamps whose label matches this destination. */
  stamps: PassportStamp[];
  postcards: PassportPostcard[];
  trips: TripRow[];
  /** ISO date of the most recent item across all content types. */
  mostRecentAt: string;
  /** Best available hero image URL (prefers postcard, then trip cover). */
  heroImageUrl: string | null;
  /** Total number of content items across all types. */
  totalCount: number;
}

function makeKey(city: string, country: string | null | undefined): string {
  return `${city.toLowerCase()}|${(country ?? '').toLowerCase()}`;
}

function mostRecentDate(dates: (string | null | undefined)[]): string {
  const valid = dates.filter(Boolean) as string[];
  if (!valid.length) return new Date(0).toISOString();
  return valid.slice().sort().reverse()[0];
}

/**
 * Aggregate passport content into per-destination groups, sorted by most
 * recent activity descending.
 *
 * Only destinations that have at least one piece of content are returned.
 * City stamps are matched to a destination by comparing the stamp label
 * (case-insensitive) against the destination city name.
 */
export function groupByDestination(
  memories: PassportMemory[],
  stamps: PassportStamp[],
  postcards: PassportPostcard[],
  trips: TripRow[],
): DestinationGroup[] {
  const map = new Map<string, DestinationGroup>();

  function getOrCreate(city: string, country: string | null | undefined): DestinationGroup {
    const key = makeKey(city, country ?? null);
    if (!map.has(key)) {
      map.set(key, {
        key,
        city,
        country: country ?? null,
        memories: [],
        stamps: [],
        postcards: [],
        trips: [],
        mostRecentAt: new Date(0).toISOString(),
        heroImageUrl: null,
        totalCount: 0,
      });
    }
    return map.get(key)!;
  }

  // --- Memories ---
  for (const m of memories) {
    if (!m.city) continue;
    getOrCreate(m.city, m.country).memories.push(m);
  }

  // --- Postcards ---
  for (const p of postcards) {
    if (!p.locationCity) continue;
    getOrCreate(p.locationCity, p.locationCountry).postcards.push(p);
  }

  // --- Trips ---
  for (const t of trips) {
    if (!t.destinationCity) continue;
    getOrCreate(t.destinationCity, t.destinationCountry).trips.push(t);
  }

  // --- Stamps (city-kind only, matched by label) ---
  const cityStamps = stamps.filter((s) => s.kind === 'city' && !s.locked);
  for (const s of cityStamps) {
    // Try to match stamp label to an existing destination (case-insensitive)
    for (const group of map.values()) {
      if (group.city.toLowerCase() === s.label.toLowerCase()) {
        group.stamps.push(s);
        break;
      }
    }
  }

  // --- Post-process: compute hero image, mostRecentAt, totalCount ---
  for (const g of map.values()) {
    // Hero image: prefer postcard with media, then trip cover
    const heroPostcard = g.postcards.find((p) => p.mediaUrl);
    const heroTrip = g.trips.find((t) => t.coverUrl);
    g.heroImageUrl = heroPostcard?.mediaUrl ?? heroTrip?.coverUrl ?? null;

    // Most recent activity date
    g.mostRecentAt = mostRecentDate([
      ...g.memories.map((m) => m.earnedAt),
      ...g.stamps.map((s) => s.earnedAt),
      ...g.postcards.map((p) => p.createdAt),
      ...g.trips.map((t) => t.startDate),
    ]);

    g.totalCount = g.memories.length + g.stamps.length + g.postcards.length + g.trips.length;
  }

  // Sort by most recent activity, newest first
  return Array.from(map.values()).sort(
    (a, b) => b.mostRecentAt.localeCompare(a.mostRecentAt),
  );
}

/**
 * Encode a destination key for use in a URL path segment.
 * Inverse: decodeDestinationKey.
 */
export function encodeDestinationKey(key: string): string {
  return encodeURIComponent(key);
}

export function decodeDestinationKey(encoded: string): string {
  return decodeURIComponent(encoded);
}
