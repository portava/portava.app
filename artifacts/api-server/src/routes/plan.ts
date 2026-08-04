/**
 * Plan helper routes — add place or meetup to a trip plan.
 *
 *   POST /api/meetups/:meetupId/add-to-trip-plan  { tripId }
 *   POST /api/places/:placeId/add-to-trip-plan    { tripId, dayDate?, startsAt? }
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, isAcceptedTripMember, canEditPlan, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

// ── POST /meetups/:meetupId/add-to-trip-plan ─────────────────────────────────

const AddMeetupSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
  lockType: z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

router.post("/meetups/:meetupId/add-to-trip-plan", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const parsed = AddMeetupSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId, lockType } = parsed.data;

  // Caller must be an accepted trip member with plan edit permission
  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  // Fetch meetup row — we use a meetups table stub (title, starts_at, location_name)
  const { data: meetup } = await client
    .from("meetups")
    .select("id, title, starts_at, location_name, trip_id")
    .eq("id", meetupId)
    .maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }

  // Enforce meetup-trip identity: a trip-scoped meetup may only be added to its own trip
  // (guard ported from the now-removed duplicate handler in meetups.ts).
  if ((meetup as any).trip_id && (meetup as any).trip_id !== tripId) {
    sendError(res, "forbidden", "This meetup is scoped to a different trip");
    return;
  }

  // Duplicate guard: same meetup already added to this trip (non-removed)
  const { data: existing } = await client
    .from("trip_plan_items")
    .select("id")
    .eq("trip_id", tripId)
    .eq("source_type", "meetup")
    .eq("source_id", meetupId)
    .is("removed_at", null)
    .maybeSingle();
  if (existing) { res.status(409).json({ error: "duplicate", message: "This meetup is already in your trip plan" }); return; }

  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id: tripId,
      creator_id: user.id,
      title: (meetup as any).title,
      category: "meeting_point",
      status: "tentative",
      source_type: "meetup",
      source_id: meetupId,
      starts_at: (meetup as any).starts_at ?? null,
      location_name: (meetup as any).location_name ?? null,
      sort_order: 0,
      visibility: "members",
      lock_type: lockType,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add meetup to plan"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
}));

// ── POST /places/:placeId/add-to-trip-plan ───────────────────────────────────

const AddPlaceSchema = z.object({
  tripId:   z.string().regex(UUID, "tripId must be a valid UUID"),
  dayDate:  z.string().optional(),
  startsAt: z.string().optional(),
  lockType: z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

router.post("/places/:placeId/add-to-trip-plan", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { placeId } = req.params;

  const parsed = AddPlaceSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId, dayDate, startsAt, lockType } = parsed.data;

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  // Fetch place row — public-safe columns only (name, category, city)
  // NOTE: exact coordinates are intentionally NOT fetched.
  // Repointed from non-existent "places" to the live "discovery_places" table.
  const { data: place } = await client
    .from("discovery_places")
    .select("id, name, category, city")
    .eq("id", placeId)
    .maybeSingle();
  if (!place) { sendError(res, "not_found", "Place not found"); return; }

  // Duplicate guard
  const { data: existing } = await client
    .from("trip_plan_items")
    .select("id")
    .eq("trip_id", tripId)
    .eq("source_type", "place")
    .eq("source_id", placeId)
    .is("removed_at", null)
    .maybeSingle();
  if (existing) { res.status(409).json({ error: "duplicate", message: "This place is already in your trip plan" }); return; }

  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id: tripId,
      creator_id: user.id,
      title: (place as any).name,
      category: (place as any).category ?? "activity",
      status: "tentative",
      source_type: "place",
      source_id: placeId,
      day_date: dayDate ?? null,
      starts_at: startsAt ?? null,
      location_name: (place as any).city ?? null,
      sort_order: 0,
      visibility: "members",
      lock_type: lockType,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add place to plan"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
}));

// ── Viewer-based privacy filter ───────────────────────────────────────────────

export function filterPlanItemForViewer(row: Record<string, any>): {
  lat: number | null;
  lng: number | null;
  locationIsPrivate: boolean;
} {
  const locationIsPrivate = row.location_is_private ?? true;
  return {
    lat: locationIsPrivate ? null : (row.lat ?? null),
    lng: locationIsPrivate ? null : (row.lng ?? null),
    locationIsPrivate,
  };
}

// ── snake_case → camelCase row mapper ────────────────────────────────────────

function toCamel(row: Record<string, any>, opts: { stripCoords?: boolean; warnings?: string[] } = {}) {
  const coords = opts.stripCoords
    ? { lat: null, lng: null, locationIsPrivate: row.location_is_private ?? true }
    : filterPlanItemForViewer(row);
  return {
    id: row.id,
    tripId: row.trip_id,
    creatorId: row.creator_id,
    title: row.title,
    category: row.category,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id ?? null,
    dayDate: row.day_date ?? null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    locationName: row.location_name ?? null,
    notes: row.notes ?? null,
    sortOrder: row.sort_order,
    visibility: row.visibility,
    lockType: row.lock_type ?? "flexible",
    ...coords,
    warnings: opts.warnings ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { toCamel };
export default router;
