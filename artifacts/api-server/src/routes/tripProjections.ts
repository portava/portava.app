/**
 * Trips spec §19.2 — the internal API's read surface, as projections.
 *
 *   GET /trips/:id/timeline   TripTimelineProjection   (§19.1)
 *   GET /trips/:id/map        TripMapProjection        (§14.1; alias of /map-projection)
 *   GET /trips/:id/crew       TripCrewProjection       (§10 cards + envelope)
 *   GET /trips/:id/context    TripCompassProjection    (§19.1; Compass consumes the same object)
 *   GET /trips/:id/safety     TripSafetyProjection     (§17.4)
 *   GET /trips/:id/freedom-windows  §7.3 windows + §7.2 conflicts (§12.1 getFreedomWindows)
 *   GET /trips/:id/health     TripHealthProjection     (§17.1 health + §3.2 phase)
 *   GET /trips/:id/today      TripTodayProjection      (§11.1)
 *   GET /trips/:id/decisions/:decisionId/explain   §21.2 ledger, §12.1 explainTripDecision
 *   GET /trips/:id/closeout   §20.2 steps + §20.3 questions for a completed trip
 *
 * The last three need kernel-era schema and sit behind
 * `trip_operational_projections_enabled` (lib/tripOperationalProjections.ts),
 * seeded FALSE: off, they answer `feature_disabled`.
 *
 * `/today` is §11.1's and is not here: its inputs (the Temporal Freedom
 * Engine, §7.3) do not exist yet, and a `/today` that returned the plan under
 * another name would be the "different path, same list" finding that
 * census-trips TR371/TR373 already made about `/plan/map` and `/plan`.
 *
 * WHAT MAKES THESE PROJECTIONS AND NOT ENDPOINTS
 * ==============================================
 * Every response spreads one `TripProjectionEnvelope` (services/trips/
 * TripProjectionEnvelope.ts): `projectionSchemaVersion`, `generatedAt`,
 * `sourceTripVersion`, `freshness`. The version is read BEFORE the rows —
 * routes/tripMapProjection.ts established the order — so it names the state
 * the rows were read against. When it cannot be read, `freshness` says
 * "unattributable" and the projection is served anyway; when the rows a
 * projection IS cannot be read, the request is refused with a
 * `TRIP_PROJECTION_UNAVAILABLE` reason, because a projection assembled from a
 * failed read is a claim about the trip that nobody made.
 *
 * THE OLD ENDPOINTS STAY
 * ======================
 * `/plan`, `/plan/map`, `/crew/map` and `/map-projection` keep their shapes.
 * The client that groups `/plan` into days on its own is not broken by a
 * server that also can; it is given something better to read.
 *
 * AUTHORIZATION
 * =============
 * The same gate the surface each projection is built from already applies:
 * accepted crew for the timeline, context and safety (as `/plan`); any
 * membership including invited for the crew projection (as `/crew/map`, whose
 * header explains why an invitee may see who else is coming). Refusals carry
 * Appendix B reasons (lib/tripReasonCodes.ts).
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { toCamel } from "./plan.js";
import { computeWarnings } from "./trips.js";
import { serveMapProjection } from "./tripMapProjection.js";
import { liveEnvelope, readTripVersion } from "../services/trips/TripProjectionEnvelope.js";
import { buildTripTimeline } from "../services/trips/TripTimelineProjection.js";
import { projectTripSafety, type SafetySessionRow } from "../services/trips/TripSafetyProjection.js";
import { buildTripCompassProjection } from "../services/trips/TripCompassProjection.js";
import { buildTripFreedomProjection } from "../services/trips/TripFreedomProjection.js";
import { buildTripHealthProjection } from "../services/trips/TripHealthProjection.js";
import { buildTripPulseProjection } from "../services/trips/TripPulseProjection.js";
import { buildTripOpportunityProjection } from "../services/trips/TripOpportunityProjection.js";
import { loadImpactState } from "../services/trips/TripImpactState.js";
import { previewImpact, CHANGE_KINDS, type ProposedChange } from "../services/trips/TripImpactPreview.js";
import { simulateChange, type ReplanConstraints } from "../services/trips/TripReplan.js";
import { computeReplan, computeMeetingPoint } from "../services/trips/TripReplanService.js";
import { planRescue, RESCUE_PROBLEMS, type RescueProblem } from "../services/trips/TripRescue.js";
import { getCrewMap, CrewMapUnavailableError } from "../services/tripCrew/TripCrewLocationService.js";
import { executeTripCommand } from "../lib/tripKernel.js";
import { incrementTripMetric } from "../lib/tripMetrics.js";
import { randomUUID } from "node:crypto";
import { recordNotificationActed } from "../lib/tripPush.js";
import { verifyTripReplay } from "../lib/tripReplayVerify.js";
import { tripOperationalProjectionsGate } from "../lib/tripOperationalProjections.js";
import { TRIP_PUSH_EVENT_PROFILES } from "../services/trips/TripAttentionPolicy.js";
import { buildTripTodayProjection } from "../services/trips/TripTodayProjection.js";
import { explainTripDecisionFrom, DECISION_RETENTION } from "../services/trips/TripDecisionLedger.js";
import { runTripCloseout } from "../services/trips/TripCloseoutService.js";
import { detectPlanOverlaps } from "../services/trips/TripFreedomEngine.js";

const router = Router();
const log = logger.child({ mod: "tripProjections" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** The columns `GET /trips/:tripId/plan` reads — the same list, so the two cannot disagree about an item. */
const PLAN_ITEM_COLUMNS =
  "id, trip_id, creator_id, title, category, status, source_type, source_id, " +
  "day_date, starts_at, ends_at, location_name, notes, sort_order, visibility, " +
  "lock_type, location_is_private, lat, lng, created_at, updated_at";

/** Safe Return statuses that have a §17.4 operational state. `pending`/`cancelled` do not. */
const OPERATIONAL_SAFE_RETURN_STATUSES = ["active", "missed", "safe"];

// ── GET /trips/:tripId/timeline ───────────────────────────────────────────────

router.get("/trips/:tripId/timeline", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the timeline"); return; }

  // Version and dates from ONE row, first. An unreadable trips row is refused
  // outright (as /plan does): the dates decide the warnings and the days, so
  // there is no honest timeline without them.
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("start_date, end_date, version")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "timeline: trip unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "We could not read this trip's dates right now, so the timeline cannot be built. Please try again shortly.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const t = trip as any;
  const tripStartDate: string | null = t.start_date ?? null;
  const tripEndDate: string | null = t.end_date ?? null;
  const sourceTripVersion: number | null = typeof t.version === "number" ? t.version : null;

  const editAllowed = await canEditPlan(sc, tripId, user.id);

  const { data, error } = await sc
    .from("trip_plan_items")
    .select(PLAN_ITEM_COLUMNS)
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true });
  if (error) {
    log.warn({ err: error.message, tripId }, "timeline: plan items unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The plan could not be read right now. Please try again shortly.");
    return;
  }
  const rows = ((data ?? []) as any[]);

  // Cancelled source meetups, exactly as /plan: an unreadable `meetups` read
  // would leave this set empty, which is what "nothing was cancelled" looks
  // like, so it refuses rather than assumes.
  const meetupSourceIds = rows.filter((i) => i.source_type === "meetup" && i.source_id).map((i) => i.source_id as string);
  const cancelledMeetupIds = new Set<string>();
  if (meetupSourceIds.length > 0) {
    const { data: meetups, error: meetupsErr } = await sc.from("meetups").select("id, status").in("id", meetupSourceIds);
    if (meetupsErr) {
      log.warn({ err: meetupsErr.message, tripId }, "timeline: source meetups unreadable — refusing");
      sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "We could not check whether the events behind this plan are still on. Please try again shortly.");
      return;
    }
    for (const m of ((meetups ?? []) as any[])) if (m.status === "cancelled") cancelledMeetupIds.add(m.id);
  }

  const warnMap = computeWarnings(rows, tripStartDate, tripEndDate, cancelledMeetupIds);
  const items = rows.map((row) => toCamel(row, { warnings: warnMap.get(row.id) ?? [] }));
  const timeline = buildTripTimeline(items, { tripStartDate, tripEndDate });

  // §7.2: a conflict is not silently rendered as a normal itinerary. Plan
  // items that overlap on a day are returned as conflicts AND named on their
  // day, so a renderer that only reads days still sees the mark.
  const conflicts = detectPlanOverlaps(items.map((i) => ({ id: i.id, dayDate: i.dayDate, startsAt: i.startsAt, endsAt: i.endsAt })));
  for (const c of conflicts) incrementTripMetric("temporal_conflict_total", { kind: c.kind });
  const conflicted = new Set(conflicts.flatMap((c) => c.planIds));
  const days = timeline.days.map((d) => ({ ...d, conflictIds: d.items.map((i) => i.id).filter((id) => conflicted.has(id)) }));
  // §3.3 AT_RISK, DERIVED rather than stored (§3.1: lifecycle is computed from
  // facts): a plan in a conflict is at risk. §21.1 plan_at_risk_total counts it.
  const atRiskPlanIds = [...conflicted];
  for (const id of atRiskPlanIds) incrementTripMetric("plan_at_risk_total", { plan: id });

  res.json({
    ...liveEnvelope(sourceTripVersion),
    tripId,
    tripStartDate,
    tripEndDate,
    canEdit: editAllowed === true,
    itemCount: rows.length,
    days,
    undated: timeline.undated,
    tripDayCount: timeline.tripDayCount,
    conflicts,
    atRiskPlanIds,
    atRiskReading: "§3.3 AT_RISK is derived, not stored: a plan item in a temporal conflict. No IN_PROGRESS / MOVED state exists (TR46).",
  });
}));

// ── GET /trips/:tripId/freedom-windows — §7.3, §12.1 getFreedomWindows ───────

router.get("/trips/:tripId/freedom-windows", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view freedom windows"); return; }

  const built = await buildTripFreedomProjection(sc, tripId);
  if (!built.ok) { refuseBuild(res, built); return; }
  res.json(built.projection);
}));

/** One mapping for the three gated builders' refusals. */
function refuseBuild(res: Parameters<typeof sendError>[0], built: { reason: string; message: string }): void {
  if (built.reason === "TRIP_NOT_FOUND") { sendError(res, "not_found", built.message); return; }
  if (built.reason === "FEATURE_DISABLED") { sendError(res, "feature_disabled", built.message); return; }
  if (built.reason === "TRIP_PROJECTION_VERSION_AHEAD" || built.reason === "TRIP_PROJECTION_STALE" || built.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH") {
    sendTripRefusal(res, "degraded_unavailable", built.reason, built.message); return;
  }
  sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", built.message);
}

// ── GET /trips/:tripId/health — §17.1 health, §3.2 phase ──────────────────────

router.get("/trips/:tripId/health", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view trip health"); return; }

  const built = await buildTripHealthProjection(sc, tripId, user.id);
  if (!built.ok) { refuseBuild(res, built); return; }
  res.json(built.projection);
}));

// ── GET /trips/:tripId/today — §11.1 ──────────────────────────────────────────

router.get("/trips/:tripId/today", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the Today projection"); return; }

  const built = await buildTripTodayProjection(sc, tripId, user.id);
  if (!built.ok) { refuseBuild(res, built); return; }
  res.json(built.projection);
}));

// ── GET /trips/:tripId/pulse — §16 Trip Pulse ────────────────────────────────

router.get("/trips/:tripId/pulse", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the Trip Pulse"); return; }

  const built = await buildTripPulseProjection(sc, tripId, user.id);
  if (!built.ok) { refuseBuild(res, built); return; }
  res.json(built.projection);
}));

// ── GET /trips/:tripId/opportunities — §13 the experience compiler's portfolio per open window, and the §13.3 event

router.get("/trips/:tripId/opportunities", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view opportunities"); return; }

  const built = await buildTripOpportunityProjection(sc, tripId, user.id);
  if (!built.ok) { refuseBuild(res, built); return; }
  res.json(built.projection);
}));

// ── POST /trips/:tripId/opportunities/:experienceId/accept — §13.3 accepted: ADD_PLAN through the kernel
//
// An accepted opportunity is a plan item in the window it was compiled for,
// written the only way a plan item is written (§4.1): ADD_PLAN, with
// source_type 'opportunity' and source_id the experience id, under an
// idempotency key made of the experience id so a double tap is one plan.
// §21.1 opportunity_accepted_total counts the first acceptance.

router.post("/trips/:tripId/opportunities/:experienceId/accept", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, experienceId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  if (typeof experienceId !== "string" || experienceId.length === 0 || experienceId.length > 200) { sendError(res, "invalid_payload", "Invalid experience id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return; }

  const built = await buildTripOpportunityProjection(sc, tripId, user.id);
  if (!built.ok) { refuseBuild(res, built); return; }
  const experience = built.projection.windows.flatMap((w) => w.executable).find((e) => e.id === experienceId) ?? null;
  if (!experience) {
    const known = built.projection.windows.flatMap((w) => [...w.uncertain, ...w.notExecutable]).find((e) => e.id === experienceId) ?? null;
    if (known) { res.status(409).json({ ok: false, error: "not_executable", reason: known.verdict, reasonCodes: known.reasonCodes, detail: known.explanation.join("; ") }); return; }
    sendError(res, "not_found", "No such opportunity in the current portfolio"); return;
  }
  const dayDate = experience.arriveAt ? experience.arriveAt.slice(0, 10) : null;
  const result = await executeTripCommand(sc, {
    commandId: randomUUID(), tripId, actorUserId: user.id, actorRole: "user",
    idempotencyKey: `opportunity:accept:${experienceId}`, type: "ADD_PLAN",
    payload: {
      title: experience.name, category: "activity", status: "tentative", day_date: dayDate,
      starts_at: experience.arriveAt, ends_at: experience.leaveBy, location_name: experience.name,
      source_type: "opportunity", source_id: experienceId, notes: `From a §13 opportunity: ${experience.explanation.join("; ")}`.slice(0, 500),
    },
    clientObservedAt: new Date().toISOString(),
  });
  if (!result.ok) { res.status(result.reason === "TRIP_KERNEL_UNAVAILABLE" ? 503 : 409).json({ ok: false, reason: result.reason, detail: (result as any).detail ?? null }); return; }
  if (!result.duplicate) incrementTripMetric("opportunity_accepted_total", { trip: tripId, primitive: experience.primitive });
  res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, version: result.version, eventId: result.eventId, planItem: result.result, experienceId });
}));

// ── Batch C: §9.4 preview, §12.1 simulate, §11.3 replan, §14.3 meeting point, §17.3 rescue ──

function parseChange(body: any): ProposedChange | string {
  const c = body?.change;
  if (!c || typeof c !== "object") return "change is required";
  if (!(CHANGE_KINDS as readonly string[]).includes(c.kind)) return `change.kind must be one of ${CHANGE_KINDS.join(", ")}`;
  const targetId = typeof c.targetId === "string" ? c.targetId : null;
  if (c.kind !== "add_plan" && !targetId) return "change.targetId is required for this kind";
  for (const k of ["startsAt", "endsAt"]) if (c[k] != null && (typeof c[k] !== "string" || !Number.isFinite(Date.parse(c[k])))) return `change.${k} must be an ISO instant`;
  return { kind: c.kind, targetId, startsAt: c.startsAt ?? null, endsAt: c.endsAt ?? null, title: typeof c.title === "string" ? c.title.slice(0, 200) : null };
}

async function memberContext(req: any, res: any): Promise<{ sc: any; tripId: string; userId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return null; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  const membership = await requireTripMember(sc, tripId, auth.user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return null; }
  return { sc, tripId, userId: auth.user.id };
}

// §9.4: the impact of a change, before it is proposed or accepted. Reads, never writes.
router.post("/trips/:tripId/proposals/preview", asyncHandler(async (req, res) => {
  const ctx = await memberContext(req, res); if (!ctx) return;
  const change = parseChange(req.body);
  if (typeof change === "string") { sendError(res, "invalid_payload", change); return; }
  const loaded = await loadImpactState(ctx.sc, ctx.tripId);
  if (!loaded.ok) { refuseBuild(res, loaded as any); return; }
  const preview = previewImpact({ ...change, proposedBy: ctx.userId }, loaded.state, Date.now());
  res.json({ tripId: ctx.tripId, sourceTripVersion: loaded.sourceTripVersion, unread: loaded.unread, preview });
}));

// §12.1 simulatePlan: judge one change against the schedule it implies. Reads, never writes.
router.post("/trips/:tripId/simulate", asyncHandler(async (req, res) => {
  const ctx = await memberContext(req, res); if (!ctx) return;
  const change = parseChange(req.body);
  if (typeof change === "string") { sendError(res, "invalid_payload", change); return; }
  const loaded = await loadImpactState(ctx.sc, ctx.tripId);
  if (!loaded.ok) { refuseBuild(res, loaded as any); return; }
  const freedom = await buildTripFreedomProjection(ctx.sc, ctx.tripId);
  if (!freedom.ok) { refuseBuild(res, freedom as any); return; }
  const verdict = simulateChange({ ...change, proposedBy: ctx.userId }, loaded.state, freedom.projection.windows, Date.now());
  res.json({ tripId: ctx.tripId, sourceTripVersion: loaded.sourceTripVersion, simulation: verdict });
}));

// §11.3 "Replan today": a candidate diff; shared mutations become proposals
// (CREATE_PROPOSAL through the kernel) only when asked, and only under the
// kernel flag. Nothing else is written.
router.post("/trips/:tripId/replan", asyncHandler(async (req, res) => {
  const ctx = await memberContext(req, res); if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const now = new Date();
  const constraints: ReplanConstraints = {
    lockedPlanIds: Array.isArray(body.lockedPlanIds) ? body.lockedPlanIds.filter((x: unknown) => typeof x === "string") : [],
    dropPlanIds: Array.isArray(body.dropPlanIds) ? body.dropPlanIds.filter((x: unknown) => typeof x === "string") : [],
    maxMoves: Number.isInteger(body.maxMoves) && body.maxMoves >= 0 ? body.maxMoves : undefined,
    preferIndoor: body.preferIndoor === true,
  };
  const r = await computeReplan(ctx.sc, ctx.tripId, ctx.userId, { day: typeof body.day === "string" ? body.day : null, constraints, now });
  if (!r.ok) { refuseBuild(res, r as any); return; }
  const { day, diff } = r;

  const created: { entryIndex: number; proposalId: string | null; duplicate: boolean; reason: string | null }[] = [];
  let proposalsSkipped: string | null = null;
  if (body.createProposals === true) {
    if (!(await isFlagEnabled(ctx.sc, "trip_kernel_enabled"))) proposalsSkipped = "trip_kernel_enabled is false";
    else {
      for (const e of diff.proposals) {
        const idx = diff.entries.indexOf(e);
        const cmd = await executeTripCommand(ctx.sc, {
          commandId: randomUUID(), tripId: ctx.tripId, actorUserId: ctx.userId, actorRole: "user",
          idempotencyKey: `replan:${day}:${e.op}:${e.planId ?? e.experienceId ?? idx}:${e.to?.startsAt ?? ""}`, type: "CREATE_PROPOSAL",
          payload: {
            proposal_type: `replan_${e.op}`, decision_rule: e.impact?.governance.suggestedDecisionRule ?? "host", expires_at: `${day}T23:59:59.000Z`,
            payload_json: { op: e.op, planId: e.planId, title: e.title, from: e.from, to: e.to, reason: e.reason, detail: e.detail, experienceId: e.experienceId, bookingSideEffects: e.impact?.bookingSideEffects ?? null, source: "replan" },
          },
          clientObservedAt: now.toISOString(),
        });
        created.push({ entryIndex: idx, proposalId: cmd.ok ? String((cmd.result as any)?.id ?? cmd.eventId) : null, duplicate: cmd.ok ? cmd.duplicate : false, reason: cmd.ok ? null : cmd.reason });
      }
    }
  }
  res.json({ tripId: ctx.tripId, sourceTripVersion: r.sourceTripVersion, unread: r.unread, diff, proposals: { created, skipped: proposalsSkipped } });
}));

// §14.3: the smart meeting point. Positions come through the crew map (every §10 rule first); candidates are the crew's saved ideas and the day's plans with a public point.
router.post("/trips/:tripId/meeting-point", asyncHandler(async (req, res) => {
  const ctx = await memberContext(req, res); if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const r = await computeMeetingPoint(ctx.sc, ctx.tripId, ctx.userId, {
    participantIds: Array.isArray(body.participantIds) ? body.participantIds.filter((x: unknown) => typeof x === "string") : undefined,
    candidateIds: Array.isArray(body.candidateIds) ? body.candidateIds.filter((x: unknown) => typeof x === "string") : undefined,
  });
  if (!r.ok) { refuseBuild(res, r as any); return; }
  res.json({ tripId: ctx.tripId, sourceTripVersion: r.sourceTripVersion, meetingPoint: r.result, candidatesConsidered: r.candidatesConsidered });
}));

// §17.3: the rescue entry point. Declares the disruption through the kernel (§17.2's switch) when the kernel is on; returns the plan either way.
router.post("/trips/:tripId/rescue", asyncHandler(async (req, res) => {
  const ctx = await memberContext(req, res); if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const problem = typeof body.problem === "string" ? body.problem : "";
  if (!(RESCUE_PROBLEMS as readonly string[]).includes(problem)) { sendError(res, "invalid_payload", `problem must be one of ${RESCUE_PROBLEMS.join(", ")}`); return; }
  const now = new Date();
  const loaded = await loadImpactState(ctx.sc, ctx.tripId, { now });
  if (!loaded.ok) { refuseBuild(res, loaded as any); return; }
  const st = loaded.state;
  const next = st.commitments.map((c) => ({ c, at: Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "") })).filter((x) => Number.isFinite(x.at) && x.at > now.getTime()).sort((a, b) => a.at - b.at)[0] ?? null;
  const lodging = st.reservations.find((r) => /hotel|lodging|stay|accommodation|hostel|apartment/i.test(`${r.type ?? ""} ${r.title ?? ""}`)) ?? null;
  const transport = st.transport.filter((t) => t.state !== "completed").sort((a, b) => (a.plannedDepartureAt ?? "").localeCompare(b.plannedDepartureAt ?? ""))[0] ?? null;
  const { data: tripRow } = await ctx.sc.from("trips").select("destination_country").eq("id", ctx.tripId).maybeSingle();
  const plan = planRescue(problem as RescueProblem, {
    now: now.getTime(), destinationCountry: (tripRow as any)?.destination_country ?? null, homeCountry: null, emergencyNumber: null,
    nextCommitment: next ? { id: next.c.id, type: next.c.type, arriveBy: new Date(next.at).toISOString() } : null,
    lodging: lodging ? { id: lodging.id, title: lodging.title, confirmationRef: null } : null,
    transport: transport ? { id: transport.id, mode: transport.mode, providerRef: null, fallbackId: null } : null,
    crewWithPosition: [], safeReturnAvailable: true,
  });
  let declared: { ok: boolean; disruptionId: string | null; duplicate: boolean; reason: string | null; skipped: string | null } = { ok: false, disruptionId: null, duplicate: false, reason: null, skipped: null };
  if (!(await isFlagEnabled(ctx.sc, "trip_kernel_enabled"))) declared.skipped = "trip_kernel_enabled is false";
  else {
    const r = await executeTripCommand(ctx.sc, {
      commandId: randomUUID(), tripId: ctx.tripId, actorUserId: ctx.userId, actorRole: "user",
      idempotencyKey: `rescue:${problem}:${now.toISOString().slice(0, 13)}`, type: "DECLARE_DISRUPTION",
      payload: { kind: plan.declare.kind, severity: plan.declare.severity, note: plan.declare.note, affected: [next?.c.id, lodging?.id, transport?.id].filter(Boolean) },
      clientObservedAt: now.toISOString(),
    });
    declared = r.ok ? { ok: true, disruptionId: String((r.result as any)?.id ?? ""), duplicate: r.duplicate, reason: null, skipped: null } : { ok: false, disruptionId: null, duplicate: false, reason: r.reason, skipped: null };
  }
  res.status(201).json({ tripId: ctx.tripId, plan, declared });
}));

// ── POST /trips/:tripId/notifications/acted — §21.1 notification_actionability_rate
//
// The acted side of the rate: the client calls this when the viewer opens a
// trip push (`data.type`). The sent side is recorded by lib/tripPush.ts at
// dispatch. Only kinds the attention policy knows are counted, so the rate
// cannot be inflated with a made-up kind.

router.post("/trips/:tripId/notifications/acted", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const kind = typeof (req.body as any)?.type === "string" ? String((req.body as any).type) : null;
  if (!kind || !(kind in TRIP_PUSH_EVENT_PROFILES)) { sendError(res, "invalid_payload", "type must name a known trip push kind"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return; }

  recordNotificationActed(kind, user.id);
  res.status(204).end();
}));

// ── POST /trips/:tripId/replay/verify — §22.2 / §21.1 trip_event_replay_mismatch_total

router.post("/trips/:tripId/replay/verify", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const atVersion = Number((req.body as any)?.atVersion);
  if (!Number.isInteger(atVersion) || atVersion < 0) { sendError(res, "invalid_payload", "atVersion must be a non-negative integer"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member"); return; }
  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) { sendError(res, "feature_disabled", `Replay verification is not enabled: ${gate.reason}`); return; }

  const v = await verifyTripReplay(sc, tripId, atVersion);
  res.status(v.reason === "TRIP_REPLAY_UNAVAILABLE" ? 503 : 200).json(v);
}));

// ── GET /trips/:tripId/decisions/:decisionId/explain — §21.2, §12.1 ───────────

router.get("/trips/:tripId/decisions/:decisionId/explain", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, decisionId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to explain a decision"); return; }

  const explained = await explainTripDecisionFrom(sc, decisionId);
  // A decision for another trip is not this crew's to read, and is answered
  // exactly as one that was never retained: nothing about it leaks.
  if (!explained || explained.decision.tripId !== tripId) {
    sendError(res, "not_found", `Decision ${decisionId} is not retained. ${DECISION_RETENTION}`);
    return;
  }
  res.json(explained);
}));

// ── GET /trips/:tripId/closeout — §20.2 / §20.3 ───────────────────────────────

router.get("/trips/:tripId/closeout", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the closeout"); return; }

  // The closeout PLAN for a trip, read-only: what POST /complete would do,
  // and — after completion — the §20.3 questions still open. Nothing is
  // stopped here; only POST /complete performs a step.
  const { data: trip, error: tripErr } = await sc.from("trips").select("status, timezone").eq("id", tripId).maybeSingle();
  if (tripErr) { sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The trip could not be read"); return; }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const report = await runTripCloseout(sc, tripId, { timezone: (trip as any).timezone ?? null, dryRun: true });
  res.json({ tripId, tripStatus: (trip as any).status ?? null, ...report });
}));

// ── GET /trips/:tripId/map — §19.2's path for the §14.1 projection ───────────

router.get("/trips/:tripId/map", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  await serveMapProjection(req, res, auth);
}));

// ── GET /trips/:tripId/crew ───────────────────────────────────────────────────

router.get("/trips/:tripId/crew", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Same flag, same order, same degraded shape as /crew/map — plus the
  // envelope, with `freshness: "unattributable"` because nothing was read.
  if (!await isFlagEnabled(sc, "trip_crew_map_enabled")) {
    res.status(200).json({
      ...liveEnvelope(null), tripId, featureEnabled: false, members: [], totalCount: 0,
      reading: "trip_crew_map_enabled is off; no crew was read",
    });
    return;
  }

  // Invited members may see who else is coming (routes/tripCrewLocation.ts header).
  const membership = await requireTripMember(sc, tripId, user.id, { status: "any" });
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "Only trip members (including invited) can view the crew projection"); return; }

  const sourceTripVersion = await readTripVersion(sc, tripId);
  try {
    const result = await getCrewMap(sc, tripId, user.id);
    res.status(200).json({ ...liveEnvelope(sourceTripVersion), tripId, featureEnabled: true, ...result });
  } catch (err) {
    // getCrewMap refuses (503, retryable) when an input it cannot answer
    // without could not be read; the global handler reads the status/code it
    // carries. Everything else stays a 500. Same as /crew/map.
    if (err instanceof CrewMapUnavailableError) {
      log.warn({ err, tripId }, "crew projection: input unavailable — refusing");
      throw err;
    }
    throw err;
  }
}));

// ── GET /trips/:tripId/context ────────────────────────────────────────────────

router.get("/trips/:tripId/context", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the trip context"); return; }

  const built = await buildTripCompassProjection(sc, tripId);
  if (!built.ok) {
    if (built.reason === "TRIP_NOT_FOUND") { sendError(res, "not_found", built.message); return; }
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", built.message);
    return;
  }
  res.json(built.projection);
}));

// ── GET /trips/:tripId/safety ─────────────────────────────────────────────────

router.get("/trips/:tripId/safety", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to view the safety projection"); return; }

  // Owner and version from one row, first.
  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, version").eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "safety: trip unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The trip could not be read right now. Please try again shortly.");
    return;
  }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const ownerId: string | null = (trip as any).owner_id ?? null;
  const sourceTripVersion: number | null = typeof (trip as any).version === "number" ? (trip as any).version : null;

  // The roster decides whose session is this trip's. REFUSE when it cannot be
  // read — a roster of "the owner and nobody else" is a claim, not a fallback.
  const { data: members, error: membersErr } = await sc
    .from("trip_members")
    .select("user_id, status")
    .eq("trip_id", tripId)
    .in("role", ["owner", "co_host", "member", "viewer"]);
  if (membersErr) {
    log.warn({ err: membersErr.message, tripId }, "safety: trip_members unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The crew could not be read right now. Please try again shortly.");
    return;
  }
  const crewIds = new Set<string>(ownerId ? [ownerId] : []);
  for (const m of ((members ?? []) as any[])) {
    if (m.status == null || m.status === "accepted") crewIds.add(String(m.user_id));
  }

  // The safety-critical read. An unreadable table would say NOBODY is walking
  // home when the truth is "we could not look" (the crew map's reasoning,
  // services/tripCrew/TripCrewLocationService.ts) — refused, not emptied.
  const { data: sessions, error: sessionsErr } = await sc
    .from("safe_return_sessions")
    .select("id, user_id, trip_id, status, escalation_level, timer_start_at, timer_end_at, notify_trip_crew_enabled, closed_at, updated_at")
    .eq("trip_id", tripId)
    .in("status", OPERATIONAL_SAFE_RETURN_STATUSES);
  if (sessionsErr) {
    log.warn({ err: sessionsErr.message, tripId }, "safety: safe_return_sessions unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "Safe Return status could not be read right now. Please try again shortly.");
    return;
  }

  // Each member's own answer to "may the crew see my Safe Return status".
  // Unreadable means the disclosure rule is unknown for everyone — refused.
  const { data: prefs, error: prefsErr } = await sc
    .from("trip_crew_location_preferences")
    .select("user_id, share_safe_return_status")
    .eq("trip_id", tripId);
  if (prefsErr) {
    log.warn({ err: prefsErr.message, tripId }, "safety: trip_crew_location_preferences unreadable — refusing");
    sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "Sharing preferences could not be read right now. Please try again shortly.");
    return;
  }
  const sharePrefs = new Map<string, boolean>();
  for (const p of ((prefs ?? []) as any[])) sharePrefs.set(String(p.user_id), p.share_safe_return_status === true);

  res.json(projectTripSafety(
    { tripId, viewerId: user.id, crewIds, sessions: ((sessions ?? []) as SafetySessionRow[]), sharePrefs },
    liveEnvelope(sourceTripVersion),
  ));
}));

export default router;
