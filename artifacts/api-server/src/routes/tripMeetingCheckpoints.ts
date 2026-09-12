/**
 * Trips spec §10.4 meeting checkpoints and §11.3 "Return / regroup" (2794).
 * census-trips TR177, TR198, TR262.
 *
 *   POST /trips/:tripId/regroup                                   §11.3: compute the §14.3 meeting point, agree it as a checkpoint
 *   GET  /trips/:tripId/meeting-checkpoints[?status=open|all]      the crew's checkpoints with everyone's arrival state
 *   POST /trips/:tripId/meeting-checkpoints/:checkpointId/arrival  my own arrival state (SET_MEETING_ARRIVAL)
 *   POST /trips/:tripId/meeting-checkpoints/:checkpointId/close    creator or host: met | cancelled (CLOSE_MEETING_CHECKPOINT)
 *
 * Every write goes through the kernel and is refused by name without it
 * (503 TRIP_KERNEL_UNAVAILABLE). Everything is behind the operational gate,
 * whose schema probe covers 2794's tables. The priority switch is not
 * written here: an open regroup is a REGROUP_OPEN health reason and §17.2
 * derives SAFETY_EVENT from it (TripHealth.ts).
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { executeTripCommand, isTripKernelEnabled, TRIP_KERNEL_FLAG, type TripKernelResult } from "../lib/tripKernel.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../lib/tripOperationalProjections.js";
import {
  ARRIVAL_STATES, CHECKPOINT_PURPOSES, listMeetingCheckpoints, regroup, REGROUP_PRIORITY_READING,
} from "../services/trips/TripMeetingCheckpoints.js";

const router = Router();
const log = logger.child({ mod: "tripMeetingCheckpoints" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

const RegroupSchema = z.object({
  participantIds: z.array(z.string().uuid()).max(30).optional(),
  subgroupId: z.string().uuid().nullable().optional(),
  candidateId: z.string().min(1).max(160).nullable().optional(),
  point: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().min(1).max(120) }).nullable().optional(),
  label: z.string().min(1).max(120).nullable().optional(),
  meetAt: z.string().datetime({ offset: true }).nullable().optional(),
  purpose: z.enum(CHECKPOINT_PURPOSES).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
const ArrivalSchema = z.object({
  arrivalState: z.enum(ARRIVAL_STATES),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
const CloseSchema = z.object({
  outcome: z.enum(["met", "cancelled"]).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();

const FORBIDDEN = new Set(["TRIP_AUTH_NOT_CREW", "TRIP_AUTH_NOT_HOST", "TRIP_MEETING_NOT_PARTICIPANT", "TRIP_MEETING_PARTICIPANT_NOT_CREW", "TRIP_SUBGROUP_NOT_MEMBER"]);
const NOT_FOUND = new Set(["TRIP_MEETING_NOT_FOUND", "TRIP_SUBGROUP_NOT_FOUND", "TRIP_NOT_FOUND"]);
const CONFLICT = new Set(["TRIP_MEETING_INVALID_TRANSITION", "TRIP_VERSION_CONFLICT", "TRIP_MEETING_NO_CANDIDATE"]);

function sendKernelRefusal(res: any, reason: string, detail: string | undefined, extra: Record<string, unknown> = {}): void {
  if (reason === "TRIP_KERNEL_UNAVAILABLE") { res.status(503).json({ ok: false, error: "degraded_unavailable", reason, detail, ...extra }); return; }
  const status = FORBIDDEN.has(reason) ? 403 : NOT_FOUND.has(reason) ? 404 : CONFLICT.has(reason) ? 409 : 400;
  res.status(status).json({ ok: false, error: status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_payload", reason, detail, ...extra });
}

/** The three preconditions every handler shares; null when a response was already sent. */
async function open(req: any, res: any, opts: { write: boolean }): Promise<{ sc: any; userId: string; tripId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { tripId } = req.params as { tripId: string };
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return null; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) {
    const refusal = refusalForGate(gate);
    sendError(res, refusal.reason === "FEATURE_DISABLED" ? "feature_disabled" : "degraded_unavailable", refusal.message);
    return null;
  }
  const membership = await requireTripMember(sc, tripId, auth.user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return null; }
  if (opts.write && !(await isTripKernelEnabled(sc))) {
    res.status(503).json({ ok: false, error: "degraded_unavailable", reason: "TRIP_KERNEL_UNAVAILABLE", detail: `${TRIP_KERNEL_FLAG} is off: meeting checkpoints are written only through the kernel` });
    return null;
  }
  return { sc, userId: auth.user.id, tripId };
}

// ── POST /trips/:tripId/regroup ─────────────────────────────────────────────
router.post("/trips/:tripId/regroup", asyncHandler(async (req, res) => {
  const ctx = await open(req, res, { write: true });
  if (!ctx) return;
  const parsed = RegroupSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid regroup"); return; }
  const r = await regroup(ctx.sc, ctx.tripId, ctx.userId, { ...parsed.data, now: new Date() });
  if (!r.ok) {
    if (r.reason === "TRIP_MEETING_NO_CANDIDATE") { sendKernelRefusal(res, r.reason, r.message, { meetingPoint: r.meetingPoint ?? null }); return; }
    if (r.reason === "FEATURE_DISABLED" || r.reason === "TRIP_PROJECTION_UNAVAILABLE" || r.reason === "TRIP_NOT_FOUND") {
      sendError(res, r.reason === "TRIP_NOT_FOUND" ? "not_found" : r.reason === "FEATURE_DISABLED" ? "feature_disabled" : "degraded_unavailable", r.message); return;
    }
    log.warn({ tripId: ctx.tripId, reason: r.reason, detail: r.message }, "regroup refused");
    sendKernelRefusal(res, r.reason, r.message, r.kernel && !r.kernel.ok ? { currentVersion: r.kernel.currentVersion, expectedVersion: r.kernel.expectedVersion } : {});
    return;
  }
  res.status(201).json({ ok: true, tripId: ctx.tripId, checkpoint: r.checkpoint, kernel: r.kernel, meetingPoint: r.meetingPoint, prioritySwitch: r.prioritySwitch });
}));

// ── GET /trips/:tripId/meeting-checkpoints ──────────────────────────────────
router.get("/trips/:tripId/meeting-checkpoints", asyncHandler(async (req, res) => {
  const ctx = await open(req, res, { write: false });
  if (!ctx) return;
  const status = req.query.status === "all" ? "all" : "open";
  const r = await listMeetingCheckpoints(ctx.sc, ctx.tripId, { status });
  if (!r.ok) { sendTripRefusal(res, "degraded_unavailable", r.reason, r.message); return; }
  res.json({ tripId: ctx.tripId, status, checkpoints: r.checkpoints, prioritySwitch: REGROUP_PRIORITY_READING });
}));

// ── POST /trips/:tripId/meeting-checkpoints/:checkpointId/arrival ───────────
router.post("/trips/:tripId/meeting-checkpoints/:checkpointId/arrival", asyncHandler(async (req, res) => {
  const ctx = await open(req, res, { write: true });
  if (!ctx) return;
  const { checkpointId } = req.params as { checkpointId: string };
  if (!UUID_RE.test(checkpointId)) { sendError(res, "invalid_payload", "Invalid checkpoint id"); return; }
  const parsed = ArrivalSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid arrival"); return; }
  const result: TripKernelResult = await executeTripCommand(ctx.sc, {
    commandId: randomUUID(), tripId: ctx.tripId, actorUserId: ctx.userId, actorRole: "user",
    idempotencyKey: parsed.data.idempotencyKey ?? `arrival:${checkpointId}:${ctx.userId}:${parsed.data.arrivalState}:${randomUUID()}`,
    type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: checkpointId, arrival_state: parsed.data.arrivalState },
    correlationId: `checkpoint:${checkpointId}`,
  });
  if (!result.ok) { sendKernelRefusal(res, result.reason, result.detail, { currentVersion: result.currentVersion, expectedVersion: result.expectedVersion }); return; }
  res.json({ ok: true, checkpointId, arrival: result.result, kernel: { version: result.version, eventId: result.eventId, duplicate: result.duplicate } });
}));

// ── POST /trips/:tripId/meeting-checkpoints/:checkpointId/close ─────────────
router.post("/trips/:tripId/meeting-checkpoints/:checkpointId/close", asyncHandler(async (req, res) => {
  const ctx = await open(req, res, { write: true });
  if (!ctx) return;
  const { checkpointId } = req.params as { checkpointId: string };
  if (!UUID_RE.test(checkpointId)) { sendError(res, "invalid_payload", "Invalid checkpoint id"); return; }
  const parsed = CloseSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid close"); return; }
  const result: TripKernelResult = await executeTripCommand(ctx.sc, {
    commandId: randomUUID(), tripId: ctx.tripId, actorUserId: ctx.userId, actorRole: "user",
    idempotencyKey: parsed.data.idempotencyKey ?? `close:${checkpointId}:${randomUUID()}`,
    type: "CLOSE_MEETING_CHECKPOINT", payload: { checkpoint_id: checkpointId, outcome: parsed.data.outcome ?? "met" },
    correlationId: `checkpoint:${checkpointId}`,
  });
  if (!result.ok) { sendKernelRefusal(res, result.reason, result.detail, { currentVersion: result.currentVersion, expectedVersion: result.expectedVersion }); return; }
  res.json({ ok: true, checkpointId, closed: result.result, kernel: { version: result.version, eventId: result.eventId, duplicate: result.duplicate }, prioritySwitch: "closed: REGROUP_OPEN no longer derives from this checkpoint" });
}));

export default router;
