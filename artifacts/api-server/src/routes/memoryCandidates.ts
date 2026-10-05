/**
 * §7 candidate inbox — the owner's private queue of Memories the system thinks
 * happened, which become Memories only when the owner says so.
 *
 *   GET  /me/memory-candidates                  the owner's open candidates
 *   POST /me/memory-candidates/detect           { tripId } — look through that
 *                                               trip's captured media (owner-initiated
 *                                               only; there is no automatic run)
 *   POST /me/memory-candidates/:id/confirm      { title? } — keep it: a private
 *                                               Memory through the §17 boundary
 *   POST /me/memory-candidates/:id/reject       discard it
 *
 * Under /me/ rather than /memories/ because routes/memories.ts registers
 * GET /memories/:id first, which would swallow /memories/candidates as an id.
 * Every route is the caller's own: there is no path to another person's
 * candidates, and an id that is not theirs is the same 404 as a missing one.
 *
 * STORAGE: memory_episodes / memory_evidence are migration 2320 — written,
 * unapplied on production. Absent ⇒ 404 feature_disabled (the feature is not
 * deployed; the client shows nothing); unreadable ⇒ 503 degraded_unavailable.
 * See services/memory/episodeCandidates.ts.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { readMemoryCommandEnvelope } from "../lib/memoryCommandBus.js";
import {
  confirmCandidate,
  detectTripCandidates,
  listCandidates,
  rejectCandidate,
  type DecideOutcome,
} from "../services/memory/episodeCandidates.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storeRefusal(res: Response, reason: "not_deployed" | "unavailable"): void {
  if (reason === "not_deployed") sendError(res, "feature_disabled", "Memory suggestions are not available yet.");
  else sendError(res, "degraded_unavailable", "Your memory suggestions could not be read. Please try again.");
}

function sendDecision(req: Request, res: Response, out: DecideOutcome): void {
  if (out.ok) { res.json(out); return; }
  if (out.reason === "not_deployed" || out.reason === "unavailable") { storeRefusal(res, out.reason); return; }
  if (out.reason === "not_found") { sendError(res, "not_found", "Suggestion not found"); return; }
  if (out.reason === "not_a_candidate") { sendError(res, "conflict", "This suggestion has already been decided.", { exposeDetail: true, reason: "not_a_candidate" }); return; }
  req.log.error({ reason: out.reason, detail: out.detail }, "memory candidates: decision failed");
  sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
}

router.get("/me/memory-candidates", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await listCandidates(sc, auth.user.id);
  if (!out.ok) {
    if (out.reason === "unavailable") req.log.error({ detail: out.detail }, "memory candidates: list unreadable — refusing rather than an empty inbox");
    storeRefusal(res, out.reason);
    return;
  }
  res.json({ candidates: out.candidates });
}));

router.post("/me/memory-candidates/detect", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const tripId = typeof req.body?.tripId === "string" ? req.body.tripId : "";
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "tripId is required"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await detectTripCandidates(sc, { ownerId: auth.user.id, tripId, now: new Date() });
  if (!out.ok) {
    switch (out.reason) {
      case "not_deployed":
      case "unavailable":
        if (out.reason === "unavailable") req.log.error({ detail: out.detail, tripId }, "memory candidates: detect could not read its inputs");
        storeRefusal(res, out.reason);
        return;
      case "trip_not_found":
      case "not_trip_member":
        sendError(res, "not_found", "Trip not found");
        return;
      case "trip_has_no_dates":
        sendError(res, "conflict", "This trip has no dates, so there is no time to look through.", { exposeDetail: true, reason: out.reason });
        return;
      default:
        req.log.error({ detail: out.detail, tripId }, "memory candidates: detect write failed");
        sendError(res, "degraded_unavailable", "Your suggestions could not be saved. Please try again.");
        return;
    }
  }
  res.json({ report: out.report });
}));

router.post("/me/memory-candidates/:id/confirm", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid suggestion id"); return; }
  const rawTitle = req.body?.title;
  if (rawTitle !== undefined && rawTitle !== null && (typeof rawTitle !== "string" || rawTitle.length > 200)) {
    sendError(res, "invalid_payload", "title must be text of at most 200 characters");
    return;
  }
  const envelope = readMemoryCommandEnvelope(req);
  if (!envelope.ok) { sendError(res, "invalid_payload", envelope.message); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const out = await confirmCandidate(sc, {
    ownerId: auth.user.id, episodeId: id, title: typeof rawTitle === "string" ? rawTitle : null,
    idempotencyKey: envelope.idempotencyKey, now: new Date(),
  });
  sendDecision(req, res, out);
}));

router.post("/me/memory-candidates/:id/reject", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid suggestion id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendDecision(req, res, await rejectCandidate(sc, { ownerId: auth.user.id, episodeId: id, now: new Date() }));
}));

export default router;
