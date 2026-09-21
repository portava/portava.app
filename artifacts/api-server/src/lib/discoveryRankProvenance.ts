/**
 * discoveryRankProvenance — the five `06` §5 cache-metadata fields, as one
 * record that travels with a ranked Discovery page.
 *
 * WHAT THIS DISCHARGES
 * ====================
 * `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md` §7, "Cache B
 * problem":
 *
 *   "Caching final ranked order without feature vectors makes re-ranking,
 *    diagnostics, and counterfactual analysis impossible."
 *
 * and its allowed pattern, whose last line is *"always preserve recommendation
 * metadata and feature/version references."*
 * `docs/specs/discovery-v1/06_Recommendation_Engine.md` §5 names the five
 * fields that must be preserved: model_version, feature_version, candidate
 * source, recommendation reasons, ranking timestamp.
 * census-discovery DV-04 (1 of 5 before this module) and DSV2-06 — *"feature
 * and model provenance survives cache reuse."*
 *
 * WHAT IT IS NOT
 * ==============
 * Nothing here MEASURES anything. Every field is copied from something the
 * ranker already computed or the retrieval already knew:
 *
 *   modelVersion / featureVersion   constants below, versioning THIS pipeline
 *                                   shape. They change when the ranker or the
 *                                   feature set changes, which is what makes a
 *                                   cached page from an older shape
 *                                   identifiable rather than silently mixed in.
 *   candidateSource                 recorded AT RETRIEVAL — which read returned
 *                                   the row — never inferred afterwards from
 *                                   the id. An id shape is a guess; the
 *                                   retrieval that produced the row is a fact.
 *   reasons                         the Compass pipeline's own grounded
 *                                   `RankingFactor.key` list, strongest first.
 *                                   No vocabulary is invented here; see
 *                                   lib/discoveryReasonCodes.ts for the
 *                                   translation into `01` §11's codes.
 *   features / scores               `04` §13 — "raw vs derived features are
 *                                   separated" — implemented as two fields, not
 *                                   as a convention. `features` holds the RAW
 *                                   per-signal contributions the ranker
 *                                   computed for this row; `scores` holds what
 *                                   was DERIVED from them (the pipeline's
 *                                   final, match and community scores). Nothing
 *                                   derived is ever written into `features`,
 *                                   because a bag that mixes inputs with their
 *                                   own output cannot be re-scored against a
 *                                   new model — which is the whole reason `01`
 *                                   §7 says to keep the vector at all.
 *   rankedAt                        the clock at the moment the RANKER RAN.
 *                                   Deliberately NOT the cache entry's write
 *                                   clock, and deliberately not re-stamped on a
 *                                   replay: a cache hit reports when the rank
 *                                   happened, not when the cache was read.
 *                                   Reporting the read time would describe a
 *                                   ranking that never took place.
 *
 * NEVER PERSISTED BEYOND THE PROCESS CACHE
 * ========================================
 * Like the candidate projection, this is a property of a RANK, not of a place.
 * It lives in the per-user Cache B entry and in the outgoing projection. It is
 * never written into Cache A or the L2 `discovery_cache` rows, which are
 * user-independent and would otherwise carry one viewer's reasons to every
 * other viewer.
 */

/**
 * The ranker shape this provenance describes. Bump when the Compass discovery
 * pipeline's scoring changes in a way that makes two pages non-comparable.
 */
export const DISCOVERY_MODEL_VERSION = "compass-discovery-2026-09";

/**
 * The feature-vector shape. Bump when `featuresFromPipelineResult` starts
 * emitting a different set of keys — a cached page whose bag has a different
 * shape cannot be re-ranked against the current one without saying so.
 */
export const DISCOVERY_FEATURE_VERSION = "compass-factors-v1";

/**
 * The SOURCE EVENT WINDOW a computation ran over, as epoch-ms bounds.
 *
 * Half-open `[startMs, endMs)` in intent — `endMs` is the clock the computation
 * was handed, and a row stamped after it is in the future and was not counted.
 * Stated as bounds rather than as a duration because a duration only says how
 * wide the window was, not where it sat: two readings taken ten minutes apart
 * over "30 days" describe two different corpora, which a consumer must see.
 *
 * `kind` keeps two absences apart: a window that admitted nothing is `bounded`
 * with `startMs === endMs`; a corpus with NO oldest event is `unbounded_start`,
 * whose `startMs` is `null`, never a plausible-looking 0. See `windowSpanMs`.
 */
export type DerivedStoreWindow =
  | { kind: "bounded";         startMs: number; endMs: number }
  | { kind: "unbounded_start"; startMs: null;   endMs: number };

/**
 * `01` §7 / `06` §5's provenance, for a store that DERIVES numbers from an
 * event window rather than from a ranked page.
 *
 * census-discovery DC-17: the two stores that compute over an event window —
 * lib/discoveryLocalMomentum and lib/discoveryTrendState — returned their
 * numbers bare, so a consumer could not tell a reading taken over a full corpus
 * from one taken over a truncated window, nor a fresh reading from a cached
 * one. The same four facts `DiscoveryRankProvenance` carries about a RANK, said
 * about a COMPUTATION.
 *
 * The version pair is deliberately NOT a second vocabulary: both fields are the
 * constants above. A momentum reading and a ranked page that claimed different
 * versions of the same pipeline would be worse than neither claiming one.
 */
export interface DerivedStoreProvenance {
  /** `06` §5 model_version — DISCOVERY_MODEL_VERSION. */
  modelVersion: string;
  /** `06` §5 feature_version — DISCOVERY_FEATURE_VERSION. */
  featureVersion: string;
  /** The event window the numbers were computed over. */
  window: DerivedStoreWindow;
  /**
   * Epoch ms the COMPUTATION ran. Deliberately not re-stamped when a cached
   * result is replayed, for the same reason `rankedAt` is not: reporting the
   * read time would describe a computation that never took place.
   */
  computedAt: number;
}

/**
 * Stamp one computation. The versions are filled from the constants above so a
 * caller cannot mint its own pair, and the window is copied rather than held by
 * reference so a later mutation of the caller's bounds cannot rewrite history.
 */
export function derivedStoreProvenance(
  window: DerivedStoreWindow,
  computedAt: number,
): DerivedStoreProvenance {
  return {
    modelVersion:   DISCOVERY_MODEL_VERSION,
    featureVersion: DISCOVERY_FEATURE_VERSION,
    window: { ...window },
    computedAt,
  };
}

/**
 * Which retrieval produced a candidate. `06` §2 lists eleven candidate sources;
 * Discovery's serve path today has exactly two retrievals plus the case where
 * neither claimed the row, and inventing the other nine would be describing a
 * pipeline that does not run.
 */
export type DiscoveryCandidateSource =
  /** loadCuratedAndCanonicalPlaces — Discovery's curated rows + the canonical registry (`06` §2 "editorial/curated"). */
  | "curated_db"
  /** queryOverpassDeduped — the OSM directory read around the destination (`06` §2 "nearby places"). */
  | "osm_directory"
  /** The row reached the ranker without either retrieval claiming it. Recorded, not guessed. */
  | "unknown";

export interface DiscoveryRankProvenance {
  /** `06` §5 model_version. */
  modelVersion: string;
  /** `06` §5 feature_version. */
  featureVersion: string;
  /** `06` §5 candidate source, recorded at retrieval. */
  candidateSource: DiscoveryCandidateSource;
  /** `06` §5 recommendation reasons — the ranker's own factor keys, strongest first. */
  reasons: string[];
  /** `04` §13 RAW — the per-signal contributions the ranker computed. `01` §7's
   *  feature vector, without which a cached order cannot be re-ranked. */
  features: Record<string, number>;
  /** `04` §13 DERIVED — what was computed FROM the features. Kept in its own
   *  field so the separation is structural rather than a naming convention. */
  scores: Record<string, number>;
  /** DC-17 field 4 — the SOURCE EVENT WINDOW this rank could have read. Optional
   *  only so a hand-built fixture can decline to claim one: `buildRankProvenance`
   *  always stamps it, and the `StampedRankProvenance` it returns requires it. */
  sourceWindow?: DerivedStoreWindow;
  /** `06` §5 ranking timestamp: epoch ms the RANKER ran. Never the cache read time. */
  rankedAt: number;
}

/**
 * Build the retrieval → source map from the two reads the route actually made.
 *
 * Takes the id lists rather than the rows so the caller cannot accidentally
 * pass a merged array and lose the distinction this map exists to keep. A row
 * present in both reads is attributed to the curated read, which is the one
 * `mergeAndDedup` lets win.
 */
export function candidateSourceMap(
  curatedIds: readonly string[],
  osmIds: readonly string[],
): Map<string, DiscoveryCandidateSource> {
  const m = new Map<string, DiscoveryCandidateSource>();
  for (const id of osmIds) m.set(id, "osm_directory");
  for (const id of curatedIds) m.set(id, "curated_db");
  return m;
}

/** The subset of a Compass `PipelineResult` this module reads. Structural on purpose. */
export interface RankedPipelineRow {
  item: { id: string };
  finalScore?: number;
  compassMatch?: number;
  communityScore?: number;
  rankingFactors?: ReadonlyArray<{ key: string; weight: number }>;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The raw per-item numbers the Compass ranker produced, as a flat bag.
 *
 * Factor weights are prefixed `factor_` so a factor key can never collide with
 * a pipeline-level score key, and so a reader can tell a grounded contribution
 * from an aggregate at a glance. Non-finite values are dropped rather than
 * coerced: a NaN recorded as 0 is a measurement that never happened.
 */
export function featuresFromPipelineResult(r: RankedPipelineRow): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of r.rankingFactors ?? []) {
    const w = num(f.weight);
    if (w != null && typeof f.key === "string" && f.key.length > 0) out[`factor_${f.key}`] = w;
  }
  return out;
}

/**
 * `04` §13 DERIVED — the scores the pipeline computed from the features above.
 *
 * Separate from `featuresFromPipelineResult` so that a later re-score cannot
 * accidentally feed a model its own previous output. The two are produced by
 * two functions and stored in two fields, because a convention that lives only
 * in a key prefix is one careless spread away from being broken.
 */
export function scoresFromPipelineResult(r: RankedPipelineRow): Record<string, number> {
  const out: Record<string, number> = {};
  const fs = num(r.finalScore);
  const cm = num(r.compassMatch);
  const cs = num(r.communityScore);
  if (fs != null) out.finalScore = fs;
  if (cm != null) out.compassMatch = cm;
  if (cs != null) out.communityScore = cs;
  return out;
}

/**
 * Recommendation reasons: the factor keys that actually fired, strongest first,
 * ties broken by key so the list is stable across two runs of the same page.
 * A factor with zero or negative weight did not contribute and is not a reason.
 */
export function reasonsFromPipelineResult(r: RankedPipelineRow): string[] {
  return (r.rankingFactors ?? [])
    .filter((f) => typeof f.key === "string" && f.key.length > 0 && (num(f.weight) ?? 0) > 0)
    .slice()
    .sort((a, b) => (b.weight - a.weight) || a.key.localeCompare(b.key))
    .map((f) => f.key);
}

/**
 * DC-17 field 4 — the SOURCE EVENT WINDOW one Compass discovery rank ran over.
 *
 * WHAT ACTUALLY BOUNDS THE RANKER'S INPUTS, READ RATHER THAN ASSUMED
 * ==================================================================
 * `rankItemsForDiscovery` (compass/CompassFeedBuilder.ts) has exactly three
 * DB-derived inputs, and only one of them is a time slice:
 *
 *   preloadFairExposureData    reads `compass_visibility_boosts.appearance_count`
 *                              with NO time predicate — a running counter whose
 *                              oldest contributing appearance is not recorded.
 *   loadUnderexposedItemIds    reads `content_distribution_stats` filtered only
 *                              on `underexposure_status` — a standing column,
 *                              again with no oldest event.
 *   computeActiveUserScore     loads `compass_active_user_events` bounded at 365
 *                              days, then re-scores the SAME rows over 24 h, 7 d,
 *                              30 d, 90 d and "lifetime". The only real bound.
 *
 * Two of the three are aggregates, so the corpus that reached the ranker has no
 * oldest event. The honest record of that is `unbounded_start` — not the 365-day
 * bound, which describes one input of three, and not 0, which would claim the
 * corpus begins at the epoch. `01` §7 keeps the feature vector so a cached order
 * can be re-ranked; a window invented here would make that re-rank compare
 * against a corpus nobody read, which is worse than admitting the bound is open.
 *
 * `endMs` is the rank clock the caller already read once for `rankedAt`, so the
 * two cannot drift: a row stamped after the ranker returned did not reach it.
 *
 * Not a parameter of `buildRankProvenance`, for the same reason the version pair
 * is not: a caller that could hand in its own window could describe a corpus the
 * ranker never read. It moves when the pipeline above moves, and when it does,
 * DISCOVERY_MODEL_VERSION moves with it.
 */
export function rankSourceWindow(rankedAt: number): DerivedStoreWindow {
  return { kind: "unbounded_start", startMs: null, endMs: rankedAt };
}

/**
 * How wide a window is, in ms — or `null` when there is no oldest event to
 * measure from.
 *
 * The accessor exists so that the two absences cannot be collapsed by accident.
 * `Number(null)` is 0, so a consumer that read `endMs - startMs` off the raw
 * bounds would report an UNBOUNDED corpus and a ZERO-WIDTH one as the same
 * number. Here they are `null` and `0`, which no arithmetic can confuse, and a
 * provenance record that was never built at all is a third thing again — `null`
 * at its own field (lib/discoveryCandidate.ts keeps that distinction on the
 * served row) rather than a record carrying a blank window.
 */
export function windowSpanMs(w: DerivedStoreWindow): number | null {
  return w.kind === "unbounded_start" ? null : w.endMs - w.startMs;
}

/**
 * What `buildRankProvenance` emits: the `06` §5 record with DC-17's fourth field
 * PRESENT, not merely permitted.
 *
 * The base record leaves `sourceWindow` optional so that a record assembled by
 * hand — a fixture, a replayed row from an older cache entry — can exist without
 * claiming a window it never had. Everything the ranker produces comes through
 * here, and here it is required, so "the producer forgot" is not a state this
 * type can represent.
 */
export interface StampedRankProvenance extends DiscoveryRankProvenance {
  sourceWindow: DerivedStoreWindow;
}

/**
 * Project one ranked page into `id → provenance`.
 *
 * `rankedAt` is supplied by the caller — the clock is read ONCE, at the moment
 * the ranker returns, and the same value is stamped on every row of that page.
 * Reading it per row would make one page carry several ranking times.
 *
 * The source event window is derived from that one clock and SHARED BY REFERENCE
 * across every row, for the reason lib/discoveryLocalMomentum gives for keeping
 * its own provenance beside the map rather than inside every value: one rank is
 * one computation over one corpus, and N copies of that sentence are N chances
 * for two rows of the same page to disagree about it.
 */
export function buildRankProvenance(
  ranked: readonly RankedPipelineRow[],
  sourceById: ReadonlyMap<string, DiscoveryCandidateSource>,
  rankedAt: number,
  ids: { normalize?: (id: string) => string } = {},
): Map<string, StampedRankProvenance> {
  const norm = ids.normalize ?? ((x: string) => x);
  const sourceWindow = rankSourceWindow(rankedAt);
  const out = new Map<string, StampedRankProvenance>();
  for (const r of ranked) {
    const id = norm(r.item.id);
    out.set(id, {
      modelVersion:    DISCOVERY_MODEL_VERSION,
      featureVersion:  DISCOVERY_FEATURE_VERSION,
      candidateSource: sourceById.get(id) ?? "unknown",
      reasons:         reasonsFromPipelineResult(r),
      features:        featuresFromPipelineResult(r),
      scores:          scoresFromPipelineResult(r),
      sourceWindow,
      rankedAt,
    });
  }
  return out;
}
