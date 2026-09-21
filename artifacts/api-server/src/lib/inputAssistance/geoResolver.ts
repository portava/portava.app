/**
 * Geographic entity resolution behind the Global Input Intelligence gateway
 * (Phase 2 — Geographic Core, spec §10/§11/§12/§14/§17/§19/§53).
 *
 * This is the "resolve WELL" layer: it turns typed text into CANONICAL cities
 * (diacritic/stroke/alias-aware, via lib/canonicalLocations.suggestCanonical-
 * LocationsFolded), attaches the §17/§53 canonical binding on selection
 * (city_id + country + coordinates + timezone), surfaces progressive
 * disambiguation for airport codes and same-name-different-place ambiguity
 * (§19) instead of a silent guess, and serves zero-character defaults (§14)
 * from the viewer's own current city + upcoming/active Trips.
 *
 * It REUSES and does not reimplement:
 *   - lib/canonicalLocations (searchKey / alias dictionary / folded resolver),
 *   - the curated airport dataset (services/airport/StaticAirportData),
 *   - the offline coordinate→IANA timezone lookup (tz-lookup) already depended
 *     on by CompassGraphEngine.
 *
 * DELIBERATELY DEFERRED (later phases): semantic NL parsing (§18, Phase 6),
 * live-intel geographic freshness (Phase 9), and the incremental 25-surface
 * client migration. Phase 2 is correct geographic resolution + canonical
 * binding through the gateway.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import tzLookup from 'tz-lookup';
import {
  suggestCanonicalLocationsFolded,
  rowSearchKey,
  resolveGeoAlias,
  searchKey,
  type CanonicalRow,
} from '../canonicalLocations';
import { resolveStaticByIata, type StaticAirport } from '../../services/airport/StaticAirportData';

// ── §17/§53 canonical binding ─────────────────────────────────────────────────
//
// The structured value stored when a user SELECTS a city. Dependent fields
// (country / coordinates / timezone) prefill from this. Every field stays
// visible + editable client-side (§17 — no invisible field mutation).

export interface CanonicalCityBinding {
  entityType: 'city';
  /** canonical_locations uuid — the CITY id-space (never a venue/place id). */
  cityId: string;
  city: string;
  country: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  /** IANA zone derived from the canonical centroid (tz-lookup). Null if unknown. */
  timezone: string | null;
}

/**
 * Offline coordinate → IANA timezone. tz-lookup throws on out-of-range or
 * missing coordinates; we degrade to null rather than fabricate a zone.
 */
export function timezoneForCoords(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

/** Build the §17/§53 binding for a canonical city row. */
export function cityBinding(row: CanonicalRow): CanonicalCityBinding {
  return {
    entityType: 'city',
    cityId: row.id,
    city: row.name || row.display_name,
    country: row.country ?? null,
    countryCode: row.country_code ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    timezone: timezoneForCoords(row.lat, row.lng),
  };
}

// ── §17 VENUE binding (G109) ──────────────────────────────────────────────────
//
// The spec's worked example for "selecting a structured field prefills
// dependents" runs from a VENUE: Sky36 → Da Nang → Vietnam → coordinates →
// Asia/Ho_Chi_Minh. The city binding above covers the case where the thing
// selected IS a city; this covers the case where it is a place inside one.
//
// THREE RULES, and each exists because its opposite would put a false value in
// a dependent field the user can see:
//
//  1. THE COORDINATES ARE THE VENUE'S, never the city's. A venue's position is
//     the more specific fact and the one a map pin needs; substituting the city
//     centroid would silently move the pin to the middle of town.
//  2. THE TIMEZONE IS DERIVED FROM THE VENUE'S OWN COORDINATES, through the
//     same `timezoneForCoords` the city binding uses, so the two paths cannot
//     disagree about the same point on the map.
//  3. COUNTRY IS NEVER INFERRED FROM THE CITY NAME. It comes from the linked
//     `canonical_locations` row or it stays null. "Springfield" names places in
//     dozens of countries, and a prefilled country the user did not choose is
//     worse than an empty one they will.

export interface CanonicalVenueBinding {
  entityType: 'venue';
  /** discovery_places uuid — the VENUE id-space (never a city id). */
  venueId: string;
  venue: string;
  /**
   * canonical_locations uuid for the venue's city, or null when the place
   * carries no canonical link (or carries one to something that is not a
   * city-class row — a landmark's parent is not a city).
   */
  cityId: string | null;
  /**
   * The city NAME may be known from the place row even when `cityId` is null:
   * `discovery_places.city` is free text and does not require a canonical link.
   * A name without an id is still useful to prefill and is honest about what it
   * is — which is why the two are separate fields rather than one.
   */
  city: string | null;
  country: string | null;
  countryCode: string | null;
  /** The VENUE's coordinates. See rule 1. */
  lat: number | null;
  lng: number | null;
  /** IANA zone derived from the VENUE's coordinates. See rule 2. */
  timezone: string | null;
}

/**
 * `canonical_locations.kind` values that denote a CITY for binding purposes.
 * `place`, `landmark` and `airport` are deliberately absent: a venue linked to
 * another venue does not thereby acquire a city, and claiming one would put a
 * landmark's name in a field labelled City.
 */
const CITY_KINDS: ReadonlySet<string> = new Set(['city', 'town', 'municipality']);

/**
 * Build the §17 binding for a place row and the canonical row it links to.
 *
 * `canonical` is the resolved `canonical_locations` row, or null when the place
 * has no link. It is NOT a way to say "the lookup failed" — a failed read must
 * suppress the binding at the call site rather than arrive here as null, or an
 * outage would render as "this venue is in no country".
 */
export function venueBinding(
  place: { id: string; name: string; city: string | null; lat: number | null; lng: number | null },
  canonical: CanonicalRow | null,
): CanonicalVenueBinding {
  const isCity = canonical != null && CITY_KINDS.has((canonical.kind ?? '').toLowerCase());
  return {
    entityType: 'venue',
    venueId: place.id,
    venue: place.name,
    cityId: isCity ? canonical!.id : null,
    city: (isCity ? canonical!.name || canonical!.display_name : null) ?? place.city ?? null,
    // Country comes off the canonical row whatever its kind — a landmark row
    // still knows which country it is in, and that is a fact about the venue's
    // location rather than a claim about its city.
    country: canonical?.country ?? null,
    countryCode: canonical?.country_code ?? null,
    lat: place.lat,
    lng: place.lng,
    timezone: timezoneForCoords(place.lat, place.lng),
  };
}

/** Binding derived from a curated airport row (the airport's CITY, not the airport). */
export function airportCityBinding(a: StaticAirport): CanonicalCityBinding {
  return {
    entityType: 'city',
    cityId: '', // no canonical_locations id yet — resolves to the city by name on select
    city: a.city,
    country: a.country ?? null,
    countryCode: a.countryCode ?? null,
    lat: a.lat ?? null,
    lng: a.lng ?? null,
    timezone: a.timezone ?? timezoneForCoords(a.lat, a.lng),
  };
}

// ── §12/§19 resolution result ─────────────────────────────────────────────────

export interface GeoResolution {
  /** Canonical city rows, prefix-first, deduped, city-class only. */
  rows: CanonicalRow[];
  /**
   * True when the input cannot be resolved to a single confident entity:
   *  - the query exactly matches ≥2 distinct canonical cities (Paris FR / Paris TX), OR
   *  - the query is a bare airport code (a code is not a city — offer the city).
   * When true the gateway surfaces ranked CHOICES (§19), never a silent pick.
   */
  ambiguous: boolean;
  /** Set when the input is a recognized IATA airport code (§12 airport/city ambiguity). */
  airport: StaticAirport | null;
}

const IATA_RE = /^[a-z]{3}$/i;

/**
 * Resolve typed text to canonical city candidates + an ambiguity verdict.
 * Pure w.r.t. side effects (read-only); fail-soft to an empty, unambiguous
 * result on any error.
 */
export async function resolveGeoCandidates(
  db: SupabaseClient,
  text: string,
  limit = 6,
): Promise<GeoResolution> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { rows: [], ambiguous: false, airport: null };

  // Airport code path (§12): a bare 3-letter IATA code is ambiguous by nature —
  // "DAD" is an airport, the user most likely means the city Da Nang, but we
  // must OFFER that, not silently swap it.
  const airport = IATA_RE.test(trimmed) ? resolveStaticByIata(trimmed) : null;

  const rows = await suggestCanonicalLocationsFolded(db, trimmed, limit).catch(() => [] as CanonicalRow[]);

  // Same-name-different-place ambiguity (§19): count DISTINCT canonical cities
  // whose folded key EXACTLY equals the resolved query key.
  const key = resolveGeoAlias(trimmed);
  const exact = rows.filter((r) => rowSearchKey(r) === key);
  const distinctExactPlaces = new Set(
    exact.map((r) => `${(r.country_code ?? r.country ?? '').toLowerCase()}|${r.region ?? ''}`),
  );
  const ambiguous = airport != null || distinctExactPlaces.size >= 2;

  return { rows, ambiguous, airport };
}

// ── §14 zero-character assistance ──────────────────────────────────────────────
//
// Served when the field is empty and the policy allows it: the viewer's current
// city (from a supplied city name / coordinates) and their active/upcoming Trip
// destinations (§53 "Current / Recent / Upcoming"). All sourced from the
// VIEWER'S OWN rows (filtered by user_id) — no cross-tenant exposure, so this
// path does not require the person-privacy gateway.

export type GeoDefaultKind = 'current' | 'upcoming_trip' | 'active_trip';

export interface GeoDefault {
  kind: GeoDefaultKind;
  label: string;
  subtitle: string | null;
  reason: string;
  /** Present when the default resolved to a canonical city (bindable on select). */
  binding: CanonicalCityBinding | null;
}

interface TripDestinationRow {
  destination_city: string | null;
  destination_country: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  status: string | null;
  start_date: string | null;
}

/**
 * Zero-character geographic defaults for the viewer. Bounded, read-only,
 * fail-soft (returns [] on any error). Order: current location, then
 * active Trips, then upcoming Trips (§53).
 */
export async function zeroCharGeoDefaults(
  db: SupabaseClient,
  opts: { userId: string; city: string | null; max?: number },
): Promise<GeoDefault[]> {
  const max = opts.max ?? 6;
  const out: GeoDefault[] = [];
  const seen = new Set<string>();

  const push = (d: GeoDefault) => {
    const k = searchKey(d.label);
    if (!k || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(d);
  };

  // 1. Current location (from a client-supplied city name; resolved to canonical
  //    when it exists so it prefills like any selection).
  if (opts.city && opts.city.trim()) {
    try {
      const canon = await suggestCanonicalLocationsFolded(db, opts.city, 1).catch(() => [] as CanonicalRow[]);
      const row = canon[0];
      push({
        kind: 'current',
        label: row ? row.name || row.display_name : opts.city.trim(),
        subtitle: (row?.country ?? null),
        reason: 'Current location',
        binding: row ? cityBinding(row) : null,
      });
    } catch {
      /* fail-soft */
    }
  }

  // 2. Active / upcoming Trip destinations (viewer's own).
  try {
    const { data: memberRows, error: memErr } = await db
      .from('trip_members')
      .select('trip_id, role')
      .eq('user_id', opts.userId)
      .neq('role', 'invited');
    if (!memErr && memberRows && memberRows.length > 0) {
      const tripIds = (memberRows as Array<{ trip_id: string }>).map((r) => r.trip_id);
      const { data: trips } = await db
        .from('trips')
        .select('destination_city, destination_country, destination_lat, destination_lng, status, start_date')
        .in('id', tripIds)
        .in('status', ['active', 'upcoming', 'planning'])
        .order('start_date', { ascending: true })
        .limit(20);
      for (const t of ((trips ?? []) as TripDestinationRow[])) {
        const city = (t.destination_city ?? '').trim();
        if (!city) continue;
        const isActive = t.status === 'active';
        const binding: CanonicalCityBinding = {
          entityType: 'city',
          cityId: '',
          city,
          country: t.destination_country ?? null,
          countryCode: null,
          lat: t.destination_lat ?? null,
          lng: t.destination_lng ?? null,
          timezone: timezoneForCoords(t.destination_lat, t.destination_lng),
        };
        push({
          kind: isActive ? 'active_trip' : 'upcoming_trip',
          label: city,
          subtitle: t.destination_country ?? null,
          reason: isActive ? 'Current Trip' : 'Upcoming Trip',
          binding,
        });
      }
    }
  } catch {
    /* fail-soft */
  }

  return out.slice(0, max);
}
