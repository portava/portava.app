/**
 * trips-expansion.ts
 * Expanded trip API routes: lifecycle, join requests, invite links,
 * budget, documents, notes, checklists, saved places, reminders,
 * activity log, and privacy-aware public trip GET.
 *
 * Mounted alongside the existing trips router via routes/index.ts.
 */
import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { getServiceClient } from "../lib/supabase.js";
import {
  requireUser,
  requireTripMember,
  sendError,
  type ApiErrorCode,
} from "../lib/http.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute canonical status from trip fields (server-authoritative). */
function computeStatus(
  title: string | null,
  destinationCity: string | null,
  startDate: string | null,
  endDate: string | null,
  currentStatus: string,
): string {
  // Honour terminal states — never overwrite.
  if (currentStatus === "cancelled" || currentStatus === "archived") return currentStatus;

  // Draft: missing required fields.
  if (!title || !destinationCity) return "draft";

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  if (startDate) {
    const start = new Date(startDate + "T00:00:00Z");
    const end   = endDate ? new Date(endDate   + "T00:00:00Z") : null;

    if (today < start)                          return "upcoming";
    if (!end || today <= end)                   return "active";
    return "completed";
  }

  // No dates yet — planning.
  return "planning";
}

/** Strip private fields for a public (non-member) viewer. */
function toPublicTrip(t: any): any {
  const out: any = {
    id:               t.id,
    title:            t.title,
    destinationCity:  t.show_destination_city !== false ? t.destination_city : null,
    destinationCountry: t.destination_country ?? null,
    status:           t.status,
    visibility:       t.visibility,
    coverUrl:         t.cover_url ?? null,
    tripType:         t.trip_type ?? "leisure",
    openToMeet:       t.open_to_meet ?? false,
    createdAt:        t.created_at,
    updatedAt:        t.updated_at,
  };

  if (t.show_exact_dates !== false) {
    out.startDate = t.start_date ?? null;
    out.endDate   = t.end_date   ?? null;
  } else {
    out.startDate = null;
    out.endDate   = null;
  }

  if (t.precise_location_visible === true) {
    out.destinationLat = t.destination_lat ?? null;
    out.destinationLng = t.destination_lng ?? null;
  }

  // Never expose: trip_notes, budget, documents, destination_lat/lng (unless above).
  return out;
}

/** Full trip shape for members / owner. */
function toMemberTrip(t: any): any {
  return {
    id:                     t.id,
    title:                  t.title,
    destinationCity:        t.destination_city,
    destinationCountry:     t.destination_country ?? null,
    destinationLat:         t.destination_lat ?? null,
    destinationLng:         t.destination_lng ?? null,
    destinationPlaceId:     t.destination_place_id ?? null,
    neighborhoods:          t.neighborhoods ?? [],
    startDate:              t.start_date ?? null,
    endDate:                t.end_date ?? null,
    status:                 t.status,
    visibility:             t.visibility,
    tripType:               t.trip_type ?? "leisure",
    timezone:               t.timezone ?? null,
    travelStyle:            t.travel_style ?? null,
    openToMeet:             t.open_to_meet ?? false,
    coverUrl:               t.cover_url ?? null,
    progress:               t.progress ?? 0,
    planEditPermission:     t.plan_edit_permission ?? "all_members",
    tripNotes:              t.trip_notes ?? null,
    // Privacy settings
    showOnProfile:          t.show_on_profile ?? true,
    showInDiscovery:        t.show_in_discovery ?? false,
    allowFriendSuggestions: t.allow_friend_suggestions ?? true,
    allowTripCrewInvites:   t.allow_trip_crew_invites ?? true,
    allowJoinRequests:      t.allow_join_requests ?? false,
    showExactDates:         t.show_exact_dates ?? true,
    showDestinationCity:    t.show_destination_city ?? true,
    delayedPostingDefault:  t.delayed_posting_default ?? false,
    preciseLocationVisible: t.precise_location_visible ?? false,
    ownerId:                t.owner_id,
    createdAt:              t.created_at,
    updatedAt:              t.updated_at,
  };
}

async function isBlocked(client: any, userA: string, userB: string): Promise<boolean> {
  const { data } = await client
    .from("blocks")
    .select("blocker_id")
    .or(`blocker_id.eq.${userA},blocker_id.eq.${userB}`)
    .or(`blocked_id.eq.${userA},blocked_id.eq.${userB}`)
    .maybeSingle();
  return Boolean(data);
}

async function logActivity(
  client: any,
  tripId: string,
  actorId: string,
  eventType: string,
  metadata: Record<string, any> = {},
): Promise<void> {
  await client
    .from("trip_activity_log")
    .insert({ trip_id: tripId, actor_id: actorId, event_type: eventType, metadata })
    .then(undefined, () => {});
}

// ---------------------------------------------------------------------------
// GET /api/trips/me  — all trips where caller is an accepted member or owner
// ---------------------------------------------------------------------------
router.get("/trips/me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id, role")
    .eq("user_id", user.id)
    .in("role", ["owner", "member", "co_host"]);

  if (memErr) { sendError(res, "db_error", memErr.message); return; }
  if (!memberRows || memberRows.length === 0) { res.json({ trips: [] }); return; }

  const tripIds = (memberRows as any[]).map((r) => r.trip_id as string);

  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .not("status", "is", null)
    .order("created_at", { ascending: false });

  if (tripsErr) { sendError(res, "db_error", tripsErr.message); return; }

  res.json({ trips: (trips ?? []).map(toMemberTrip) });
});

// ---------------------------------------------------------------------------
// GET /api/trips/upcoming  — upcoming trips (start_date in the future)
// ---------------------------------------------------------------------------
router.get("/trips/upcoming", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: memberRows } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .in("role", ["owner", "member", "co_host"]);

  const tripIds = (memberRows ?? []).map((r: any) => r.trip_id as string);
  if (tripIds.length === 0) { res.json({ trips: [] }); return; }

  const today = new Date().toISOString().slice(0, 10);

  const { data: trips, error } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .in("status", ["upcoming", "planning"])
    .gte("start_date", today)
    .order("start_date", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ trips: (trips ?? []).map(toMemberTrip) });
});

// ---------------------------------------------------------------------------
// GET /api/trips/active  — trips where today is between start and end
// ---------------------------------------------------------------------------
router.get("/trips/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: memberRows } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .in("role", ["owner", "member", "co_host"]);

  const tripIds = (memberRows ?? []).map((r: any) => r.trip_id as string);
  if (tripIds.length === 0) { res.json({ trips: [] }); return; }

  const today = new Date().toISOString().slice(0, 10);

  const { data: trips, error } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .in("status", ["active"])
    .lte("start_date", today)
    .gte("end_date", today)
    .order("start_date", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ trips: (trips ?? []).map(toMemberTrip) });
});

// ---------------------------------------------------------------------------
// GET /api/trips/past  — completed or cancelled trips
// ---------------------------------------------------------------------------
router.get("/trips/past", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: memberRows } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .in("role", ["owner", "member", "co_host"]);

  const tripIds = (memberRows ?? []).map((r: any) => r.trip_id as string);
  if (tripIds.length === 0) { res.json({ trips: [] }); return; }

  const { data: trips, error } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .in("status", ["completed", "cancelled", "archived"])
    .order("end_date", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ trips: (trips ?? []).map(toMemberTrip) });
});

// ---------------------------------------------------------------------------
// GET /api/trips/invites  — pending invitations for the caller (alias for
//   existing /me/trip-invites/pending, kept for consistency with new route set)
// ---------------------------------------------------------------------------
router.get("/trips/invites", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: rows, error } = await sc
    .from("trip_members")
    .select("trip_id, created_at")
    .eq("user_id", user.id)
    .eq("role", "invited");

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!rows || rows.length === 0) { res.json({ invites: [] }); return; }

  const tripIds = (rows as any[]).map((r) => r.trip_id as string);
  const { data: trips } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id")
    .in("id", tripIds);

  const tripMap: Record<string, any> = {};
  for (const t of trips ?? []) tripMap[(t as any).id] = t;

  const ownerIds = [...new Set((trips ?? []).map((t: any) => t.owner_id as string))];
  const profileMap: Record<string, any> = {};
  if (ownerIds.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ownerIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  const invites = (rows as any[]).map((row) => {
    const trip = tripMap[row.trip_id];
    if (!trip) return null;
    const inviter = profileMap[trip.owner_id] ?? null;
    return {
      tripId:             trip.id,
      tripTitle:          trip.title,
      destinationCity:    trip.destination_city,
      destinationCountry: trip.destination_country ?? null,
      startDate:          trip.start_date ?? null,
      endDate:            trip.end_date ?? null,
      coverUrl:           trip.cover_url ?? null,
      invitedAt:          row.created_at,
      inviter: inviter
        ? { id: inviter.id, name: inviter.name, handle: inviter.handle, avatarUrl: inviter.avatar_url ?? null }
        : null,
    };
  }).filter(Boolean);

  res.json({ invites });
});

// ---------------------------------------------------------------------------
// GET /api/trips/join-requests  — pending join requests for caller's trips
// ---------------------------------------------------------------------------
router.get("/trips/join-requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  // Owner's trips only
  const { data: ownedTrips } = await sc
    .from("trips")
    .select("id")
    .eq("owner_id", user.id);

  const tripIds = (ownedTrips ?? []).map((t: any) => t.id as string);
  if (tripIds.length === 0) { res.json({ requests: [] }); return; }

  const { data: reqs, error } = await sc
    .from("trip_join_requests")
    .select("*")
    .in("trip_id", tripIds)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }

  const userIds = [...new Set((reqs ?? []).map((r: any) => r.user_id as string))];
  const profileMap: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", userIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  res.json({
    requests: (reqs ?? []).map((r: any) => ({
      id:        r.id,
      tripId:    r.trip_id,
      status:    r.status,
      message:   r.message ?? null,
      createdAt: r.created_at,
      user:      profileMap[r.user_id]
        ? { id: profileMap[r.user_id].id, handle: profileMap[r.user_id].handle,
            name: profileMap[r.user_id].name, avatarUrl: profileMap[r.user_id].avatar_url ?? null }
        : null,
    })),
  });
});

// ===========================================================================
// PATCH /api/trips/:tripId  — expanded trip update (owner only)
// ===========================================================================
const ExpandedPatchTripSchema = z.object({
  title:                  z.string().min(1).max(200).optional(),
  destinationCity:        z.string().min(1).max(200).optional(),
  destinationCountry:     z.string().max(100).nullable().optional(),
  destinationLat:         z.number().nullable().optional(),
  destinationLng:         z.number().nullable().optional(),
  destinationPlaceId:     z.string().max(300).nullable().optional(),
  startDate:              z.string().nullable().optional(),
  endDate:                z.string().nullable().optional(),
  visibility:             z.enum(["public", "buddies", "private", "invite"]).optional(),
  tripType:               z.string().max(50).optional(),
  timezone:               z.string().max(100).nullable().optional(),
  travelStyle:            z.string().max(100).nullable().optional(),
  openToMeet:             z.boolean().optional(),
  coverUrl:               z.string().max(500).nullable().optional(),
  tripNotes:              z.string().max(2000).nullable().optional(),
  // Privacy
  showOnProfile:          z.boolean().optional(),
  showInDiscovery:        z.boolean().optional(),
  allowFriendSuggestions: z.boolean().optional(),
  allowTripCrewInvites:   z.boolean().optional(),
  allowJoinRequests:      z.boolean().optional(),
  showExactDates:         z.boolean().optional(),
  showDestinationCity:    z.boolean().optional(),
  delayedPostingDefault:  z.boolean().optional(),
  preciseLocationVisible: z.boolean().optional(),
  // Plan edit permission (carry-over)
  planEditPermission:     z.enum(["owner_only", "all_members", "specific_members"]).optional(),
  planEditors:            z.array(z.string().regex(UUID_RE)).optional(),
  // Explicit lifecycle status (partial; computed otherwise)
  status:                 z.enum(["draft", "planning", "upcoming", "active", "completed", "cancelled", "archived"]).optional(),
});

router.patch("/trips/:tripId/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = ExpandedPatchTripSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("*").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const t = trip as any;
  if (t.owner_id !== user.id) { sendError(res, "forbidden", "Only the trip owner can update this trip"); return; }

  // Date conflict check
  const newStart = b.startDate !== undefined ? b.startDate : t.start_date;
  const newEnd   = b.endDate   !== undefined ? b.endDate   : t.end_date;
  if (newStart && newEnd && new Date(newStart) > new Date(newEnd)) {
    sendError(res, "invalid_payload", "end_date must be ≥ start_date");
    return;
  }

  // Build patch object
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.title                  !== undefined) patch.title                    = b.title;
  if (b.destinationCity        !== undefined) patch.destination_city         = b.destinationCity;
  if (b.destinationCountry     !== undefined) patch.destination_country      = b.destinationCountry;
  if (b.destinationLat         !== undefined) patch.destination_lat          = b.destinationLat;
  if (b.destinationLng         !== undefined) patch.destination_lng          = b.destinationLng;
  if (b.destinationPlaceId     !== undefined) patch.destination_place_id     = b.destinationPlaceId;
  if (b.startDate              !== undefined) patch.start_date               = b.startDate;
  if (b.endDate                !== undefined) patch.end_date                 = b.endDate;
  if (b.visibility             !== undefined) patch.visibility               = b.visibility;
  if (b.tripType               !== undefined) patch.trip_type                = b.tripType;
  if (b.timezone               !== undefined) patch.timezone                 = b.timezone;
  if (b.travelStyle            !== undefined) patch.travel_style             = b.travelStyle;
  if (b.openToMeet             !== undefined) patch.open_to_meet             = b.openToMeet;
  if (b.coverUrl               !== undefined) patch.cover_url                = b.coverUrl;
  if (b.tripNotes              !== undefined) patch.trip_notes               = b.tripNotes;
  if (b.showOnProfile          !== undefined) patch.show_on_profile          = b.showOnProfile;
  if (b.showInDiscovery        !== undefined) patch.show_in_discovery        = b.showInDiscovery;
  if (b.allowFriendSuggestions !== undefined) patch.allow_friend_suggestions = b.allowFriendSuggestions;
  if (b.allowTripCrewInvites   !== undefined) patch.allow_trip_crew_invites  = b.allowTripCrewInvites;
  if (b.allowJoinRequests      !== undefined) patch.allow_join_requests      = b.allowJoinRequests;
  if (b.showExactDates         !== undefined) patch.show_exact_dates         = b.showExactDates;
  if (b.showDestinationCity    !== undefined) patch.show_destination_city    = b.showDestinationCity;
  if (b.delayedPostingDefault  !== undefined) patch.delayed_posting_default  = b.delayedPostingDefault;
  if (b.preciseLocationVisible !== undefined) patch.precise_location_visible = b.preciseLocationVisible;
  if (b.planEditPermission     !== undefined) patch.plan_edit_permission     = b.planEditPermission;

  // Compute canonical status
  const effectiveTitle = (b.title ?? t.title) as string | null;
  const effectiveCity  = (b.destinationCity ?? t.destination_city) as string | null;
  const effectiveStatus = b.status ?? t.status;
  patch.status = computeStatus(effectiveTitle, effectiveCity, newStart as string | null, newEnd as string | null, effectiveStatus);

  const { data: updated, error } = await sc
    .from("trips")
    .update(patch)
    .eq("id", tripId)
    .select("*")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }

  // Handle planEditors replacement
  if (b.planEditors !== undefined) {
    await sc.from("plan_editors").delete().eq("trip_id", tripId);
    if (b.planEditors.length > 0) {
      await sc.from("plan_editors").insert(b.planEditors.map((uid) => ({ trip_id: tripId, user_id: uid })));
    }
  }

  await logActivity(sc, tripId, user.id, "trip_updated", { fields: Object.keys(patch) });

  res.json(toMemberTrip(updated as any));
});

// ===========================================================================
// Lifecycle routes
// ===========================================================================

// POST /api/trips/:tripId/cancel
router.post("/trips/:tripId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can cancel a trip"); return; }
  if ((trip as any).status === "cancelled") { res.json({ status: "cancelled", idempotent: true }); return; }
  if ((trip as any).status === "archived")  { sendError(res, "invalid_state_transition", "Cannot cancel an archived trip"); return; }

  await sc.from("trips").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", tripId);
  await logActivity(sc, tripId, user.id, "trip_cancelled");
  res.json({ status: "cancelled", tripId });
});

// POST /api/trips/:tripId/complete
router.post("/trips/:tripId/complete", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can complete a trip"); return; }
  if ((trip as any).status === "completed") { res.json({ status: "completed", idempotent: true }); return; }

  const terminal = ["cancelled", "archived"];
  if (terminal.includes((trip as any).status)) {
    sendError(res, "invalid_state_transition", `Cannot complete a ${(trip as any).status} trip`);
    return;
  }

  await sc.from("trips").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", tripId);
  await logActivity(sc, tripId, user.id, "trip_completed");
  res.json({ status: "completed", tripId });
});

// POST /api/trips/:tripId/archive
router.post("/trips/:tripId/archive", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can archive a trip"); return; }
  if ((trip as any).status === "archived") { res.json({ status: "archived", idempotent: true }); return; }

  await sc.from("trips").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", tripId);
  await logActivity(sc, tripId, user.id, "trip_archived");
  res.json({ status: "archived", tripId });
});

// DELETE /api/trips/:tripId  — soft-delete (archive unless already completed/cancelled)
router.delete("/trips/:tripId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete a trip"); return; }

  await sc.from("trips").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", tripId);
  await logActivity(sc, tripId, user.id, "trip_deleted");
  res.status(204).send();
});

// ===========================================================================
// Join request routes
// ===========================================================================

// POST /api/trips/:tripId/join-request
router.post("/trips/:tripId/join-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("owner_id, allow_join_requests, status, visibility")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const t = trip as any;
  if (!t.allow_join_requests) { sendError(res, "forbidden", "This trip does not accept join requests"); return; }
  if (["completed","cancelled","archived"].includes(t.status)) {
    sendError(res, "invalid_state_transition", "Cannot request to join a trip that is not active or upcoming");
    return;
  }

  // Block check
  const blocked = await isBlocked(sc, user.id, t.owner_id);
  if (blocked) { sendError(res, "forbidden", "Blocked"); return; }

  // Already a member?
  const existing = await requireTripMember(sc, tripId, user.id, { status: "any" });
  if (existing) { res.status(200).json({ status: "already_member", idempotent: true }); return; }

  // Existing pending request?
  const { data: existingReq } = await sc
    .from("trip_join_requests")
    .select("id, status")
    .eq("trip_id", tripId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingReq) {
    if ((existingReq as any).status === "pending") {
      res.status(200).json({ status: "already_requested", requestId: (existingReq as any).id, idempotent: true });
      return;
    }
    if ((existingReq as any).status === "approved") {
      res.status(200).json({ status: "already_member", idempotent: true });
      return;
    }
  }

  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 500) : null;

  const { data: newReq, error } = await sc
    .from("trip_join_requests")
    .insert({ trip_id: tripId, user_id: user.id, status: "pending", message })
    .select("id, status, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  await logActivity(sc, tripId, user.id, "join_request_created");

  res.status(201).json({ status: "pending", requestId: (newReq as any).id, createdAt: (newReq as any).created_at });
});

// POST /api/trips/:tripId/join-requests/:requestId/approve
router.post("/trips/:tripId/join-requests/:requestId/approve", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, requestId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(requestId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const approveIsOwner = (trip as any).owner_id === user.id;
  if (!approveIsOwner) {
    const approveM = await requireTripMember(sc, tripId, user.id);
    if (!approveM || !["owner", "co_host"].includes(approveM.role)) {
      sendError(res, "forbidden", "Only the owner or co-host can approve join requests"); return;
    }
  }

  const { data: req_ } = await sc
    .from("trip_join_requests")
    .select("*")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  const requestedUserId = (req_ as any).user_id as string;

  // Add to trip_members
  const { error: memErr } = await sc
    .from("trip_members")
    .upsert({ trip_id: tripId, user_id: requestedUserId, role: "member", status: "accepted", joined_at: new Date().toISOString() },
             { onConflict: "trip_id,user_id" });
  if (memErr) { sendError(res, "db_error", memErr.message); return; }

  await sc
    .from("trip_join_requests")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", requestId);

  await logActivity(sc, tripId, user.id, "join_request_approved", { userId: requestedUserId });
  res.json({ status: "approved", requestId, userId: requestedUserId });
});

// POST /api/trips/:tripId/join-requests/:requestId/decline
router.post("/trips/:tripId/join-requests/:requestId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, requestId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(requestId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const declineIsOwner = (trip as any).owner_id === user.id;
  if (!declineIsOwner) {
    const declineM = await requireTripMember(sc, tripId, user.id);
    if (!declineM || !["owner", "co_host"].includes(declineM.role)) {
      sendError(res, "forbidden", "Only the owner or co-host can decline join requests"); return;
    }
  }

  const { data: req_ } = await sc
    .from("trip_join_requests")
    .select("status")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  await sc
    .from("trip_join_requests")
    .update({ status: "declined", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", requestId);

  await logActivity(sc, tripId, user.id, "join_request_declined", { requestId });
  res.json({ status: "declined", requestId });
});

// POST /api/trips/:tripId/join-requests/:requestId/cancel  — requester cancels
router.post("/trips/:tripId/join-requests/:requestId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, requestId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(requestId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: req_ } = await sc
    .from("trip_join_requests")
    .select("*")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).user_id !== user.id) { sendError(res, "forbidden", "Can only cancel your own request"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  await sc.from("trip_join_requests").update({ status: "cancelled" }).eq("id", requestId);
  res.json({ status: "cancelled", requestId });
});

// ===========================================================================
// Invite link routes
// ===========================================================================

// POST /api/trips/:tripId/invite-link  — create invite link
router.post("/trips/:tripId/invite-link", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can create invite links"); return; }

  const maxUses    = typeof req.body?.maxUses === "number" ? req.body.maxUses : null;
  const expiresIn  = typeof req.body?.expiresInHours === "number" ? req.body.expiresInHours : null;
  const expiresAt  = expiresIn ? new Date(Date.now() + expiresIn * 3_600_000).toISOString() : null;
  const token      = crypto.randomBytes(20).toString("hex");

  const { data: link, error } = await sc
    .from("trip_invite_links")
    .insert({ trip_id: tripId, token, created_by: user.id, max_uses: maxUses, expires_at: expiresAt })
    .select("id, token, max_uses, expires_at, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(201).json({
    id:        (link as any).id,
    token:     (link as any).token,
    maxUses:   (link as any).max_uses ?? null,
    expiresAt: (link as any).expires_at ?? null,
    createdAt: (link as any).created_at,
    url:       `/api/trips/invite-link/${(link as any).token}/preview`,
  });
});

// DELETE /api/trips/:tripId/invite-link/:linkId  — revoke
router.delete("/trips/:tripId/invite-link/:linkId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, linkId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(linkId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can revoke invite links"); return; }

  const { data: link } = await sc
    .from("trip_invite_links")
    .select("id")
    .eq("id", linkId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!link) { sendError(res, "not_found", "Invite link not found"); return; }

  await sc.from("trip_invite_links").update({ revoked_at: new Date().toISOString() }).eq("id", linkId);
  res.status(204).send();
});

// GET /api/trips/invite-link/:token/preview  — public non-sensitive preview
router.get("/trips/invite-link/:token/preview", async (req, res) => {
  const { token } = req.params;
  if (!token || token.length > 200) { sendError(res, "invalid_payload", "Invalid token"); return; }

  // Require auth so we can personalise the response (already a member?)
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: link } = await sc
    .from("trip_invite_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!link) { sendError(res, "not_found", "Invite link not found or expired"); return; }
  const lk = link as any;

  if (lk.revoked_at) {
    res.status(410).json({ error: "gone", message: "This invite link has been revoked" });
    return;
  }
  if (lk.expires_at && new Date(lk.expires_at) < new Date()) {
    res.status(410).json({ error: "gone", message: "This invite link has expired" });
    return;
  }
  if (lk.max_uses !== null && lk.use_count >= lk.max_uses) {
    res.status(410).json({ error: "gone", message: "This invite link has reached its usage limit" });
    return;
  }

  const { data: trip } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id, visibility")
    .eq("id", lk.trip_id)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  // Is the caller already a member?
  const membership = await requireTripMember(sc, lk.trip_id, user.id, { status: "any" });

  res.json({
    tripId:             (trip as any).id,
    tripTitle:          (trip as any).title,
    destinationCity:    (trip as any).destination_city,
    destinationCountry: (trip as any).destination_country ?? null,
    startDate:          (trip as any).start_date ?? null,
    endDate:            (trip as any).end_date ?? null,
    coverUrl:           (trip as any).cover_url ?? null,
    alreadyMember:      Boolean(membership),
    linkId:             lk.id,
    expiresAt:          lk.expires_at ?? null,
  });
});

// POST /api/trips/invite-link/:token/accept  — join via link
router.post("/trips/invite-link/:token/accept", async (req, res) => {
  const { token } = req.params;
  if (!token || token.length > 200) { sendError(res, "invalid_payload", "Invalid token"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: link } = await sc
    .from("trip_invite_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!link) { sendError(res, "not_found", "Invite link not found"); return; }
  const lk = link as any;

  if (lk.revoked_at) {
    res.status(410).json({ error: "gone", message: "This invite link has been revoked" });
    return;
  }
  if (lk.expires_at && new Date(lk.expires_at) < new Date()) {
    res.status(410).json({ error: "gone", message: "This invite link has expired" });
    return;
  }
  if (lk.max_uses !== null && lk.use_count >= lk.max_uses) {
    res.status(410).json({ error: "gone", message: "This invite link has reached its usage limit" });
    return;
  }

  const tripId = lk.trip_id as string;

  // Block check against owner
  const { data: trip } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const blocked = await isBlocked(sc, user.id, (trip as any).owner_id);
  if (blocked) { sendError(res, "forbidden", "Blocked"); return; }

  // Already a member?
  const membership = await requireTripMember(sc, tripId, user.id, { status: "any" });
  if (membership) {
    res.json({ status: "already_member", tripId, idempotent: true });
    return;
  }

  // Add member
  const { error: memErr } = await sc
    .from("trip_members")
    .insert({ trip_id: tripId, user_id: user.id, role: "member", status: "accepted", joined_at: new Date().toISOString() });

  if (memErr) { sendError(res, "db_error", memErr.message); return; }

  // Increment use_count
  await sc
    .from("trip_invite_links")
    .update({ use_count: lk.use_count + 1 })
    .eq("id", lk.id);

  await logActivity(sc, tripId, user.id, "joined_via_invite_link", { linkId: lk.id });

  res.status(201).json({ status: "joined", tripId, role: "member" });
});

// ===========================================================================
// Budget routes (owner + co_host only — never public)
// ===========================================================================

// GET /api/trips/:tripId/budget  — owner + co_host only
router.get("/trips/:tripId/budget", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Budget is only visible to the trip owner and co-hosts"); return;
    }
  }

  const { data: budget } = await sc
    .from("trip_budget")
    .select("*")
    .eq("trip_id", tripId)
    .maybeSingle();

  res.json({ budget: budget ?? null });
});

// PUT /api/trips/:tripId/budget  — upsert
router.put("/trips/:tripId/budget", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can update the budget"); return; }

  const BudgetSchema = z.object({
    currency:    z.string().max(3).optional(),
    totalBudget: z.number().nullable().optional(),
    spent:       z.number().optional(),
    breakdown:   z.record(z.any()).optional(),
  });

  const parsed = BudgetSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const upsertData: Record<string, any> = { trip_id: tripId, updated_at: new Date().toISOString() };
  if (b.currency    !== undefined) upsertData.currency     = b.currency;
  if (b.totalBudget !== undefined) upsertData.total_budget = b.totalBudget;
  if (b.spent       !== undefined) upsertData.spent        = b.spent;
  if (b.breakdown   !== undefined) upsertData.breakdown    = b.breakdown;

  const { data: budget, error } = await sc
    .from("trip_budget")
    .upsert(upsertData, { onConflict: "trip_id" })
    .select("*")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ budget });
});

// ===========================================================================
// Documents routes
// ===========================================================================

// GET /api/trips/:tripId/documents
router.get("/trips/:tripId/documents", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership && (trip as any).owner_id !== user.id) { sendError(res, "not_member", "Not a trip member"); return; }

  const isOwner = (trip as any).owner_id === user.id;

  let query = sc
    .from("trip_documents")
    .select("id, title, document_type, is_private, creator_id, created_at, updated_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });

  if (!isOwner) {
    // Non-owners see: own docs + public docs
    query = (query as any).or(`is_private.eq.false,creator_id.eq.${user.id}`);
  }

  const { data, error } = await (query as any);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ documents: data ?? [] });
});

// POST /api/trips/:tripId/documents
router.post("/trips/:tripId/documents", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const DocSchema = z.object({
    title:        z.string().min(1).max(200),
    content:      z.string().optional(),
    documentType: z.enum(["note","itinerary","packing_list","visa","insurance","other"]).default("note"),
    isPrivate:    z.boolean().default(true),
  });

  const parsed = DocSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const { data, error } = await sc
    .from("trip_documents")
    .insert({ trip_id: tripId, creator_id: user.id, title: b.title, content: b.content ?? null, document_type: b.documentType, is_private: b.isPrivate })
    .select("id, title, document_type, is_private, creator_id, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json(data);
});

// PATCH /api/trips/:tripId/documents/:docId  — update document
router.patch("/trips/:tripId/documents/:docId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, docId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(docId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: doc } = await sc.from("trip_documents").select("creator_id").eq("id", docId).eq("trip_id", tripId).maybeSingle();
  if (!doc) { sendError(res, "not_found", "Document not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (doc as any).creator_id === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot update this document"); return; }

  const DocPatchSchema = z.object({
    title:        z.string().min(1).max(200).optional(),
    content:      z.string().nullable().optional(),
    documentType: z.enum(["note","itinerary","packing_list","visa","insurance","other"]).optional(),
    isPrivate:    z.boolean().optional(),
  });
  const parsed = DocPatchSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.title        !== undefined) patch.title         = b.title;
  if (b.content      !== undefined) patch.content       = b.content;
  if (b.documentType !== undefined) patch.document_type = b.documentType;
  if (b.isPrivate    !== undefined) patch.is_private    = b.isPrivate;

  const { data: updated, error } = await sc
    .from("trip_documents")
    .update(patch)
    .eq("id", docId)
    .select("id, title, document_type, is_private, creator_id, created_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json(updated);
});

// DELETE /api/trips/:tripId/documents/:docId
router.delete("/trips/:tripId/documents/:docId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, docId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(docId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const { data: doc } = await sc.from("trip_documents").select("creator_id").eq("id", docId).eq("trip_id", tripId).maybeSingle();
  if (!doc) { sendError(res, "not_found", "Document not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (doc as any).creator_id === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot delete this document"); return; }

  await sc.from("trip_documents").delete().eq("id", docId);
  res.status(204).send();
});

// ===========================================================================
// Notes routes
// ===========================================================================

// GET /api/trips/:tripId/notes
router.get("/trips/:tripId/notes", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership && (trip as any).owner_id !== user.id) { sendError(res, "not_member", "Not a trip member"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  let query = sc
    .from("trip_notes")
    .select("id, title, content, is_private, author_id, created_at, updated_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });

  if (!isOwner) {
    query = (query as any).or(`is_private.eq.false,author_id.eq.${user.id}`);
  }

  const { data, error } = await (query as any);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ notes: data ?? [] });
});

// POST /api/trips/:tripId/notes
router.post("/trips/:tripId/notes", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const NoteSchema = z.object({
    title:     z.string().max(200).optional(),
    content:   z.string().min(1),
    isPrivate: z.boolean().default(false),
  });

  const parsed = NoteSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const { data, error } = await sc
    .from("trip_notes")
    .insert({ trip_id: tripId, author_id: user.id, title: b.title ?? null, content: b.content, is_private: b.isPrivate })
    .select("id, title, content, is_private, author_id, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json(data);
});

// PATCH /api/trips/:tripId/notes/:noteId  — update note
router.patch("/trips/:tripId/notes/:noteId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, noteId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(noteId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: note } = await sc.from("trip_notes").select("author_id").eq("id", noteId).eq("trip_id", tripId).maybeSingle();
  if (!note) { sendError(res, "not_found", "Note not found"); return; }

  const isOwner  = (trip as any).owner_id === user.id;
  const isAuthor = (note as any).author_id === user.id;
  if (!isOwner && !isAuthor) { sendError(res, "forbidden", "Cannot update this note"); return; }

  const NotePatchSchema = z.object({
    title:     z.string().max(200).nullable().optional(),
    content:   z.string().min(1).optional(),
    isPrivate: z.boolean().optional(),
  });
  const parsed = NotePatchSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.title     !== undefined) patch.title      = b.title;
  if (b.content   !== undefined) patch.content    = b.content;
  if (b.isPrivate !== undefined) patch.is_private = b.isPrivate;

  const { data: updated, error } = await sc
    .from("trip_notes")
    .update(patch)
    .eq("id", noteId)
    .select("id, title, content, is_private, author_id, created_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json(updated);
});

// DELETE /api/trips/:tripId/notes/:noteId
router.delete("/trips/:tripId/notes/:noteId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, noteId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(noteId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: note } = await sc.from("trip_notes").select("author_id").eq("id", noteId).eq("trip_id", tripId).maybeSingle();
  if (!note) { sendError(res, "not_found", "Note not found"); return; }

  const isOwner  = (trip as any).owner_id === user.id;
  const isAuthor = (note as any).author_id === user.id;
  if (!isOwner && !isAuthor) { sendError(res, "forbidden", "Cannot delete this note"); return; }

  await sc.from("trip_notes").delete().eq("id", noteId);
  res.status(204).send();
});

// ===========================================================================
// Saved places routes
// ===========================================================================

// GET /api/trips/:tripId/saved-places
router.get("/trips/:tripId/saved-places", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data, error } = await sc
    .from("trip_saved_places")
    .select("id, place_id, place_name, place_type, lat, lng, notes, user_id, saved_at")
    .eq("trip_id", tripId)
    .order("saved_at", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ savedPlaces: data ?? [] });
});

// POST /api/trips/:tripId/saved-places
router.post("/trips/:tripId/saved-places", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const PlaceSchema = z.object({
    placeId:   z.string().max(300).optional(),
    placeName: z.string().min(1).max(300),
    placeType: z.string().max(100).optional(),
    lat:       z.number().nullable().optional(),
    lng:       z.number().nullable().optional(),
    notes:     z.string().max(500).optional(),
  });

  const parsed = PlaceSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Duplicate prevention
  if (b.placeId) {
    const { data: dup } = await sc
      .from("trip_saved_places")
      .select("id")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .eq("place_id", b.placeId)
      .maybeSingle();
    if (dup) {
      res.status(409).json({ error: "duplicate", message: "This place is already saved to the trip" });
      return;
    }
  }

  const { data, error } = await sc
    .from("trip_saved_places")
    .insert({ trip_id: tripId, user_id: user.id, place_id: b.placeId ?? null, place_name: b.placeName, place_type: b.placeType ?? null, lat: b.lat ?? null, lng: b.lng ?? null, notes: b.notes ?? null })
    .select("id, place_id, place_name, place_type, lat, lng, notes, user_id, saved_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json(data);
});

// DELETE /api/trips/:tripId/saved-places/:placeEntryId
router.delete("/trips/:tripId/saved-places/:placeEntryId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, placeEntryId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(placeEntryId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: entry } = await sc.from("trip_saved_places").select("user_id").eq("id", placeEntryId).eq("trip_id", tripId).maybeSingle();
  if (!entry) { sendError(res, "not_found", "Saved place not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (entry as any).user_id === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot remove this saved place"); return; }

  await sc.from("trip_saved_places").delete().eq("id", placeEntryId);
  res.status(204).send();
});

// ===========================================================================
// Checklists routes
// ===========================================================================

// GET /api/trips/:tripId/checklists
router.get("/trips/:tripId/checklists", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data: lists, error } = await sc
    .from("trip_checklists")
    .select("id, title, created_by, created_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }

  // Fetch items for each checklist
  const listIds = (lists ?? []).map((l: any) => l.id as string);
  let itemMap: Record<string, any[]> = {};
  if (listIds.length > 0) {
    const { data: items } = await sc
      .from("trip_checklist_items")
      .select("id, checklist_id, label, is_done, assigned_to, due_date, sort_order")
      .in("checklist_id", listIds)
      .order("sort_order", { ascending: true });
    for (const item of items ?? []) {
      const cid = (item as any).checklist_id as string;
      if (!itemMap[cid]) itemMap[cid] = [];
      itemMap[cid].push(item);
    }
  }

  res.json({
    checklists: (lists ?? []).map((l: any) => ({
      id:        l.id,
      title:     l.title,
      createdBy: l.created_by,
      createdAt: l.created_at,
      items:     itemMap[l.id] ?? [],
    })),
  });
});

// POST /api/trips/:tripId/checklists
router.post("/trips/:tripId/checklists", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : "";
  if (!title) { sendError(res, "invalid_payload", "title is required"); return; }

  const { data, error } = await sc
    .from("trip_checklists")
    .insert({ trip_id: tripId, title, created_by: user.id })
    .select("id, title, created_by, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ ...(data as any), items: [] });
});

// PATCH /api/trips/:tripId/checklists/:checklistId  — rename checklist
router.patch("/trips/:tripId/checklists/:checklistId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, checklistId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(checklistId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : undefined;
  if (!title) { sendError(res, "invalid_payload", "title is required"); return; }

  const { data, error } = await sc
    .from("trip_checklists")
    .update({ title })
    .eq("id", checklistId)
    .eq("trip_id", tripId)
    .select("id, title, created_by, created_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Checklist not found"); return; }
  res.json(data);
});

// DELETE /api/trips/:tripId/checklists/:checklistId  — delete checklist + items
router.delete("/trips/:tripId/checklists/:checklistId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, checklistId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(checklistId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: list } = await sc.from("trip_checklists").select("created_by").eq("id", checklistId).eq("trip_id", tripId).maybeSingle();
  if (!list) { sendError(res, "not_found", "Checklist not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (list as any).created_by === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot delete this checklist"); return; }

  await sc.from("trip_checklist_items").delete().eq("checklist_id", checklistId);
  await sc.from("trip_checklists").delete().eq("id", checklistId);
  res.status(204).send();
});

// POST /api/trips/:tripId/checklists/:checklistId/items
router.post("/trips/:tripId/checklists/:checklistId/items", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, checklistId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(checklistId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data: list } = await sc.from("trip_checklists").select("id").eq("id", checklistId).eq("trip_id", tripId).maybeSingle();
  if (!list) { sendError(res, "not_found", "Checklist not found"); return; }

  const ItemSchema = z.object({
    label:      z.string().min(1).max(300),
    assignedTo: z.string().regex(UUID_RE).optional(),
    dueDate:    z.string().optional(),
    sortOrder:  z.number().int().default(0),
  });

  const parsed = ItemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const { data, error } = await sc
    .from("trip_checklist_items")
    .insert({ checklist_id: checklistId, trip_id: tripId, label: b.label, assigned_to: b.assignedTo ?? null, due_date: b.dueDate ?? null, sort_order: b.sortOrder })
    .select("id, checklist_id, label, is_done, assigned_to, due_date, sort_order")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json(data);
});

// DELETE /api/trips/:tripId/checklists/:checklistId/items/:itemId
router.delete("/trips/:tripId/checklists/:checklistId/items/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, checklistId, itemId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(checklistId) || !UUID_RE.test(itemId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const { data: item } = await sc
    .from("trip_checklist_items")
    .select("id, assigned_to")
    .eq("id", itemId)
    .eq("checklist_id", checklistId)
    .maybeSingle();
  if (!item) { sendError(res, "not_found", "Checklist item not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  const membership = isOwner ? null : await requireTripMember(sc, tripId, user.id);
  if (!isOwner && (!membership || !["owner", "co_host", "member"].includes(membership.role))) {
    sendError(res, "forbidden", "Not a trip member"); return;
  }

  await sc.from("trip_checklist_items").delete().eq("id", itemId);
  res.status(204).send();
});

// PATCH /api/trips/:tripId/checklists/:checklistId/items/:itemId  — toggle/update
router.patch("/trips/:tripId/checklists/:checklistId/items/:itemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, checklistId, itemId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(checklistId) || !UUID_RE.test(itemId)) {
    sendError(res, "invalid_payload", "Invalid ID"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const patch: Record<string, any> = {};
  if (typeof req.body?.isDone === "boolean")   patch.is_done    = req.body.isDone;
  if (typeof req.body?.label  === "string")    patch.label      = req.body.label.slice(0, 300);
  if (typeof req.body?.sortOrder === "number") patch.sort_order = req.body.sortOrder;

  if (Object.keys(patch).length === 0) { sendError(res, "invalid_payload", "No fields to update"); return; }

  const { data, error } = await sc
    .from("trip_checklist_items")
    .update(patch)
    .eq("id", itemId)
    .eq("checklist_id", checklistId)
    .select("id, label, is_done, sort_order")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data)  { sendError(res, "not_found", "Checklist item not found"); return; }
  res.json(data);
});

// ===========================================================================
// Reminders routes
// ===========================================================================

// GET /api/trips/:tripId/reminders
router.get("/trips/:tripId/reminders", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data, error } = await sc
    .from("trip_reminders")
    .select("id, title, remind_at, is_sent, created_at")
    .eq("trip_id", tripId)
    .eq("user_id", user.id)
    .order("remind_at", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ reminders: data ?? [] });
});

// POST /api/trips/:tripId/reminders
router.post("/trips/:tripId/reminders", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }

  const RemSchema = z.object({
    title:    z.string().min(1).max(200),
    remindAt: z.string(),
  });

  const parsed = RemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data, error } = await sc
    .from("trip_reminders")
    .insert({ trip_id: tripId, user_id: user.id, title: parsed.data.title, remind_at: parsed.data.remindAt })
    .select("id, title, remind_at, is_sent, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json(data);
});

// DELETE /api/trips/:tripId/reminders/:reminderId
router.delete("/trips/:tripId/reminders/:reminderId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, reminderId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(reminderId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: rem } = await sc
    .from("trip_reminders")
    .select("user_id")
    .eq("id", reminderId)
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!rem) { sendError(res, "not_found", "Reminder not found"); return; }
  if ((rem as any).user_id !== user.id) { sendError(res, "forbidden", "Can only delete your own reminders"); return; }

  await sc.from("trip_reminders").delete().eq("id", reminderId);
  res.status(204).send();
});

// ===========================================================================
// Activity log (read-only, owner + co_host)
// ===========================================================================

router.get("/trips/:tripId/activity", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Only the owner or co-host can view the activity log");
      return;
    }
  }

  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

  const { data, error } = await sc
    .from("trip_activity_log")
    .select("id, actor_id, event_type, metadata, created_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ activity: data ?? [] });
});

// ---------------------------------------------------------------------------
// GET /api/trips/:tripId  — public-aware trip detail
// MUST be registered LAST so static paths (/me, /upcoming, etc.) match first.
// ---------------------------------------------------------------------------
router.get("/trips/:tripId", async (req, res) => {
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error } = await sc
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();

  if (error || !trip) { sendError(res, "not_found", "Trip not found"); return; }

  const t = trip as any;
  const isMember = await requireTripMember(sc, tripId, user.id);
  const isOwner  = t.owner_id === user.id;

  // Check block (blocked users get 403)
  if (!isOwner && !isMember) {
    const blocked = await isBlocked(sc, user.id, t.owner_id);
    if (blocked) { sendError(res, "forbidden", "Blocked"); return; }
  }

  // Private trips: non-members get 404 (don't reveal existence)
  if (t.visibility === "private" && !isMember && !isOwner) {
    sendError(res, "not_found", "Trip not found");
    return;
  }

  // Members / owner: full shape
  if (isMember || isOwner) {
    res.json(toMemberTrip(t));
    return;
  }

  // Public viewer: stripped shape
  res.json(toPublicTrip(t));
});

export default router;
