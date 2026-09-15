/**
 * AirportProfileService
 *
 * Resolves airport records by IATA code, GPS proximity, or city name.
 * Tries the DB first; falls back to the static airport dataset when the DB
 * table is empty or unavailable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { safeOrIlikeValue } from "../../lib/postgrestFilter.js";

const logger = rootLogger.child({ service: "AirportProfileService" });

/**
 * The static dataset is a REAL answer — the airport, its city and its timezone
 * are correct — but it carries the GENERIC buffer defaults and `verified:
 * false`, never the admin-configured buffers of the DB row. So a resolution
 * that fell back because the table was UNREADABLE (rather than because the row
 * genuinely is not there) is a silent downgrade of the numbers every
 * hard-return time is later computed from. supabase-js resolves on a database
 * error, so the four resolvers below could not see the difference at all.
 * They can now, and they say so. Behaviour is deliberately UNCHANGED — the
 * static answer stays, because it is honest and the caller is mid-search — but
 * it is no longer invisible, and `verified: false` on the result is what stops
 * the downgrade from posing as a curated profile.
 */
function noteFallback(where: string, error: unknown): void {
  logger.warn({ err: error, where }, "airport_profiles unreadable — answering from the static dataset with DEFAULT buffers");
}
import {
  searchStaticAirports,
  resolveStaticByIata,
  resolveStaticByCity,
  resolveStaticByGps,
  type StaticAirport,
} from "./StaticAirportData.js";

export interface AirportProfile {
  id: string | null;
  iataCode: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  timezone: string;
  lat: number;
  lng: number;
  domesticBufferMin: number;
  domesticBufferMax: number;
  internationalBufferMin: number;
  internationalBufferMax: number;
  immigrationExtraMin: number;
  checkedBagsExtraMin: number;
  trafficExtraMin: number;
  verified: boolean;
  /**
   * Spec §15 "terminal/gate context is pinned" at CONNECTION_AT_RISK (census
   * L143, scored NOT-BUILT for "no gate data"). `airport_profiles.terminal_info`
   * is a JSONB column that has existed since 0127:27 and was never read into
   * the profile, so no surface could pin anything even where a curator had
   * filled it in.
   *
   * NULL when there is nothing to pin — and an EMPTY OBJECT NORMALISES TO NULL,
   * because `terminal_info` defaults to `'{}'` and every one of the 3,206
   * production rows carries that default (measured 2026-09-07: 0 rows with
   * terminal_info). Returning `{}` would let a client render an empty
   * "terminal information" panel that looks like data and is not.
   *
   * OPTIONAL, and the reason is an ownership boundary, not a design choice:
   * `routes/airport.ts:151-172` builds an `AirportProfile` by hand from the
   * same row instead of calling `airportRowToProfile` below, and that file
   * belongs to another lane. A required field would break its build. The
   * wiring that closes the gap is one line there — see `airportRowToProfile`.
   */
  terminalInfo?: Record<string, unknown> | null;
}

/** Convert a static airport record to an AirportProfile with fallback buffer values. */
function staticToProfile(s: StaticAirport): AirportProfile {
  return {
    id: null,
    iataCode:               s.iataCode,
    name:                   s.name,
    city:                   s.city,
    country:                s.country,
    countryCode:            s.countryCode,
    timezone:               s.timezone,
    lat:                    s.lat,
    lng:                    s.lng,
    domesticBufferMin:      60,
    domesticBufferMax:      90,
    internationalBufferMin: 120,
    internationalBufferMax: 180,
    immigrationExtraMin:    30,
    checkedBagsExtraMin:    15,
    trafficExtraMin:        20,
    verified:               false,
    // The static dataset carries no terminal or gate detail at all.
    terminalInfo:           null,
  };
}

const FALLBACK_PROFILE: Omit<AirportProfile, "id" | "iataCode" | "name" | "city" | "country" | "countryCode" | "lat" | "lng"> = {
  timezone: "UTC",
  domesticBufferMin: 60,
  domesticBufferMax: 90,
  internationalBufferMin: 120,
  internationalBufferMax: 180,
  immigrationExtraMin: 30,
  checkedBagsExtraMin: 15,
  trafficExtraMin: 20,
  verified: false,
  terminalInfo: null,
};

/**
 * The ONE mapping from an `airport_profiles` row to a profile.
 *
 * Exported because `routes/airport.ts:151-172` currently repeats it by hand,
 * which is how `terminal_info` came to be selected by `select("*")` on both
 * paths and read by neither. Callers should use this.
 */
export function airportRowToProfile(row: any): AirportProfile {
  return rowToProfile(row);
}

function rowToProfile(row: any): AirportProfile {
  return {
    id:                     row.id,
    iataCode:               row.iata_code,
    name:                   row.name,
    city:                   row.city,
    country:                row.country,
    countryCode:            row.country_code,
    timezone:               row.timezone ?? "UTC",
    lat:                    Number(row.lat),
    lng:                    Number(row.lng),
    domesticBufferMin:      row.domestic_buffer_min     ?? 60,
    domesticBufferMax:      row.domestic_buffer_max     ?? 90,
    internationalBufferMin: row.international_buffer_min ?? 120,
    internationalBufferMax: row.international_buffer_max ?? 180,
    immigrationExtraMin:    row.immigration_extra_min    ?? 30,
    checkedBagsExtraMin:    row.checked_bags_extra_min   ?? 15,
    trafficExtraMin:        row.traffic_extra_min         ?? 20,
    verified:               Boolean(row.verified),
    terminalInfo:           normaliseTerminalInfo(row.terminal_info),
  };
}

/** `{}` and every non-object are NOTHING TO PIN. See AirportProfile.terminalInfo. */
function normaliseTerminalInfo(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return Object.keys(obj).length > 0 ? obj : null;
}

/**
 * ── census L294/C2 — WHY THESE FOUR LOOKUPS RETURN A RECORD ─────────────────
 *
 * Each of the four resolvers below used to answer `AirportProfile | null`, and
 * on an unreadable `airport_profiles` each logged (`noteFallback`) and then
 * answered from the STATIC dataset — whose every buffer is a generic constant
 * (60 / 120 / 30 / 15 / 20). That answer is byte-identical to the honest one
 * for an airport this product has simply never curated, which is the §22 L0
 * tier and a DESIGNED state. So "the database is down" and "we do not know this
 * airport" were the same value, exactly as "the write was refused" and "there
 * is no such session" were the same value before §19.
 *
 * It is worse here than a lost log line, because `POST /airport/sessions` takes
 * this profile and — when it carries no id — `upsertAirportProfile` WRITES the
 * generic defaults into `airport_profiles` and links the session to that row.
 * `routes/airport.ts` already states the harm on the one branch that was
 * guarded: *"EVERY later hard-return time for it is computed from the generic
 * buffer defaults — permanently, long after the database recovers. The
 * transient failure would have been baked into the row."* That guard was on the
 * `airportId` branch and on neither of the other two.
 *
 * The `resolveBy*` / `searchAirports` names keep their exact old signatures —
 * `src/test/airport.test.ts` binds them and belongs to another lane — and are
 * one-line projections of the records below. Nothing about their behaviour
 * moves; what is new is that a caller may now ASK.
 */
export interface AirportLookup {
  airport: AirportProfile | null;
  /** TRUE only when `airport_profiles` could not be READ. Not "not found". */
  degraded: boolean;
  /** Named so a route can disclose it. Empty unless `degraded`. */
  degradedReasons: string[];
  /** TRUE when the answer came from the static dataset rather than the table. */
  fromStatic: boolean;
}

export interface AirportLookupList {
  airports: AirportProfile[];
  degraded: boolean;
  degradedReasons: string[];
  fromStatic: boolean;
}

const AIRPORT_PROFILES_UNREADABLE = "airport_profiles_unreadable";

function degradedReasonsFor(unreadable: boolean): string[] {
  return unreadable ? [AIRPORT_PROFILES_UNREADABLE] : [];
}

/** Resolve by IATA code (e.g. "TPE", "NRT"). Case-insensitive. */
export async function lookupByIata(
  db: SupabaseClient,
  iataCode: string,
): Promise<AirportLookup> {
  let unreadable = false;
  try {
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .ilike("iata_code", iataCode.trim())
      .maybeSingle();
    if (error) { noteFallback("resolveByIata", error); unreadable = true; }
    if (data) return { airport: rowToProfile(data), degraded: false, degradedReasons: [], fromStatic: false };
  } catch (err) {
    // NOT dead code the way a supabase-js catch is: `.ilike` on a malformed
    // code and `rowToProfile` on a malformed row both throw synchronously.
    noteFallback("resolveByIata", err);
    unreadable = true;
  }
  // Static fallback
  const s = resolveStaticByIata(iataCode);
  return {
    airport: s ? staticToProfile(s) : null,
    degraded: unreadable,
    degradedReasons: degradedReasonsFor(unreadable),
    fromStatic: true,
  };
}

export async function resolveByIata(
  db: SupabaseClient,
  iataCode: string,
): Promise<AirportProfile | null> {
  return (await lookupByIata(db, iataCode)).airport;
}

/** Resolve by nearest GPS coordinate within maxDistanceKm. */
export async function lookupByGps(
  db: SupabaseClient,
  lat: number,
  lng: number,
  maxDistanceKm = 50,
): Promise<AirportLookup> {
  let unreadable = false;
  try {
    const delta = maxDistanceKm / 111; // rough degree equivalent
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .gte("lat", lat - delta)
      .lte("lat", lat + delta)
      .gte("lng", lng - delta)
      .lte("lng", lng + delta)
      .limit(20);

    if (error) { noteFallback("resolveByGps", error); unreadable = true; }
    if (data && data.length > 0) {
      // Find closest DB row
      let closest: any = null;
      let closestDist = Infinity;
      for (const row of data) {
        const dLat = Number(row.lat) - lat;
        const dLng = Number(row.lng) - lng;
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);
        if (dist < closestDist) {
          closestDist = dist;
          closest = row;
        }
      }
      if (closest) {
        return { airport: rowToProfile(closest), degraded: false, degradedReasons: [], fromStatic: false };
      }
    }
  } catch (err) {
    noteFallback("resolveByGps", err);
    unreadable = true;
  }
  const s = resolveStaticByGps(lat, lng);
  return {
    airport: s ? staticToProfile(s) : null,
    degraded: unreadable,
    degradedReasons: degradedReasonsFor(unreadable),
    fromStatic: true,
  };
}

export async function resolveByGps(
  db: SupabaseClient,
  lat: number,
  lng: number,
  maxDistanceKm = 50,
): Promise<AirportProfile | null> {
  return (await lookupByGps(db, lat, lng, maxDistanceKm)).airport;
}

/** Resolve by city name search. Returns the first match. */
export async function lookupByCity(
  db: SupabaseClient,
  city: string,
): Promise<AirportLookup> {
  let unreadable = false;
  try {
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .ilike("city", `%${city.trim()}%`)
      .limit(1)
      .maybeSingle();
    if (error) { noteFallback("resolveByCity", error); unreadable = true; }
    if (data) return { airport: rowToProfile(data), degraded: false, degradedReasons: [], fromStatic: false };
  } catch (err) {
    noteFallback("resolveByCity", err);
    unreadable = true;
  }
  // Static fallback
  const s = resolveStaticByCity(city);
  return {
    airport: s ? staticToProfile(s) : null,
    degraded: unreadable,
    degradedReasons: degradedReasonsFor(unreadable),
    fromStatic: true,
  };
}

export async function resolveByCity(
  db: SupabaseClient,
  city: string,
): Promise<AirportProfile | null> {
  return (await lookupByCity(db, city)).airport;
}

/** Search airports by query (IATA, city, name). Returns up to 10 results. */
export async function lookupAirports(
  db: SupabaseClient,
  query: string,
): Promise<AirportLookupList> {
  const q = query.trim();
  if (!q) return { airports: [], degraded: false, degradedReasons: [], fromStatic: false };
  // The .or() argument is a filter EXPRESSION: an unescaped `,` in `q` ends the
  // current predicate and starts a caller-chosen one, and a bare `%` turns the
  // prefix search into a full scan. `q` arrives from a z.string().max(100) with
  // no character constraint, so it must be sanitised here rather than trusted.
  // The static fallback below keeps using the raw `q` — it is an in-memory
  // string match with no filter grammar to break out of.
  const qSafe = safeOrIlikeValue(q);
  let unreadable = false;
  try {
    const { data, error } = await db
      .from("airport_profiles")
      .select("*")
      .or(`iata_code.ilike.${qSafe}%,city.ilike.%${qSafe}%,name.ilike.%${qSafe}%`)
      .order("verified", { ascending: false })
      .limit(10);
    if (error) { noteFallback("searchAirports", error); unreadable = true; }
    // If DB has results, use them
    if (data && data.length > 0) {
      return { airports: data.map(rowToProfile), degraded: false, degradedReasons: [], fromStatic: false };
    }
  } catch (err) {
    noteFallback("searchAirports", err);
    unreadable = true;
  }
  // Static fallback — always available even with empty DB
  return {
    airports: searchStaticAirports(q, 10).map(staticToProfile),
    degraded: unreadable,
    degradedReasons: degradedReasonsFor(unreadable),
    fromStatic: true,
  };
}

export async function searchAirports(
  db: SupabaseClient,
  query: string,
): Promise<AirportProfile[]> {
  return (await lookupAirports(db, query)).airports;
}

/** Build a minimal fallback profile when the airport is not in the DB. */
export function buildFallbackProfile(opts: {
  iataCode: string;
  name?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
}): AirportProfile {
  return {
    id: null,
    iataCode:    opts.iataCode.toUpperCase(),
    name:        opts.name        ?? `${opts.iataCode.toUpperCase()} Airport`,
    city:        opts.city        ?? "Unknown",
    country:     opts.country     ?? "Unknown",
    countryCode: opts.countryCode ?? "XX",
    lat:         opts.lat         ?? 0,
    lng:         opts.lng         ?? 0,
    ...FALLBACK_PROFILE,
  };
}

/** Admin: upsert airport profile. */
export async function upsertAirportProfile(
  db: SupabaseClient,
  adminId: string,
  data: Partial<AirportProfile> & { iataCode: string; name: string; city: string; country: string; countryCode: string; lat: number; lng: number },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const record = {
      iata_code:               data.iataCode.toUpperCase(),
      name:                    data.name,
      city:                    data.city,
      country:                 data.country,
      country_code:            data.countryCode,
      timezone:                data.timezone                  ?? "UTC",
      lat:                     data.lat,
      lng:                     data.lng,
      domestic_buffer_min:     data.domesticBufferMin         ?? 60,
      domestic_buffer_max:     data.domesticBufferMax         ?? 90,
      international_buffer_min: data.internationalBufferMin   ?? 120,
      international_buffer_max: data.internationalBufferMax   ?? 180,
      immigration_extra_min:   data.immigrationExtraMin       ?? 30,
      checked_bags_extra_min:  data.checkedBagsExtraMin       ?? 15,
      traffic_extra_min:       data.trafficExtraMin           ?? 20,
      verified:                data.verified                  ?? false,
      created_by:              adminId,
      updated_at:              new Date().toISOString(),
    };
    const { data: row, error } = await db
      .from("airport_profiles")
      .upsert(record, { onConflict: "iata_code" })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: (row as any)?.id };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "unknown error" };
  }
}
