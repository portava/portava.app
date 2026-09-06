/**
 * Route Plan API
 *
 *   POST   /api/route-plans               — create + optimize
 *   GET    /api/route-plans/:id           — fetch with stops + legs
 *   POST   /api/route-plans/:id/accept    — the traveller ACCEPTS the plan
 *   PATCH  /api/route-plans/:id/stops/:stopId — checkpoint status / reorder / skip
 *   DELETE /api/route-plans/:id           — delete plan
 *
 * ON `status`. POST creates a plan as 'draft' and NOTHING ELSE writes 'active'.
 * That is deliberate and load-bearing: the stops a plan holds are OPTIMIZER
 * OUTPUT (services/routeOptimizer picked the ordering), so a draft records what
 * a machine proposed, not what a traveller decided. Only POST .../accept turns
 * a proposal into a declaration, and migration 2224's CHECK constraint
 * `route_plans_accepted_requires_evidence` makes an accepted state with no
 * recorded accepter unrepresentable. Map spec §10 (lib/routeHopSignal) reads
 * ONLY accepted plans for exactly this reason.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { requireUser, sendError, canEditPlan, isAcceptedTripMember } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { optimizeRoute, type RouteStyle, type CandidateStop } from "../services/routeOptimizer.js";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine.js";
import type { CompassContext } from "../compass/types.js";
import { makeConfidence } from "../lib/liveIntelligence.js";
import { resolveLocalHour } from "../lib/localTime.js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

// ── Schemas ───────────────────────────────────────────────────────────────────

const LocationSchema = z.object({
  label: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
}).strict();

const CandidateStopSchema = z.object({
  title: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
  openingHoursNote: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

const CreateRoutePlanSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  tripId: z.string().regex(UUID).optional().nullable(),
  routeStyle: z.enum(["nightlife", "scenic", "foodie", "low_walking", "custom"]).default("custom"),
  startLocation: LocationSchema.nullable().optional(),
  endLocation: LocationSchema.nullable().optional(),
  stops: z.array(CandidateStopSchema).min(2).max(20),
});

const PatchStopSchema = z.object({
  checkpointStatus: z.enum(["pending", "arrived", "skipped", "cancelled"]).optional(),
  orderIndex: z.number().int().min(0).optional(),
  arrivedAt: z.string().datetime().optional().nullable(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCamelKey(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[toCamelKey(k)] = v;
  }
  return out;
}

// ── POST /api/route-plans ─────────────────────────────────────────────────────

router.post("/route-plans", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const parsed = CreateRoutePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { title, tripId, routeStyle, startLocation, endLocation, stops } = parsed.data;

  if (tripId) {
    const isMember = await isAcceptedTripMember(client, tripId, user.id);
    if (!isMember) { sendError(res, "not_member", "You must be an accepted trip member"); return; }
    const permitted = await canEditPlan(client, tripId, user.id);
    if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
    if (!permitted) { sendError(res, "forbidden", "You don't have permission to edit this trip plan"); return; }
  }

  // sourceId is carried on CandidateStop so the optimizer preserves it through
  // reordering; stopInserts reads from os.stop directly (not stops[os.index]).
  const candidates: CandidateStop[] = stops.map((s) => ({
    title: s.title,
    lat: s.lat,
    lng: s.lng,
    sourceType: s.sourceType,
    sourceId: s.sourceId ?? null,
    openingHoursNote: s.openingHoursNote ?? null,
    category: s.category ?? null,
  }));

  // Derive Compass intent mode from traveler's local hour + route style.
  // This feeds through to compassExplanation so the AI rationale reflects the
  // user's current situational mode (night_mode vs explore_now, etc.).
  const hourUtc = await resolveLocalHour(client, user.id, null);
  const contextState = routeStyle === "nightlife"
    ? "night_mode"
    : routeStyle === "scenic"
    ? "exploring_now"
    : "normal";
  const compassIntentMode = deriveIntentMode({
    contextState,
    signals: { hourUtc, safeReturnActive: false },
  } as CompassContext);

  const optimized = optimizeRoute(candidates, {
    style: routeStyle as RouteStyle,
    startLocation: startLocation ?? null,
    endLocation: endLocation ?? null,
    intentMode: compassIntentMode.primary,
  });

  const { data: plan, error: planErr } = await client
    .from("route_plans")
    .insert({
      owner_user_id: user.id,
      trip_id: tripId ?? null,
      title: title ?? "My Route",
      route_style: routeStyle,
      start_location: startLocation ?? null,
      end_location: endLocation ?? null,
      status: "draft",
      compass_explanation: optimized.compassExplanation ?? null,
      is_approximated: true,
    })
    .select("*")
    .single();

  if (planErr || !plan) {
    req.log.error({ err: planErr }, "create route_plan");
    sendError(res, "db_error", planErr?.message ?? "Failed to create route plan");
    return;
  }

  const planId = (plan as any).id as string;

  // Allowed values for route_stops.source_type DB enum.
  const VALID_SOURCE_TYPES = new Set(["manual", "place", "meetup", "hidden_gem", "discovery", "plan_item"]);
  /** Map client-side aliases to a canonical DB enum value. */
  const canonicalizeSourceType = (t: string | undefined): string => {
    if (!t || !VALID_SOURCE_TYPES.has(t)) return "manual";
    return t;
  };

  // os.stop is the original CandidateStop object (passed by reference through the
  // optimizer). Read sourceType/sourceId from it directly — never use os.index to
  // re-index into the original stops[] array, which breaks after NN + 2-opt reorder.
  const stopInserts = optimized.stops.map((os, i) => {
    const canonicalType = canonicalizeSourceType(os.stop.sourceType);
    return {
      route_plan_id: planId,
      source_type: canonicalType,
      source_id: canonicalType !== "manual" ? (os.stop.sourceId ?? null) : null,
      title: os.stop.title,
      structured_location: {
        label: os.stop.title,
        lat: os.stop.lat,
        lng: os.stop.lng,
      },
      order_index: i,
      checkpoint_status: "pending",
    };
  });

  const { data: insertedStops, error: stopsErr } = await client
    .from("route_stops")
    .insert(stopInserts)
    .select("id, order_index");

  if (stopsErr || !insertedStops) {
    req.log.error({ err: stopsErr }, "insert route_stops");
    sendError(res, "db_error", stopsErr?.message ?? "Failed to insert stops");
    return;
  }

  const stopIdByIndex = new Map((insertedStops as Array<{ id: string; order_index: number }>).map((s) => [s.order_index, s.id]));

  const legInserts = optimized.legs.map((leg) => ({
    route_plan_id: planId,
    from_stop_id: stopIdByIndex.get(leg.fromIndex) ?? null,
    to_stop_id: stopIdByIndex.get(leg.toIndex) ?? null,
    distance_meters: leg.distanceMeters,
    duration_seconds: leg.durationSeconds,
    mode: leg.mode,
    provider: "approximated",
    is_approximated: true,
    safety_notes: leg.safetyNotes ?? null,
  })).filter((l) => l.from_stop_id && l.to_stop_id);

  if (legInserts.length > 0) {
    const { error: legsErr } = await client.from("route_legs").insert(legInserts);
    if (legsErr) req.log.warn({ err: legsErr }, "insert route_legs partial failure");
  }

  // Link trip_plan_items.route_stop_id for stops whose sourceType is 'plan_item'.
  // This enables bidirectional navigation between itinerary items and route stops.
  const planItemLinks = stopInserts
    .map((si, idx) => ({
      sourceType: si.source_type,
      sourceId:   si.source_id,
      stopId:     stopIdByIndex.get(idx),
    }))
    .filter((x) => x.sourceType === "plan_item" && x.sourceId && x.stopId);

  if (planItemLinks.length > 0) {
    for (const link of planItemLinks) {
      const { error: linkErr } = await (client as any)
        .from("trip_plan_items")
        .update({ route_stop_id: link.stopId })
        .eq("id", link.sourceId);
      if (linkErr) {
        req.log.warn({ err: linkErr, sourceId: link.sourceId }, "link trip_plan_item route_stop_id");
      }
    }
  }

  const fullPlan = await fetchFullPlan(client, planId);
  res.status(201).json({
    ...fullPlan,
    warnings: optimized.warnings,
    totalDistanceMeters: optimized.totalDistanceMeters,
    totalDurationSeconds: optimized.totalDurationSeconds,
  });
}));

// ── GET /api/route-plans/:id ──────────────────────────────────────────────────

router.get("/route-plans/:id", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const fullPlan = await fetchFullPlan(client, id);
  if (!fullPlan) { sendError(res, "not_found", "Route plan not found"); return; }

  const plan = fullPlan.plan as any;
  if (plan.ownerUserId !== user.id) {
    if (plan.tripId) {
      const isMember = await isAcceptedTripMember(client, plan.tripId, user.id);
      if (!isMember) { sendError(res, "forbidden", "Not a trip member"); return; }
    } else {
      sendError(res, "forbidden", "Not the route owner"); return;
    }
  }

  res.json(fullPlan);
}));

// ── GET /api/route-plans/for-trip/:tripId ──────────────────────────────────────
//
// The Trip Map (§11) renders "routes from the route plan", but the map is opened
// with a tripId, not a plan id. This returns the VIEWER'S OWN route plan for the
// trip — the accepted (status='active') one if present, else the most recently
// updated — so the map can draw the route line without the client reconstructing
// route intelligence (§19). Scoped to owner_user_id = the caller, so a member
// only ever sees their own plan (no cross-member disclosure). Returns null when
// the viewer has no route plan for the trip.
//
// The two-segment path never collides with GET /route-plans/:id (one segment).
router.get("/route-plans/for-trip/:tripId", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const { data: plans, error } = await (client as any)
    .from("route_plans")
    .select("id, status, updated_at")
    .eq("owner_user_id", user.id)
    .eq("trip_id", tripId)
    .order("updated_at", { ascending: false });
  if (error) { req.log.error({ err: error }, "route plans for trip"); sendError(res, "db_error", error.message ?? "Failed to read route plans"); return; }

  const list = (plans ?? []) as Array<{ id: string; status: string }>;
  // Prefer the accepted plan (§10: only accepted plans are declarations), else
  // the most recently updated draft.
  const chosen = list.find((p) => p.status === "active") ?? list[0] ?? null;
  if (!chosen) { res.json(null); return; }

  const fullPlan = await fetchFullPlan(client, chosen.id);
  res.json(fullPlan ?? null);
}));

// ── POST /api/route-plans/:id/accept ──────────────────────────────────────────
//
// THE ACCEPTANCE TRANSITION — the only writer of route_plans.status='active'.
//
// WHY IT EXISTS. Until this endpoint, `status` was written exactly once, as
// 'draft', so the enum's accepted states were unreachable and there was no way
// to tell a plan a traveller ADOPTED from one the optimizer merely GENERATED.
// That distinction is the whole basis on which Map spec §10 may treat a route
// leg as a signal at all: an optimizer's proposed ordering is a machine's guess
// about where somebody might go, and aggregating those would publish what a
// machine proposed rather than what people did.
//
// WHAT MAKES AN ACCEPTED PLAN DISTINGUISHABLE, IN THE DATA:
//   status='active' AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT
//   NULL — and migration 2224's CHECK constraint makes any other combination
//   unrepresentable, so a reader is trusting the database rather than trusting
//   that every future writer remembers to stamp all three.
//
// OWNER ONLY. Acceptance is a declaration about the accepter's own intended
// movement, so it is not a trip-editing permission: a trip editor may reshape
// somebody else's plan (canEditPlan), but may not declare on their behalf. This
// also keeps the §10 actor unambiguous — one accepted plan contributes exactly
// one person, the one who pressed accept.
//
// IDEMPOTENT, AND DELIBERATELY NOT RE-STAMPING. Re-accepting an already-active
// plan returns the existing acceptance untouched. Re-stamping accepted_at would
// let a client refresh a plan's freshness on demand and hold a stale hop inside
// the crowd-flow window indefinitely — a freshness gate anyone can reset is not
// a freshness gate.
//
// ACCEPTANCE IS NOT CONSENT TO PUBLISH. Nothing here reads or requires
// route_flow_contribution_consent: a traveller may accept a plan and contribute
// nothing. Consent is checked at READ time (lib/routeHopSignal), so a
// withdrawal takes effect immediately and retroactively.

router.post("/route-plans/:id/accept", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, owner_user_id, status, accepted_at, accepted_by_user_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }

  if ((plan as any).owner_user_id !== user.id) {
    sendError(res, "forbidden", "Only the route owner can accept this plan"); return;
  }

  const status = (plan as any).status as string;

  if (status === "active") {
    res.json({
      id,
      status,
      acceptedAt:        (plan as any).accepted_at ?? null,
      acceptedByUserId:  (plan as any).accepted_by_user_id ?? null,
      alreadyAccepted:   true,
    });
    return;
  }
  if (status !== "draft") {
    sendError(res, "invalid_state_transition", `A ${status} route plan cannot be accepted`);
    return;
  }

  const acceptedAt = new Date().toISOString();
  // Compare-and-set on status='draft': two concurrent accepts collapse to one
  // acceptance instead of racing to overwrite each other's timestamp.
  const { data: updated, error: acceptErr } = await (client as any)
    .from("route_plans")
    .update({
      status:              "active",
      accepted_at:         acceptedAt,
      accepted_by_user_id: user.id,
      updated_at:          acceptedAt,
    })
    .eq("id", id)
    .eq("status", "draft")
    .select("id, status, accepted_at, accepted_by_user_id")
    .maybeSingle();

  if (acceptErr) {
    req.log.error({ err: acceptErr }, "accept route_plan");
    sendError(res, "db_error", acceptErr.message ?? "Failed to accept route plan");
    return;
  }
  if (!updated) {
    // The compare-and-set matched nothing: the plan left 'draft' between the
    // read and the write. Say so rather than reporting a success we did not do.
    sendError(res, "conflict", "Route plan changed state while being accepted");
    return;
  }

  res.json({
    id:               (updated as any).id,
    status:           (updated as any).status,
    acceptedAt:       (updated as any).accepted_at,
    acceptedByUserId: (updated as any).accepted_by_user_id,
    alreadyAccepted:  false,
  });
}));

// ── POST /api/route-plans/:id/complete ────────────────────────────────────────
//
// THE TERMINATION TRANSITION — the only writer of route_plans.status='completed'.
//
// WHY THIS EXISTS. Acceptance had a canonical server mutation and termination did
// not, so a walk that finished stayed 'active' forever. That is not cosmetic:
// lib/routeHopSignal.ts:118 declares ACCEPTED_PLAN_STATUS='active' as the ONLY
// status that contributes to the §10 Crowd Flow aggregate, precisely because
// "a completed plan is a past journey, not a live intent". With nothing ever
// writing a terminal status, an ended walk kept contributing route-flow
// intelligence for the whole freshness window after the traveller went home.
//
// NO NEW SCHEMA. 'completed' is an existing label of the route_plan_status enum
// (draft | active | completed | cancelled) and accepted_at / accepted_by_user_id
// are left UNTOUCHED: migration 2224's CHECK requires any non-draft row to carry
// both, and the acceptance instant remains the honest observation time for the
// hops already derived from it. Clearing them would both violate the constraint
// and rewrite history.
router.post("/route-plans/:id/complete", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, owner_user_id, status, accepted_at, accepted_by_user_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }

  if ((plan as any).owner_user_id !== user.id) {
    sendError(res, "forbidden", "Only the route owner can complete this plan"); return;
  }

  const status = (plan as any).status as string;

  // Idempotent: ending an already-ended route is a no-op success, so a retried
  // or double-tapped "End route" cannot surface as an error to the traveller.
  if (status === "completed") {
    res.json({
      id,
      status,
      acceptedAt:         (plan as any).accepted_at ?? null,
      alreadyCompleted:   true,
    });
    return;
  }
  if (status !== "active") {
    sendError(res, "invalid_state_transition", `A ${status} route plan cannot be completed`);
    return;
  }

  const completedAt = new Date().toISOString();
  // Compare-and-set on status='active', matching the accept path: two concurrent
  // completions collapse to one instead of racing.
  const { data: updated, error: completeErr } = await (client as any)
    .from("route_plans")
    .update({ status: "completed", updated_at: completedAt })
    .eq("id", id)
    .eq("status", "active")
    .select("id, status, accepted_at, accepted_by_user_id")
    .maybeSingle();

  if (completeErr) {
    req.log.error({ err: completeErr }, "complete route_plan");
    sendError(res, "db_error", completeErr.message ?? "Failed to complete route plan");
    return;
  }
  if (!updated) {
    sendError(res, "conflict", "Route plan changed state while being completed");
    return;
  }

  res.json({
    id:               (updated as any).id,
    status:           (updated as any).status,
    acceptedAt:       (updated as any).accepted_at,
    alreadyCompleted: false,
  });
}));

// ── PATCH /api/route-plans/:id/stops/:stopId ──────────────────────────────────

router.patch("/route-plans/:id/stops/:stopId", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id, stopId } = req.params;
  if (!UUID.test(id) || !UUID.test(stopId)) {
    sendError(res, "invalid_payload", "Invalid plan or stop id"); return;
  }

  const parsed = PatchStopSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, owner_user_id, trip_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }

  const ownerId = (plan as any).owner_user_id as string;
  const tripId = (plan as any).trip_id as string | null;
  const isOwner = ownerId === user.id;

  if (!isOwner) {
    if (tripId) {
      const permitted = await canEditPlan(client, tripId, user.id);
      if (!permitted) { sendError(res, "forbidden", "No permission to update route stops"); return; }
    } else {
      sendError(res, "forbidden", "Only the route owner can update stops"); return;
    }
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.checkpointStatus !== undefined) patch.checkpoint_status = parsed.data.checkpointStatus;
  if (parsed.data.orderIndex !== undefined) patch.order_index = parsed.data.orderIndex;
  if (parsed.data.arrivedAt !== undefined) patch.arrived_at = parsed.data.arrivedAt ?? null;
  if (parsed.data.checkpointStatus === "arrived" && !patch.arrived_at) {
    patch.arrived_at = new Date().toISOString();
  }
  patch.updated_at = new Date().toISOString();

  const { data: updated, error: patchErr } = await client
    .from("route_stops")
    .update(patch)
    .eq("id", stopId)
    .eq("route_plan_id", id)
    .select("*")
    .single();

  if (patchErr || !updated) {
    req.log.error({ err: patchErr }, "patch route_stop");
    sendError(res, "db_error", patchErr?.message ?? "Failed to update stop");
    return;
  }

  res.json(toCamel(updated as Record<string, unknown>));
}));

// ── GET /api/route-plans/:id/members ─────────────────────────────────────────
// Returns route_plan_members (who has explicitly joined) + shared checkpoint progress.

router.get("/route-plans/:id/members", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, owner_user_id, trip_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }

  const isOwner = (plan as any).owner_user_id === user.id;
  const tripId  = (plan as any).trip_id as string | null;

  if (!isOwner) {
    if (tripId) {
      const isMember = await isAcceptedTripMember(client, tripId, user.id);
      if (!isMember) { sendError(res, "forbidden", "Not a trip member"); return; }
    } else {
      sendError(res, "forbidden", "Not the route owner"); return;
    }
  }

  // Fetch joined members from route_plan_members + their profiles
  const { data: members } = await (client as any)
    .from("route_plan_members")
    .select("user_id, joined_at, profiles(id, display_name, handle, avatar_url)")
    .eq("route_plan_id", id);

  // Shared checkpoint progress
  const { data: stops } = await (client as any)
    .from("route_stops")
    .select("id, checkpoint_status")
    .eq("route_plan_id", id);

  const totalStops    = (stops ?? []).length;
  const arrivedCount  = (stops ?? []).filter(
    (s: Record<string, unknown>) => s.checkpoint_status === "arrived",
  ).length;

  // Universal display-name rule: members show @handle unless opted in.
  const allowedMemberNames = await nameVisibilitySet(
    getServiceClient(),
    (members ?? []).map((m: any) => m.user_id),
  );
  const result = (members ?? []).map((m: any) => ({
    userId:      m.user_id,
    displayName: (m.user_id === user.id || allowedMemberNames.has(m.user_id as string))
      ? (m.profiles?.display_name ?? "Traveler")
      : (m.profiles?.handle ? `@${m.profiles.handle}` : "Traveler"),
    avatarUrl:   m.profiles?.avatar_url ?? null,
    isOwner:     m.user_id === (plan as any).owner_user_id,
    joinedAt:    m.joined_at,
    arrivedCount,
    totalCount:  totalStops,
  }));

  res.json({ members: result, totalStops, arrivedCount });
}));

// ── POST /api/route-plans/:id/members — join ──────────────────────────────────

router.post("/route-plans/:id/members", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, trip_id, owner_user_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }

  const tripId = (plan as any).trip_id as string | null;

  if (!tripId) {
    // Non-trip (private) route plans: only the owner can join their own plan.
    // Without this gate any authenticated user who discovers the UUID could
    // mutate membership on a private route.
    if ((plan as any).owner_user_id !== user.id) {
      sendError(res, "forbidden", "Private route plans can only be joined by the owner"); return;
    }
  } else {
    // Trip-linked plans: only accepted trip members may join
    const isMember = await isAcceptedTripMember(client, tripId, user.id);
    if (!isMember) { sendError(res, "forbidden", "Only trip members can join this route"); return; }
  }

  const { error } = await (client as any)
    .from("route_plan_members")
    .upsert({ route_plan_id: id, user_id: user.id }, { onConflict: "route_plan_id,user_id" });

  if (error) {
    req.log.error({ err: error }, "join route_plan_members");
    sendError(res, "db_error", error.message); return;
  }

  res.status(201).json({ joined: true });
}));

// ── DELETE /api/route-plans/:id/members — leave ───────────────────────────────

router.delete("/route-plans/:id/members", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { error } = await (client as any)
    .from("route_plan_members")
    .delete()
    .eq("route_plan_id", id)
    .eq("user_id", user.id);

  if (error) {
    req.log.error({ err: error }, "leave route_plan_members");
    sendError(res, "db_error", error.message); return;
  }

  res.status(204).send();
}));

// ── DELETE /api/route-plans/:id ───────────────────────────────────────────────

router.delete("/route-plans/:id", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid plan id"); return; }

  const { data: plan } = await client
    .from("route_plans")
    .select("id, owner_user_id")
    .eq("id", id)
    .maybeSingle();

  if (!plan) { sendError(res, "not_found", "Route plan not found"); return; }
  if ((plan as any).owner_user_id !== user.id) {
    sendError(res, "forbidden", "Only the route owner can delete this plan"); return;
  }

  const { error } = await client.from("route_plans").delete().eq("id", id);
  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(204).send();
}));

// ── Helper: fetch full plan ───────────────────────────────────────────────────

async function fetchFullPlan(client: ReturnType<typeof import("../lib/supabase.js").getServiceClient>, id: string) {
  const { data: plan } = await (client as any)
    .from("route_plans")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!plan) return null;

  const [stopsResult, legsResult] = await Promise.all([
    (client as any)
      .from("route_stops")
      .select("*")
      .eq("route_plan_id", id)
      .order("order_index", { ascending: true }),
    (client as any)
      .from("route_legs")
      .select("*")
      .eq("route_plan_id", id)
      .order("created_at", { ascending: true }),
  ]);

  // For trip-linked plans, include the primary accommodation location from
  // trip_plan_items so the mobile screen can warn if the last stop is far
  // from where the user is staying.
  let tripAccommodationLocation: { lat: number; lng: number; label?: string } | null = null;
  const tripId = (plan as Record<string, unknown>).trip_id as string | null;
  if (tripId) {
    const { data: accommodationItem } = await (client as any)
      .from("trip_plan_items")
      .select("title, location_name, lat, lng")
      .eq("trip_id", tripId)
      .eq("category", "accommodation")
      .order("day_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (accommodationItem?.lat != null && accommodationItem?.lng != null) {
      const sl = { lat: accommodationItem.lat, lng: accommodationItem.lng, label: accommodationItem.location_name ?? accommodationItem.title } as Record<string, unknown>;
      if (sl.lat != null && sl.lng != null) {
        tripAccommodationLocation = {
          lat:   sl.lat as number,
          lng:   sl.lng as number,
          label: (accommodationItem.title ?? sl.label ?? "Accommodation") as string,
        };
      }
    }
  }

  return {
    plan: {
      ...toCamel(plan as Record<string, unknown>),
      tripAccommodationLocation,
    },
    stops: (stopsResult.data ?? []).map((s: Record<string, unknown>) => toCamel(s)),
    // Phase 8 — route timing is approximated (no live routing source is
    // configured): label each leg's timing honestly as historical estimate.
    legs: (legsResult.data ?? []).map((l: Record<string, unknown>) => ({
      ...toCamel(l),
      timingConfidence: makeConfidence(
        (l.provider as string) === "approximated" ? "historical" : "verified_live",
        (l.provider as string) === "approximated"
          ? "Estimated timing — not verified against live traffic or transit data."
          : undefined,
      ),
    })),
  };
}

export default router;
