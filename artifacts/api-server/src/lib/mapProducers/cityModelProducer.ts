/**
 * cityModelProducer — the `city_model` kind (Map spec §36 Phase 7).
 *
 * "A per-city aggregate profile (activity rhythm by time band, top zones)."
 *
 * ── IT CONSUMES A PUBLISHED AGGREGATE; IT DOES NOT BUILD ONE ─────────────────
 * `compass_city_models` already exists (migration
 * 20260730_compass_intelligence_graph) and is already a per-city aggregate:
 * `CompassGraphEngine.buildCityWorldModels` folds the intelligence graph's
 * city→time-slice edges into `time_slices`, `top_categories`, `monthly` and
 * `sample_size`. Phase 7 READS that and projects it onto the map. Building a
 * second city model here would have meant a second aggregation, a second k
 * decision and a second thing to keep honest.
 *
 * ── EVERY SLICE IS INDEPENDENTLY k-GATED, AT THE MAP'S FLOOR, NOT COMPASS'S ──
 * `TimeSliceProfile.count` sums `observed_count` over graph edges whose dedup
 * key contains NO user id, so N observations can all be ONE person — the exact
 * leak lib/compassRhythmGate (IG-07) was written to close. The trustworthy
 * number is `distinctActors`, which the graph build records per slice, and this
 * producer gates on THAT and never on `count`.
 *
 * The floor it gates at is `WORLD_INTELLIGENCE_K` — `PRIVACY_THRESHOLD_V1`'s 15
 * — which is STRICTLY TIGHTER than Compass's own `COMPASS_RHYTHM_K` of 5. That
 * direction is deliberate and is the only one allowed: the map is a public
 * geographic surface and may be more conservative than the text line Compass
 * writes into a private feed, never less. A slice whose distinct-actor count is
 * absent counts as 0 and is suppressed, so a model built before the graph
 * recorded actor counts publishes NO rhythm at all rather than an unguarded one.
 *
 * A city with no publishable slice still publishes its object when it has
 * something else to say (top categories, top zones); `rhythm` is simply an
 * empty array. That keeps "this city has a thin rhythm" and "this city has a
 * rhythm we are withholding" the same observable state, which is the same
 * indistinguishability rule worldPulseProducer states at length.
 *
 * ── TOP ZONES COME FROM THE REQUEST'S OWN ALREADY-GATED OUTPUT ───────────────
 * There is no per-zone distinct-actor aggregate in this repository, and
 * deriving one would mean reading presence — the one thing §36 Phase 7's brief
 * forbids. So `topZones` is built from the `activity_zone` objects THIS REQUEST
 * already produced, each of which cleared `summarizeCell`'s cohort floor before
 * it existed. Their cohorts are re-published as BUCKETS, never as the counts
 * the zone objects carry, and a zone is attributed to a city only when its
 * centroid falls inside that city's own geometry. When the request produced no
 * activity zones (district zoom and below do not aggregate), `topZones` is
 * empty — which is the honest answer, not a gap.
 *
 * ── §37 ──────────────────────────────────────────────────────────────────────
 * A city model is a HISTORICAL profile: "Fridays are busy in the evening" is a
 * statement about what was observed, not a forecast that this Friday will be.
 * `basis` says `observed_history` on every object, `city_model` is not a
 * FORECAST_KIND, and nothing here projects a slice forward into a prediction.
 * The moment someone wants "this Friday will be busy", that is a `prediction`
 * object built by the §15 temporal path, not a field added here.
 */
import {
  bboxContains,
  cohortWeightOf,
  type BBox,
} from "../mapAggregation.js";
import {
  CONFIDENCE_STATES,
  KIND_DEFAULT_PRIORITY,
  centroidOf,
  point,
  type ActivityLevel,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import { canonicalCityKey } from "../canonicalLocations.js";
import { isFlagEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";
import {
  WORLD_INTELLIGENCE_FLAG,
  bucketCohort,
  resolveWorldIntelligenceK,
  type WorldIntelligenceRefusal,
} from "./worldIntelligence.js";

/** A city profile describes a population, never a person. */
export const CITY_MODEL_PRIVACY_CLASS: PrivacyClass = "aggregate_only";

/** Time bands, in `CompassGraphEngine.DAYPARTS` order. */
export const CITY_MODEL_DAYPARTS = ["morning", "afternoon", "evening", "night"] as const;
export type CityModelDaypart = (typeof CITY_MODEL_DAYPARTS)[number];

/** Days, in `CompassGraphEngine`'s `DOW_KEYS` order. */
export const CITY_MODEL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type CityModelDay = (typeof CITY_MODEL_DAYS)[number];

/** How many rhythm slices and zones one city object may carry. Bounded output. */
export const MAX_RHYTHM_SLICES = 8;
export const MAX_TOP_ZONES = 3;
export const MAX_TOP_CATEGORIES = 5;

/** Cities read per request. Bounded; the cap is reported. */
export const MAX_CITY_MODEL_ROWS = 200;

/** One publishable time band. Carries a BUCKET, never a headcount. */
export interface CityRhythmSlice {
  day: CityModelDay;
  band: CityModelDaypart;
  /** §7's activity ladder, banded on multiples of k. */
  activityBucket: ActivityLevel;
}

/** One of the city's busiest already-published zones. */
export interface CityTopZone {
  /** The activity_zone object's own id. Not a place, not a person. */
  zoneId: string;
  title: string;
  activityBucket: ActivityLevel;
}

export interface CityModelPayload {
  /** §37: measured history, never a forecast. Always the literal below. */
  basis: "observed_history";
  cityKey: string;
  cityLabel: string;
  /** Publishable time bands only. Empty when none cleared the floor. */
  rhythm: CityRhythmSlice[];
  /** From the already-aggregated model. Categories are not people. */
  topCategories: string[];
  /** From THIS request's own already-k-gated activity zones. */
  topZones: CityTopZone[];
  /** When the underlying aggregate was last rebuilt. */
  builtAt: string | null;
}

/** The `compass_city_models` columns this producer reads. */
export interface CityModelRowLike {
  city: string;
  time_slices?: unknown;
  top_categories?: unknown;
  built_at?: string | null;
}

/** One city's geography, supplied by the caller. Never derived here. */
export interface CityGeography {
  /** geo_zones.id — the map identity of the city. */
  id: string;
  /** Public display name. */
  label: string;
  /** `canonicalCityKey(label)` — the join key into compass_city_models. */
  cityKey: string;
  centroid: { lat: number; lng: number };
  /** Does a point sit inside this city? Injected: geometry is the caller's model. */
  contains: (lat: number, lng: number) => boolean;
}

export interface CityModelReport {
  /** Cities the caller offered inside the viewport. */
  cities: number;
  capped: boolean;
  /** City rows read from the published aggregate. */
  modelsRead: number;
  published: number;
  /**
   * Rhythm slices withheld for failing the k floor. A COUNT, never which slice:
   * "Friday evening was withheld" would describe the shape of a small cohort.
   */
  slicesWithheld: number;
  slicesPublished: number;
}

export interface DeriveCityModelsOptions {
  bbox: BBox;
  /** Cohort floor override. May only TIGHTEN. */
  k?: number;
}

export interface DeriveCityModelsResult {
  models: MapObject<CityModelPayload>[];
  report: CityModelReport;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function isDay(v: string): v is CityModelDay {
  return (CITY_MODEL_DAYS as readonly string[]).includes(v);
}
function isBand(v: string): v is CityModelDaypart {
  return (CITY_MODEL_DAYPARTS as readonly string[]).includes(v);
}

/** Rank for deterministic ordering: day order, then band order. */
function sliceRank(s: CityRhythmSlice): number {
  return CITY_MODEL_DAYS.indexOf(s.day) * CITY_MODEL_DAYPARTS.length +
    CITY_MODEL_DAYPARTS.indexOf(s.band);
}

/**
 * Project published city aggregates onto the map. PURE.
 *
 * `activityZones` are the `activity_zone` objects this request already
 * produced; each has cleared `summarizeCell`'s floor. Their cohorts are
 * re-published as buckets only.
 */
export function deriveCityModels(
  rows: readonly CityModelRowLike[],
  cities: readonly CityGeography[],
  activityZones: readonly MapObject[],
  opts: DeriveCityModelsOptions,
): DeriveCityModelsResult {
  const report: CityModelReport = {
    cities: Array.isArray(cities) ? cities.length : 0,
    capped: false,
    modelsRead: Array.isArray(rows) ? rows.length : 0,
    published: 0,
    slicesWithheld: 0,
    slicesPublished: 0,
  };
  const models: MapObject<CityModelPayload>[] = [];
  if (!Array.isArray(cities) || cities.length === 0) return { models, report };

  const k = resolveWorldIntelligenceK(opts?.k);

  const byKey = new Map<string, CityModelRowLike>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.city !== "string" || r.city === "") continue;
    byKey.set(r.city, r);
  }

  // Attribute each already-gated zone to at most one city, by containment. A
  // zone in no city belongs to no city model — never to the nearest one.
  const zonesByCity = new Map<string, CityTopZone[]>();
  for (const zone of Array.isArray(activityZones) ? activityZones : []) {
    if (!zone || zone.kind !== "activity_zone") continue;
    const c = centroidOf(zone.geometry);
    if (!c) continue;
    const weight = cohortWeightOf(zone);
    // A zone with an unusable cohort is dropped, not published at an unknown
    // size. `bucketCohort` refuses below k, so a zone that somehow escaped
    // summarizeCell's floor cannot be re-published here either.
    if (weight == null) continue;
    const bucket = bucketCohort(weight, k);
    if (bucket === null) continue;
    for (const city of cities) {
      if (!city?.contains) continue;
      let inside = false;
      try {
        inside = city.contains(c.lat, c.lng) === true;
      } catch {
        inside = false;
      }
      if (!inside) continue;
      const list = zonesByCity.get(city.id) ?? [];
      list.push({
        zoneId: zone.id,
        title: typeof zone.title === "string" ? zone.title : "Activity zone",
        activityBucket: bucket,
      });
      zonesByCity.set(city.id, list);
      break;
    }
  }

  // Deterministic: cities in id order, so paging is stable across requests.
  const ordered = [...cities]
    .filter((c) => c && typeof c.id === "string" && c.id !== "")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const city of ordered) {
    const { lat, lng } = city.centroid ?? ({} as { lat?: number; lng?: number });
    if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (!bboxContains(opts?.bbox, lat, lng)) continue;

    const row = byKey.get(city.cityKey);

    // ── Rhythm: one slice per publishable time band ─────────────────────────
    const rhythm: CityRhythmSlice[] = [];
    const slices = row?.time_slices;
    if (slices && typeof slices === "object" && !Array.isArray(slices)) {
      for (const [sliceKey, raw] of Object.entries(slices as Record<string, unknown>)) {
        const parts = String(sliceKey).split(":");
        if (parts.length !== 2) continue;
        const [day, band] = parts;
        if (!isDay(day) || !isBand(band)) continue;
        const profile = raw as { distinctActors?: unknown } | null | undefined;
        // `count` is DELIBERATELY not read: it can be one person N times. Only
        // the distinct-actor count may decide whether a slice publishes.
        const actorsRaw = profile && typeof profile === "object" ? profile.distinctActors : undefined;
        const actors = finite(actorsRaw) ? actorsRaw : 0;
        const bucket = bucketCohort(actors, k);
        if (bucket === null) {
          report.slicesWithheld += 1;
          continue;
        }
        rhythm.push({ day, band, activityBucket: bucket });
      }
    }
    rhythm.sort((a, b) => sliceRank(a) - sliceRank(b));
    const publishedRhythm = rhythm.slice(0, MAX_RHYTHM_SLICES);
    report.slicesPublished += publishedRhythm.length;

    // ── Top categories: from the published aggregate. Not people. ───────────
    const topCategories = Array.isArray(row?.top_categories)
      ? (row!.top_categories as unknown[])
          .filter((c): c is string => typeof c === "string" && c.trim() !== "")
          .slice(0, MAX_TOP_CATEGORIES)
      : [];

    // ── Top zones: this request's own already-gated activity zones ──────────
    const topZones = (zonesByCity.get(city.id) ?? [])
      .sort((a, b) =>
        a.activityBucket === b.activityBucket
          ? a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0
          : bucketRank(b.activityBucket) - bucketRank(a.activityBucket),
      )
      .slice(0, MAX_TOP_ZONES);

    // A city with nothing to say is not published. Suppression here is not a
    // privacy decision — it is "we know nothing about this city" — and it looks
    // identical to the privacy-driven case by construction, because a withheld
    // rhythm leaves `rhythm` empty exactly as an absent one does.
    if (publishedRhythm.length === 0 && topCategories.length === 0 && topZones.length === 0) {
      continue;
    }

    models.push({
      id: `citymodel:${city.id}`,
      kind: "city_model",
      geometry: point(lat, lng),
      title: city.label,
      subtitle: describe(publishedRhythm, topZones),
      privacyClass: CITY_MODEL_PRIVACY_CLASS,
      renderingPriority: KIND_DEFAULT_PRIORITY.city_model,
      // No freshness and no confidence: a city model is a HISTORICAL profile,
      // not a claim about current conditions, and stamping it `live` would be
      // exactly the §37 failure ("Do not let stale claims remain visually
      // live") with the words the other way round.
      interaction: { actions: ["ask_compass", "view"], opensSheet: true },
      provenance: {
        lines: [{ text: "Built from this city's aggregated activity history" }],
        confidence: CONFIDENCE_STATES[0],
      },
      payload: {
        basis: "observed_history",
        cityKey: city.cityKey,
        cityLabel: city.label,
        rhythm: publishedRhythm,
        topCategories,
        topZones,
        builtAt: typeof row?.built_at === "string" ? row.built_at : null,
      },
    });
    report.published += 1;
  }

  return { models, report };
}

const BUCKET_ORDER: readonly ActivityLevel[] = [
  "very_quiet", "quiet", "moderate", "busy", "very_busy", "peak",
];
function bucketRank(b: ActivityLevel): number {
  const i = BUCKET_ORDER.indexOf(b);
  return i < 0 ? 0 : i;
}

function describe(rhythm: readonly CityRhythmSlice[], zones: readonly CityTopZone[]): string {
  const parts: string[] = [];
  if (rhythm.length > 0) parts.push(`${rhythm.length} active time band${rhythm.length === 1 ? "" : "s"}`);
  if (zones.length > 0) parts.push(`${zones.length} busy area${zones.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "City profile";
}

// ── The ONE I/O function ─────────────────────────────────────────────────────

export interface ReadCityModelsOptions {
  bbox: BBox;
  /** The viewport's cities, built by the caller from its own zone model. */
  cities: readonly CityGeography[];
  /** This request's already-k-gated activity zones. */
  activityZones: readonly MapObject[];
  k?: number;
}

export type CityModelReadResult =
  | { ok: true; models: MapObject<CityModelPayload>[]; report: CityModelReport }
  | { ok: false; reason: WorldIntelligenceRefusal };

/**
 * Read the published per-city aggregates for the viewport's cities.
 *
 * Fail-closed: flag off, no city model or a read failure all return a refusal
 * and no objects. A read failure is NOT an empty city profile.
 */
export async function readCityModels(
  sc: any,
  opts: ReadCityModelsOptions,
): Promise<CityModelReadResult> {
  if (!sc) return { ok: false, reason: "no_service_client" };
  // A LITERAL, not the constant — see travelerFlowProducer's note on
  // check:flag-polarity. The pin at the bottom of this file stops them drifting.
  if (!(await isFlagEnabled(sc, "map_world_intelligence_enabled"))) {
    return { ok: false, reason: "flag_off" };
  }
  const cities = Array.isArray(opts?.cities) ? opts.cities : [];
  if (cities.length === 0) return { ok: false, reason: "no_city_model" };

  const capped = cities.slice(0, MAX_CITY_MODEL_ROWS);
  const keys = [...new Set(capped.map((c) => c.cityKey).filter((k) => typeof k === "string" && k !== ""))];

  let rows: CityModelRowLike[] = [];
  if (keys.length > 0) {
    const { data, error } = await sc
      .from("compass_city_models")
      .select("city, time_slices, top_categories, built_at")
      .in("city", keys);
    if (error || !Array.isArray(data)) {
      logger.warn({ err: error }, "cityModelProducer: compass_city_models read failed");
      return { ok: false, reason: "read_failed" };
    }
    rows = data as CityModelRowLike[];
  }

  const derived = deriveCityModels(rows, capped, opts.activityZones ?? [], {
    bbox: opts.bbox,
    k: opts.k,
  });
  derived.report.cities = cities.length;
  derived.report.capped = cities.length > MAX_CITY_MODEL_ROWS;
  return { ok: true, models: derived.models, report: derived.report };
}

/** The join key into `compass_city_models`, for a caller building CityGeography. */
export function cityJoinKey(label: unknown): string | null {
  return canonicalCityKey(label);
}

/** Compile-time pin for the flag literal above. See travelerFlowProducer. */
const WORLD_INTELLIGENCE_FLAG_PIN: "map_world_intelligence_enabled" = WORLD_INTELLIGENCE_FLAG;
void WORLD_INTELLIGENCE_FLAG_PIN;
