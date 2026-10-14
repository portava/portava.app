/**
 * §9 entity split → Memory re-resolution over HTTP. Census-highlights-memories
 * H72 (B58 cluster MEM-PLACE-SPLIT; migration 3812, unapplied). Every rule is in
 * services/memory/memoryPlaceSplitReresolution.ts.
 *
 * ADMIN (requireAdmin; both `external_places_enabled` and
 * `memory_place_split_reresolution_enabled` must be ON, else 404
 * `feature_disabled` with nothing written; an unreadable flag is 503):
 *   POST /admin/places/:id/split              { name, latitude, longitude, primaryCategory?, address?, city?,
 *                                               neighborhood?, countryCode?, canonicalLocationId?, referenceIds? }
 *        keeps :id, creates the second venue, logs 'split', then runs the
 *        re-resolution job and answers its COUNTS (never a Memory, owner or
 *        coordinate)
 *   POST /admin/places/splits/:splitId/reresolve   re-runs the job (idempotent)
 *
 * OWNER (the same two flags; OFF or absent ⇒ every route falls through as if this
 * router were not mounted, BEFORE authentication; unreadable ⇒ 503):
 *   GET  /me/memory-place-proposals[?memoryId=]     the caller's pending proposals
 *   POST /memory-place-proposals/:id/accept { placeId }   records the owner's choice
 *        AFTER the owner changed the Memory's place through PATCH /memories/:id
 *        (409 `memory_not_changed` until the Memory stores placeId)
 *   POST /memory-place-proposals/:id/dismiss
 * Someone else's proposal and a missing one are the same 404.
 *
 * This file is NEW so routes/placesCanonical.ts (the Places/Discovery lane's
 * line-cited admin catalog routes) is not edited; it is mounted from
 * routes/index.ts on that file's last line (cited by line).
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import {
  acceptProposal,
  dismissProposal,
  listPendingProposals,
  readSplitGates,
  runSplitReresolution,
  splitPlace,
  type DecisionOutcome,
  type ReresolutionOutcome,
} from "../services/memory/memoryPlaceSplitReresolution.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const splitSchema = z.object({
  name: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  primaryCategory: optionalText(80),
  address: optionalText(500),
  city: optionalText(200),
  neighborhood: optionalText(200),
  countryCode: optionalText(4),
  canonicalLocationId: z.string().uuid().nullable().optional(),
  referenceIds: z.array(z.string().uuid()).max(500).optional(),
}).strict();

/** The job's answer to an admin: counts and a state, nothing about any Memory or person. */
function jobSummary(out: ReresolutionOutcome): Record<string, unknown> {
  if (out.state === "done" || out.state === "incomplete") return { state: out.state, ...out.counts, ...(out.detail ? { detail: out.detail } : {}) };
  if (out.state === "unreadable") return { state: "unreadable", detail: out.detail };
  return { state: out.state };
}

async function adminGate(req: Request, res: Response): Promise<{ sc: any; userId: string } | null> {
  const admin = await requireAdmin(req, res);
  if (!admin) return null;
  const gate = await readSplitGates(admin.sc);
  if (gate === "unreadable") {
    (req as any).log?.error?.({ flags: ["memory_place_split_reresolution_enabled", "external_places_enabled"] }, "place split: a flag is unreadable — refusing");
    sendError(res, "degraded_unavailable", "Place splitting is unavailable right now. Please try again.");
    return null;
  }
  if (gate === "off") { sendError(res, "feature_disabled", "Place splitting is not enabled."); return null; }
  return { sc: admin.sc, userId: admin.userId };
}

// ── POST /admin/places/:id/split ──────────────────────────────────────────────
router.post("/admin/places/:id/split", asyncHandler(async (req: Request, res: Response) => {
  const ctx = await adminGate(req, res);
  if (!ctx) return;
  const id = String(req.params.id ?? "");
  const parsed = splitSchema.safeParse(req.body ?? {});
  if (!UUID_RE.test(id) || !parsed.success) {
    sendError(res, "invalid_payload", parsed.success ? "Invalid place id" : (parsed.error.issues[0]?.message ?? "Invalid split"));
    return;
  }
  const out = await splitPlace(ctx.sc, id, ctx.userId, parsed.data);
  switch (out.kind) {
    case "split": {
      const job = await runSplitReresolution(ctx.sc, out.splitId);
      if (job.state !== "done") (req as any).log?.error?.({ splitId: out.splitId, job: jobSummary(job) }, "place split: re-resolution did not complete — re-run POST /admin/places/splits/:splitId/reresolve");
      res.status(201).json({ ok: true, splitId: out.splitId, placeId: id, newPlaceId: out.newPlaceId, referencesMoved: out.referencesMoved, reresolution: jobSummary(job) });
      return;
    }
    case "disabled": sendError(res, "feature_disabled", "Place splitting is not enabled."); return;
    case "not_found": sendError(res, "not_found", "Place not found"); return;
    case "merged": sendError(res, "conflict", "This place was merged into another; split its survivor.", { exposeDetail: true, reason: "place_merged" }); return;
    case "reference_not_on_place": sendError(res, "invalid_payload", "Every reference to move must belong to this place.", { reason: "reference_not_on_place" }); return;
    case "invalid": sendError(res, "invalid_payload", out.detail); return;
    case "failed":
      (req as any).log?.error?.({ placeId: id, detail: out.detail }, "place split: place_split failed — nothing was split");
      sendError(res, "degraded_unavailable", "The place could not be split right now. Please try again.");
      return;
  }
}));

// ── POST /admin/places/splits/:splitId/reresolve ──────────────────────────────
router.post("/admin/places/splits/:splitId/reresolve", asyncHandler(async (req: Request, res: Response) => {
  const ctx = await adminGate(req, res);
  if (!ctx) return;
  const splitId = String(req.params.splitId ?? "");
  if (!UUID_RE.test(splitId)) { sendError(res, "invalid_payload", "Invalid split id"); return; }
  const job = await runSplitReresolution(ctx.sc, splitId);
  if (job.state === "not_found") { sendError(res, "not_found", "Split not found"); return; }
  if (job.state === "inert") { sendError(res, "feature_disabled", "Place splitting is not enabled."); return; }
  if (job.state === "unreadable") {
    (req as any).log?.error?.({ splitId, detail: job.detail }, "place split: re-resolution refused — a read failed");
    sendError(res, "degraded_unavailable", "Re-resolution could not run right now. Please try again.");
    return;
  }
  res.json({ ok: true, splitId, reresolution: jobSummary(job) });
}));

// ── The owner's proposals ─────────────────────────────────────────────────────

/** OFF / absent ⇒ not here (fall through). Unreadable ⇒ 503. ON ⇒ the route runs. */
const whenEnabled = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const gate = await readSplitGates(sc);
  if (gate === "on") { next(); return; }
  if (gate === "unreadable") {
    (req as any).log?.error?.({ flags: ["memory_place_split_reresolution_enabled", "external_places_enabled"] }, "memory place proposals: a flag is unreadable — refusing rather than answering as if the feature did not exist");
    sendError(res, "degraded_unavailable", "This is not available right now. Please try again.");
    return;
  }
  next("route");
});

function unavailable(req: Request, res: Response, detail: string): void {
  (req as any).log?.error?.({ detail }, "memory place proposals: read or write failed — refusing rather than answering from a partial read");
  sendError(res, "degraded_unavailable", "This could not be loaded right now. Please try again.");
}

function sendDecision(req: Request, res: Response, proposalId: string, out: DecisionOutcome): void {
  switch (out.kind) {
    case "ok": res.json({ proposalId, state: out.state, ...(out.placeId ? { placeId: out.placeId } : {}) }); return;
    case "not_found": sendError(res, "not_found", "Not found"); return;
    case "already_decided": sendError(res, "conflict", "This suggestion was already answered.", { exposeDetail: true, reason: "already_decided" }); return;
    case "not_a_candidate": sendError(res, "invalid_payload", "That place is not one of this suggestion's places.", { reason: "not_a_candidate" }); return;
    case "memory_not_changed":
      sendError(res, "conflict", "Change this Memory's place first; then confirm the suggestion.", { exposeDetail: true, reason: "memory_not_changed" });
      return;
    case "unreadable": case "write_failed": unavailable(req, res, out.detail); return;
  }
}

router.get("/me/memory-place-proposals", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const memoryId = typeof req.query.memoryId === "string" ? req.query.memoryId : undefined;
  if (memoryId !== undefined && !UUID_RE.test(memoryId)) { sendError(res, "invalid_payload", "memoryId must be a Memory id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const read = await listPendingProposals(sc, auth.user.id, memoryId ? { memoryId } : {});
  if (read.state !== "ok") { unavailable(req, res, read.detail); return; }
  res.json({ proposals: read.proposals });
}));

router.post("/memory-place-proposals/:id/accept", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const proposalId = String(req.params.id ?? "");
  if (!UUID_RE.test(proposalId)) { sendError(res, "not_found", "Not found"); return; }
  const placeId = typeof req.body?.placeId === "string" ? req.body.placeId : "";
  if (!UUID_RE.test(placeId)) { sendError(res, "invalid_payload", "placeId must be a place id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendDecision(req, res, proposalId, await acceptProposal(sc, auth.user.id, proposalId, placeId));
}));

router.post("/memory-place-proposals/:id/dismiss", whenEnabled, asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const proposalId = String(req.params.id ?? "");
  if (!UUID_RE.test(proposalId)) { sendError(res, "not_found", "Not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  sendDecision(req, res, proposalId, await dismissProposal(sc, auth.user.id, proposalId));
}));

export default router;
