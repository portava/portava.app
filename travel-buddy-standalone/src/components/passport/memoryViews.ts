/**
 * memoryViews — pure grouping for the §15 Memories views.
 *
 * §15: "Memories are travel-contextual, not a generic media grid. Views: Trips,
 * Places, People, Timeline and Map."
 *
 * WHAT THIS MODULE COVERS, AND THE ONE IT DOES NOT.
 * ================================================
 * Timeline already shipped and lives in `src/lib/memoryTimeline.ts`; this module
 * adds **Trips**, **Places** and **Map**. It does NOT add **People**, and that
 * omission is deliberate rather than unfinished: `PassportMemory` carries no
 * participant field at all (see `src/services/passportStamps.ts`), and the
 * memory-participant visibility contract that would give it one is owned by the
 * Highlights/Memories lane under `artifacts/api-server/src/services/memory/`.
 * A People view built here would have to invent that contract. Four of §15's
 * five views is therefore the ceiling for this lane, and four of five does not
 * close the requirement.
 *
 * Every export is pure and deterministic — no `Date.now()`, no
 * `toLocaleString` — so each view is unit-testable without rendering.
 *
 * ORDERING, stated once because all three views share it: sections are ordered
 * by their most recent memory, newest first, and memories inside a section are
 * ordered newest first, matching the Timeline view. The "leftover" buckets
 * (untripped, unplaced) always sort LAST regardless of recency, because they
 * are a residue rather than a destination.
 */
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { TripRow } from '../../services/trips.ts';
import { memoryTimestamp } from '../../lib/memoryTimeline.ts';
import { getCityCentroid } from '../../lib/cityCentroids.ts';

/** Section key for memories that belong to no Trip. */
export const UNTRIPPED_KEY = '__untripped__';
/** Section key for memories that carry no city. */
export const UNPLACED_KEY = '__unplaced__';

export interface MemoryViewSection {
  /** Stable key — a trip id, a `city|country` key, or one of the bucket keys above. */
  key: string;
  /** Primary display label. */
  label: string;
  /** Secondary display label (country, trip dates); null when there is none. */
  sublabel: string | null;
  /** Memories in the section, newest first. */
  memories: PassportMemory[];
}

/**
 * NFC-normalised lowercase `city|country`.
 *
 * This MATCHES the grouping key used by the shared passport destination
 * grouping (`src/utils/destinationGrouping.ts`), deliberately, so that a city
 * reads the same way in the Memories "Places" view as it does in the
 * Destinations tab. It is restated here rather than imported because that file
 * belongs to another lane's surface and exports no key helper; if it ever does,
 * this should collapse onto it.
 */
function placeKey(city: string, country: string | null | undefined): string {
  const normalise = (s: string) => s.normalize('NFC').toLowerCase();
  return `${normalise(city)}|${normalise(country ?? '')}`;
}

/** Newest-first by the memory timestamp; undated memories keep their input order at the end. */
function newestFirst(memories: PassportMemory[]): PassportMemory[] {
  return memories
    .map((m, i) => ({ m, i, t: memoryTimestamp(m) }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return b.t - a.t;
    })
    .map((e) => e.m);
}

/** The most recent timestamp in a set, or null when nothing in it is dated. */
function sectionRecency(memories: PassportMemory[]): number | null {
  let best: number | null = null;
  for (const m of memories) {
    const t = memoryTimestamp(m);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * Order sections newest-first, forcing the named leftover buckets to the end.
 * Undated sections sort after dated ones but before the leftover buckets.
 */
function orderSections(sections: MemoryViewSection[], leftoverKeys: string[]): MemoryViewSection[] {
  return sections
    .map((s, i) => ({ s, i, t: sectionRecency(s.memories), leftover: leftoverKeys.includes(s.key) }))
    .sort((a, b) => {
      if (a.leftover !== b.leftover) return a.leftover ? 1 : -1;
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return b.t - a.t;
    })
    .map((e) => e.s);
}

// ── Trips view ────────────────────────────────────────────────────────────────

/**
 * Group memories by the Trip they were earned on.
 *
 * `trips` is optional and supplies the human title; without it the sections
 * still form, labelled neutrally. Memories with `tripId: null` go to an
 * explicit untripped bucket that is RENDERED rather than skipped — the same
 * convention the server already uses for `PassportWorldTrip.tripId === null`,
 * so a view never appears to lose a memory.
 */
export function groupMemoriesByTrip(
  memories: PassportMemory[],
  trips: TripRow[] = [],
): MemoryViewSection[] {
  const titles = new Map<string, TripRow>();
  for (const t of trips) titles.set(t.id, t);

  const byKey = new Map<string, MemoryViewSection>();
  for (const m of memories) {
    const key = m.tripId ?? UNTRIPPED_KEY;
    let sec = byKey.get(key);
    if (!sec) {
      const row = m.tripId !== null ? titles.get(m.tripId) : undefined;
      sec = {
        key,
        label: key === UNTRIPPED_KEY ? 'Not on a trip' : (row?.title ?? 'Trip'),
        sublabel: row?.destinationCity ?? null,
        memories: [],
      };
      byKey.set(key, sec);
    }
    sec.memories.push(m);
  }

  for (const sec of byKey.values()) sec.memories = newestFirst(sec.memories);
  return orderSections(Array.from(byKey.values()), [UNTRIPPED_KEY]);
}

// ── Places view ───────────────────────────────────────────────────────────────

/**
 * Group memories by city (+country). Memories with no city go to an explicit
 * unplaced bucket, rendered last, for the same reason the untripped bucket is
 * rendered: the view must account for every memory it was given.
 */
export function groupMemoriesByPlace(memories: PassportMemory[]): MemoryViewSection[] {
  const byKey = new Map<string, MemoryViewSection>();
  for (const m of memories) {
    const key = m.city ? placeKey(m.city, m.country) : UNPLACED_KEY;
    let sec = byKey.get(key);
    if (!sec) {
      sec = {
        key,
        // First writer wins on display casing, matching the shared destination
        // grouping's "preserves original casing" behaviour.
        label: m.city ?? 'Place unknown',
        sublabel: m.city ? (m.country ?? null) : null,
        memories: [],
      };
      byKey.set(key, sec);
    }
    sec.memories.push(m);
  }

  for (const sec of byKey.values()) sec.memories = newestFirst(sec.memories);
  return orderSections(Array.from(byKey.values()), [UNPLACED_KEY]);
}

// ── Map view ──────────────────────────────────────────────────────────────────

export interface MemoryMapPin {
  /** `city|country` key, matching the Places view. */
  key: string;
  city: string;
  country: string | null;
  lat: number;
  lng: number;
  /** Memories at this pin, newest first. */
  memories: PassportMemory[];
}

export interface MemoryMapData {
  pins: MemoryMapPin[];
  /**
   * Memories that could NOT be placed on the map — no city, or a city with no
   * known coordinate. Returned rather than discarded so the surface can say how
   * many memories the map is not showing. A map that silently drops memories
   * misreports the size of the collection.
   */
  unplotted: PassportMemory[];
}

/**
 * Build map pins from memories, one per city.
 *
 * Coordinate source, in order of preference:
 *   1. the matching Trip's own `destinationLat`/`destinationLng`, when the
 *      memory is filed under a trip whose destination is that city — the most
 *      precise value the client already holds;
 *   2. the shared city centroid table (`src/lib/cityCentroids.ts`), the same
 *      table the map surfaces elsewhere seed their camera from.
 *
 * Coordinates are city-level only. Memories carry no precise coordinates and
 * this view does not invent any.
 */
export function buildMemoryMap(
  memories: PassportMemory[],
  trips: TripRow[] = [],
): MemoryMapData {
  // Trip destination coordinates, keyed the same way as the Places view.
  const tripCoord = new Map<string, [number, number]>();
  for (const t of trips) {
    if (t.destinationCity && typeof t.destinationLat === 'number' && typeof t.destinationLng === 'number') {
      tripCoord.set(placeKey(t.destinationCity, t.destinationCountry), [t.destinationLat, t.destinationLng]);
    }
  }

  const byKey = new Map<string, MemoryMapPin>();
  const unplotted: PassportMemory[] = [];

  for (const m of memories) {
    if (!m.city) {
      unplotted.push(m);
      continue;
    }
    const key = placeKey(m.city, m.country);
    const existing = byKey.get(key);
    if (existing) {
      existing.memories.push(m);
      continue;
    }
    const coord = tripCoord.get(key) ?? getCityCentroid(m.city);
    if (!coord) {
      unplotted.push(m);
      continue;
    }
    byKey.set(key, {
      key,
      city: m.city,
      country: m.country ?? null,
      lat: coord[0],
      lng: coord[1],
      memories: [m],
    });
  }

  const pins = Array.from(byKey.values()).map((p) => ({ ...p, memories: newestFirst(p.memories) }));
  // Busiest pin first, so the densest city is the one a reader reaches for.
  pins.sort((a, b) => b.memories.length - a.memories.length || a.key.localeCompare(b.key));
  return { pins, unplotted };
}
