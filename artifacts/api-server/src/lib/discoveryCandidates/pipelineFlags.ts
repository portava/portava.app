/**
 * The §85 pipeline flags — census-discovery §85 (lane W10-R3).
 *
 * Eight NEW flags, each seeded FALSE by a migration in 3480–3484, each read
 * fail-closed. With all eight off `rankForViewer`'s output is byte-identical to
 * the tree before §85 (src/test/discoveryCandidatePipelineGolden.test.ts).
 *
 * ONE READ, NOT EIGHT. Under D5=B `rankForViewer` runs on every request, so the
 * eight flags are read in one `feature_flags` query (`in(flag, …)`), cached for
 * 30 s PER CLIENT OBJECT (a WeakMap, so one test's client can never answer the
 * next test's read — the defect a module-global cache would have). A read that
 * errors, throws or has no client is ALL OFF: an unreadable flag is an off flag.
 * A row counts as ON only when it names the flag AND says `enabled === true`,
 * so a fake or a view that returns a bare `{ enabled: true }` turns nothing on.
 */
/** DC-12 / DV-49 — the per-viewer retrievals (3480). */
export const DISCOVERY_CANDIDATE_SOURCES_FLAG = "discovery_candidate_sources_enabled";
/**
 * `06` §2 "social/circle context" — circle mates' PUBLIC experiences as
 * candidates (3480). A consent question the lane may not decide: seeded FALSE,
 * and its register entry is APPROVAL REQUIRED (D-W10-R3-4).
 */
export const DISCOVERY_CIRCLE_CANDIDATES_FLAG = "discovery_circle_candidates_enabled";
/** DV-53 / DC-11 exploration — the reserved inventory (3481). */
export const DISCOVERY_EXPLORATION_INVENTORY_FLAG = "discovery_exploration_inventory_enabled";
/** DV-55 — cold start for a new viewer (3482). */
export const DISCOVERY_COLD_START_FLAG = "discovery_cold_start_enabled";
/** DC-11 integrity checks — the stage that calls DV-12's detector (3483). */
export const DISCOVERY_INTEGRITY_STAGE_FLAG = "discovery_integrity_stage_enabled";
/** DC-11 learn from outcomes (3483). */
export const DISCOVERY_OUTCOME_LEARNING_FLAG = "discovery_outcome_learning_enabled";
/**
 * H-P21-4 — the Compass city-confidence producer's windowed reads (3484). PDE
 * reads it too: only a reading written under it carries the provenance columns,
 * so with it off PDE does not spend a read looking for them.
 */
export const COMPASS_CITY_CONFIDENCE_WINDOWED_READS_FLAG = "compass_city_confidence_windowed_reads_enabled";
/** DC-01 — Trails, Shared Moments and emerging discoveries ranked by PDE (3483). */
export const DISCOVERY_OUTPUT_KINDS_FLAG = "discovery_output_kinds_enabled";

export const PIPELINE_FLAG_NAMES = [
  DISCOVERY_CANDIDATE_SOURCES_FLAG, DISCOVERY_CIRCLE_CANDIDATES_FLAG,
  DISCOVERY_EXPLORATION_INVENTORY_FLAG, DISCOVERY_COLD_START_FLAG,
  DISCOVERY_INTEGRITY_STAGE_FLAG, DISCOVERY_OUTCOME_LEARNING_FLAG,
  DISCOVERY_OUTPUT_KINDS_FLAG, COMPASS_CITY_CONFIDENCE_WINDOWED_READS_FLAG,
] as const;

export interface PipelineFlags {
  candidateSources: boolean;
  circleCandidates: boolean;
  explorationInventory: boolean;
  coldStart: boolean;
  integrityStage: boolean;
  outcomeLearning: boolean;
  outputKinds: boolean;
  graphReadingProvenance: boolean;
}

export const PIPELINE_FLAGS_OFF: Readonly<PipelineFlags> = Object.freeze({
  candidateSources: false, circleCandidates: false, explorationInventory: false,
  coldStart: false, integrityStage: false, outcomeLearning: false, outputKinds: false,
  graphReadingProvenance: false,
});

/** True when any §85 stage is on — the one test `rankForViewer` makes before doing §85 work. */
export function anyPipelineFlag(f: PipelineFlags): boolean {
  return f.candidateSources || f.circleCandidates || f.explorationInventory || f.coldStart
    || f.integrityStage || f.outcomeLearning || f.graphReadingProvenance;
}

const FLAG_TTL_MS = 30_000;
const cache = new WeakMap<object, { flags: PipelineFlags; at: number }>();

/** Test hook: forget one client's cached flags (or every client's, by dropping the map's keys). */
export function invalidatePipelineFlagCache(sc?: object | null): void {
  if (sc) cache.delete(sc);
}

/** Read the eight flags in one query. Never throws; any failure is ALL OFF. */
export async function loadPipelineFlags(sc: any, nowMs: number = Date.now()): Promise<PipelineFlags> {
  if (!sc || typeof sc !== "object") return { ...PIPELINE_FLAGS_OFF };
  const hit = cache.get(sc);
  if (hit && nowMs - hit.at < FLAG_TTL_MS && nowMs >= hit.at) return { ...hit.flags };
  let on = new Set<string>();
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("flag, enabled")
      .in("flag", ["discovery_candidate_sources_enabled", "discovery_circle_candidates_enabled", "discovery_exploration_inventory_enabled", "discovery_cold_start_enabled", "discovery_integrity_stage_enabled", "discovery_outcome_learning_enabled", "discovery_output_kinds_enabled", "compass_city_confidence_windowed_reads_enabled"]); // §91: literal, so check:flag-polarity sees each read; ≡ PIPELINE_FLAG_NAMES (pinned by discoveryIntegrationHooks X0)
    if (!error && Array.isArray(data)) {
      on = new Set((data as Array<{ flag?: unknown; enabled?: unknown }>)
        .filter((r) => typeof r?.flag === "string" && r.enabled === true)
        .map((r) => r.flag as string));
    }
  } catch { on = new Set(); }
  const flags: PipelineFlags = {
    candidateSources:     on.has(DISCOVERY_CANDIDATE_SOURCES_FLAG),
    circleCandidates:     on.has(DISCOVERY_CIRCLE_CANDIDATES_FLAG),
    explorationInventory: on.has(DISCOVERY_EXPLORATION_INVENTORY_FLAG),
    coldStart:            on.has(DISCOVERY_COLD_START_FLAG),
    integrityStage:       on.has(DISCOVERY_INTEGRITY_STAGE_FLAG),
    outcomeLearning:      on.has(DISCOVERY_OUTCOME_LEARNING_FLAG),
    outputKinds:          on.has(DISCOVERY_OUTPUT_KINDS_FLAG),
    graphReadingProvenance: on.has(COMPASS_CITY_CONFIDENCE_WINDOWED_READS_FLAG),
  };
  cache.set(sc, { flags, at: nowMs });
  return { ...flags };
}
