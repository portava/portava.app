/**
 * Intelligence Gathering — internal coverage & mission routes (IG-08, spec §26).
 *
 * GET  /v1/internal/intel/coverage           — latest producer-computed gap ranking
 * POST /v1/internal/intel/coverage           — rank coverage gaps from supplied inputs (ad-hoc)
 * GET  /v1/internal/intel/missions           — list mission candidates (gap dashboard)
 * POST /v1/internal/intel/missions           — generate candidates from trigger specs
 * POST /v1/internal/intel/missions/:id/dispatch — atomic budget-commit + dispatch
 * POST /v1/internal/intel/missions/:id/accept   — accept a dispatched mission
 *
 * ALL internal: requireAdmin gates every route (never client-facing). GET /coverage
 * serves the ranking the coverage producer (lib/intelCoverageScheduler) writes to
 * intel_coverage_snapshots; the POST remains for ad-hoc ranking of inputs the caller
 * supplies. Missions are NON-CASH; dispatch/generate are gated by intel_missions,
 * accept is not (an already-dispatched commitment is honored even with the flag off).
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { computeCoverage, generateMissions, commitAndDispatch, acceptMission, completeMission, declineMission, MISSION_RESULTS, type MissionResult } from "../services/intel/CoverageService.js";

const router = Router();

const cellSchema = z.object({
  claimFamily: z.string().max(60),
  zoneId: z.string().max(120).nullable().optional(),
  demandEvents: z.number().int().min(0),
  claimMissing: z.boolean(),
  freshestAgeRatio: z.number().min(0).max(1).optional(),
  currentConfidence: z.number().min(0).max(1),
  requiredConfidence: z.number().min(0).max(1).optional(),
  topContributorShare: z.number().min(0).max(1),
});

const triggerCtxSchema = z.object({
  qualifiedDemandEvents6h: z.number().int().min(0),
  requiredLiveFamilyMissing: z.boolean(),
  pendingDecisionsAffectedByContradiction: z.number().int().min(0),
  criticalClaimStale: z.boolean(),
  criticalClaimInActivePlan: z.boolean(),
  campaignHasExplicitBudget: z.boolean(),
  campaignHasAcceptanceContract: z.boolean(),
});

const missionSpecSchema = z.object({
  ctx: triggerCtxSchema,
  mission: z.object({
    city: z.string().max(120),
    zoneId: z.string().max(120).nullable().optional(),
    claimFamily: z.string().max(60),
    trigger: z.enum(["demand_spike_missing_family", "material_contradiction", "stale_critical_in_plan", "funded_campaign"]),
    coverageScore: z.number().min(0).max(1),
    question: z.string().max(500),
    budgetUnits: z.number().int().min(0).optional(),
  }),
});

router.post("/v1/internal/intel/coverage", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const parsed = z.object({ cells: z.array(cellSchema).max(500) }).safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid cells");
  res.json({ coverage: computeCoverage(parsed.data.cells.map((c) => ({ ...c, zoneId: c.zoneId ?? null }))) });
}));

// GET /coverage — the real gap ranking the producer writes (intel_coverage_snapshots).
// Serves the LATEST snapshot per (zone, claim-family), worst gap first. Replaces the
// former "reader not wired yet" note: the coverage scheduler now assembles the inputs.
router.get("/v1/internal/intel/coverage", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const cityFilter = typeof req.query.city === "string" && req.query.city.length > 0 ? req.query.city : null;
  // Only UNEXPIRED snapshots: a gap that stopped being written (filled, or its
  // demand lapsed) ages out instead of lingering as a false open gap.
  let q = ctx.sc
    .from("intel_coverage_snapshots")
    .select("*")
    .gt("expires_at", new Date().toISOString())
    .order("computed_at", { ascending: false })
    .limit(4000);
  if (cityFilter) q = q.eq("city", cityFilter);
  const { data, error } = await q;
  if (error) return sendError(res, "db_error", "coverage read failed");
  // Latest snapshot per (zone, claim-family): rows arrive newest-first, so the
  // first occurrence of each cell key is the current one.
  const seen = new Set<string>();
  const latest: any[] = [];
  for (const row of (data ?? []) as any[]) {
    const key = `${row.zone_id ?? ""}|${row.claim_family}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  latest.sort((a, b) => Number(b.score) - Number(a.score));
  res.json({ coverage: latest });
}));

router.get("/v1/internal/intel/missions", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { data, error } = await ctx.sc
    .from("intel_mission_candidates")
    .select("*")
    .order("coverage_score", { ascending: false })
    .limit(200);
  if (error) return sendError(res, "db_error", "mission list failed");
  res.json({ missions: data ?? [] });
}));

router.post("/v1/internal/intel/missions", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const parsed = z.object({ specs: z.array(missionSpecSchema).max(100) }).safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid specs");
  const out = await generateMissions(ctx.sc, parsed.data.specs as any);
  if (!out.ok) return sendError(res, out.reason === "disabled" ? "feature_disabled" : "db_error", out.reason ?? "generate failed");
  res.status(201).json({ created: out.created });
}));

router.post("/v1/internal/intel/missions/:id/dispatch", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "mission id (uuid) required");
  const out = await commitAndDispatch(ctx.sc, id.data);
  if (!out.ok) {
    if (out.reason === "disabled") return sendError(res, "feature_disabled", "dispatch disabled");
    if (out.reason === "not_dispatchable") return sendError(res, "invalid_payload", "mission is not a dispatchable candidate");
    return sendError(res, "db_error", out.reason ?? "dispatch failed");
  }
  res.json({ ok: true });
}));

router.post("/v1/internal/intel/missions/:id/accept", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "mission id (uuid) required");
  const actorId = z.string().uuid().safeParse((req.body ?? {}).actorId);
  if (!actorId.success) return sendError(res, "invalid_payload", "actorId (uuid) required");
  const out = await acceptMission(ctx.sc, id.data, actorId.data);
  if (!out.ok) {
    if (out.reason === "not_acceptable") return sendError(res, "invalid_payload", "mission is not a dispatched, acceptable mission");
    return sendError(res, "db_error", out.reason ?? "accept failed");
  }
  res.json({ ok: true });
}));

// POST /v1/internal/intel/missions/:id/complete — complete an accepted mission
// (§16). A 'negative' result is a VALID completion (AT-13), not a rejection. The
// evidence_contract required shape is enforced by the DB CHECK.
router.post("/v1/internal/intel/missions/:id/complete", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "mission id (uuid) required");
  const result = z.enum(MISSION_RESULTS as unknown as [string, ...string[]]).safeParse((req.body ?? {}).result);
  if (!result.success) return sendError(res, "invalid_payload", "result must be positive | negative | inconclusive");
  const out = await completeMission(ctx.sc, id.data, result.data as MissionResult);
  if (!out.ok) {
    if (out.reason === "not_completable") return sendError(res, "invalid_payload", "mission is not an accepted, completable mission");
    if (out.reason === "invalid_result") return sendError(res, "invalid_payload", "invalid result");
    return sendError(res, "db_error", out.reason ?? "complete failed");
  }
  res.json({ ok: true });
}));

// POST /v1/internal/intel/missions/:id/decline — decline/abort WITHOUT penalty
// (§22). No conduct side effect; records the terminal state + optional reason.
router.post("/v1/internal/intel/missions/:id/decline", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "mission id (uuid) required");
  const reason = z.string().max(500).optional().safeParse((req.body ?? {}).reason);
  if (!reason.success) return sendError(res, "invalid_payload", "reason must be a string");
  const out = await declineMission(ctx.sc, id.data, reason.data);
  if (!out.ok) {
    if (out.reason === "not_declinable") return sendError(res, "invalid_payload", "mission is not in a declinable state");
    return sendError(res, "db_error", out.reason ?? "decline failed");
  }
  res.json({ ok: true });
}));

export default router;
