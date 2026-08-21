/**
 * JourneyShadowRolloutService
 *
 * Internal-only service wrapping each admin-facing Journey shadow-rollout RPC.
 * All calls pass ctx.userId as p_actor and p_approved_by — never from request body.
 * RPC failures are caught and re-thrown as safe Error objects (no raw DB details).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigureStageInput {
  stage: "internal" | "qa" | "consented";
  startsAt: string;  // ISO datetime
  endsAt: string;    // ISO datetime
  /** approvedAt must be server-generated (Date.now()), never from request body. */
  approvedAt: string;
}

export interface AssignCohortInput {
  userId: string;
  stageId: string;
  cohortStartsAt: string;
  cohortEndsAt: string;
}

export interface IssueSessionInput {
  assignmentId: string;
  sessionType: "live_share" | "trip_check_in";
  expiresAt: string;
}

export interface RecordGroundTruthInput {
  assignmentId: string;
  /** p_location_session_id: coded for future evolution; may not be in DB yet */
  locationSessionId: string;
  recordedAt: string;
  /** Canonical place UUID — never coordinates */
  expectedPlaceId: string | null;
  /** Canonical category UUID — never coordinates */
  expectedCategoryId: string | null;
  expectedArrivalAt: string | null;
  expectedDepartureAt: string | null;
  expectedDwellSeconds: number | null;
  expectedStop: boolean;
  notes: string | null;
}

export interface ConfigureStageResult {
  stageId: string;
}

export interface AssignCohortResult {
  assignmentId: string;
}

export interface RevokeAssignmentResult {
  revoked: boolean;
}

export interface IssueSessionResult {
  locationSessionId: string;
}

export interface GlobalStopResult {
  flagsDisabled: number;
  stagesStopped: number;
  assignmentsRevoked: number;
  sessionsEnded: number;
  groundTruthDeleted: number;
  observationsDeleted: number;
  segmentsDeleted: number;
  stoppedAt: string;
}

export interface RecordGroundTruthResult {
  groundTruthId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeError(context: string, err: unknown): Error {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  // Do not propagate raw DB messages (table names, constraint names, etc.)
  // Map to safe generic messages while preserving the context label.
  return new Error(`journey shadow rollout: ${context} failed`);
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * configure_journey_shadow_stage_v1
 *
 * p_approved_by is always set to actorId (same as p_actor) — never from request.
 * p_approved_at is always the server-generated approvedAt — never from request.
 */
export async function configureJourneyShadowStage(
  sc: any,
  actorId: string,
  input: ConfigureStageInput,
): Promise<ConfigureStageResult> {
  try {
    const { data, error } = await sc.rpc("configure_journey_shadow_stage_v1", {
      p_actor: actorId,
      p_stage: input.stage,
      p_starts_at: input.startsAt,
      p_ends_at: input.endsAt,
      p_approved_by: actorId,  // always actor, never from request
      p_approved_at: input.approvedAt,
    });
    if (error) throw error;
    if (typeof data !== "string") throw new Error("unexpected return from configure stage RPC");
    return { stageId: data };
  } catch (err) {
    throw safeError("configure stage", err);
  }
}

/**
 * assign_journey_shadow_cohort_v1
 */
export async function assignJourneyShadowCohort(
  sc: any,
  actorId: string,
  input: AssignCohortInput,
): Promise<AssignCohortResult> {
  try {
    const { data, error } = await sc.rpc("assign_journey_shadow_cohort_v1", {
      p_actor: actorId,
      p_user_id: input.userId,
      p_stage_id: input.stageId,
      p_cohort_starts_at: input.cohortStartsAt,
      p_cohort_ends_at: input.cohortEndsAt,
    });
    if (error) throw error;
    if (typeof data !== "string") throw new Error("unexpected return from assign cohort RPC");
    return { assignmentId: data };
  } catch (err) {
    throw safeError("assign cohort", err);
  }
}

/**
 * revoke_journey_shadow_cohort_v1
 */
export async function revokeJourneyShadowCohort(
  sc: any,
  actorId: string,
  assignmentId: string,
): Promise<RevokeAssignmentResult> {
  try {
    const { data, error } = await sc.rpc("revoke_journey_shadow_cohort_v1", {
      p_actor: actorId,
      p_assignment_id: assignmentId,
    });
    if (error) throw error;
    return { revoked: data === true };
  } catch (err) {
    throw safeError("revoke cohort", err);
  }
}

/**
 * issue_journey_shadow_session_v1
 */
export async function issueJourneyShadowSession(
  sc: any,
  actorId: string,
  input: IssueSessionInput,
): Promise<IssueSessionResult> {
  try {
    const { data, error } = await sc.rpc("issue_journey_shadow_session_v1", {
      p_actor: actorId,
      p_assignment_id: input.assignmentId,
      p_session_type: input.sessionType,
      p_expires_at: input.expiresAt,
    });
    if (error) throw error;
    if (typeof data !== "string") throw new Error("unexpected return from issue session RPC");
    return { locationSessionId: data };
  } catch (err) {
    throw safeError("issue session", err);
  }
}

/**
 * global_journey_shadow_stop_v1
 */
export async function globalJourneyShadowStop(
  sc: any,
  actorId: string,
): Promise<GlobalStopResult> {
  try {
    const { data, error } = await sc.rpc("global_journey_shadow_stop_v1", {
      p_actor: actorId,
    });
    if (error) throw error;
    if (!data || typeof data !== "object") {
      throw new Error("unexpected return from global stop RPC");
    }
    const d = data as Record<string, unknown>;
    return {
      flagsDisabled: Number(d["flags_disabled"] ?? 0),
      stagesStopped: Number(d["stages_stopped"] ?? 0),
      assignmentsRevoked: Number(d["assignments_revoked"] ?? 0),
      sessionsEnded: Number(d["sessions_ended"] ?? 0),
      groundTruthDeleted: Number(d["ground_truth_deleted"] ?? 0),
      observationsDeleted: Number(d["observations_deleted"] ?? 0),
      segmentsDeleted: Number(d["segments_deleted"] ?? 0),
      stoppedAt: typeof d["stopped_at"] === "string" ? d["stopped_at"] : new Date().toISOString(),
    };
  } catch (err) {
    throw safeError("global stop", err);
  }
}

/**
 * record_journey_shadow_ground_truth_v1
 *
 * Builds the aggregate-only ground_truth payload (no coordinates, no raw IDs).
 * Codes for p_location_session_id per task spec (future migration evolution).
 */
export async function recordJourneyShadowGroundTruth(
  sc: any,
  actorId: string,
  input: RecordGroundTruthInput,
): Promise<RecordGroundTruthResult> {
  // Build aggregate-only ground_truth payload — no coordinates, no raw user/session IDs
  const groundTruth: Record<string, unknown> = {
    expectedStop: input.expectedStop,
  };
  if (input.expectedArrivalAt !== null && input.expectedArrivalAt !== undefined) {
    groundTruth["expectedArrivalAt"] = input.expectedArrivalAt;
  }
  if (input.expectedDepartureAt !== null && input.expectedDepartureAt !== undefined) {
    groundTruth["expectedDepartureAt"] = input.expectedDepartureAt;
  }
  if (input.expectedDwellSeconds !== null && input.expectedDwellSeconds !== undefined) {
    groundTruth["expectedDwellSeconds"] = input.expectedDwellSeconds;
  }
  if (input.expectedPlaceId !== null && input.expectedPlaceId !== undefined) {
    groundTruth["expectedPlaceId"] = input.expectedPlaceId;
  }
  if (input.expectedCategoryId !== null && input.expectedCategoryId !== undefined) {
    groundTruth["expectedCategoryId"] = input.expectedCategoryId;
  }

  try {
    const { data, error } = await sc.rpc("record_journey_shadow_ground_truth_v1", {
      p_actor: actorId,
      p_assignment_id: input.assignmentId,
      // Code for future evolution: location_session_id may be added to the RPC/table
      p_location_session_id: input.locationSessionId,
      p_recorded_at: input.recordedAt,
      p_ground_truth: groundTruth,
      p_notes: input.notes ?? null,
    });
    if (error) throw error;
    if (typeof data !== "string") throw new Error("unexpected return from ground truth RPC");
    return { groundTruthId: data };
  } catch (err) {
    throw safeError("record ground truth", err);
  }
}
