/**
 * Route Plan API
 *
 *   POST   /api/route-plans               — create + optimize
 *   GET    /api/route-plans/:id           — fetch with stops + legs
 *   PATCH  /api/route-plans/:id/stops/:stopId — checkpoint status / reorder / skip
 *   DELETE /api/route-plans/:id           — delete plan
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, canEditPlan, isAcceptedTripMember } from "../lib/http.js";
import { optimizeRoute, type RouteStyle, type CandidateStop } from "../services/routeOptimizer.js";

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

router.post("/route-plans", async (req, res) => {
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

  const candidates: CandidateStop[] = stops.map((s) => ({
    title: s.title,
    lat: s.lat,
    lng: s.lng,
    sourceType: s.sourceType,
    openingHoursNote: s.openingHoursNote ?? null,
    category: s.category ?? null,
  }));

  const optimized = optimizeRoute(candidates, {
    style: routeStyle as RouteStyle,
    startLocation: startLocation ?? null,
    endLocation: endLocation ?? null,
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

  const stopInserts = optimized.stops.map((os, i) => {
    const src = stops[os.index - (startLocation ? 1 : 0)];
    return {
      route_plan_id: planId,
      source_type: src?.sourceType ?? "manual",
      source_id: src?.sourceType !== "manual" ? (src as any)?.sourceId ?? null : null,
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

  const fullPlan = await fetchFullPlan(client, planId);
  res.status(201).json({
    ...fullPlan,
    warnings: optimized.warnings,
    totalDistanceMeters: optimized.totalDistanceMeters,
    totalDurationSeconds: optimized.totalDurationSeconds,
  });
});

// ── GET /api/route-plans/:id ──────────────────────────────────────────────────

router.get("/route-plans/:id", async (req, res) => {
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
});

// ── PATCH /api/route-plans/:id/stops/:stopId ──────────────────────────────────

router.patch("/route-plans/:id/stops/:stopId", async (req, res) => {
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
});

// ── DELETE /api/route-plans/:id ───────────────────────────────────────────────

router.delete("/route-plans/:id", async (req, res) => {
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
});

// ── Helper: fetch full plan ───────────────────────────────────────────────────

async function fetchFullPlan(client: ReturnType<typeof import("../lib/supabase.js").getServiceClient>, id: string) {
  const { data: plan } = await (client as any)
    .from("route_plans")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!plan) return null;

  const { data: stops } = await (client as any)
    .from("route_stops")
    .select("*")
    .eq("route_plan_id", id)
    .order("order_index", { ascending: true });

  const { data: legs } = await (client as any)
    .from("route_legs")
    .select("*")
    .eq("route_plan_id", id)
    .order("created_at", { ascending: true });

  return {
    plan: toCamel(plan as Record<string, unknown>),
    stops: (stops ?? []).map((s: Record<string, unknown>) => toCamel(s)),
    legs: (legs ?? []).map((l: Record<string, unknown>) => toCamel(l)),
  };
}

export default router;
