/**
 * Creator economy — the creator's OWN reads. census-discovery DC-23.
 *
 *   GET /creator-economy/me/impact        `11` §6 "impact summaries"
 *   GET /creator-economy/me/attributions  `11` §6 "attributed conversions"
 *   GET /creator-economy/me/earnings      `11` §6 "provisional earnings"
 *
 * `11` §6's fourth read, "payout eligibility", is NOT served: `07` §4's
 * progression and its six eligibility inputs are the owner's rule, and a route
 * answering it would have to invent one (census §52).
 *
 * ── "NO CLIENT-SIDE EARNING CALCULATION" ────────────────────────────────────
 * Every figure below is computed on the server by
 * `services/creators/CreatorLedgerReader.ts` from the one canonical ledger and
 * sent finished: per (source ledger, unit) the provisional, held, reversed-net
 * and lifetime amounts, and `available: 0` with the reason. A client renders
 * these; it is never handed a set of legs to add up, and no endpoint returns a
 * rate, a percentage or a formula.
 *
 * ── WHOSE LEDGER ────────────────────────────────────────────────────────────
 * The caller's, always: the creator id is `requireUser`'s user id and no route
 * accepts one as a parameter, so no request can name another creator. Held
 * earnings are reported as held; nothing is ever reported as payable.
 *
 * FEATURE-DISABLED IS NOT "YOU EARNED NOTHING". With `creator_attribution_enabled`
 * off (2922's seed) every route answers `feature_disabled` (`11` §9) instead of
 * an empty ledger, and an unapplied migration answers `degraded_unavailable`.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { readMyCreatorLedger } from "../services/creators/CreatorLedgerReader.js";
import type { CreatorServiceRefusal } from "../services/creators/CreatorAttributionService.js";

const router = Router();

/** Map a service refusal to `11` §9's distinguishable error semantics. */
export function sendCreatorRefusal(res: any, reason: CreatorServiceRefusal, detail?: string): void {
  switch (reason) {
    case "disabled":
      sendError(res, "feature_disabled", "The creator economy is not enabled.");
      return;
    case "degraded_unavailable":
      sendError(res, "degraded_unavailable", "The creator ledger is not available on this deployment.");
      return;
    case "not_found":
      sendError(res, "not_found", detail ?? "not found");
      return;
    default:
      sendError(res, "db_error", detail ?? reason);
  }
}

async function ledgerFor(req: any, res: any) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient() ?? auth.client;
  const r = await readMyCreatorLedger(sc, auth.user.id);
  if (!r.ok) { sendCreatorRefusal(res, r.reason, r.detail); return null; }
  return r.value;
}

router.get("/creator-economy/me/impact", asyncHandler(async (req, res) => {
  const v = await ledgerFor(req, res);
  if (!v) return;
  res.json({ impact: v.impact });
}));

router.get("/creator-economy/me/attributions", asyncHandler(async (req, res) => {
  const v = await ledgerFor(req, res);
  if (!v) return;
  res.json({ attributions: v.conversions });
}));

router.get("/creator-economy/me/earnings", asyncHandler(async (req, res) => {
  const v = await ledgerFor(req, res);
  if (!v) return;
  res.json({
    earnings: v.earnings.buckets,
    availableReason: v.earnings.availableReason,
    entries: v.entries.map((e) => ({
      sourceLedger: e.sourceLedger,
      entryId: e.sourceEntryId,
      unitKind: e.unitKind,
      unitCode: e.unitCode,
      amount: e.amount,
      status: e.status,
      entryReason: e.entryReason,
      ruleVersion: e.ruleVersion,
      occurredAt: e.occurredAt,
    })),
  });
}));

export default router;
