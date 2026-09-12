/**
 * Trips §11 — `POST /trips/:tripId/commands`, the endpoint the spec names.
 *
 * §11's API list, verbatim: "POST /trips/:id/commands".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Ten command families were added to trip_kernel_execute across migrations
 * 2764–2777 — stages, legs, commitments, goals, decision tasks, risks,
 * presence, proposals, outcomes, attendance and voting — and NOT ONE of them
 * was reachable from the product. Every route that calls executeTripCommand
 * (routes/trips-expansion.ts, routePlan.ts, hiddenGems.ts, compass.ts and the
 * rest) sends only plan-item and participant commands, because those are the
 * legacy writes the kernel was retrofitted under. A command family nothing can
 * issue is a table with a stored procedure attached, not a capability.
 *
 * This is one endpoint rather than thirty, because the kernel already IS a
 * command bus: the envelope is §4.1's, the authorization is per command inside
 * the function, and the failure vocabulary is one set of reason codes. Thirty
 * endpoints would each restate the envelope and each get the authorization
 * slightly differently.
 *
 * THE FLAG DOES NOT GATE THIS, AND THAT IS NOT AN OVERSIGHT
 * ========================================================
 * `trip_kernel_enabled` gates whether the LEGACY writers route through the
 * kernel instead of writing directly — it is a cutover switch for paths that
 * already exist and already work. The families below have NO legacy path: there
 * is no other way to write a stage, and gating them off would not fall back to
 * anything, it would just refuse. So this endpoint issues commands regardless
 * of the flag, and `plan` and `participant` family commands are REFUSED here
 * precisely because those DO have a legacy path and a cutover of their own.
 * Sending ADD_PLAN here would route around the flag it exists to respect.
 *
 * AUTHORIZATION IS BOTH PLACES, ON PURPOSE
 * ========================================
 * The route requires a verified user and trip membership before issuing
 * anything; the kernel then re-checks the capability each command needs (§6.2:
 * "service-role mutations still pass application authorization"). The route's
 * check is not redundant — it is what keeps a non-member from reaching the
 * kernel at all, and it produces a 403 rather than a modelled refusal, which is
 * the right answer to "you are not on this trip".
 *
 * actorUserId comes from the VERIFIED TOKEN and never from the body. A body
 * that names an actor is refused rather than ignored: silently overriding it
 * would let a caller believe they had acted as someone else.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { executeTripCommand, type TripCommandType } from "../lib/tripKernel.js";

const router = Router();
const log = logger.child({ mod: "tripCommands" });

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * The families this endpoint issues: the ones with no legacy writer.
 *
 * An allowlist and not a denylist. A command type added to the kernel later is
 * NOT reachable here until someone adds it and thinks about which side of the
 * cutover it is on — which is the safe direction to be wrong in.
 */
export const COMMANDS_ENDPOINT_TYPES: readonly TripCommandType[] = [
  // §5.1 stage spine (2764, 2765)
  "ADD_STAGE", "UPDATE_STAGE", "REMOVE_STAGE",
  "ADD_LEG", "UPDATE_LEG", "REMOVE_LEG",
  "ADD_COMMITMENT", "UPDATE_COMMITMENT", "REMOVE_COMMITMENT",
  // §8 goals, decisions, risks (2766)
  "ADD_GOAL", "UPDATE_GOAL", "REMOVE_GOAL",
  "ADD_DECISION_TASK", "UPDATE_DECISION_TASK", "REMOVE_DECISION_TASK",
  "ADD_RISK", "UPDATE_RISK", "REMOVE_RISK",
  // §10 presence (2768, 2777)
  "SET_PRESENCE", "CLEAR_PRESENCE",
  // §9.3 proposals (2768, 2775)
  "CREATE_PROPOSAL", "VOTE_ON_PROPOSAL", "ACCEPT_PROPOSAL", "REJECT_PROPOSAL",
  // §20.1 outcomes (2768)
  "RECORD_OUTCOME",
  // §9.1 attendance (2772)
  "JOIN_PLAN", "LEAVE_PLAN", "SET_PLAN_ATTENDANCE",
  // 2779: no legacy twin writes in_progress / skipped or moves a stage.
  "START_PLAN", "SKIP_PLAN", "START_STAGE", "COMPLETE_STAGE",
  // 2780, 2782, 2785: families whose tables arrived with them.
  "CREATE_SUBGROUP", "JOIN_SUBGROUP", "LEAVE_SUBGROUP", "DISSOLVE_SUBGROUP",
  "ADD_TRANSPORT_SEGMENT", "UPDATE_TRANSPORT_SEGMENT", "SET_TRANSPORT_STATE", "REMOVE_TRANSPORT_SEGMENT",
  "DECLARE_DISRUPTION", "RESOLVE_DISRUPTION",
  "MARK_COMMITMENT_AT_RISK", "CLEAR_COMMITMENT_RISK", "OPEN_FREE_WINDOW", "RECORD_OPPORTUNITY_CHANGE",
] as const;

const ISSUABLE = new Set<string>(COMMANDS_ENDPOINT_TYPES);

/**
 * Refused here, and named so the message can say WHY rather than "unknown".
 * These have a legacy writer and a flag-gated cutover; issuing them through
 * this endpoint would route around `trip_kernel_enabled`.
 */
export const CUTOVER_GATED_TYPES: ReadonlySet<string> = new Set([
  "ADD_PLAN", "UPDATE_PLAN", "MOVE_PLAN", "CONFIRM_PLAN", "CANCEL_PLAN",
  "COMPLETE_ACTIVITY", "REMOVE_PLAN", "REORDER_PLAN", "LINK_PLAN_ROUTE_STOP",
  "CREATE_TRIP", "UPDATE_TRIP", "CANCEL_TRIP", "COMPLETE_TRIP", "ARCHIVE_TRIP",
  "INVITE_PARTICIPANT", "ADD_PARTICIPANT", "SET_PARTICIPANT_ROLE",
  "REMOVE_PARTICIPANT", "ACCEPT_INVITE", "DECLINE_INVITE", "JOIN_VIA_LINK",
  "ADMIN_HIDE_TRIP", "SET_TRIP_COVER",
]);

/** Reason codes that mean "you may not", so they map to 403 rather than 409. */
const FORBIDDEN_REASONS = new Set([
  "TRIP_AUTH_NOT_CREW", "TRIP_AUTH_NOT_OWNER", "TRIP_AUTH_NOT_HOST",
  "TRIP_AUTH_NOT_INVITED", "TRIP_AUTH_NOT_ADMIN", "TRIP_AUTH_NOT_LINK_HOLDER",
  "TRIP_AUTH_ROLE_NOT_PERMITTED", "TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN",
  "TRIP_PRESENCE_NOT_SELF", "TRIP_ASSIGNEE_NOT_CREW",
  "TRIP_AUTH_NOT_CREATOR", "TRIP_SUBGROUP_NOT_MEMBER", "TRIP_SUBGROUP_MEMBER_NOT_CREW",
]);
/** Reason codes that mean "the thing you named is not here". */
const NOT_FOUND_REASONS = new Set([
  "TRIP_NOT_FOUND", "TRIP_PLAN_NOT_FOUND", "TRIP_STAGE_NOT_FOUND",
  "TRIP_LEG_NOT_FOUND", "TRIP_COMMITMENT_NOT_FOUND", "TRIP_GOAL_NOT_FOUND",
  "TRIP_DECISION_TASK_NOT_FOUND", "TRIP_RISK_NOT_FOUND",
  "TRIP_PRESENCE_NOT_FOUND", "TRIP_PROPOSAL_NOT_FOUND",
  "TRIP_PARTICIPANT_NOT_FOUND", "TRIP_PLAN_ATTENDANCE_NOT_FOUND",
  "TRIP_SUBGROUP_NOT_FOUND", "TRIP_TRANSPORT_NOT_FOUND", "TRIP_DISRUPTION_NOT_FOUND",
]);
/** Reason codes that mean "not from here": the state refuses the arrow, or the version moved. 409. */
const CONFLICT_REASONS = new Set([
  "TRIP_VERSION_CONFLICT", "TRIP_PLAN_VERSION_CONFLICT",
  "TRIP_IDENTITY_ALREADY_EXISTS", "TRIP_PARTICIPANT_ALREADY_EXISTS",
  "TRIP_STAGE_SEQUENCE_TAKEN", "TRIP_PROPOSAL_NOT_PENDING",
  "TRIP_TEMPORAL_CONFLICT", "TRIP_PLAN_INVALID_TRANSITION", "TRIP_STAGE_INVALID_TRANSITION",
  "TRIP_TRANSPORT_INVALID_TRANSITION", "TRIP_DISRUPTION_NOT_ACTIVE", "TRIP_LIFECYCLE_INVALID_TRANSITION",
]);

router.post("/trips/:tripId/commands", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // The actor is the token's subject. A body that names one is REFUSED rather
  // than ignored: silently overriding it would let a caller believe they had
  // acted as someone else, and believe it right up until they checked.
  if ("actor_user_id" in body || "actorUserId" in body || "actor_role" in body) {
    sendError(res, "invalid_payload",
      "actor_user_id and actor_role are taken from the verified token and must not be sent");
    return;
  }

  const type = typeof body.type === "string" ? body.type : "";
  if (!type) { sendError(res, "invalid_payload", "type is required"); return; }

  if (CUTOVER_GATED_TYPES.has(type)) {
    // Named, not lumped into "unknown": the caller is sending a real command to
    // the wrong door, and the message should say which door.
    sendError(res, "invalid_payload",
      `${type} has a legacy writer and a flag-gated cutover; it is issued by its own route, not this endpoint`);
    return;
  }
  if (!ISSUABLE.has(type)) {
    sendError(res, "invalid_payload", `${type} is not a command this endpoint issues`);
    return;
  }

  const payload = body.payload;
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    sendError(res, "invalid_payload", "payload must be an object");
    return;
  }

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    // Required, not defaulted. A generated key would make every retry a NEW
    // command and defeat the receipt the kernel keeps for exactly this.
    sendError(res, "invalid_payload",
      "idempotency_key is required (1-200 chars) — a generated one would make every retry a new command");
    return;
  }

  let expectedTripVersion: number | null = null;
  if (body.expected_trip_version !== undefined && body.expected_trip_version !== null) {
    const v = Number(body.expected_trip_version);
    if (!Number.isSafeInteger(v) || v < 0) {
      sendError(res, "invalid_payload", "expected_trip_version must be a non-negative integer");
      return;
    }
    expectedTripVersion = v;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  const result = await executeTripCommand(sc, {
    commandId: randomUUID(),
    tripId,
    actorUserId: user.id,
    actorRole: "user",
    expectedTripVersion,
    idempotencyKey,
    type: type as TripCommandType,
    payload: (payload as Record<string, unknown>) ?? {},
    clientObservedAt: typeof body.client_observed_at === "string" ? body.client_observed_at : null,
    correlationId: typeof body.correlation_id === "string" ? body.correlation_id : null,
  });

  if (result.ok) {
    res.json({
      ok: true,
      duplicate: result.duplicate,
      version: result.version,
      eventId: result.eventId,
      sequence: result.sequence,
      result: result.result,
      contractVersion: result.contractVersion,
    });
    return;
  }

  // Every refusal is MODELLED. The kernel returns a reason rather than raising,
  // and this maps the reason to a status without collapsing the distinctions:
  // "you may not", "it is not there", "it moved under you" and "that is not a
  // valid command" are four different things to a caller.
  const reason = result.reason;
  if (reason === "TRIP_KERNEL_UNAVAILABLE") {
    log.warn({ tripId, type, detail: result.detail }, "trip kernel unavailable");
    // 503 and NOT a 400: the command may have been perfectly valid. Telling a
    // caller their input was wrong when the database was unreachable sends them
    // to fix the wrong thing.
    res.status(503).json({ ok: false, error: "degraded_unavailable", reason, detail: result.detail });
    return;
  }
  const status = FORBIDDEN_REASONS.has(reason) ? 403
    : NOT_FOUND_REASONS.has(reason) ? 404
    : CONFLICT_REASONS.has(reason) ? 409
    : 400;

  res.status(status).json({
    ok: false,
    error: status === 403 ? "forbidden" : status === 404 ? "not_found"
         : status === 409 ? "conflict" : "invalid_payload",
    reason,
    detail: result.detail,
    currentVersion: result.currentVersion,
    expectedVersion: result.expectedVersion,
  });
}));

/**
 * §11: "GET /trips/:id/snapshots/:version".
 *
 * Reads a stored §22.1 snapshot and, beside it, the §22.2 replay verdict for
 * that version — because a snapshot handed to a caller without the answer to
 * "does this still match the event log" is a claim nobody checked. The
 * verification is one function call (2773's trip_snapshot_verify_replay) and it
 * is cheap enough to do on read.
 *
 * `version` may be the literal `latest`.
 */
router.get("/trips/:tripId/snapshots/:version", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, version } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const wantsLatest = version === "latest";
  let wanted: number | null = null;
  if (!wantsLatest) {
    const v = Number(version);
    if (!Number.isSafeInteger(v) || v < 0) {
      sendError(res, "invalid_payload", "version must be a non-negative integer or 'latest'");
      return;
    }
    wanted = v;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  let q = sc.from("trip_snapshots")
    .select("id, aggregate_version, snapshot_json, engine_versions_json, created_at")
    .eq("trip_id", tripId);
  q = wantsLatest
    ? q.order("aggregate_version", { ascending: false }).limit(1)
    : q.eq("aggregate_version", wanted as number).limit(1);

  const { data, error } = await q;
  if (error) {
    // NOT "no snapshot". A read that failed and a version that was never
    // snapshotted are different answers, and only one of them means the caller
    // should ask for a different version.
    log.warn({ err: error.message, tripId }, "snapshot read failed");
    res.status(503).json({ ok: false, error: "degraded_unavailable", reason: "SNAPSHOT_READ_FAILED" });
    return;
  }
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) { sendError(res, "not_found", "No snapshot at that version"); return; }

  // §22.2, on read. `verified: null` means the check itself could not run —
  // distinct from `false`, which means it ran and the snapshot does not match.
  let verified: boolean | null = null;
  let verification: unknown = null;
  const { data: vData, error: vErr } = await sc.rpc("trip_snapshot_verify_replay", {
    p_trip_id: tripId,
    p_at_version: (row as { aggregate_version: number }).aggregate_version,
  });
  if (vErr) {
    log.warn({ err: vErr.message, tripId }, "snapshot replay verification unavailable");
  } else if (vData && typeof vData === "object") {
    verification = vData;
    const eq = (vData as Record<string, unknown>).equal;
    verified = typeof eq === "boolean" ? eq : null;
  }

  res.json({
    tripId,
    aggregateVersion: (row as { aggregate_version: number }).aggregate_version,
    snapshot: (row as { snapshot_json: unknown }).snapshot_json,
    engineVersions: (row as { engine_versions_json: unknown }).engine_versions_json,
    createdAt: (row as { created_at: string }).created_at,
    // Three states, not two: true, false, and "the check could not run".
    replayVerified: verified,
    verification,
  });
}));

export default router;
