/**
 * personalCityProducer — the `personal_city` kind (Map spec §36 Phase 7).
 *
 * "For the viewer only, their own city history summary (their own data only,
 * owner-scoped)."
 *
 * ── OWNER-SCOPED MEANS SESSION-SCOPED, AND THAT IS THE WHOLE SECURITY MODEL ──
 * `viewerId` is the SESSION identity that routes/mapProjection takes from
 * `requireUser`, never a query parameter — the 2182 lesson, which
 * lib/mapProducers/memoryProducer records in the same words. The read is
 * `.eq("user_id", viewerId)` and there is no other predicate that could widen
 * it, no join that could reach another user's row, and no code path that takes
 * an owner id from the request. `readPersonalCityPins` REFUSES on a missing or
 * empty viewer rather than reading unscoped.
 *
 * ── WHY THERE IS NO k FLOOR HERE, AND WHY THAT IS NOT AN EXEMPTION ───────────
 * k-anonymity protects a person from being identified inside an aggregate. This
 * object is not an aggregate over people: it is a summary over ONE person's own
 * rows, shown to that person. A k floor on it would be meaningless — the cohort
 * is one and is meant to be one — and imposing a fake one would suppress the
 * viewer's own history from the viewer.
 *
 * What replaces the floor is a HARDER guarantee: the object can never be about
 * anybody else, because the only rows it can see belong to the session. It is
 * stamped `place_level` (a city the viewer has been to, shown to the viewer),
 * it is in `NEVER_AGGREGATED_KINDS` so it can never contribute a body to a cell
 * that renders as public activity, and it carries no cohort, no count of other
 * people and no comparison against them.
 *
 * ── SOURCE ───────────────────────────────────────────────────────────────────
 * `passport_stamps` (0042 / 0102): the viewer's own awarded stamps, each
 * carrying `city`, `country` and `awarded_at`. It is the codebase's existing
 * record of "where this traveller has been" and it is already the viewer's own
 * by RLS. Nothing is widened: the service-role read restates the same
 * `user_id = viewer` predicate that RLS would apply through PostgREST.
 *
 * Stamp `visibility` is NOT consulted, deliberately. That column governs who
 * ELSE may see a stamp; this object is shown to the owner and to nobody else,
 * so filtering by it would hide the viewer's own history from the viewer for a
 * reason that does not apply. The object never crosses to another viewer, so
 * the column has no work to do here.
 *
 * ── §37 ──────────────────────────────────────────────────────────────────────
 * A personal city summary is a record of what happened. `basis` says
 * `observed_own_history`, `personal_city` is not a FORECAST_KIND, and nothing
 * here projects a next visit. "You will probably go back to Bangkok" would be a
 * `prediction`, built somewhere else, labelled as one.
 */
import { bboxContains, type BBox } from "../mapAggregation.js";
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import { canonicalCityKey } from "../canonicalLocations.js";
import { isFlagEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";
import {
  WORLD_INTELLIGENCE_FLAG,
  type WorldIntelligenceRefusal,
} from "./worldIntelligence.js";
import type { CityGeography } from "./cityModelProducer.js";

/**
 * A city the viewer has been to, shown to the viewer. `place_level` is the same
 * rung `saved_place` and `memory` carry for the same reason: it is the viewer's
 * own relationship to public geography, not anybody's position.
 */
export const PERSONAL_CITY_PRIVACY_CLASS: PrivacyClass = "place_level";

/** Bounded: the stamp read is capped and the cap is reported. */
export const MAX_PERSONAL_STAMP_ROWS = 1000;

/** Cities one response may summarize. Bounded output. */
export const MAX_PERSONAL_CITIES = 100;

/** The `passport_stamps` columns this producer reads. */
export interface PassportStampRowLike {
  id: string;
  city?: string | null;
  country?: string | null;
  awarded_at?: string | null;
  stamp_type?: string | null;
}

export interface PersonalCityPayload {
  /** §37: the viewer's own past, never a projection of their future. */
  basis: "observed_own_history";
  cityKey: string;
  cityLabel: string;
  country: string | null;
  /**
   * How many of the VIEWER'S OWN stamps this city holds. An exact number is
   * correct here and only here: it is a count of the reader's own rows, so
   * there is no cohort to protect and rounding it would just make the reader's
   * own history wrong.
   */
  stampCount: number;
  /** ISO instants, from the viewer's own rows. */
  firstVisitAt: string | null;
  lastVisitAt: string | null;
}

export interface PersonalCityReport {
  /** Stamp rows read (capped). */
  stamps: number;
  capped: boolean;
  /** Stamps whose city could not be canonicalized. */
  unresolvedCity: number;
  /** Stamps whose city has no geography in the caller's model. */
  unplaced: number;
  published: number;
}

export interface DerivePersonalCitiesOptions {
  bbox: BBox;
}

export interface DerivePersonalCitiesResult {
  pins: MapObject<PersonalCityPayload>[];
  report: PersonalCityReport;
}

interface CityAccumulator {
  city: CityGeography;
  country: string | null;
  stamps: number;
  firstMs: number | null;
  lastMs: number | null;
}

function toMs(t: string | null | undefined): number | null {
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Fold the VIEWER'S OWN stamps into one summary per city. PURE.
 *
 * `cities` is the caller's geography model, keyed by `cityKey`; a stamp whose
 * city is not in it is DROPPED and counted, never placed at a guessed point.
 */
export function derivePersonalCities(
  stamps: readonly PassportStampRowLike[],
  cities: readonly CityGeography[],
  opts: DerivePersonalCitiesOptions,
): DerivePersonalCitiesResult {
  const report: PersonalCityReport = {
    stamps: Array.isArray(stamps) ? stamps.length : 0,
    capped: false,
    unresolvedCity: 0,
    unplaced: 0,
    published: 0,
  };
  const pins: MapObject<PersonalCityPayload>[] = [];
  if (!Array.isArray(stamps) || stamps.length === 0) return { pins, report };

  const byKey = new Map<string, CityGeography>();
  for (const c of Array.isArray(cities) ? cities : []) {
    if (c && typeof c.cityKey === "string" && c.cityKey !== "" && !byKey.has(c.cityKey)) {
      byKey.set(c.cityKey, c);
    }
  }

  const acc = new Map<string, CityAccumulator>();
  for (const row of stamps) {
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    const key = canonicalCityKey(row.city);
    if (!key) {
      report.unresolvedCity += 1;
      continue;
    }
    const city = byKey.get(key);
    if (!city) {
      report.unplaced += 1;
      continue;
    }
    let entry = acc.get(key);
    if (!entry) {
      entry = { city, country: null, stamps: 0, firstMs: null, lastMs: null };
      acc.set(key, entry);
    }
    entry.stamps += 1;
    if (entry.country === null && typeof row.country === "string" && row.country.trim() !== "") {
      entry.country = row.country.trim();
    }
    const ms = toMs(row.awarded_at ?? null);
    if (ms !== null) {
      if (entry.firstMs === null || ms < entry.firstMs) entry.firstMs = ms;
      if (entry.lastMs === null || ms > entry.lastMs) entry.lastMs = ms;
    }
  }

  // Deterministic: city key order, so paging is stable across requests.
  for (const key of [...acc.keys()].sort().slice(0, MAX_PERSONAL_CITIES)) {
    const e = acc.get(key) as CityAccumulator;
    const { lat, lng } = e.city.centroid ?? ({} as { lat?: number; lng?: number });
    if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      report.unplaced += e.stamps;
      continue;
    }
    if (!bboxContains(opts?.bbox, lat, lng)) continue;

    pins.push({
      id: `mycity:${e.city.id}`,
      kind: "personal_city",
      geometry: point(lat, lng),
      title: e.city.label,
      subtitle: `${e.stamps} stamp${e.stamps === 1 ? "" : "s"} — your history here`,
      privacyClass: PERSONAL_CITY_PRIVACY_CLASS,
      renderingPriority: KIND_DEFAULT_PRIORITY.personal_city,
      // No freshness, no confidence, no activity: this is a record of the
      // viewer's own past, not a claim about the city's current state. Giving
      // it a live band would be inventing a live condition (§37).
      interaction: { actions: ["view", "add_to_trip", "ask_compass"], opensSheet: true },
      payload: {
        basis: "observed_own_history",
        cityKey: key,
        cityLabel: e.city.label,
        country: e.country,
        stampCount: e.stamps,
        firstVisitAt: e.firstMs === null ? null : new Date(e.firstMs).toISOString(),
        lastVisitAt: e.lastMs === null ? null : new Date(e.lastMs).toISOString(),
      },
    });
    report.published += 1;
  }

  return { pins, report };
}

// ── The ONE I/O function ─────────────────────────────────────────────────────

export interface ReadPersonalCitiesOptions {
  bbox: BBox;
  /** The viewport's cities, built by the caller from its own zone model. */
  cities: readonly CityGeography[];
}

export type PersonalCityReadResult =
  | { ok: true; pins: MapObject<PersonalCityPayload>[]; report: PersonalCityReport }
  | { ok: false; reason: WorldIntelligenceRefusal };

/**
 * Read the VIEWER'S OWN city history. The ONE privacy-complete personal-city
 * read for the map; routes/mapProjection.ts is its only approved caller
 * (src/test/gatewayBypassGuard.test.ts).
 *
 * `viewerId` MUST be the session identity. A missing or empty one is a refusal,
 * never an unscoped read.
 */
export async function readPersonalCityPins(
  sc: any,
  viewerId: string,
  opts: ReadPersonalCitiesOptions,
): Promise<PersonalCityReadResult> {
  if (!sc) return { ok: false, reason: "no_service_client" };
  if (typeof viewerId !== "string" || viewerId === "") return { ok: false, reason: "no_viewer" };
  // A LITERAL, not the constant — see travelerFlowProducer's note on
  // check:flag-polarity. The pin at the bottom of this file stops them drifting.
  if (!(await isFlagEnabled(sc, "map_world_intelligence_enabled"))) {
    return { ok: false, reason: "flag_off" };
  }
  const cities = Array.isArray(opts?.cities) ? opts.cities : [];
  if (cities.length === 0) return { ok: false, reason: "no_city_model" };

  const { data, error } = await sc
    .from("passport_stamps")
    .select("id, city, country, awarded_at, stamp_type")
    .eq("user_id", viewerId)
    .order("awarded_at", { ascending: false })
    .limit(MAX_PERSONAL_STAMP_ROWS);
  if (error || !Array.isArray(data)) {
    logger.warn({ err: error }, "personalCityProducer: passport_stamps read failed");
    return { ok: false, reason: "read_failed" };
  }

  const rows = data as PassportStampRowLike[];
  const derived = derivePersonalCities(rows, cities, { bbox: opts.bbox });
  derived.report.capped = rows.length >= MAX_PERSONAL_STAMP_ROWS;
  return { ok: true, pins: derived.pins, report: derived.report };
}

/** Compile-time pin for the flag literal above. See travelerFlowProducer. */
const WORLD_INTELLIGENCE_FLAG_PIN: "map_world_intelligence_enabled" = WORLD_INTELLIGENCE_FLAG;
void WORLD_INTELLIGENCE_FLAG_PIN;
