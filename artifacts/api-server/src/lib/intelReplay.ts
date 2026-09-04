/**
 * Projection replay (unit I1) — "every model decision is reproducible from
 * versioned features, claims, policies and algorithm versions" (spec §1) and
 * "every projection is replayable" (Appendix B).
 *
 * A snapshot version row (intel_state_snapshot_versions, migration 2273)
 * carries everything the writer used: the ConfidenceResult components and
 * penalties, the freshness inputs, the formula version and the projection
 * algorithm version. This module feeds those stored inputs back through the
 * SAME code path the writer used (lib/confidenceScore.scoreConfidence) and
 * compares what comes out with what was stored.
 *
 * TWO KINDS OF DIVERGENCE, KEPT APART:
 *   * `algorithm_version_changed` / `formula_version_changed` /
 *     `freshness_curve_changed` — the stored row was produced by a different
 *     version of the code than the one replaying it. Recomputing is still done
 *     and reported, but the row is NOT the same computation, and a replay must
 *     say so rather than quietly re-scoring under new rules.
 *   * `confidence_mismatch` / `band_mismatch` / `freshness_component_mismatch`
 *     — same versions, different answer. That is a corrupted or hand-edited
 *     row, or a formula that is not actually deterministic, and either is a
 *     defect.
 *
 * FAIL-CLOSED. A row whose replay record is missing or malformed is reported
 * `diverged` with `replay_record_missing` — it is unreplayable, which is the
 * whole thing this unit exists to make impossible for new writes. Nothing here
 * writes anything.
 */
import { logger } from "./logger.js";
import {
  scoreConfidence,
  CONFIDENCE_FORMULA_VERSION,
  type ConfidenceComponents,
  type ConfidencePenalties,
} from "./confidenceScore.js";
import { freshnessScore, FRESHNESS_CURVE_VERSION } from "./freshnessPolicy.js";
import { PROJECTION_ALGORITHM_VERSION, type ConfidenceReplayRecord } from "./intelProjection.js";

/** The columns a replay reads from intel_state_snapshot_versions. */
export interface SnapshotVersionForReplay {
  id: string;
  subject_id: string;
  zone_id: string;
  claim_type: string;
  confidence: number | string | null;
  confidence_band: string | null;
  confidence_components: unknown;
  algorithm_version: string;
  generated_at?: string;
}

export type ReplayDivergence =
  | "replay_record_missing"
  | "algorithm_version_changed"
  | "formula_version_changed"
  | "freshness_curve_changed"
  | "freshness_component_mismatch"
  | "confidence_mismatch"
  | "band_mismatch";

export interface ReplayResult {
  status: "equal" | "diverged";
  versionId: string;
  reasons: ReplayDivergence[];
  stored: { confidence: number | null; band: string | null; algorithmVersion: string; formulaVersion: number | null };
  recomputed: { confidence: number | null; band: string | null; algorithmVersion: string; formulaVersion: number };
}

/** Numeric tolerance: numeric(…) round-trips through PostgREST as a string/float. */
const EPSILON = 1e-9;

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Narrow an untyped jsonb value to the replay record shape, or null. */
export function parseReplayRecord(raw: unknown): ConfidenceReplayRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const comps = r.components, pens = r.penalties;
  if (!comps || typeof comps !== "object" || !pens || typeof pens !== "object") return null;
  const formulaVersion = asNumber(r.formulaVersion);
  if (formulaVersion === null) return null;
  let freshness: ConfidenceReplayRecord["freshness"] = null;
  if (r.freshness && typeof r.freshness === "object") {
    const f = r.freshness as Record<string, unknown>;
    const age = asNumber(f.ageSeconds), ttl = asNumber(f.ttlSeconds);
    if (age !== null && ttl !== null) freshness = { ageSeconds: age, ttlSeconds: ttl, curve: String(f.curve ?? "") };
  }
  return {
    formulaVersion: formulaVersion as ConfidenceReplayRecord["formulaVersion"],
    raw: asNumber(r.raw) ?? 0,
    penalty: asNumber(r.penalty) ?? 0,
    invalid: r.invalid === true,
    components: comps as ConfidenceComponents,
    penalties: pens as ConfidencePenalties,
    freshness,
  };
}

/**
 * Replay one stored version row through the current formula. Pure: no I/O.
 *
 * `opts.algorithmVersion` lets a caller replay "as of" a specific version
 * string (e.g. a test proving that a changed version is reported); it defaults
 * to the running code's PROJECTION_ALGORITHM_VERSION.
 */
export function replayVersion(
  row: SnapshotVersionForReplay,
  opts: { algorithmVersion?: string } = {},
): ReplayResult {
  const currentAlgorithm = opts.algorithmVersion ?? PROJECTION_ALGORITHM_VERSION;
  const reasons: ReplayDivergence[] = [];
  const storedConfidence = asNumber(row.confidence);
  const storedBand = row.confidence_band ?? null;
  const record = parseReplayRecord(row.confidence_components);

  if (!record) {
    return {
      status: "diverged",
      versionId: row.id,
      reasons: ["replay_record_missing"],
      stored: { confidence: storedConfidence, band: storedBand, algorithmVersion: row.algorithm_version, formulaVersion: null },
      recomputed: { confidence: null, band: null, algorithmVersion: currentAlgorithm, formulaVersion: CONFIDENCE_FORMULA_VERSION },
    };
  }

  if (row.algorithm_version !== currentAlgorithm) reasons.push("algorithm_version_changed");
  if (record.formulaVersion !== CONFIDENCE_FORMULA_VERSION) reasons.push("formula_version_changed");

  // Recompute the freshness component from its stored inputs when the row was
  // produced under the current curve; under a different curve the component
  // is expected to differ, and that is already reported above.
  if (record.freshness) {
    if (record.freshness.curve !== FRESHNESS_CURVE_VERSION) {
      reasons.push("freshness_curve_changed");
    } else {
      const expected = freshnessScore(record.freshness.ageSeconds, record.freshness.ttlSeconds);
      if (Math.abs(expected - record.components.freshness) > EPSILON) reasons.push("freshness_component_mismatch");
    }
  }

  // The formula itself, from the stored components and penalties.
  const scored = scoreConfidence(record.components, record.penalties);
  if (storedConfidence === null || Math.abs(scored.confidence - storedConfidence) > EPSILON) reasons.push("confidence_mismatch");
  if (scored.band !== storedBand) reasons.push("band_mismatch");

  return {
    status: reasons.length === 0 ? "equal" : "diverged",
    versionId: row.id,
    reasons,
    stored: { confidence: storedConfidence, band: storedBand, algorithmVersion: row.algorithm_version, formulaVersion: record.formulaVersion },
    recomputed: { confidence: scored.confidence, band: scored.band, algorithmVersion: currentAlgorithm, formulaVersion: CONFIDENCE_FORMULA_VERSION },
  };
}

export type ReplayOutcome =
  | ReplayResult
  | { status: "not_found"; versionId: string }
  | { status: "error"; versionId: string; detail: string };

/**
 * Read one version row and replay it. Read-only; the row is never touched.
 * `not_found` and `error` are distinct from `diverged` so an operator can tell
 * "the record disagrees" from "there is no record".
 */
export async function replaySnapshotVersion(
  sc: any,
  versionId: string,
  opts: { algorithmVersion?: string } = {},
): Promise<ReplayOutcome> {
  if (!sc || !versionId) return { status: "error", versionId: String(versionId ?? ""), detail: "client and versionId are required" };
  try {
    const { data, error } = await sc
      .from("intel_state_snapshot_versions")
      .select("id, subject_id, zone_id, claim_type, confidence, confidence_band, confidence_components, algorithm_version, generated_at")
      .eq("id", versionId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, versionId }, "intelReplay: version read failed");
      return { status: "error", versionId, detail: String((error as { message?: string }).message ?? "read failed") };
    }
    if (!data) return { status: "not_found", versionId };
    const result = replayVersion(data as SnapshotVersionForReplay, opts);
    logger.info(
      { event: "intel.projection.replay", version_id: versionId, status: result.status, reasons: result.reasons, stored_algorithm_version: result.stored.algorithmVersion, current_algorithm_version: result.recomputed.algorithmVersion },
      "intel projection replay",
    );
    return result;
  } catch (err) {
    logger.warn({ err, versionId }, "intelReplay: replay threw");
    return { status: "error", versionId, detail: err instanceof Error ? err.message : String(err) };
  }
}
