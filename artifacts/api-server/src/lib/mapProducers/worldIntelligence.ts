/**
 * worldIntelligence — the shared contract for Map spec §36 Phase 7.
 *
 * Phase 7 is four producers (World Pulse, the traveler-flow graph, the city
 * model and the viewer's own city model) that share one flag, one k floor and
 * one rule about how a cohort may be published. Those three things live here so
 * no producer can quietly hold a different opinion about any of them.
 *
 * PURE. No I/O, no clock, no privacy decision of its own — it declares the
 * vocabulary the four producers apply.
 *
 * ── THE ONE FLAG (migration 2295) ────────────────────────────────────────────
 * All four capabilities ride one switch because they are one capability: World
 * Pulse without the city model is a heat cell you cannot interrogate, and the
 * flow graph is the movement half of the same world view. Four switches would
 * invite the half-enabled state where a viewer is shown an aggregate they have
 * no way to open.
 *
 * ── THE K FLOOR IS BORROWED, NEVER CHOSEN ────────────────────────────────────
 * `WORLD_INTELLIGENCE_K` is `mapAggregation.MIN_ZONE_COHORT`, which is
 * `PRIVACY_THRESHOLD_V1.minUniqueActors`. Deriving it means Phase 7 can never
 * become the loosest publisher in the codebase, and a tightening of the product
 * threshold reaches these four producers without anyone remembering to come
 * here. `resolveWorldIntelligenceK` may only ever TIGHTEN, for the same reason
 * `resolveCohortFloor` may: a stage that runs after Privacy / Eligibility must
 * not be able to relax it.
 *
 * ── A COHORT IS PUBLISHED AS A BUCKET, NEVER AS A NUMBER ─────────────────────
 * §36 Phase 7's brief says the flow graph's counts are "bucketed, never exact",
 * and the same reasoning applies to every Phase 7 aggregate: at world and city
 * scale an exact headcount is simultaneously useless to a reader and a
 * fingerprint that changes by one when one person does.
 *
 * The bucket vocabulary is NOT a new one. It is `ActivityLevel` — §7's own
 * activity ladder — banded by `mapAggregation.activityForCohort`, whose steps
 * are MULTIPLES OF THE K FLOOR rather than absolute headcounts. Reusing it buys
 * three things a bespoke ladder would not:
 *
 *   1. The buckets move with k automatically. A raised threshold re-bands every
 *      Phase 7 aggregate; it cannot leave a stale ladder behind.
 *   2. The client already has the vocabulary and the labels
 *      (types/mapObjects.ACTIVITY_LEVELS / ACTIVITY_LABELS), so nothing new
 *      crosses the wire and the drift test already covers it.
 *   3. The coarsest bucket a publishable cohort can land in is `quiet` (a
 *      cohort that only just cleared k), which is the honest reading — not
 *      `very_quiet`, which the ladder reserves for a cohort that never gets
 *      published at all.
 *
 * `bucketCohort` refuses (returns null) below k rather than returning the
 * bottom rung, so a caller cannot accidentally publish a sub-k cohort as
 * "very quiet".
 */
import {
  MIN_ZONE_COHORT,
  activityForCohort,
  type ZoomBand,
} from "../mapAggregation.js";
import { meetsKAnonymity } from "../kAnonymity.js";
import type { ActivityLevel, MapObjectKind } from "../mapObjects.js";

/** Migration 2295. CAPABILITY convention (`*_enabled`), seeded OFF. */
export const WORLD_INTELLIGENCE_FLAG = "map_world_intelligence_enabled";

/** The four §18 kinds Phase 7 introduced. Used by the route and by the guards. */
export const WORLD_INTELLIGENCE_KINDS: readonly MapObjectKind[] = [
  "world_pulse",
  "traveler_flow",
  "city_model",
  "personal_city",
];

/**
 * The §17 bands Phase 7 renders in. `world` and `city` are exactly the two
 * bands `mapAggregation.AGGREGATING_BANDS` names, and that is not a
 * coincidence: Phase 7 summarizes the aggregation's own output, so it can only
 * exist where the aggregation runs.
 */
export const WORLD_INTELLIGENCE_BANDS: readonly ZoomBand[] = ["world", "city"];

export function bandCarriesWorldIntelligence(band: ZoomBand): boolean {
  return WORLD_INTELLIGENCE_BANDS.includes(band);
}

/** The k floor. Borrowed from the map's own, which borrows the product's own. */
export const WORLD_INTELLIGENCE_K: number = MIN_ZONE_COHORT;

/**
 * Resolve the k to enforce. An override may only TIGHTEN. An invalid override
 * returns NaN, which `meetsKAnonymity` fail-closes on — so a caller that passes
 * junk suppresses everything rather than publishing at an unknown floor.
 */
export function resolveWorldIntelligenceK(k?: number | null): number {
  if (k == null) return WORLD_INTELLIGENCE_K;
  if (!Number.isFinite(k) || k < 1) return Number.NaN;
  return Math.max(WORLD_INTELLIGENCE_K, k);
}

/**
 * The bucket a cohort is published as, or NULL when it may not be published.
 *
 * Null is returned for a sub-k cohort AND for an unusable one, and the caller
 * must render both the same way it renders "there was nobody here" — that
 * indistinguishability is the property that stops suppression from becoming a
 * signal in its own right. See `worldPulseProducer`'s test, which asserts a
 * cell built over k-1 contributors serializes identically to one built over
 * none at all.
 */
export function bucketCohort(cohort: number, k: number = WORLD_INTELLIGENCE_K): ActivityLevel | null {
  if (!Number.isFinite(cohort) || cohort < 0) return null;
  if (!meetsKAnonymity(cohort, k)) return null;
  return activityForCohort(cohort, k);
}

/**
 * Why a Phase 7 producer declined. Every producer returns one of these instead
 * of an empty result, so "nothing here" is never confused with "we could not
 * look" — the same discipline `CrowdFlowReport.refusal` established.
 */
export type WorldIntelligenceRefusal =
  | "flag_off"
  | "band_not_eligible"
  | "no_city_model"
  | "read_failed"
  | "no_service_client"
  | "no_viewer";

/** A producer result. `ok: false` always names a refusal. */
export type WorldIntelligenceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: WorldIntelligenceRefusal };
