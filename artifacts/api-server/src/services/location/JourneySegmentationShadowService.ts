/**
 * Restricted persistence boundary for shadow-only Journey segment revisions.
 *
 * The write-only Journey observation route calls the restricted session runner
 * after a batch is accepted. It re-reads only that owner's active session rows
 * and never exposes segment output. All controls are read uncached on every
 * call; the Compass 30-second presentation cache is never an authorization
 * boundary.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  segmentJourney,
  type SegmentJourneyInput,
  type JourneySegmentRevision,
  type RestrictedJourneyObservation,
} from "./JourneySegmenter.js";

export const JOURNEY_SEGMENT_MAX_SOURCE_OBSERVATIONS = 10_000;
export const JOURNEY_SEGMENT_PROVENANCE_VERSION = "journey-segment-provenance-v1";

export type JourneyShadowPersistResult =
  | { status: "disabled"; revisionCount: 0; revisions: [] }
  | { status: "authorization_required"; revisionCount: 0; revisions: [] }
  | {
      status: "persisted";
      revisionCount: number;
      revisions: JourneySegmentRevision[];
    };

type JourneyShadowAuthorization =
  | "authorized"
  | "feature_disabled"
  | "not_authorized"
  | "temporarily_unavailable";

async function authorizeJourneyShadow(
  db: SupabaseClient,
  input: Pick<SegmentJourneyInput, "userId" | "locationSessionId">,
  operation: "raw_read" | "derived_write",
): Promise<JourneyShadowAuthorization> {
  try {
    const { data, error } = await db.rpc("journey_shadow_authorize_v1", {
      p_user_id: input.userId,
      p_location_session_id: input.locationSessionId,
      p_operation: operation,
      p_observed_at: null,
      p_source: null,
    });
    if (error) return "temporarily_unavailable";
    return data === "authorized"
      || data === "feature_disabled"
      || data === "not_authorized"
      || data === "temporarily_unavailable"
      ? data
      : "temporarily_unavailable";
  } catch {
    return "temporarily_unavailable";
  }
}

function deniedResult(
  authorization: Exclude<JourneyShadowAuthorization, "authorized">,
): JourneyShadowPersistResult {
  return authorization === "feature_disabled"
    ? { status: "disabled", revisionCount: 0, revisions: [] }
    : { status: "authorization_required", revisionCount: 0, revisions: [] };
}

export async function persistJourneySegmentsShadow(
  db: SupabaseClient,
  input: SegmentJourneyInput,
): Promise<JourneyShadowPersistResult> {
  const authorization = await authorizeJourneyShadow(db, input, "derived_write");
  if (authorization !== "authorized") return deniedResult(authorization);

  const revisions = segmentJourney(input);
  if (revisions.length === 0) {
    return { status: "persisted", revisionCount: 0, revisions };
  }

  const rows = revisions.map((revision) => ({
    id: revision.revisionId,
    user_id: revision.userId,
    location_session_id: revision.locationSessionId,
    segment_key: revision.segmentKey,
    supersedes_id: revision.supersedesRevisionId,
    revision_index: revision.revisionIndex,
    state: revision.state,
    started_at: revision.startedAt,
    ended_at: revision.endedAt,
    duration_s: revision.durationS,
    world_ref: revision.worldRef,
    movement_class: revision.movementClass,
    uncertainty_score: revision.uncertainty.score,
    uncertainty_tier: revision.uncertainty.tier,
    reason_codes: revision.uncertainty.reasons,
    median_accuracy_m: revision.evidence.medianAccuracyM,
    max_gap_seconds: revision.evidence.maxGapSeconds,
    stop_radius_m: revision.evidence.stopRadiusM,
    uncertainty_computed_at: revision.uncertainty.computedAt,
    algorithm_version: revision.algorithmVersion,
    observation_count: revision.evidence.observationCount,
    expires_at: revision.expiresAt,
    quality_version: revision.qualitySummary.scorerVersion,
    quality_score: revision.qualitySummary.medianQualityScore,
    quality_class:
      revision.qualitySummary.medianQualityScore == null
        ? null
        : revision.qualitySummary.medianQualityScore >= 0.8
          ? "high"
          : revision.qualitySummary.medianQualityScore >= 0.5
            ? "usable"
            : "degraded",
    quality_reasons: revision.evidence.reasonCodes,
    provenance_version: JOURNEY_SEGMENT_PROVENANCE_VERSION,
    segment_started_at: revision.startedAt,
    segment_ended_at: revision.endedAt,
    place_category: null,
    place_subcategory: null,
    timing_uncertainty: revision.timingUncertainty,
    quality_summary: revision.qualitySummary,
    place_provenance: revision.placeProvenance,
  }));

  const { error } = await db.rpc("append_journey_segment_revisions_v2", {
    p_rows: rows,
  });
  if (error) throw new Error(`append journey segment revisions: ${error.message}`);

  return { status: "persisted", revisionCount: revisions.length, revisions };
}

interface RawJourneyObservationRow {
  id: unknown;
  observed_at: unknown;
  source: unknown;
  lat: unknown;
  lng: unknown;
  accuracy_m: unknown;
  speed_mps: unknown;
  quality_version: unknown;
  quality_score: unknown;
  quality_class: unknown;
  quality_reasons: unknown;
}

function toRestrictedObservation(row: RawJourneyObservationRow): RestrictedJourneyObservation {
  const id = typeof row.id === "string" ? row.id : "";
  const observedAt = typeof row.observed_at === "string" ? row.observed_at : "";
  const source = row.source === "foreground_gps" || row.source === "background_gps"
    ? row.source
    : null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  const accuracyM = Number(row.accuracy_m);
  const speedMps = row.speed_mps == null ? null : Number(row.speed_mps);
  const qualityVersion = typeof row.quality_version === "string" ? row.quality_version : "";
  const qualityScore = Number(row.quality_score);
  const qualityClass =
    row.quality_class === "high"
    || row.quality_class === "usable"
    || row.quality_class === "degraded"
    || row.quality_class === "unusable"
      ? row.quality_class
      : null;
  const qualityReasons = Array.isArray(row.quality_reasons)
    && row.quality_reasons.every((reason) => typeof reason === "string")
    ? [...row.quality_reasons]
    : null;
  if (
    !id ||
    !source ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(accuracyM) ||
    (speedMps != null && !Number.isFinite(speedMps)) ||
    !qualityVersion ||
    !Number.isFinite(qualityScore) ||
    qualityScore < 0 ||
    qualityScore > 1 ||
    !qualityClass ||
    !qualityReasons
  ) {
    throw new Error("invalid restricted Journey observation row");
  }
  return {
    id,
    observedAt,
    source,
    lat,
    lng,
    accuracyM,
    speedMps,
    quality: {
      qualityVersion,
      qualityScore,
      qualityClass,
      qualityReasons,
      gpsSegmentable: qualityClass !== "unusable",
    },
  };
}

/**
 * Restricted post-ingest runner. Calls read_journey_shadow_observations_v1
 * which runs journey_shadow_authorize_v1(raw_read) inside the same SQL
 * transaction before returning any rows — no TOCTOU gap between authorize
 * and select. The separate app-level authorizeJourneyShadow call that
 * previously preceded the direct table read has been removed; the RPC
 * handles authorization atomically inside the SQL transaction.
 *
 * Unusable rows are excluded by the RPC (quality_class <> 'unusable') so
 * they never enter GPS segmentation.
 */
export async function processJourneySegmentationShadowSession(
  db: SupabaseClient,
  userId: string,
  locationSessionId: string,
): Promise<JourneyShadowPersistResult> {
  // read_journey_shadow_observations_v1 authorises and reads atomically.
  // It returns zero rows on any denial (fails closed); no error is raised.
  const { data, error } = await db.rpc("read_journey_shadow_observations_v1", {
    p_user_id: userId,
    p_location_session_id: locationSessionId,
  });

  if (error) {
    throw new Error(`read Journey shadow observations: ${error.message}`);
  }

  const rows = (data ?? []) as RawJourneyObservationRow[];

  // Zero rows on denial — the RPC returns empty rather than raising.
  // Distinguish denial from a genuinely empty session by checking auth
  // separately only when we get zero rows and need to decide the result status.
  if (rows.length === 0) {
    // Try derived_write auth to distinguish "feature_disabled" from "not_authorized".
    // If auth is denied at this stage, return the appropriate denied status.
    const emptyInput: SegmentJourneyInput = {
      userId,
      locationSessionId,
      observations: [],
    };
    const authorization = await authorizeJourneyShadow(db, emptyInput, "derived_write");
    if (authorization !== "authorized") return deniedResult(authorization);
    // Genuinely empty session (no eligible observations) — persist zero revisions.
    return persistJourneySegmentsShadow(db, { userId, locationSessionId, observations: [] });
  }

  if (rows.length > JOURNEY_SEGMENT_MAX_SOURCE_OBSERVATIONS) {
    throw new Error("Journey shadow observation safety limit exceeded");
  }

  return persistJourneySegmentsShadow(db, {
    userId,
    locationSessionId,
    observations: rows.map(toRestrictedObservation),
  });
}
