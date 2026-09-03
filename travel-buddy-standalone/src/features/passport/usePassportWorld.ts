/**
 * usePassportWorld — data hook for the standalone My World Passport surface.
 *
 * Reuses the existing privacy-safe passport map payload
 * (`GET /me/passport/map` via `getPassportMap()`), which the server already
 * aggregates to CITY level and — by invariant — never returns exact lat/lng
 * (see api-server services/passport/PassportMapService.ts). This hook does not
 * invent a new endpoint and does not merge with the live Map truth model
 * (spec §26): it only re-shapes the flat marker list into the
 * WORLD → Country → City hierarchy My World renders.
 *
 * `buildWorld` is a pure function exported for direct unit/component testing.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getPassportMap,
  type PassportMapPayload,
} from '../../services/passportStamps.ts';

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
      };
      byCountry.set(groupKey, group);
    }

    const stampCount = Number.isFinite(m.stampCount) ? m.stampCount : 0;
    group.cities.push({
      key: `${groupKey}|${m.city}`,
      city: m.city,
      country: rawCountry,
      neighborhood: m.neighborhood ?? null,
      stampCount,
      verificationLevel: m.verificationLevel ?? 'unverified',
      displayLabel: m.displayLabel ?? m.city,
    });
    group.stampCount += stampCount;
  }

  const countries = [...byCountry.values()].map((g) => {
    // Most-stamped cities first, then alphabetical for stable ordering.
    g.cities.sort(
      (a, b) => b.stampCount - a.stampCount || a.city.localeCompare(b.city),
    );
    g.cityCount = g.cities.length;
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
