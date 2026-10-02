/**
 * Admin — Trails moderation and trend integrity review. census-discovery §86
 * (lane W10-T): DV-74 (`11` §8 "Trail merge", "Trail archive", "trend integrity
 * review"; `11` §10 "admin actions are audited"), DC-04 (`02` §15's moderation
 * moves), DV-24 (edge review).
 *
 *   POST /admin/discovery/trails/:id/lifecycle     { to, reason, idempotencyKey? }  needs_update | stale | active | archived
 *   POST /admin/discovery/trails/:id/archive       { reason, idempotencyKey? }      `11` §8 "Trail archive"
 *   POST /admin/discovery/trails/:id/merge         { intoTrailId, reason, idempotencyKey? }  `11` §8 "Trail merge"
 *   POST /admin/discovery/trails/:id/edges/review  { toTrailId, edgeType, verdict, reason, idempotencyKey? }
 *   POST /admin/discovery/trails/:id/curate        { sourceType, sourceId, relationship, signal?, reason, idempotencyKey? }  Local Picks (`02` §5 curated catalog)
 *   GET  /admin/discovery/trails/:id/audit         the audit trail of one Trail
 *   GET  /admin/discovery/trend-integrity/trails/:id          the evidence, raw (`11` §4 admin diagnostics)
 *   POST /admin/discovery/trend-integrity/reviews   { subjectKind, subjectId, verdict, reason, evidence?, idempotencyKey? }
 *
 * Guarded by the shared `requireAdmin` (role 'admin'). Every write is one 3486
 * function call that changes the data AND appends its audit row in one
 * transaction (services/trails/trailAdmin.ts), exactly as §52's ledger actions
 * are audited. A replay answers 200 with `replayed: true`; a new action 201.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { sendError } from "../lib/http.js";
import {
  adminIdempotencyKey, curateTrailContentAsAdmin, mergeTrailsAsAdmin, moveTrailLifecycleAsAdmin, readTrailAdminAudit, recordTrendIntegrityReview,
  reviewTrailEdgeAsAdmin, trailTrendEvidence, type TrailAdminOutcome,
} from "../services/trails/trailAdmin.js";

const router = Router();

const IdParam = z.string().uuid();
const Reason = z.string().trim().min(1).max(2000);
const Key = z.string().trim().min(1).max(200).nullish();

/** Refusals that are decisions about the data (409), not faults. */
const CONFLICTS: ReadonlySet<string> = new Set([
  "transition_not_allowed", "no_op", "same_trail", "source_archived", "target_archived", "target_descends_from_source",
  "idempotency_key_reused", "edge_type_not_declarable", "label_refused",
]);

function send(res: any, r: TrailAdminOutcome): void {
  if (r.ok) { res.status(r.replayed ? 200 : 201).json({ ...r.value, replayed: r.replayed }); return; }
  if (r.reason === "unavailable") return sendError(res, "degraded_unavailable", "Trail moderation is not available on this deployment (3486 not applied).");
  if (r.reason === "degraded") return sendError(res, "degraded_unavailable", "Trail moderation could not be completed; nothing was changed. Retry with the same idempotency key.");
  if (r.reason === "unknown_trail" || r.reason === "unknown_target" || r.reason === "unknown_content") return sendError(res, "not_found", r.reason);
  if (r.reason === "source_unreadable") return sendError(res, "degraded_unavailable", "the content could not be verified; nothing was curated");
  if (r.reason === "unverifiable_source_type") return sendError(res, "invalid_payload", r.reason);
  if (r.reason === "reason_required" || r.reason === "unknown_state" || r.reason === "unknown_verdict" || r.reason === "unknown_subject_kind") {
    return sendError(res, "invalid_payload", r.reason);
  }
  if (CONFLICTS.has(r.reason)) { res.status(409).json({ error: "conflict", reason: r.reason, detail: r.detail ?? null }); return; }
  sendError(res, "db_error", r.reason);
}

router.post("/admin/discovery/trails/:id/lifecycle", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  const body = z.object({ to: z.enum(["active", "needs_update", "stale", "archived"]), reason: Reason, idempotencyKey: Key }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return sendError(res, "invalid_payload", "body must be { to, reason }");
  const key = adminIdempotencyKey("trail_lifecycle", ctx.userId, { trail: id.data, to: body.data.to, reason: body.data.reason }, body.data.idempotencyKey);
  send(res, await moveTrailLifecycleAsAdmin(ctx.sc, id.data, body.data.to, { userId: ctx.userId, reason: body.data.reason, idempotencyKey: key }));
}));

router.post("/admin/discovery/trails/:id/archive", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  const body = z.object({ reason: Reason, idempotencyKey: Key }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return sendError(res, "invalid_payload", "body must be { reason }");
  const key = adminIdempotencyKey("trail_lifecycle", ctx.userId, { trail: id.data, to: "archived", reason: body.data.reason }, body.data.idempotencyKey);
  send(res, await moveTrailLifecycleAsAdmin(ctx.sc, id.data, "archived", { userId: ctx.userId, reason: body.data.reason, idempotencyKey: key }));
}));

router.post("/admin/discovery/trails/:id/merge", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  const body = z.object({ intoTrailId: z.string().uuid(), reason: Reason, idempotencyKey: Key }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return sendError(res, "invalid_payload", "body must be { intoTrailId, reason }");
  const key = adminIdempotencyKey("trail_merge", ctx.userId, { from: id.data, into: body.data.intoTrailId, reason: body.data.reason }, body.data.idempotencyKey);
  send(res, await mergeTrailsAsAdmin(ctx.sc, id.data, body.data.intoTrailId, { userId: ctx.userId, reason: body.data.reason, idempotencyKey: key }));
}));

router.post("/admin/discovery/trails/:id/edges/review", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  const body = z.object({
    toTrailId: z.string().uuid(),
    edgeType: z.enum(["parent", "related", "seasonal_variant", "geographic_sub", "experience_branch"]),
    verdict: z.enum(["accepted", "rejected"]),
    reason: Reason, idempotencyKey: Key,
  }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return sendError(res, "invalid_payload", "body must be { toTrailId, edgeType, verdict, reason }");
  const key = adminIdempotencyKey("trail_edge_review", ctx.userId, { from: id.data, to: body.data.toTrailId, type: body.data.edgeType, verdict: body.data.verdict, reason: body.data.reason }, body.data.idempotencyKey);
  send(res, await reviewTrailEdgeAsAdmin(ctx.sc, id.data, body.data.toTrailId, body.data.edgeType, body.data.verdict, { userId: ctx.userId, reason: body.data.reason, idempotencyKey: key }));
}));

router.post("/admin/discovery/trails/:id/curate", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  const body = z.object({
    sourceType: z.enum(["post", "place", "event", "route"]),
    sourceId: z.string().uuid(),
    relationship: z.enum(["primary", "supporting", "signal"]),
    signal: z.string().max(40).nullish(),
    reason: Reason, idempotencyKey: Key,
  }).strict().safeParse(req.body ?? {});
  if (!id.success || !body.success) return sendError(res, "invalid_payload", "body must be { sourceType, sourceId, relationship, reason }");
  const b = body.data;
  const key = adminIdempotencyKey("trail_curate", ctx.userId, { trail: id.data, type: b.sourceType, source: b.sourceId, rel: b.relationship, signal: b.signal ?? null, reason: b.reason }, b.idempotencyKey);
  send(res, await curateTrailContentAsAdmin(ctx.sc, id.data, { sourceType: b.sourceType, sourceId: b.sourceId, relationship: b.relationship, signal: b.signal ?? null }, { userId: ctx.userId, reason: b.reason, idempotencyKey: key }));
}));

router.get("/admin/discovery/trails/:id/audit", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "id must be a uuid");
  const r = await readTrailAdminAudit(ctx.sc, id.data);
  if (!r.ok) return send(res, r);
  res.json(r.value);
}));

router.get("/admin/discovery/trend-integrity/trails/:id", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "id must be a uuid");
  const r = await trailTrendEvidence(ctx.sc, id.data);
  if (!r.ok) return send(res, r);
  res.json(r.value);
}));

router.post("/admin/discovery/trend-integrity/reviews", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const body = z.object({
    subjectKind: z.enum(["trail", "place"]),
    subjectId: z.string().trim().min(1).max(200),
    verdict: z.enum(["confirmed", "suspect", "suppressed", "cleared"]),
    reason: Reason,
    evidence: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: Key,
  }).strict().safeParse(req.body ?? {});
  if (!body.success) return sendError(res, "invalid_payload", "body must be { subjectKind, subjectId, verdict, reason }");
  const b = body.data;
  const key = adminIdempotencyKey("trend_integrity_review", ctx.userId, { kind: b.subjectKind, subject: b.subjectId, verdict: b.verdict, reason: b.reason }, b.idempotencyKey);
  send(res, await recordTrendIntegrityReview(ctx.sc, b.subjectKind, b.subjectId, b.verdict, b.evidence ?? {}, { userId: ctx.userId, reason: b.reason, idempotencyKey: key }));
}));

export default router;
