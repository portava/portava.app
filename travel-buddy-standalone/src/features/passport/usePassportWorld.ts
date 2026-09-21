/**
 * usePassportWorld — data hook for the standalone My World Passport surface.
 *
 * Reuses the existing privacy-safe passport map payload
 * (`GET /me/passport/map` via `getPassportMap()`), which the server already
 * aggregates to CITY level and — by invariant — never returns exact lat/lng
 * (see api-server services/passport/PassportMapService.ts). This hook does not
 * invent a new endpoint and does not merge with the live Map truth model
 * (spec §26): it only re-shapes the server's payload into the
 * WORLD → Country → City → Trip → Places → Memories / Stamps hierarchy §26 names.
 *
 * THE DEEPER THREE LEVELS ARE THE SERVER'S, NOT THIS HOOK'S. Trip, Places and
 * Memories arrive already grouped and already privacy-filtered on the marker
 * (`PassportMapMarker.trips`); this file carries them through and derives only
 * counts. Nothing here decides what a viewer may see, and nothing here has a
 * coordinate to leak — the payload has none by server invariant.
 *
 * `buildWorld` is a pure function exported for direct unit/component testing.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getPassportMap,
  type PassportMapPayload,
  type PassportWorldTrip,
  type PassportWorldPlace,
  type PassportWorldMemory,
} from '../../services/passportStamps.ts';

/** §26 level 4 — one Trip inside a city, as the server grouped it. */
export type WorldTrip = PassportWorldTrip;
/** §26 level 5 — a named place inside a Trip. */
export type WorldPlace = PassportWorldPlace;
/** §26 level 6 — a Memory filed under a Trip. */
export type WorldMemory = PassportWorldMemory;

/** A single city aggregate (one server marker), rooted under its country. */
export interface WorldCity {
  /** Stable list key: `${countryKey}|${city}`. */
  key: string;
  city: string;
  /** Raw country from the marker ('' when the server had none). */
  country: string;
  /** Coarse neighbourhood/zone label — never coordinates (§23). */
  neighborhood: string | null;
  stampCount: number;
  verificationLevel: string;
  /** Coarse "City, Country" label produced by the server. */
  displayLabel: string;
  /**
   * §26 levels 4-6, straight from the server. Empty when the server sent none
   * (an older build, or a viewer permitted nothing deeper) — in which case the
   * hierarchy stops at City exactly as it used to.
   */
  trips: WorldTrip[];
  /** Distinct places named across this city's Trips. */
  placeCount: number;
  /** Memories filed under this city's Trips. */
  memoryCount: number;
}

/** A country group with its visited cities. */
export interface WorldCountry {
  /** Stable list key (the raw country, or `__unmapped__`). */
  key: string;
  /** Display name — the raw country, or a fallback for blank-country markers. */
  country: string;
  /** False when the underlying markers had no country name. */
  isNamed: boolean;
  cities: WorldCity[];
  cityCount: number;
  stampCount: number;
  /** Distinct Trips (never the untripped bucket) across this country's cities. */
  tripCount: number;
}

/** The full My World model derived from the passport map payload. */
export interface PassportWorld {
  countries: WorldCountry[];
  /** Distinct countries visited (server-canonical when available). */
  totalCountries: number;
  /** Distinct cities visited (server-canonical when available). */
  totalCities: number;
  /** Total stamps rooted to a place across the whole world. */
  totalStamps: number;
  /** Distinct Trips across the whole world (§26 level 4). */
  totalTrips: number;
  isEmpty: boolean;
}

/** Label for markers the server could not attribute to a named country. */
export const UNMAPPED_COUNTRY_LABEL = 'Unmapped region';

/**
 * Re-shape the flat, privacy-safe marker list into the
 * WORLD → Country → City hierarchy. Pure — no I/O, safe to unit-test.
 */
export function buildWorld(
  payload: PassportMapPayload | null | undefined,
): PassportWorld {
  const markers = payload?.markers ?? [];
  const byCountry = new Map<string, WorldCountry>();
  // Trip ids are counted DISTINCTLY: one Trip that touched three cities is one
  // journey, not three, at both the country and the world level.
  const tripKeys = new Set<string>();
  const countryTrips = new Set<string>();

  for (const m of markers) {
    if (!m || !m.city) continue;
    const rawCountry = (m.country ?? '').trim();
    const groupKey = rawCountry || '__unmapped__';

    let group = byCountry.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        country: rawCountry || UNMAPPED_COUNTRY_LABEL,
        isNamed: rawCountry.length > 0,
        cities: [],
        cityCount: 0,
        stampCount: 0,
        tripCount: 0,
      };
      byCountry.set(groupKey, group);
    }

    const stampCount = Number.isFinite(m.stampCount) ? m.stampCount : 0;
    // §26 levels 4-6 arrive already grouped and already filtered. An absent
    // `trips` field is an older payload, not an empty city — either way the
    // deeper sections simply do not render.
    const trips = Array.isArray(m.trips) ? m.trips : [];
    const placeKeys = new Set<string>();
    let memoryCount = 0;
    for (const tr of trips) {
      for (const p of tr?.places ?? []) if (p?.key) placeKeys.add(p.key);
      memoryCount += (tr?.memories ?? []).length;
      // The untripped bucket is a holder for what has no Trip; it is not one.
      if (tr?.tripId) tripKeys.add(tr.tripId);
    }
    group.cities.push({
      key: `${groupKey}|${m.city}`,
      city: m.city,
      country: rawCountry,
      neighborhood: m.neighborhood ?? null,
      stampCount,
      verificationLevel: m.verificationLevel ?? 'unverified',
      displayLabel: m.displayLabel ?? m.city,
      trips,
      placeCount: placeKeys.size,
      memoryCount,
    });
    group.stampCount += stampCount;
    for (const tr of trips) if (tr?.tripId) countryTrips.add(`${groupKey}|${tr.tripId}`);
  }

  const countries = [...byCountry.values()].map((g) => {
    // Most-stamped cities first, then alphabetical for stable ordering.
    g.cities.sort(
      (a, b) => b.stampCount - a.stampCount || a.city.localeCompare(b.city),
    );
    g.cityCount = g.cities.length;
    g.tripCount = [...countryTrips].filter((k) => k.startsWith(`${g.key}|`)).length;
    return g;
  });

  // Named countries first (alphabetical); the unmapped bucket sinks to the end.
  countries.sort((a, b) => {
    if (a.isNamed !== b.isNamed) return a.isNamed ? -1 : 1;
    return a.country.localeCompare(b.country);
  });

  const namedCount = countries.filter((c) => c.isNamed).length;
  const totalCountries = payload?.countries?.length ?? namedCount;
  const totalCities = payload?.cities?.length ?? markers.length;
  const totalStamps = markers.reduce(
    (sum, m) => sum + (Number.isFinite(m?.stampCount) ? m.stampCount : 0),
    0,
  );

  return {
    countries,
    totalCountries,
    totalCities,
    totalStamps,
    totalTrips: tripKeys.size,
    isEmpty: markers.length === 0,
  };
}

export interface UsePassportWorldResult {
  world: PassportWorld | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Fetches the passport map payload and exposes it as the My World hierarchy.
 * Fails soft: on error `world` is null and `error` carries a message the
 * screen can surface with a retry affordance.
 */
export function usePassportWorld(): UsePassportWorldResult {
  const [world, setWorld] = useState<PassportWorld | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getPassportMap();
    if (res.ok) {
      setWorld(buildWorld(res.data));
    } else {
      setError(res.message ?? 'Could not load your world');
      setWorld(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { world, loading, error, reload: load };
}
