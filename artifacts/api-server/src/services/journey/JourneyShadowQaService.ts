/**
 * JourneyShadowQaService
 *
 * Aggregate-only QA evaluation for the Journey shadow-rollout.
 *
 * - Queries ground truth restricted to stage cohort overlapping the period window.
 * - Loads journey_shadow_session_issuances to derive exact issued location_session_ids.
 * - Scopes journey_segment_revisions by location_session_id only.
 * - Calls read_journey_shadow_qa_observations_v1 (admin-only) per session which
 *   runs _journey_shadow_require_admin_actor AND journey_shadow_authorize_v1
 *   (raw_read) inside the same SQL transaction (eliminates TOCTOU gap). Includes
 *   ALL quality classes (including unusable) for failure-mode measurement.
 *   Denial RAISEs a generic 42501; authorised-but-empty returns zero rows.
 * - Calculates aggregate metrics via JourneyShadowMetrics API.
 * - Persists only aggregate payload via persist_journey_shadow_qa_report_v1.
 * - Never returns/persists user IDs, session IDs, raw timestamps, or coordinates.
 * - Fails closed on any missing or unreadable data.
 */

import {
  measureJourneyGroundTruth,
  type JourneyGroundTruthFixture,
  type JourneyGroundTruthMetrics,
  type JourneyObservationEvidence,
} from "../location/JourneyShadowMetrics.js";
import type { JourneySegmentRevision } from "../location/JourneySegmenter.js";
import { queryJourneyRetentionHealth } from "../../lib/journeyObservationPurge.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvaluateInput {
  stageId: string;
  periodStartsAt: string;
  periodEndsAt: string;
}

export interface EvaluateResult {
  reportId: string;
  metrics: JourneyGroundTruthMetrics;
  fixtureCount: number;
}

export interface ShadowRating {
  rating: "insufficient" | "blocked" | "poor" | "promising" | "ready_for_larger_shadow_only";
  /** Always false — behavior/pattern inference is never ready. */
  behaviorPatternInferenceReady: false;
  reasons: string[];
}

// ── DB row shapes (internal) ──────────────────────────────────────────────────

interface RawGroundTruthRow {
  ground_truth: unknown;
  // location_session_id may exist if migration evolves; code for it explicitly
  location_session_id?: unknown;
}

interface RawIssuanceRow {
  location_session_id: unknown;
  user_id: unknown;
}

interface RawRevisionRow {
  location_session_id: unknown;
  id: unknown;
  segment_key: unknown;
  supersedes_id: unknown;
  revision_index: unknown;
  state: unknown;
  started_at: unknown;
  ended_at: unknown;
  duration_s: unknown;
  world_ref: unknown;
  movement_class: unknown;
  uncertainty_score: unknown;
  uncertainty_tier: unknown;
  reason_codes: unknown;
  median_accuracy_m: unknown;
  max_gap_seconds: unknown;
  stop_radius_m: unknown;
  uncertainty_computed_at: unknown;
  algorithm_version: unknown;
  observation_count: unknown;
  expires_at: unknown;
  quality_version: unknown;
  quality_score: unknown;
  quality_class: unknown;
  quality_reasons: unknown;
  provenance_version: unknown;
  timing_uncertainty: unknown;
  quality_summary: unknown;
  place_provenance: unknown;
}

interface RawObservationRow {
  observed_at: unknown;
  quality_reasons: unknown;
  location_session_id: unknown;
  // lat/lng are transiently read AFTER raw_read authorization solely to compute
  // in-memory haversine distances. They are never persisted, returned, or logged.
  lat: unknown;
  lng: unknown;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance between two lat/lng points in metres.
 * Used transiently in memory only for jitter-distance evidence — the input
 * coordinates are never persisted, returned, or logged.
 */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

function safeError(context: string, _err: unknown): Error {
  return new Error(`journey shadow qa: ${context} failed`);
}

function parseGroundTruthPayload(row: RawGroundTruthRow): {
  condition: string;
  expectedArrivalAt: string | null;
  expectedDepartureAt: string | null;
  expectedDwellS: number | null;
  expectedPlaceId: string | null;
  expectedCategoryId: string | null;
  locationSessionId: string | null;
} | null {
  const gt = row.ground_truth;
  if (!gt || typeof gt !== "object" || Array.isArray(gt)) return null;
  const g = gt as Record<string, unknown>;

  // Extract location_session_id from the row (may come from column or ground_truth)
  const locationSessionId =
    typeof row.location_session_id === "string" && row.location_session_id
      ? row.location_session_id
      : null;

  const expectedArrivalAt =
    typeof g["expectedArrivalAt"] === "string" ? g["expectedArrivalAt"] : null;
  const expectedDepartureAt =
    typeof g["expectedDepartureAt"] === "string" ? g["expectedDepartureAt"] : null;
  const expectedDwellSeconds =
    typeof g["expectedDwellSeconds"] === "number" ? g["expectedDwellSeconds"] : null;
  const expectedStop = g["expectedStop"] === true;
  const expectedPlaceId =
    typeof g["expectedPlaceId"] === "string" ? g["expectedPlaceId"] : null;
  const expectedCategoryId =
    typeof g["expectedCategoryId"] === "string" ? g["expectedCategoryId"] : null;

  // Derive a non-PII condition label
  const parts: string[] = [];
  if (expectedStop) parts.push("stop");
  if (expectedDwellSeconds !== null) parts.push("dwell");
  if (expectedPlaceId) parts.push("place");
  if (expectedCategoryId) parts.push("category");
  const condition = parts.length > 0 ? parts.join("+") : "transit";

  return {
    condition,
    expectedArrivalAt,
    expectedDepartureAt,
    expectedDwellS: expectedDwellSeconds,
    expectedPlaceId,
    expectedCategoryId,
    locationSessionId,
  };
}

function coerceRevision(row: RawRevisionRow): JourneySegmentRevision | null {
  try {
    const state = row.state;
    if (
      state !== "moving" &&
      state !== "candidate_stop" &&
      state !== "dwelling" &&
      state !== "departed" &&
      state !== "discarded"
    ) return null;

    const rawWorldRef =
      row.world_ref && typeof row.world_ref === "object" && !Array.isArray(row.world_ref)
        ? (row.world_ref as Record<string, unknown>)
        : {};
    const worldRef: JourneySegmentRevision["worldRef"] = {
      countryCode: typeof rawWorldRef["countryCode"] === "string" ? rawWorldRef["countryCode"] : null,
      regionId: typeof rawWorldRef["regionId"] === "string" ? rawWorldRef["regionId"] : null,
      cityId: typeof rawWorldRef["cityId"] === "string" ? rawWorldRef["cityId"] : null,
      districtId: typeof rawWorldRef["districtId"] === "string" ? rawWorldRef["districtId"] : null,
      placeId: typeof rawWorldRef["placeId"] === "string" ? rawWorldRef["placeId"] : null,
    };

    const rawPP =
      row.place_provenance && typeof row.place_provenance === "object" && !Array.isArray(row.place_provenance)
        ? (row.place_provenance as Record<string, unknown>)
        : {};
    const placeProvenance: JourneySegmentRevision["placeProvenance"] = {
      placeConfidence:
        rawPP["placeConfidence"] === "resolved" ? "resolved" : "unknown",
      categoryConfidence:
        rawPP["categoryConfidence"] === "resolved" ? "resolved" : "unknown",
      provenance:
        rawPP["provenance"] === "world_ref" ? "world_ref" : "none",
    };

    const rawTU =
      row.timing_uncertainty && typeof row.timing_uncertainty === "object" && !Array.isArray(row.timing_uncertainty)
        ? (row.timing_uncertainty as Record<string, unknown>)
        : {};
    const timingUncertainty: JourneySegmentRevision["timingUncertainty"] = {
      arrivalUncertaintyS:
        rawTU["arrivalUncertaintyS"] != null ? Number(rawTU["arrivalUncertaintyS"]) : null,
      departureUncertaintyS:
        rawTU["departureUncertaintyS"] != null ? Number(rawTU["departureUncertaintyS"]) : null,
    };

    const rawQS =
      row.quality_summary && typeof row.quality_summary === "object" && !Array.isArray(row.quality_summary)
        ? (row.quality_summary as Record<string, unknown>)
        : {};
    const qualitySummary: JourneySegmentRevision["qualitySummary"] = {
      scorerVersion:
        typeof rawQS["scorerVersion"] === "string"
          ? rawQS["scorerVersion"]
          : typeof row.quality_version === "string"
            ? row.quality_version
            : "unknown",
      medianQualityScore:
        rawQS["medianQualityScore"] != null
          ? Number(rawQS["medianQualityScore"])
          : row.quality_score != null
            ? Number(row.quality_score)
            : null,
      gpsOnly: rawQS["gpsOnly"] === true,
      totalObservations:
        rawQS["totalObservations"] != null
          ? Number(rawQS["totalObservations"])
          : row.observation_count != null
            ? Number(row.observation_count)
            : 0,
      usableObservations:
        rawQS["usableObservations"] != null
          ? Number(rawQS["usableObservations"])
          : row.observation_count != null
            ? Number(row.observation_count)
            : 0,
      excludedObservations:
        rawQS["excludedObservations"] != null ? Number(rawQS["excludedObservations"]) : 0,
    };

    const movementClass =
      row.movement_class === "unknown" ||
      row.movement_class === "walking" ||
      row.movement_class === "vehicle" ||
      row.movement_class === "transit"
        ? row.movement_class
        : "unknown";

    return {
      revisionId: typeof row.id === "string" ? row.id : "",
      userId: "", // redacted — never exposed in aggregate path
      locationSessionId: typeof row.location_session_id === "string" ? row.location_session_id : "",
      segmentKey: typeof row.segment_key === "string" ? row.segment_key : "",
      supersedesRevisionId: typeof row.supersedes_id === "string" ? row.supersedes_id : null,
      revisionIndex: typeof row.revision_index === "number" ? row.revision_index : 0,
      state,
      startedAt: typeof row.started_at === "string" ? row.started_at : "",
      endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
      durationS: row.duration_s != null ? Number(row.duration_s) : null,
      worldRef,
      movementClass,
      uncertainty: {
        score: row.uncertainty_score != null ? Number(row.uncertainty_score) : 0,
        tier:
          row.uncertainty_tier === "low" || row.uncertainty_tier === "medium" ||
          row.uncertainty_tier === "high"
            ? row.uncertainty_tier
            : "medium",
        reasons: Array.isArray(row.reason_codes)
          ? (row.reason_codes as unknown[]).filter((r): r is string => typeof r === "string")
          : [],
        algorithmVersion: typeof row.algorithm_version === "string" ? row.algorithm_version : "unknown",
        computedAt: typeof row.uncertainty_computed_at === "string" ? row.uncertainty_computed_at : new Date().toISOString(),
      },
      evidence: {
        observationCount: row.observation_count != null ? Number(row.observation_count) : 0,
        medianAccuracyM: row.median_accuracy_m != null ? Number(row.median_accuracy_m) : null,
        maxGapSeconds: row.max_gap_seconds != null ? Number(row.max_gap_seconds) : null,
        stopRadiusM: row.stop_radius_m != null ? Number(row.stop_radius_m) : 0,
        reasonCodes: Array.isArray(row.quality_reasons)
          ? (row.quality_reasons as unknown[]).filter((r): r is string => typeof r === "string")
          : [],
      },
      algorithmVersion: typeof row.algorithm_version === "string" ? row.algorithm_version : "unknown",
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : "",
      qualitySummary,
      timingUncertainty,
      placeProvenance,
    };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run aggregate evaluation for stage + period and persist via
 * persist_journey_shadow_qa_report_v1.
 *
 * Fails closed if:
 *  - stage or cohort data cannot be read
 *  - no ground truth samples exist
 *  - retention is not fresh HEALTHY
 *  - any DB error occurs
 *  - journey_shadow_authorize_v1 denies raw_read for any session
 */
export async function evaluateJourneyShadowQa(
  sc: any,
  actorId: string,
  input: EvaluateInput,
): Promise<EvaluateResult> {
  // 1. Verify retention is HEALTHY before any reads
  let retention;
  try {
    retention = await queryJourneyRetentionHealth({ client: sc });
  } catch (err) {
    throw safeError("retention health check", err);
  }
  if (retention.state !== "HEALTHY") {
    throw new Error(
      `journey shadow qa: retention not HEALTHY (state=${retention.state}); evaluation blocked`,
    );
  }

  // 2. Read stage info to verify it exists
  let stageRow: { id: string; stage: string; max_accounts?: number } | null = null;
  try {
    const { data, error } = await sc
      .from("journey_shadow_stages")
      .select("id, stage, starts_at, ends_at, is_active, max_accounts")
      .eq("id", input.stageId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("stage not found");
    stageRow = data as { id: string; stage: string; max_accounts?: number };
  } catch (err) {
    throw safeError("load stage", err);
  }

  // 3. Load cohort assignment IDs for this stage — scoped by overlapping
  //    cohort window (cohort_starts_at <= periodEndsAt AND cohort_ends_at >= periodStartsAt).
  //    This is NOT filtered by assigned_at.
  let assignmentIds: string[] = [];
  try {
    const { data, error } = await sc
      .from("journey_shadow_cohort_assignments")
      .select("id")
      .eq("stage_id", input.stageId)
      .lte("cohort_starts_at", input.periodEndsAt)
      .gte("cohort_ends_at", input.periodStartsAt);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string }>;
    assignmentIds = rows.map((r) => r.id);
  } catch (err) {
    throw safeError("load cohort assignments", err);
  }

  if (assignmentIds.length === 0) {
    throw new Error("journey shadow qa: no cohort assignments found for stage+period; evaluation blocked");
  }

  // 4. Load journey_shadow_session_issuances for those assignment IDs to get
  //    exact issued location_session_ids and user_ids. This is the only valid
  //    scope for observations and revisions — never broad user_id.
  let issuedSessionIds: string[] = [];
  let sessionUserMap: Map<string, string> = new Map(); // sessionId -> userId
  try {
    const { data, error } = await sc
      .from("journey_shadow_session_issuances")
      .select("location_session_id, user_id")
      .in("assignment_id", assignmentIds);
    if (error) throw error;
    const rows = (data ?? []) as RawIssuanceRow[];
    for (const row of rows) {
      if (typeof row.location_session_id === "string" && row.location_session_id) {
        issuedSessionIds.push(row.location_session_id);
        if (typeof row.user_id === "string" && row.user_id) {
          sessionUserMap.set(row.location_session_id, row.user_id);
        }
      }
    }
  } catch (err) {
    throw safeError("load session issuances", err);
  }

  // 5. Load ground truth restricted to stage cohort and period — no user IDs exposed
  let groundTruthRows: RawGroundTruthRow[] = [];
  try {
    const { data, error } = await sc
      .from("journey_shadow_ground_truth")
      .select("ground_truth, location_session_id")
      .in("assignment_id", assignmentIds)
      .gte("recorded_at", input.periodStartsAt)
      .lte("recorded_at", input.periodEndsAt)
      .gt("expires_at", new Date().toISOString());
    if (error) throw error;
    groundTruthRows = ((data ?? []) as RawGroundTruthRow[]);
  } catch (err) {
    throw safeError("load ground truth", err);
  }

  if (groundTruthRows.length === 0) {
    throw new Error("journey shadow qa: zero ground truth samples; evaluation insufficient");
  }

  // 6. Load derived segment revisions per issued session through the SECURITY
  //    DEFINER RPC read_journey_shadow_qa_segment_revisions_v1. service_role no
  //    longer has direct SELECT on journey_segment_revisions; the RPC runs the
  //    central journey_shadow_authorize_v1(raw_read) in-transaction for the exact
  //    user+session (no TOCTOU) and RAISEs a generic 42501 on denial (no IDs).
  //    Any RPC error (including denial) blocks the entire evaluation — fail
  //    closed — mirroring the observation loader below. Revisions are scoped by
  //    exact location_session_id + user_id, never by broad user_id.
  const revisionRows: RawRevisionRow[] = [];
  for (const sessionId of issuedSessionIds) {
    const revisionUserId = sessionUserMap.get(sessionId) ?? null;
    try {
      const { data, error } = await sc.rpc("read_journey_shadow_qa_segment_revisions_v1", {
        p_actor: actorId,
        p_user_id: revisionUserId,
        p_location_session_id: sessionId,
        p_period_starts_at: input.periodStartsAt,
        p_period_ends_at: input.periodEndsAt,
      });
      if (error) {
        // Any RPC error (including a denial 42501) blocks the entire evaluation.
        // The RPC never leaks IDs in its error message.
        throw new Error(`rpc error: ${error.message ?? "unknown"}`);
      }
      const rows = (data ?? []) as RawRevisionRow[];
      if (rows.length > 10000) {
        throw new Error("segment revision row cap exceeded; evaluation blocked");
      }
      for (const row of rows) revisionRows.push(row);
    } catch {
      throw safeError("read_journey_shadow_qa_segment_revisions_v1 failed; evaluation blocked", null);
    }
  }

  // 7. Group revisions by location_session_id internally
  const revisionsBySession = new Map<string, JourneySegmentRevision[]>();
  for (const row of revisionRows) {
    const sessionId = typeof row.location_session_id === "string" ? row.location_session_id : "";
    if (!sessionId) continue;
    const revision = coerceRevision(row);
    if (!revision) continue;
    const existing = revisionsBySession.get(sessionId) ?? [];
    existing.push(revision);
    revisionsBySession.set(sessionId, existing);
  }

  // 8. For each issued session, call read_journey_shadow_qa_observations_v1 which
  //    runs _journey_shadow_require_admin_actor AND journey_shadow_authorize_v1
  //    (raw_read) inside the same SQL transaction before returning any rows — no
  //    TOCTOU gap. On denial the RPC RAISEs a generic 42501 (surfaced as an error
  //    here) so denial is cleanly distinguished from an authorised-but-empty
  //    session (which returns zero rows, no error). QA reads ALL quality classes
  //    (including 'unusable') to measure failure-mode distributions.
  //    Lat/lng are transiently read ONLY to compute in-memory haversine distances;
  //    coordinates are NEVER persisted, returned, or logged.
  const authorizedSessionIds = new Set<string>();
  const evidenceBySession = new Map<string, JourneyObservationEvidence>();

  for (const sessionId of issuedSessionIds) {
    const userId = sessionUserMap.get(sessionId) ?? null;
    let sessionRows: RawObservationRow[] = [];
    try {
      const { data, error } = await sc.rpc("read_journey_shadow_qa_observations_v1", {
        p_actor: actorId,
        p_user_id: userId,
        p_location_session_id: sessionId,
        p_period_starts_at: input.periodStartsAt,
        p_period_ends_at: input.periodEndsAt,
      });
      if (error) {
        // Any RPC error (including a denial 42501) blocks the entire evaluation
        // — fail closed. The RPC never leaks IDs in its error message.
        throw new Error(`rpc error: ${error.message ?? "unknown"}`);
      }
      sessionRows = ((data ?? []) as RawObservationRow[]);
    } catch {
      throw safeError("read_journey_shadow_qa_observations_v1 failed; evaluation blocked", null);
    }

    // Authorised-but-empty session: the RPC returned zero rows WITHOUT raising,
    // so this session is authorized but genuinely has no observations. Contribute
    // empty evidence. (Denial would have raised above and been caught.)
    if (sessionRows.length === 0) {
      authorizedSessionIds.add(sessionId);
      evidenceBySession.set(sessionId, {
        orderedTimestampsMs: [],
        consecutiveDistancesM: [],
        qualityReasonSets: [],
      });
      continue;
    }

    authorizedSessionIds.add(sessionId);

    // Group and sort observations. We transiently retain lat/lng in memory ONLY
    // to compute haversine distances immediately below; coordinates are discarded
    // when the local array goes out of scope.
    const obs: Array<{ tsMs: number; reasons: string[]; lat: number | null; lng: number | null }> = [];
    for (const row of sessionRows) {
      const tsMs = typeof row.observed_at === "string" ? Date.parse(row.observed_at) : NaN;
      if (!Number.isFinite(tsMs)) continue;
      const reasons = Array.isArray(row.quality_reasons)
        ? (row.quality_reasons as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      const lat = typeof row.lat === "number" && Number.isFinite(row.lat) ? row.lat : null;
      const lng = typeof row.lng === "number" && Number.isFinite(row.lng) ? row.lng : null;
      obs.push({ tsMs, reasons, lat, lng });
    }
    obs.sort((a, b) => a.tsMs - b.tsMs);

    const orderedTimestampsMs = obs.map((o) => o.tsMs);
    const qualityReasonSets = obs.map((o) => o.reasons);

    // Compute consecutive haversine distances (metres) in memory. Only the
    // resulting distance numbers are kept — coordinates are discarded when
    // `obs` goes out of scope. No coordinate ever reaches evidence/payload.
    const consecutiveDistancesM: number[] = [];
    for (let i = 1; i < obs.length; i++) {
      const prev = obs[i - 1]!;
      const cur = obs[i]!;
      if (prev.lat != null && prev.lng != null && cur.lat != null && cur.lng != null) {
        consecutiveDistancesM.push(
          haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng),
        );
      }
    }

    evidenceBySession.set(sessionId, {
      orderedTimestampsMs,
      consecutiveDistancesM,
      qualityReasonSets,
    });
  }

  // 10. Build fixtures from ground truth — group by session, match revisions + evidence
  const fixtures: JourneyGroundTruthFixture[] = [];
  for (const row of groundTruthRows) {
    const parsed = parseGroundTruthPayload(row);
    if (!parsed) continue;

    // Only include fixtures for sessions that are issued AND authorized
    if (parsed.locationSessionId && !authorizedSessionIds.has(parsed.locationSessionId)) {
      // Session not authorized — skip this fixture
      continue;
    }

    const sessionRevisions = parsed.locationSessionId
      ? (revisionsBySession.get(parsed.locationSessionId) ?? [])
      : [];

    const evidence = parsed.locationSessionId
      ? (evidenceBySession.get(parsed.locationSessionId) ?? null)
      : null;

    fixtures.push({
      condition: parsed.condition,
      expectedArrivalAt: parsed.expectedArrivalAt,
      expectedDepartureAt: parsed.expectedDepartureAt,
      expectedDwellS: parsed.expectedDwellS,
      expectedPlaceId: parsed.expectedPlaceId,
      expectedCategoryId: parsed.expectedCategoryId,
      revisions: sessionRevisions,
      observationEvidence: evidence,
    });
  }

  if (fixtures.length === 0) {
    throw new Error("journey shadow qa: ground truth parsed to zero valid fixtures; evaluation blocked");
  }

  // 11. Calculate aggregate metrics — no IDs, coordinates, or raw values returned
  const metrics = measureJourneyGroundTruth(fixtures);

  // 12. Build aggregate-only QA payload — no user IDs, no session IDs, no raw timestamps
  const payload: Record<string, unknown> = {
    stageId: input.stageId,
    stage: (stageRow as any).stage,
    maxAccounts: (stageRow as any).max_accounts ?? null,
    periodStartsAt: input.periodStartsAt,
    periodEndsAt: input.periodEndsAt,
    cohortAssignmentCount: assignmentIds.length,
    fixtureCount: fixtures.length,
    groundTruthCount: groundTruthRows.length,
    revisionSessionCount: revisionsBySession.size,
    fixtures: metrics.fixtures,
    arrivalErrorDist: metrics.arrivalErrorDist,
    departureErrorDist: metrics.departureErrorDist,
    dwellErrorDist: metrics.dwellErrorDist,
    falseStop: metrics.falseStop,
    falseDwell: metrics.falseDwell,
    placeMatch: metrics.placeMatch,
    categoryMatch: metrics.categoryMatch,
    confidenceCalibration: metrics.confidenceCalibration,
    jitterDistM: metrics.jitterDistM,
    samplingGapDist: metrics.samplingGapDist,
    impossibleSpeedEvents: metrics.impossibleSpeedEvents,
    byCondition: metrics.byCondition,
  };

  // 13. Persist aggregate-only QA report
  let reportId: string;
  try {
    const { data, error } = await sc.rpc("persist_journey_shadow_qa_report_v1", {
      p_actor: actorId,
      p_stage_id: input.stageId,
      p_report_type: "segment_accuracy",
      p_period_starts_at: input.periodStartsAt,
      p_period_ends_at: input.periodEndsAt,
      p_payload: payload,
      p_notes: null,
    });
    if (error) throw error;
    if (typeof data !== "string") throw new Error("unexpected return from persist QA report RPC");
    reportId = data;
  } catch (err) {
    throw safeError("persist QA report", err);
  }

  return {
    reportId,
    metrics,
    fixtureCount: fixtures.length,
  };
}

// ── Shadow Rating ─────────────────────────────────────────────────────────────

const FALSE_STOP_THRESHOLD = 0.15;
const FALSE_DWELL_THRESHOLD = 0.20;
const UNKNOWN_RATIO_THRESHOLD = 0.5;
const PLACE_MATCH_MIN_RATE = 0.5;
const CALIBRATION_MAX_UNCERTAINTY = 0.8;

/**
 * Evidence-based shadow rating — deterministic, conservative, fail-closed.
 *
 * Blocking conditions (rating = "blocked"):
 *   - Any retention not fresh HEALTHY
 *   - Zero truth samples
 *
 * Insufficient conditions (rating = "insufficient"):
 *   - Privacy or authorization failure (unknown place/category too high)
 *
 * Never says behavior/pattern inference is ready.
 */
export function computeShadowRating(
  metrics: JourneyGroundTruthMetrics,
  retentionState: string,
  fixtureCount: number,
): ShadowRating {
  const reasons: string[] = [];

  // Retention not fresh HEALTHY always blocks
  if (retentionState !== "HEALTHY") {
    return {
      rating: "blocked",
      behaviorPatternInferenceReady: false,
      reasons: [`retention_not_healthy:${retentionState}`],
    };
  }

  // Zero truth samples blocks
  if (fixtureCount === 0 || metrics.fixtures === 0) {
    return {
      rating: "blocked",
      behaviorPatternInferenceReady: false,
      reasons: ["zero_truth_samples"],
    };
  }

  // Privacy failure: too many unknowns in place/category when expected
  let isInsufficient = false;

  if (metrics.placeMatch.expectedCount > 0) {
    const unknownRatio = metrics.placeMatch.unknownCount / metrics.placeMatch.expectedCount;
    if (unknownRatio > UNKNOWN_RATIO_THRESHOLD) {
      isInsufficient = true;
      reasons.push(`place_unknown_ratio:${unknownRatio.toFixed(3)}`);
    }
  }

  if (metrics.categoryMatch.expectedCount > 0) {
    const unknownRatio = metrics.categoryMatch.unknownCount / metrics.categoryMatch.expectedCount;
    if (unknownRatio > UNKNOWN_RATIO_THRESHOLD) {
      isInsufficient = true;
      reasons.push(`category_unknown_ratio:${unknownRatio.toFixed(3)}`);
    }
  }

  if (isInsufficient) {
    return {
      rating: "insufficient",
      behaviorPatternInferenceReady: false,
      reasons,
    };
  }

  // Authorization failure: false stop/dwell rates block
  if (metrics.falseStop.eligibleCount > 0 && metrics.falseStop.rate > FALSE_STOP_THRESHOLD) {
    reasons.push(`false_stop_rate:${metrics.falseStop.rate.toFixed(3)}`);
  }
  if (metrics.falseDwell.eligibleCount > 0 && metrics.falseDwell.rate > FALSE_DWELL_THRESHOLD) {
    reasons.push(`false_dwell_rate:${metrics.falseDwell.rate.toFixed(3)}`);
  }

  // Calibration failure: any state bucket with mean uncertainty too high blocks
  for (const [state, cal] of Object.entries(metrics.confidenceCalibration)) {
    if (cal.count > 0 && cal.meanUncertaintyScore > CALIBRATION_MAX_UNCERTAINTY) {
      reasons.push(`calibration_high_uncertainty:${state}:${cal.meanUncertaintyScore.toFixed(3)}`);
    }
  }

  // Impossible speed events: any is a concern but not blocking alone
  if (metrics.impossibleSpeedEvents > 0) {
    reasons.push(`impossible_speed_events:${metrics.impossibleSpeedEvents}`);
  }

  // Determine rating
  if (reasons.length > 0) {
    const hasFalseRateViolation = reasons.some(
      (r) => r.startsWith("false_stop_rate") || r.startsWith("false_dwell_rate"),
    );
    const hasCalibrationViolation = reasons.some((r) =>
      r.startsWith("calibration_high_uncertainty"),
    );
    if (hasFalseRateViolation || hasCalibrationViolation) {
      return {
        rating: "poor",
        behaviorPatternInferenceReady: false,
        reasons,
      };
    }
    // Only speed events — still promising but noted
    return {
      rating: "promising",
      behaviorPatternInferenceReady: false,
      reasons,
    };
  }

  // Check if place matching is good enough for "ready_for_larger_shadow_only"
  if (
    metrics.placeMatch.expectedCount > 0 &&
    metrics.placeMatch.matchedCount / metrics.placeMatch.expectedCount >= PLACE_MATCH_MIN_RATE
  ) {
    return {
      rating: "ready_for_larger_shadow_only",
      behaviorPatternInferenceReady: false,
      reasons,
    };
  }

  return {
    rating: "promising",
    behaviorPatternInferenceReady: false,
    reasons,
  };
}
