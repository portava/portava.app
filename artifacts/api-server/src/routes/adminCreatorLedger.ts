/**
 * Admin — creator ledger: fraud holds and ledger audit. census-discovery
 * DV-59, DV-60, DV-68, DV-63, DV-74 (`11` §8 "creator fraud holds", "ledger
 * audit"; `11` §10 "admin actions are audited").
 *
 *   GET  /admin/creator-ledger/attributions/:id/audit      the whole trail of one attribution
 *   POST /admin/creator-ledger/attributions/:id/hold       { reason }  place a fraud hold
 *   POST /admin/creator-ledger/attributions/:id/release    { reason }  lift it
 *   POST /admin/creator-ledger/attributions/:id/recompute  { reason }  recompute under the version in force
 *   POST /admin/creator-ledger/transactions/reverse        { transactionKey, reason }
 *
 * Guarded by the shared `requireAdmin` (role 'admin'); every write names the
 * admin as its actor and goes through `services/creators/CreatorLedgerOperations.ts`,
 * which writes the change AND its audit row in one transaction
 * (`public.creator_ledger_append`, 3387) — there is no path that changes the
 * ledger without recording who did it and why.
 *
 * Nothing here moves money: a hold stops an earning being booked or shown as
 * anything but held; a release lifts that; a recomputation reverses and rebooks
 * RECORDS; a reversal negates records. No payout exists (DV-81).
 *
 * FAIL-CLOSED on `creator_attribution_enabled` (2922, seeded FALSE).
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { sendError } from "../lib/http.js";
import {
  placeCreatorHold,
  readCreatorLedgerAuditTrail,
  recomputeCreatorAttribution,
  releaseCreatorHold,
  reverseCreatorTransaction,
} from "../services/creators/CreatorLedgerOperations.js";
import type { CreatorServiceRefusal } from "../services/creators/CreatorAttributionService.js";

const router = Router();

const IdParam = z.string().uuid();
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const ReverseBody = z.object({
  transactionKey: z.string().min(1).max(400),
  reason: z.string().trim().min(1).max(2000),
}).strict();

/** Refusals that are decisions about the ledger (409), not faults (5xx). */
const CONFLICTS: ReadonlySet<CreatorServiceRefusal> = new Set<CreatorServiceRefusal>([
  "already_held", "not_held", "recompute_while_held", "seam_has_no_computation", "same_rule_version",
  "already_reversed", "stale_head", "conflicting_replay", "attribution_not_current", "attribution_held",
  "stale_rule_version", "unpublished_rule_version", "booked_in_subsystem_ledger", "transaction_unbalanced",
  "rule_params_incomplete", "rule_params_invalid", "multi_party_split_undecided", "chain_forked",
  // The record exists and was read; what it no longer carries is an identity.
  // 409, not 404 (the row is there) and not 5xx (nothing faulted).
  "identity_severed",
  "refused_by_model",
]);

function sendLedgerRefusal(res: any, reason: CreatorServiceRefusal, detail?: string): void {
  if (reason === "disabled") return sendError(res, "feature_disabled", "The creator economy is not enabled.");
  if (reason === "degraded_unavailable") return sendError(res, "degraded_unavailable", "The creator ledger is not available on this deployment.");
  if (reason === "not_found" || reason === "unknown_attribution" || reason === "unknown_transaction") {
    return sendError(res, "not_found", detail ?? reason);
  }
  if (reason === "unexplained") return sendError(res, "invalid_payload", "A reason is required.");
  if (CONFLICTS.has(reason)) {
    res.status(409).json({ error: "conflict", reason, message: detail ?? reason });
    return;
  }
  sendError(res, "db_error", detail ?? reason);
}

router.get("/admin/creator-ledger/attributions/:id/audit", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = IdParam.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "id must be a uuid");
  const r = await readCreatorLedgerAuditTrail(ctx.sc, id.data);
  if (!r.ok) return sendLedgerRefusal(res, r.reason, r.detail);
  res.json(r.value);
}));

type AttributionOperation = typeof placeCreatorHold;

/** One handler shape for the three operations on an attribution. */
function attributionOperation(op: AttributionOperation) {
  return async (req: any, res: any) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) return sendError(res, "invalid_payload", "id must be a uuid");
    const body = ReasonBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(res, "invalid_payload", "body must be { reason: string }");
    const r = await op(ctx.sc, { attributionId: id.data, reason: body.data.reason, actor: { kind: "admin", userId: ctx.userId } });
    if (!r.ok) return sendLedgerRefusal(res, r.reason, r.detail);
    res.status(r.replayed ? 200 : 201).json({ ...r.value, replayed: r.replayed === true });
  };
}

router.post("/admin/creator-ledger/attributions/:id/hold", asyncHandler(attributionOperation(placeCreatorHold)));
router.post("/admin/creator-ledger/attributions/:id/release", asyncHandler(attributionOperation(releaseCreatorHold)));
router.post("/admin/creator-ledger/attributions/:id/recompute", asyncHandler(attributionOperation(recomputeCreatorAttribution)));

router.post("/admin/creator-ledger/transactions/reverse", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const body = ReverseBody.safeParse(req.body ?? {});
  if (!body.success) return sendError(res, "invalid_payload", "body must be { transactionKey, reason }");
  const r = await reverseCreatorTransaction(ctx.sc, {
    transactionKey: body.data.transactionKey, reason: body.data.reason, actor: { kind: "admin", userId: ctx.userId },
  });
  if (!r.ok) return sendLedgerRefusal(res, r.reason, r.detail);
  res.status(r.replayed ? 200 : 201).json({ ...r.value, replayed: r.replayed === true });
}));

export default router;
