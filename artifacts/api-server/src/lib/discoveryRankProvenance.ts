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
  /**
   * `04` §13 RAW — the per-signal contributions the ranker computed. `01` §7's
   * feature vector, without which a cached order cannot be re-ranked.
   */
  features: Record<string, number>;
  /**
   * `04` §13 DERIVED — what was computed FROM the features. Kept in its own
   * field so the separation is structural rather than a naming convention.
   */
  scores: Record<string, number>;
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
 * Project one ranked page into `id → provenance`.
 *
 * `rankedAt` is supplied by the caller — the clock is read ONCE, at the moment
 * the ranker returns, and the same value is stamped on every row of that page.
 * Reading it per row would make one page carry several ranking times.
 */
export function buildRankProvenance(
  ranked: readonly RankedPipelineRow[],
  sourceById: ReadonlyMap<string, DiscoveryCandidateSource>,
  rankedAt: number,
  ids: { normalize?: (id: string) => string } = {},
): Map<string, DiscoveryRankProvenance> {
  const norm = ids.normalize ?? ((x: string) => x);
  const out = new Map<string, DiscoveryRankProvenance>();
  for (const r of ranked) {
    const id = norm(r.item.id);
    out.set(id, {
      modelVersion:    DISCOVERY_MODEL_VERSION,
      featureVersion:  DISCOVERY_FEATURE_VERSION,
      candidateSource: sourceById.get(id) ?? "unknown",
      reasons:         reasonsFromPipelineResult(r),
      features:        featuresFromPipelineResult(r),
      scores:          scoresFromPipelineResult(r),
      rankedAt,
    });
  }
  return out;
}
