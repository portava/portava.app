/**
 * Trips spec §20 post-trip on the wire. census-trips TR362, TR363, TR382,
 * TR385, TR388, TR428.
 *
 *   GET  /trips/:tripId/memory-candidates     TripMemoryProjection — trip → Memory candidates for the viewer
 *   GET  /trips/:tripId/passport-projection   TripPassportProjection — what this trip contributed to the viewer's Passport
 *   POST /trips/:tripId/closeout/answers      §20.3 — answer "Did you make it to X?": RECORD_OUTCOME through the kernel
 *
 * The reads are for accepted crew and carry the §19.1 envelope; kernel-era
 * inputs (2763 outcomes, 2794 checkpoints) are read only under the
 * operational gate and named in `unread` otherwise. The answer is the one
 * write here and it is a kernel command: refused by name (503
 * TRIP_KERNEL_UNAVAILABLE) without the kernel; keyed by plan and answer, so
 * the same answer twice is a duplicate receipt and a different answer is a
 * new outcome row — corrections are new rows (2763), never edits. plan_id
 * carries no foreign key, so the route checks the plan is this trip's before
 * the kernel sees it.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { executeTripCommand, isTripKernelEnabled, TRIP_KERNEL_FLAG } from "../lib/tripKernel.js";
import { liveEnvelope, readTripVersion } from "../services/trips/TripProjectionEnvelope.js";
import { buildTripMemoryProjection, buildTripPassportProjection, readPostTripInputs } from "../services/trips/TripPostTripProjections.js";
import { reconciliationQuestions } from "../services/trips/TripCloseout.js";

const router = Router();
const log = logger.child({ mod: "tripPostTrip" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

const AnswerSchema = z.object({
  planId: z.string().uuid(),
  answer: z.enum(["completed", "skipped"]),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();

/** The preconditions every handler shares; null when a response was already sent. */
async function open(req: any, res: any): Promise<{ sc: any; userId: string; tripId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { tripId } = req.params as { tripId: string };
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return null; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  const membership = await requireTripMember(sc, tripId, auth.user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return null; }
  return { sc, userId: auth.user.id, tripId };
}

async function serve(kind: "memory" | "passport", req: any, res: any): Promise<void> {
  const ctx = await open(req, res);
  if (!ctx) return;
  const read = await readPostTripInputs(ctx.sc, ctx.tripId, ctx.userId);
  if (!read.ok) {
    if (read.reason === "TRIP_NOT_FOUND") sendError(res, "not_found", read.message);
    else sendTripRefusal(res, "degraded_unavailable", read.reason, read.message);
    return;
  }
  const sourceTripVersion = await readTripVersion(ctx.sc, ctx.tripId);
  const projection = kind === "memory" ? buildTripMemoryProjection(read.inputs) : buildTripPassportProjection(read.inputs);
  res.json({ ...liveEnvelope(sourceTripVersion), ...projection });
}

// ── GET /trips/:tripId/memory-candidates ────────────────────────────────────
router.get("/trips/:tripId/memory-candidates", asyncHandler(async (req, res) => serve("memory", req, res)));

// ── GET /trips/:tripId/passport-projection ──────────────────────────────────
router.get("/trips/:tripId/passport-projection", asyncHandler(async (req, res) => serve("passport", req, res)));

// ── POST /trips/:tripId/closeout/answers — §20.3 ────────────────────────────
router.post("/trips/:tripId/closeout/answers", asyncHandler(async (req, res) => {
  const ctx = await open(req, res);
  if (!ctx) return;
  const parsed = AnswerSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid answer"); return; }
  if (!(await isTripKernelEnabled(ctx.sc))) {
    res.status(503).json({ ok: false, error: "degraded_unavailable", reason: "TRIP_KERNEL_UNAVAILABLE", detail: `${TRIP_KERNEL_FLAG} is off: an outcome is recorded only through the kernel` });
    return;
  }
  const { data: plan, error: pErr } = await ctx.sc.from("trip_plan_items")
    .select("id, title, location_name, day_date, starts_at, ends_at, status")
    .eq("id", parsed.data.planId).eq("trip_id", ctx.tripId).is("removed_at", null).maybeSingle();
  if (pErr) { sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The plan could not be read"); return; }
  if (!plan) { sendError(res, "not_found", "Plan not found on this trip"); return; }
  // The question in the spec's own words, when the plan is one the closeout
  // would ask about; an answer for a plan already certain is a correction and
  // carries no question.
  const question = reconciliationQuestions({ today: "9999-12-31", planItems: [{ id: String(plan.id), title: plan.title ?? null, status: plan.status ?? null, dayDate: plan.day_date ?? null, locationName: plan.location_name ?? null }] })[0]?.question ?? null;
  const occurredAt = plan.ends_at ?? plan.starts_at ?? (plan.day_date ? `${plan.day_date}T23:59:59.000Z` : new Date().toISOString());
  const result = await executeTripCommand(ctx.sc, {
    commandId: randomUUID(), tripId: ctx.tripId, actorUserId: ctx.userId, actorRole: "user",
    idempotencyKey: parsed.data.idempotencyKey ?? `closeout:answer:${plan.id}:${parsed.data.answer}`,
    type: "RECORD_OUTCOME",
    payload: {
      outcome_type: parsed.data.answer, plan_id: String(plan.id), occurred_at: occurredAt,
      evidence_json: { source: "closeout_answer", question, answered_by: ctx.userId, plan_status_at_answer: plan.status ?? null },
    },
    correlationId: `closeout:${ctx.tripId}`,
  });
  if (!result.ok) {
    log.warn({ tripId: ctx.tripId, reason: result.reason, detail: result.detail }, "closeout answer refused");
    const status = result.reason === "TRIP_AUTH_NOT_CREW" ? 403 : result.reason === "TRIP_KERNEL_UNAVAILABLE" ? 503 : 400;
    res.status(status).json({ ok: false, error: status === 403 ? "forbidden" : status === 503 ? "degraded_unavailable" : "invalid_payload", reason: result.reason, detail: result.detail });
    return;
  }
  res.status(201).json({ ok: true, tripId: ctx.tripId, planId: String(plan.id), answer: parsed.data.answer, question, outcome: result.result, kernel: { version: result.version, eventId: result.eventId, duplicate: result.duplicate } });
}));

export default router;
