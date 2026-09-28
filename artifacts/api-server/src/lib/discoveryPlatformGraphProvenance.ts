/**
 * The served graph reading's provenance on the PLATFORM path — census-discovery
 * §94 (lane W11-X2), DC-17 / W11A-B7, §75.3 blocker 3.
 *
 * `10` §5: "Derived features must retain: source event window, feature version,
 * model version, computation time." Under 3484, a reading the Compass producer
 * computed carries all four (lib/discoveryCandidates/graphReadingProvenance.ts).
 * A reading the PLATFORM's coverage store answered did not: it was recorded as
 * `platform_producer` with no facts, because Compass never writes that store and
 * never re-runs its producer (CPV2-12), so a Compass producer version stamped on
 * it would be false exactly there.
 *
 * WHAT IS TRUE OF A PLATFORM READING, AND IS STATED HERE. The served depth is
 * not a number the platform stored. It is computed AT READ TIME by
 * `readPlatformCityCoverage` (compass/CompassGraphEngine.ts): the unexpired
 * `intel_coverage_snapshots` cells of the city, counted by `coverage_state` and
 * averaged over `current_confidence`, folded by `platformCoverageDepthScore`.
 * So the four facts are:
 *
 *   modelVersion    the fold — `PLATFORM_COVERAGE_FOLD_MODEL_VERSION`, pinned by
 *                   a test to `platformCoverageDepthScore`'s outputs and to
 *                   `tierForScore`'s cut-points, so a weight change without a
 *                   bump turns it red;
 *   featureVersion  what one cell contributes — its `coverage_state` (the
 *                   platform's `coverageState`) and its clamped
 *                   `current_confidence`; pinned the same way;
 *   sourceWindow    the cells the read admitted: `expires_at` after the read
 *                   clock, oldest to newest `computed_at`, and how many rows;
 *   computedAt      the reading's own (the newest cell's `computed_at`).
 *
 * The same reading, or none. The cells are read again with the governing
 * read's exact query and folded with the governing fold. Unless the newest
 * `computed_at` and the depth both equal the reading's, the answer is
 * `reading_moved`: the producer rewrote cells between the two reads (it runs
 * every 10 minutes), and a record of other cells would describe a reading
 * nobody served.
 *
 * NO CLAIM WHERE NONE CAN BE MADE. The governing read is capped and unordered
 * (`.limit(2000)`, no ORDER). When the re-read reaches the cap, the corpus is
 * whatever subset the planner returned and no window can name it, so the answer
 * stays `platform_producer` — the answer before this module — rather than a
 * window that names an unreproducible set (§75.3 blocker 1's rule).
 *
 * Behind `discovery_platform_graph_provenance_enabled` (3490, seeded FALSE),
 * read as a literal. OFF / absent / unreadable ⇒ `{ status: "platform_producer" }`,
 * exactly the object this path answered before, and no snapshot is read.
 * Reached only from `loadGraphReadingProvenance`, which runs only under 3484
 * with the ranking modifiers on. Provenance only: nothing here is read back
 * into a score or an order.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { canonicalCityKey } from "./canonicalLocations.js";
import { platformCoverageDepthScore } from "../compass/CompassGraphEngine.js";
import type { GraphReadingProvenance } from "./discoveryCandidates/graphReadingProvenance.js";
import type { PdeGraphReading } from "./discoveryPde.js";

export const DISCOVERY_PLATFORM_GRAPH_PROVENANCE_FLAG = "discovery_platform_graph_provenance_enabled";

/** Bump when `platformCoverageDepthScore`'s weights or `tierForScore`'s cut-points change. */
export const PLATFORM_COVERAGE_FOLD_MODEL_VERSION = "compass-platform-coverage-fold-v1";
/** Bump when what one cell contributes changes: its `coverage_state` (lib/coverageScore coverageState) or its clamped `current_confidence`. */
export const PLATFORM_COVERAGE_FEATURE_VERSION = "intel-coverage-cell-state-v1";
/** The governing read's cap (compass/CompassGraphEngine.ts PLATFORM_COVERAGE_READ_LIMIT); a test pins the two equal. */
export const PLATFORM_COVERAGE_READ_CAP = 2000;

export interface PlatformCoverageWindow {
  kind: "bounded";
  /** Oldest admitted cell's `computed_at`, epoch ms. */
  startMs: number;
  /** The read clock: every admitted cell's `expires_at` is after it. */
  endMs: number;
  truncated: false;
  rows: { intel_coverage_snapshots: number };
}

const UNRECORDED: GraphReadingProvenance = { status: "platform_producer" };

export async function platformGraphReadingProvenance(
  sc: any,
  reading: PdeGraphReading,
  now: Date = new Date(),
): Promise<GraphReadingProvenance> {
  if (!sc) return { ...UNRECORDED };
  if (!(await isFlagEnabled(sc, "discovery_platform_graph_provenance_enabled"))) return { ...UNRECORDED };
  const key = canonicalCityKey(reading.city);
  if (!key || !reading.computedAt || reading.source !== "platform_coverage") return { status: "not_recorded" };
  try {
    // The governing read, verbatim (compass/CompassGraphEngine.ts readPlatformCityCoverage).
    const { data, error } = await sc
      .from("intel_coverage_snapshots")
      .select("city, zone_id, claim_family, coverage_state, current_confidence, score, computed_at, expires_at")
      .ilike("city", `${key}%`)
      .gt("expires_at", now.toISOString())
      .limit(PLATFORM_COVERAGE_READ_CAP);
    if (error) return { status: "read_failed" };
    const raw = Array.isArray(data) ? (data as any[]) : [];
    if (raw.length >= PLATFORM_COVERAGE_READ_CAP) return { ...UNRECORDED };

    let cells = 0, covered = 0, confSum = 0, newest = "", oldestMs: number | null = null;
    for (const r of raw) {
      if (canonicalCityKey(r?.city) !== key) continue;
      cells++;
      if (String(r?.coverage_state ?? "unknown") === "covered") covered++;
      const c = Number(r?.current_confidence ?? 0);
      confSum += Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
      const at = String(r?.computed_at ?? "");
      if (at > newest) newest = at;
      const t = Date.parse(at);
      if (Number.isFinite(t) && (oldestMs === null || t < oldestMs)) oldestMs = t;
    }
    if (cells === 0 || oldestMs === null) return { status: "reading_moved" };
    const meanConfidence = Math.round((confSum / cells) * 10000) / 10000;
    const depth = platformCoverageDepthScore({ cells, covered, meanConfidence });
    if (newest !== reading.computedAt || depth !== reading.depthScore) return { status: "reading_moved" };

    const sourceWindow: PlatformCoverageWindow = {
      kind: "bounded", startMs: oldestMs, endMs: now.getTime(), truncated: false,
      rows: { intel_coverage_snapshots: raw.length },
    };
    return {
      status: "recorded",
      modelVersion: PLATFORM_COVERAGE_FOLD_MODEL_VERSION,
      featureVersion: PLATFORM_COVERAGE_FEATURE_VERSION,
      sourceWindow,
      computedAt: reading.computedAt,
    };
  } catch {
    return { status: "read_failed" };
  }
}
