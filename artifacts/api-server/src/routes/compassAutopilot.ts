/**
 * Trip Autopilot — Phase 13 routes.
 *
 *   GET  /api/trips/:tripId/autopilot/settings  — user-granted permissions
 *   PUT  /api/trips/:tripId/autopilot/settings  — update permissions
 *   POST /api/trips/:tripId/autopilot/check     — run monitors + partial
 *        re-planner; creates PENDING proposals only (never executes).
 *        Accepts an optional `simulate` array of disruptions so recovery
 *        paths can be exercised end-to-end.
 *   GET  /api/trips/:tripId/heartbeat           — Trip Heartbeat health view
 *   GET  /api/trips/:tripId/autopilot/proposals — pending + recent proposals
 *   POST /api/autopilot/proposals/:id/confirm   — apply within re-verified
 *        permissions and lock types (Fixed items always refused)
 *   POST /api/autopilot/proposals/:id/decline
 *
 * Security: requireUser + accepted trip membership on every route;
 * COMPASS_ENABLED gate with the honest fallback envelope like every
 * Compass surface.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError, isAcceptedTripMember, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isCompassEnabled } from "../compass/flags.js";
import {
  getAutopilotSettings,
  upsertAutopilotSettings,
  runAutopilotCheck,
  computeHeartbeat,
  applyProposal,
  type SimulatedDisruption,
} from "../compass/CompassAutopilotEngine.js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

/* ── Test hooks ─────────────────────────────────────────────────────────────── */
let _testNowMs: number | null = null;
export function _setTestNowMs(ms: number | null): void { _testNowMs = ms; }

async function gate(res: any): Promise<any | null> {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return null;
  }
  const enabled = await isCompassEnabled(sc).catch(() => false);
  if (!enabled) {
    res.json({ compassEnabled: false, fallback: true });
    return null;
  }
  return sc;
}

async function requireMember(sc: any, res: any, tripId: string, userId: string): Promise<boolean> {
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return false; }
  const ok = await isAcceptedTripMember(sc, tripId, userId);
  if (!ok) { sendError(res, "forbidden", "Not a trip member"); return false; }
  return true;
}

// ── Settings ──────────────────────────────────────────────────────────────────

router.get("/trips/:tripId/autopilot/settings", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;
  if (!(await requireMember(sc, res, req.params.tripId, auth.user.id))) return;

  const settings = await getAutopilotSettings(sc, req.params.tripId, auth.user.id);
  res.json({ compassEnabled: true, settings });
}));

const PutSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  allowMoveFlexible: z.boolean().optional(),
  allowMoveOptional: z.boolean().optional(),
  allowRemoveOptional: z.boolean().optional(),
});

router.put("/trips/:tripId/autopilot/settings", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;
  if (!(await requireMember(sc, res, req.params.tripId, auth.user.id))) return;

  const parsed = PutSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const settings = await upsertAutopilotSettings(sc, req.params.tripId, auth.user.id, parsed.data);
  res.json({ compassEnabled: true, settings });
}));

// ── Check (monitors + partial re-planner; propose only) ───────────────────────

const SimulateSchema = z.object({
  simulate: z
    .array(
      z.object({
        kind: z.enum(["item_cancelled", "transport_delay", "closure"]),
        itemId: z.string().regex(UUID).or(z.string().min(1)),
        delayMinutes: z.number().int().min(1).max(1440).optional(),
        note: z.string().max(300).optional(),
      }),
    )
    .max(10)
    .optional(),
});

router.post("/trips/:tripId/autopilot/check", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;
  if (!(await requireMember(sc, res, req.params.tripId, auth.user.id))) return;

  const parsed = SimulateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const result = await runAutopilotCheck(sc, req.params.tripId, auth.user.id, {
    simulate: (parsed.data.simulate ?? []) as SimulatedDisruption[],
  });
  res.json({
    compassEnabled: true,
    issues: result.issues,
    proposalsCreated: result.proposalsCreated,
    proposalsSkipped: result.proposalsSkipped,
  });
}));

// ── Heartbeat ─────────────────────────────────────────────────────────────────

router.get("/trips/:tripId/heartbeat", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;
  if (!(await requireMember(sc, res, req.params.tripId, auth.user.id))) return;

  const heartbeat = await computeHeartbeat(sc, req.params.tripId, auth.user.id, {
    nowMs: _testNowMs ?? undefined,
  });
  res.json({ compassEnabled: true, heartbeat });
}));

// ── Proposals list ────────────────────────────────────────────────────────────

router.get("/trips/:tripId/autopilot/proposals", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;
  if (!(await requireMember(sc, res, req.params.tripId, auth.user.id))) return;

  const { data, error } = await sc
    .from("trip_autopilot_proposals")
    .select("id, issue_type, severity, reason, changes, status, created_at, resolved_at")
    .eq("trip_id", req.params.tripId)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    compassEnabled: true,
    proposals: ((data ?? []) as any[]).map((p) => ({
      id: p.id,
      issueType: p.issue_type,
      severity: p.severity,
      reason: p.reason,
      changes: p.changes ?? [],
      status: p.status,
      createdAt: p.created_at,
      resolvedAt: p.resolved_at ?? null,
    })),
  });
}));

// ── Confirm / decline ─────────────────────────────────────────────────────────

async function loadOwnPendingProposal(sc: any, res: any, id: string, userId: string): Promise<any | null> {
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid proposal id"); return null; }
  const { data: proposal } = await sc
    .from("trip_autopilot_proposals")
    .select("id, trip_id, user_id, issue_type, reason, changes, status")
    .eq("id", id)
    .maybeSingle();
  if (!proposal) { sendError(res, "not_found", "Proposal not found"); return null; }
  if ((proposal as any).user_id !== userId) { sendError(res, "forbidden", "Not your proposal"); return null; }
  if ((proposal as any).status !== "pending") {
    res.status(409).json({ error: "already_resolved", status: (proposal as any).status });
    return null;
  }
  const isMember = await isAcceptedTripMember(sc, (proposal as any).trip_id, userId);
  if (!isMember) { sendError(res, "forbidden", "Not a trip member"); return null; }
  return proposal;
}

router.post("/autopilot/proposals/:id/confirm", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const proposal = await loadOwnPendingProposal(sc, res, req.params.id, auth.user.id);
  if (!proposal) return;

  // Re-authorize at execution time. Confirm is the only autopilot route that
  // WRITES trip_plan_items, so it must honour trips.plan_edit_permission like
  // every other plan write. Membership alone is not enough on an owner_only or
  // specific_members trip, and the per-user autopilot settings applyProposal
  // re-checks are self-service, so they authorize nothing. Deliberately NOT put
  // in loadOwnPendingProposal: /decline shares that helper and writes no plan
  // rows, so gating there would reject a decline the user is entitled to make.
  const permitted = await canEditPlan(sc, (proposal as any).trip_id, auth.user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to edit this trip's plan"); return; }

  const { applied, blocked } = await applyProposal(sc, proposal);
  await sc
    .from("trip_autopilot_proposals")
    .update({ status: "confirmed", resolved_at: new Date().toISOString() })
    .eq("id", proposal.id);

  res.json({ compassEnabled: true, status: "confirmed", applied, blocked });
}));

router.post("/autopilot/proposals/:id/decline", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const proposal = await loadOwnPendingProposal(sc, res, req.params.id, auth.user.id);
  if (!proposal) return;

  await sc
    .from("trip_autopilot_proposals")
    .update({ status: "declined", resolved_at: new Date().toISOString() })
    .eq("id", proposal.id);

  res.json({ compassEnabled: true, status: "declined" });
}));

export default router;
