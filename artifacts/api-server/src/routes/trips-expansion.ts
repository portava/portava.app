/**
 * trips-expansion.ts
 * Expanded trip API routes: lifecycle, join requests, invite links,
 * budget, documents, notes, checklists, saved places, reminders,
 * activity log, and privacy-aware public trip GET.
 *
 * Mounted alongside the existing trips router via routes/index.ts.
 */
import { Router } from "express";
import { isBlockedBetween } from "../lib/blockGuard.js";
import { z } from "zod";
import crypto from "node:crypto";
import { getServiceClient } from "../lib/supabase.js";
import { runTripCloseout } from "../services/trips/TripCloseoutService.js";
import { logger } from "../lib/logger.js";
import {
  requireUser,
  optionalUser,
  requireTripMember,
  sendError,
  type ApiErrorCode,
} from "../lib/http.js";
import { canViewTrip, canManageJoinRequests } from "../lib/tripPolicy.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { nameVisibilitySet, sanitizeIdentity, nameVisibleFor, presentedName } from "../lib/publicIdentity.js";
import { truncateDisplayName } from "../lib/displayName.js";
import {
  toPrivateTripPreview,
  toAuthorizedTripView,
} from "../lib/privacy/tripSerializers.js";
import { computeTripStatus } from "../lib/tripStatus.js";
import {
  isTripKernelEnabled,
  readCommandEnvelope,
  executeTripCommand,
  sendKernelRejection,
  setTripVersionHeader,
  type TripKernelResult,
} from "../lib/tripKernel.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Trip Kernel gate (Trips spec §4; lib/tripKernel.ts; migrations 2420/2450/2500).
 * Returns the service client when `trip_kernel_enabled` is TRUE, else null.
 * Null means: run the pre-kernel direct write exactly as before. The flag read
 * is fail-closed, so an unreadable feature_flags table is "off", never "on".
 * Same shape as routes/trips.ts.
 */
async function tripKernel(): Promise<any | null> {
  const sc = getServiceClient();
  if (!sc) return null;
  return (await isTripKernelEnabled(sc)) ? sc : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// toPublicTrip and toMemberTrip have been replaced by the explicit DTO
// serializers imported above. Legacy references are gone; all call sites
// now use toPrivateTripPreview / toAuthorizedTripView directly.

// Fail-closed shared guard. The previous local impl used .maybeSingle(), which
// raised on the two-row mutual-block state and, with the error ignored, read as
// "not blocked" — fail-OPEN precisely on a mutual block. See lib/blockGuard.ts.
async function isBlocked(client: any, userA: string, userB: string): Promise<boolean> {
  return isBlockedBetween(client, userA, userB);
}

/**
 * A read in this file that DID NOT ANSWER, refused rather than answered.
 *
 * supabase-js RESOLVES on a database error: `{ data: null, error }` is what a
 * failed read looks like, and it is byte-identical to "no such row" unless
 * `error` is bound. Every gate below turns `null` into a confident sentence —
 * "Trip not found", "Document not found", "Not a trip member", "you have no
 * upcoming trips", "this checklist is empty", "this link has no joiners". Those
 * are claims about a person's data and their access, and the rule lib/http.ts
 * states for `TripAccessUnavailableError` applies verbatim: A FAILED READ MUST
 * NEVER BE REPORTED AS EMPTY, CLEAN, OR DONE.
 *
 * So the 60 call sites in this file that used to drop `.error` now bind it and
 * throw this. `status`/`code` are read by the global error handler
 * (lib/errorEnvelope.ts), which turns it into 503 `degraded_unavailable` with
 * `retryable: true` — exactly the response the route would have sent by hand.
 * Express 5 forwards a rejected async handler there automatically, so no route
 * needs a try/catch (and a try/catch around a resolving PostgREST read would be
 * dead code anyway).
 *
 * Deliberately NOT converted, and annotated at their sites: the fire-and-forget
 * push blocks (a notification that cannot be addressed is not an answer to
 * anyone), the display-name/avatar enrichment lookups (an absent label renders
 * as null and reveals nothing), and `getJoinRequestStatus` in GET /trips/:tripId
 * (documented fail-open; it only decorates a preview the caller already sees).
 */
class TripReadUnavailableError extends Error {
  readonly status = 503;
  readonly code: ApiErrorCode = "degraded_unavailable";
  readonly table: string;
  constructor(table: string, detail: string) {
    super(`trip read input ${table} unavailable — refusing to answer: ${detail}`);
    this.name = "TripReadUnavailableError";
    this.table = table;
  }
}

/** Build the refusal for an unreadable `table`, from a PostgREST error object. */
function readUnavailable(table: string, error: any): TripReadUnavailableError {
  return new TripReadUnavailableError(table, String(error?.message ?? error?.code ?? "db_error"));
}

/**
 * Append to the trip's audit log. Deliberately non-fatal: a trip really WAS
 * cancelled even if the audit row did not land, and failing the route would
 * report the opposite. But the write is not silent any more.
 *
 * The old body was `.then(undefined, () => {})`, which is worse than it reads:
 * a PostgREST builder RESOLVES on a database error, so the rejection handler
 * never ran and the resolved `{ error }` was discarded unread. Every row this
 * log failed to write vanished with no trace anywhere. It now binds the error
 * and logs it, so a systematically-unwritable trip_activity_log — the table
 * GET /trips/:tripId/activity and the invite-link joiner list both read — is
 * visible in the server log instead of being inferred from a permanently empty
 * activity feed.
 */
async function logActivity(
  client: any,
  tripId: string,
  actorId: string,
  eventType: string,
  metadata: Record<string, any> = {},
): Promise<void> {
  const { error } = await client
    .from("trip_activity_log")
    .insert({ trip_id: tripId, actor_id: actorId, event_type: eventType, metadata })
    .then((r: any) => r, (err: any) => ({ error: err }));
  if (error) logger.warn({ err: error, tripId, actorId, eventType }, "trip_activity_log insert failed — audit row lost");
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
    .neq("role", "invited");

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

  res.json({ trips: (trips ?? []).map(toAuthorizedTripView) });
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

  const { data: memberRows, error: memberRowsErr } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .neq("role", "invited");
  if (memberRowsErr) throw readUnavailable("trip_members", memberRowsErr);

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
  res.json({ trips: (trips ?? []).map(toAuthorizedTripView) });
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

  const { data: memberRows, error: memberRowsErr } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .neq("role", "invited");
  if (memberRowsErr) throw readUnavailable("trip_members", memberRowsErr);

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
  res.json({ trips: (trips ?? []).map(toAuthorizedTripView) });
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

  const { data: memberRows, error: memberRowsErr } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .neq("role", "invited");
  if (memberRowsErr) throw readUnavailable("trip_members", memberRowsErr);

  const tripIds = (memberRows ?? []).map((r: any) => r.trip_id as string);
  if (tripIds.length === 0) { res.json({ trips: [] }); return; }

  const { data: trips, error } = await sc
    .from("trips")
    .select("*")
    .in("id", tripIds)
    .in("status", ["completed", "cancelled", "archived"])
    .order("end_date", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ trips: (trips ?? []).map(toAuthorizedTripView) });
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
  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id")
    .in("id", tripIds);
  if (tripsErr) throw readUnavailable("trips", tripsErr);

  const tripMap: Record<string, any> = {};
  for (const t of trips ?? []) tripMap[(t as any).id] = t;

  const ownerIds = [...new Set((trips ?? []).map((t: any) => t.owner_id as string))];
  const profileMap: Record<string, any> = {};
  if (ownerIds.length > 0) {
    // Enrichment only: an unreadable `profiles` leaves `inviter: null` on the
    // invite card. The invite itself still lists, and no access decision reads
    // this map — so emptiness IS the right answer here.
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ownerIds);
    const allowedNames = await nameVisibilitySet(sc, ownerIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);
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
  const { data: ownedTrips, error: ownedTripsErr } = await sc
    .from("trips")
    .select("id")
    .eq("owner_id", user.id);
  if (ownedTripsErr) throw readUnavailable("trips", ownedTripsErr);

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
    // Enrichment only: an unreadable `profiles` leaves `user: null` on the
    // request row. The request, its id and its status still list; nothing
    // gates on this map.
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", userIds);
    const allowedNames = await nameVisibilitySet(sc, userIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("*").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
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
  const effectiveTimezone = (b.timezone ?? (t as any).timezone) as string | null;
  patch.status = computeTripStatus(effectiveTitle, effectiveCity, newStart as string | null, newEnd as string | null, effectiveStatus, effectiveTimezone);

  // Trip Kernel path (UPDATE_TRIP, contract v2). The owner check above is the
  // authorization; the kernel re-checks owner, refuses a way out of a terminal
  // status (§3.1) and a start > end, and records which columns changed. Off
  // => the direct update below, exactly as before.
  const kernelPatch = await tripKernel();
  let kernelUpdated: Record<string, unknown> | null = null;
  if (kernelPatch) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const { updated_at: patchStamp, ...columnPatch } = patch;
    const r = await executeTripCommand(kernelPatch, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "UPDATE_TRIP",
      payload: { patch: columnPatch, updated_at: patchStamp },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelUpdated = r.result as Record<string, unknown>;
  }

  // trip-kernel:legacy-path — the flag-off twin of UPDATE_TRIP above.
  const { data: updated, error } = kernelUpdated
    ? { data: kernelUpdated, error: null }
    : await sc
    .from("trips")
    .update(patch)
    .eq("id", tripId)
    .select("*")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }

  // Handle planEditors replacement
  if (b.planEditors !== undefined) {
    // Delete-then-insert, and NEITHER write was bound. The failure that matters
    // is the second one: the delete lands, the insert does not, and the trip is
    // left with an EMPTY plan-editor list under `plan_edit_permission:
    // 'specific_members'` — every delegated editor silently loses plan access
    // while the route answers 200 with the updated trip. Both are bound now.
    //
    // The pair is still NOT atomic: there is no transaction across two PostgREST
    // calls, so a failed insert leaves the list empty and the client must retry.
    // Making it atomic needs a DB function; that is a migration and is recorded
    // in the lane report rather than done here.
    const { error: peDelErr } = await sc.from("plan_editors").delete().eq("trip_id", tripId);
    if (peDelErr) { sendError(res, "db_error", peDelErr.message); return; }
    if (b.planEditors.length > 0) {
      const { error: peInsErr } = await sc.from("plan_editors").insert(b.planEditors.map((uid) => ({ trip_id: tripId, user_id: uid })));
      if (peInsErr) { sendError(res, "db_error", peInsErr.message); return; }
    }
  }

  await logActivity(sc, tripId, user.id, "trip_updated", { fields: Object.keys(patch) });

  res.json(toAuthorizedTripView(updated as any));
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can cancel a trip"); return; }
  if ((trip as any).status === "cancelled") { res.json({ status: "cancelled", idempotent: true }); return; }
  if ((trip as any).status === "archived")  { sendError(res, "invalid_state_transition", "Cannot cancel an archived trip"); return; }

  // Trip Kernel path (CANCEL_TRIP, contract v2). The owner and terminal-state
  // checks above are the authorization and the idempotent answer; the kernel
  // re-checks owner and the §3.1 edge. Off => the direct update below.
  const kernelCancel = await tripKernel();
  let kernelCancelled = false;
  if (kernelCancel) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelCancel, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "CANCEL_TRIP",
      payload: { updated_at: new Date().toISOString() },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelCancelled = true;
  }

  // A bodyless UPDATE returns `data: null`, so it cannot say how many rows it
  // matched — `error === null` is NOT "it worked". This route answered the
  // status word for a write that may have touched NOTHING (and, before this,
  // for a write that outright FAILED: `.error` was never bound). `.select("id")`
  // makes the affected-row count observable; zero rows now refuses.
  // trip-kernel:legacy-path — the flag-off twin of CANCEL_TRIP above.
  if (!kernelCancelled) {
    const { data: cancelRows, error: cancelErr } = await sc
      .from("trips")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", tripId)
      .select("id");
    if (cancelErr) { sendError(res, "db_error", cancelErr.message); return; }
    if ((cancelRows ?? []).length === 0) { sendError(res, "not_found", "Trip not found"); return; }
  }
  await logActivity(sc, tripId, user.id, "trip_cancelled");

  // Fire-and-forget: notify all accepted trip members that the trip was cancelled.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const [{ data: tripRow }, { data: members }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("trip_members").select("user_id").eq("trip_id", tripId).eq("role", "member"),
      ]);
      const recipients: Array<{ userId: string; tokens: (string | null | undefined)[] }> = [];
      if (members && members.length > 0) {
        const memberIds = (members as any[]).map((m: any) => m.user_id).filter((id: string) => id !== user.id);
        if (memberIds.length > 0) {
          // Inside the fire-and-forget push block: an unreadable `profiles`
          // means no push tokens and therefore no notification. That is the
          // correct outcome for a best-effort courtesy send — the state change
          // itself already succeeded and was answered — and it is why this read
          // is not converted to a refusal like the ones on the request path.
          const { data: profiles } = await sc2.from("profiles").select("id, expo_push_token").in("id", memberIds);
          (profiles ?? []).forEach((p: any) => recipients.push({ userId: p.id as string, tokens: [p.expo_push_token] }));
        }
      }
      if (recipients.length > 0) {
        await sendPushWithRetry(sc2, recipients, {
          title: "Trip cancelled",
          body:  `${(tripRow as any)?.title ?? "A trip"} has been cancelled`,
          data:  { type: "trip_cancelled", tripId },
        });
      }
    } catch { /* best-effort */ }
  })();

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, status, timezone").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can complete a trip"); return; }
  if ((trip as any).status === "completed") { res.json({ status: "completed", idempotent: true }); return; }

  const terminal = ["cancelled", "archived"];
  if (terminal.includes((trip as any).status)) {
    sendError(res, "invalid_state_transition", `Cannot complete a ${(trip as any).status} trip`);
    return;
  }

  // Trip Kernel path (COMPLETE_TRIP, contract v2). Off => the direct update below.
  const kernelComplete = await tripKernel();
  let kernelCompleted = false;
  if (kernelComplete) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelComplete, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "COMPLETE_TRIP",
      payload: { updated_at: new Date().toISOString() },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelCompleted = true;
  }

  // A bodyless UPDATE returns `data: null`, so it cannot say how many rows it
  // matched — `error === null` is NOT "it worked". This route answered the
  // status word for a write that may have touched NOTHING (and, before this,
  // for a write that outright FAILED: `.error` was never bound). `.select("id")`
  // makes the affected-row count observable; zero rows now refuses.
  // trip-kernel:legacy-path — the flag-off twin of COMPLETE_TRIP above.
  if (!kernelCompleted) {
    const { data: completeRows, error: completeErr } = await sc
      .from("trips")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", tripId)
      .select("id");
    if (completeErr) { sendError(res, "db_error", completeErr.message); return; }
    if ((completeRows ?? []).length === 0) { sendError(res, "not_found", "Trip not found"); return; }
  }
  await logActivity(sc, tripId, user.id, "trip_completed");
  // §20.2: the closeout, AFTER the transition, so a failed step cannot
  // un-complete the trip and every step is reported rather than implied.
  const closeout = await runTripCloseout(sc, tripId, { timezone: (trip as any).timezone ?? null });
  res.json({ status: "completed", tripId, closeout });
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can archive a trip"); return; }
  if ((trip as any).status === "archived") { res.json({ status: "archived", idempotent: true }); return; }

  // Trip Kernel path (ARCHIVE_TRIP, contract v2). Off => the direct update below.
  const kernelArchive = await tripKernel();
  let kernelArchived = false;
  if (kernelArchive) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernelArchive, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "ARCHIVE_TRIP",
      payload: { updated_at: new Date().toISOString() },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelArchived = true;
  }

  // A bodyless UPDATE returns `data: null`, so it cannot say how many rows it
  // matched — `error === null` is NOT "it worked". This route answered the
  // status word for a write that may have touched NOTHING (and, before this,
  // for a write that outright FAILED: `.error` was never bound). `.select("id")`
  // makes the affected-row count observable; zero rows now refuses.
  // trip-kernel:legacy-path — the flag-off twin of ARCHIVE_TRIP above.
  if (!kernelArchived) {
    const { data: archiveRows, error: archiveErr } = await sc
      .from("trips")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", tripId)
      .select("id");
    if (archiveErr) { sendError(res, "db_error", archiveErr.message); return; }
    if ((archiveRows ?? []).length === 0) { sendError(res, "not_found", "Trip not found"); return; }
  }
  await logActivity(sc, tripId, user.id, "trip_archived");

  // Fire-and-forget: notify all accepted trip members that the trip was archived.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const [{ data: tripRow }, { data: members }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("trip_members").select("user_id").eq("trip_id", tripId).eq("role", "member"),
      ]);
      const recipients: Array<{ userId: string; tokens: (string | null | undefined)[] }> = [];
      if (members && members.length > 0) {
        const memberIds = (members as any[]).map((m: any) => m.user_id).filter((id: string) => id !== user.id);
        if (memberIds.length > 0) {
          // Inside the fire-and-forget push block: an unreadable `profiles`
          // means no push tokens and therefore no notification. That is the
          // correct outcome for a best-effort courtesy send — the state change
          // itself already succeeded and was answered — and it is why this read
          // is not converted to a refusal like the ones on the request path.
          const { data: profiles } = await sc2.from("profiles").select("id, expo_push_token").in("id", memberIds);
          (profiles ?? []).forEach((p: any) => recipients.push({ userId: p.id as string, tokens: [p.expo_push_token] }));
        }
      }
      if (recipients.length > 0) {
        await sendPushWithRetry(sc2, recipients, {
          title: "Trip archived",
          body:  `${(tripRow as any)?.title ?? "A trip"} has been archived`,
          data:  { type: "trip_archived", tripId },
        });
      }
    } catch { /* best-effort */ }
  })();

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, status").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete a trip"); return; }

  // Trip Kernel path (ARCHIVE_TRIP, contract v2). Legacy writes 'archived'
  // unconditionally, so a second DELETE re-writes an archived row; ARCHIVE_TRIP
  // refuses archived -> archived as a non-transition, so under the kernel an
  // already-archived trip is answered 204 with NO command (nothing to
  // transition; only the legacy updated_at bump is lost, recorded in the lane
  // report). Off => the direct update below, exactly as before.
  const kernelDelete = await tripKernel();
  let deleteWrite: "legacy" | "kernel" | "already_archived" = "legacy";
  if (kernelDelete) {
    if ((trip as any).status === "archived") {
      deleteWrite = "already_archived";
    } else {
      const env = readCommandEnvelope(req);
      if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
      const r = await executeTripCommand(kernelDelete, {
        commandId: crypto.randomUUID(),
        tripId,
        actorUserId: user.id,
        expectedTripVersion: env.expectedTripVersion,
        idempotencyKey: env.idempotencyKey,
        type: "ARCHIVE_TRIP",
        payload: { updated_at: new Date().toISOString(), soft_delete: true },
      });
      if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
      setTripVersionHeader(res, r.version);
      deleteWrite = "kernel";
    }
  }

  // TRANSITION AGREEMENT (lib/stateMachines/registry.ts, TRIPS_STATUS): the
  // registry declares `-> archived` from draft/planning/upcoming/active/
  // completed/cancelled — `archived` is NOT in that `from` list, yet this legacy
  // path writes 'archived' unconditionally, so a second DELETE re-writes an
  // already-archived row. The kernel path refuses that as a non-transition; the
  // two paths therefore disagree by design, and tripKernelExpansion.test.ts pins
  // the legacy side ("legacy writes archived again, unconditionally") as the
  // flag-off byte-identity baseline. Left as it is deliberately: a self-write of
  // the same value is idempotent, not a state change, and unpinning another
  // lane's recorded baseline to make the two agree is not this lane's call. The
  // divergence is reported rather than silently closed.
  // A bodyless UPDATE returns `data: null`, so it cannot say how many rows it
  // matched — `error === null` is NOT "it worked". This route answered the
  // status word for a write that may have touched NOTHING (and, before this,
  // for a write that outright FAILED: `.error` was never bound). `.select("id")`
  // makes the affected-row count observable; zero rows now refuses.
  // trip-kernel:legacy-path — the flag-off twin of ARCHIVE_TRIP above.
  if (deleteWrite === "legacy") {
    const { data: deleteRows, error: deleteErr } = await sc
      .from("trips")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", tripId)
      .select("id");
    if (deleteErr) { sendError(res, "db_error", deleteErr.message); return; }
    if ((deleteRows ?? []).length === 0) { sendError(res, "not_found", "Trip not found"); return; }
  }
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

  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("owner_id, allow_join_requests, status, visibility")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);

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
  // supabase-js RESOLVES on a DB error, so an unbound `error` read an
  // unreadable trip_join_requests as "this user has never asked" and fell
  // through to the INSERT — filing a fresh pending request (and a fresh push to
  // the trip owner) for someone whose earlier request the owner already
  // DENIED, which is the one state this lookup exists to keep from being
  // reopened by the requester alone.
  const { data: existingReq, error: existingReqErr } = await sc
    .from("trip_join_requests")
    .select("id, status")
    .eq("trip_id", tripId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingReqErr) {
    req.log?.error({ err: existingReqErr, tripId }, "trip_join_requests lookup failed — refusing to file a possible duplicate request");
    sendError(res, "db_error", existingReqErr.message);
    return;
  }

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

  // Fire-and-forget: notify trip owner that someone requested to join.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const ownerId = (trip as any).owner_id as string;
      if (ownerId === user.id) return; // owner self-request (shouldn't happen, but guard)
      const [{ data: tripRow }, { data: ownerRow }, { data: requesterRow }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("profiles").select("expo_push_token").eq("id", ownerId).maybeSingle(),
        sc2.from("profiles").select("display_name, handle").eq("id", user.id).maybeSingle(),
      ]);
      const requesterNameAllowed = await nameVisibleFor(sc2, user.id);
      const requesterName = truncateDisplayName(requesterNameAllowed
        ? ((requesterRow as any)?.display_name ?? ((requesterRow as any)?.handle ? `@${(requesterRow as any).handle}` : "Someone"))
        : ((requesterRow as any)?.handle ? `@${(requesterRow as any).handle}` : "Someone"));
      await sendPushWithRetry(sc2, { userId: ownerId, tokens: [(ownerRow as any)?.expo_push_token] }, {
        title: "New join request",
        body:  `${requesterName} wants to join ${(tripRow as any)?.title ?? "your trip"}`,
        data:  { type: "trip_join_request_received", tripId },
      });
    } catch { /* best-effort */ }
  })();

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  // §6.1 host — owner or accepted co-host — as canManageJoinRequests defines
  // it and as the kernel's `host` capability (2500) re-checks it.
  const approveHost = await canManageJoinRequests(sc, { userId: user.id }, tripId, { trip: { id: tripId, owner_id: (trip as any).owner_id } });
  if (!approveHost.allowed) { sendTripRefusal(res, "forbidden", approveHost.reason, "Only the owner or co-host can approve join requests"); return; }

  const { data: req_, error: req_Err } = await sc
    .from("trip_join_requests")
    .select("*")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (req_Err) throw readUnavailable("trip_join_requests", req_Err);

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  const requestedUserId = (req_ as any).user_id as string;

  // Trip Kernel path (contract v2 + 2500). The legacy upsert hides which case
  // it is, so read the row first: no row => ADD_PARTICIPANT (member, accepted,
  // joined now); an existing row => SET_PARTICIPANT_ROLE to member (the kernel
  // refuses to touch the owner's row, which the upsert would silently
  // downgrade). The route's owner/co_host check above is the authorization;
  // the kernel re-checks `host` (owner or accepted co_host; 2500 — under 2450
  // alone a co_host approver is refused TRIP_AUTH_NOT_OWNER). Off => the
  // direct upsert below, exactly as before.
  const kernelApprove = await tripKernel();
  let kernelApproved = false;
  if (kernelApprove) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const { data: existingRow, error: existingErr } = await kernelApprove
      .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", requestedUserId).maybeSingle();
    if (existingErr) { sendError(res, "db_error", existingErr.message); return; }
    const r = await executeTripCommand(kernelApprove, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: existingRow ? "SET_PARTICIPANT_ROLE" : "ADD_PARTICIPANT",
      payload: existingRow
        ? { user_id: requestedUserId, role: "member" }
        : { user_id: requestedUserId, role: "member", status: "accepted", joined_at: new Date().toISOString() },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    kernelApproved = true;
  }

  // Add to trip_members
  // trip-kernel:legacy-path — the flag-off twin of ADD_PARTICIPANT / SET_PARTICIPANT_ROLE above.
  const { error: memErr } = kernelApproved ? { error: null } : await sc
    .from("trip_members")
    .upsert({ trip_id: tripId, user_id: requestedUserId, role: "member", status: "accepted", joined_at: new Date().toISOString() },
             { onConflict: "trip_id,user_id" });
  if (memErr) { sendError(res, "db_error", memErr.message); return; }

  // The member row above is committed by this point, so a request that stays
  // 'pending' here is the WORST outcome this route has: the user IS on the trip
  // and the owner's join-request queue still shows an unanswered request they
  // can "approve" again. The write bound no `.error` and had no `.select()`, so
  // both a failure and a zero-row match answered {status:"approved"}.
  const { data: approvedRows, error: approvedErr } = await sc
    .from("trip_join_requests")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", requestId)
    .select("id");
  if (approvedErr) { sendError(res, "db_error", approvedErr.message); return; }
  if ((approvedRows ?? []).length === 0) { sendError(res, "not_found", "Join request not found"); return; }

  await logActivity(sc, tripId, user.id, "join_request_approved", { userId: requestedUserId });

  // Fire-and-forget: notify the requester their join request was approved.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const [{ data: tripRow }, { data: requesterRow }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("profiles").select("expo_push_token").eq("id", requestedUserId).maybeSingle(),
      ]);
      await sendPushWithRetry(sc2, { userId: requestedUserId, tokens: [(requesterRow as any)?.expo_push_token] }, {
        title: "Join request approved!",
        // Privacy: do not expose the trip name on the lock screen.
        // Full details load after the user opens the app with their session.
        body:  "Your trip access request was approved.",
        data:  { type: "trip_join_approved", tripId },
      });
      // In-app notification: store with generic text — no trip name in params.
      // notifRouter.route() is intentionally NOT called here; push was already
      // sent above via sendPushWithRetry to avoid double-delivery.
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const notifSvc = new NotificationService(sc2);
      await notifSvc.create({
        userId:     requestedUserId,
        eventType:  "trip.join_approved",
        sourceType: "trips",
        sourceId:   tripId,
        // Privacy: params deliberately contain NO trip title.
        params: { tripId },
      });
    } catch { /* best-effort */ }
  })();

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const declineHost = await canManageJoinRequests(sc, { userId: user.id }, tripId, { trip: { id: tripId, owner_id: (trip as any).owner_id } });
  if (!declineHost.allowed) { sendTripRefusal(res, "forbidden", declineHost.reason, "Only the owner or co-host can decline join requests"); return; }

  const { data: req_, error: req_Err } = await sc
    .from("trip_join_requests")
    .select("status, user_id")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (req_Err) throw readUnavailable("trip_join_requests", req_Err);

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  // A decline that did not land leaves the request 'pending' while the requester
  // is told (and pushed) that it was declined — and the route would say so on a
  // hard DB failure too, since `.error` was never bound and a bodyless UPDATE
  // reports no affected-row count.
  const { data: declinedRows, error: declinedErr } = await sc
    .from("trip_join_requests")
    .update({ status: "declined", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", requestId)
    .select("id");
  if (declinedErr) { sendError(res, "db_error", declinedErr.message); return; }
  if ((declinedRows ?? []).length === 0) { sendError(res, "not_found", "Join request not found"); return; }

  await logActivity(sc, tripId, user.id, "join_request_declined", { requestId });

  // Fire-and-forget: notify the requester their join request was declined.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const declinedUserId = (req_ as any).user_id as string;
      const [{ data: tripRow }, { data: requesterRow }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("profiles").select("expo_push_token").eq("id", declinedUserId).maybeSingle(),
      ]);
      await sendPushWithRetry(sc2, { userId: declinedUserId, tokens: [(requesterRow as any)?.expo_push_token] }, {
        title: "Join request update",
        // Privacy: do not expose the trip name on the lock screen.
        body:  "Your trip access request was not approved.",
        data:  { type: "trip_join_declined", tripId },
      });
      // In-app notification: store with generic text — no trip name in params.
      // notifRouter.route() is intentionally NOT called here; push was already
      // sent above via sendPushWithRetry to avoid double-delivery.
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const notifSvc = new NotificationService(sc2);
      await notifSvc.create({
        userId:     declinedUserId,
        eventType:  "trip.join_declined",
        sourceType: "trips",
        sourceId:   tripId,
        // Privacy: params deliberately contain NO trip title.
        params: { tripId },
      });
    } catch { /* best-effort */ }
  })();

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

  const { data: req_, error: req_Err } = await sc
    .from("trip_join_requests")
    .select("*")
    .eq("id", requestId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (req_Err) throw readUnavailable("trip_join_requests", req_Err);

  if (!req_) { sendError(res, "not_found", "Join request not found"); return; }
  if ((req_ as any).user_id !== user.id) { sendError(res, "forbidden", "Can only cancel your own request"); return; }
  if ((req_ as any).status !== "pending") {
    sendError(res, "invalid_state_transition", `Request is already ${(req_ as any).status}`);
    return;
  }

  // Same shape: {status:"cancelled"} was answered for a write whose outcome the
  // route never asked about. A request that is still 'pending' after this keeps
  // notifying the owner about someone who withdrew.
  const { data: cancelledRows, error: cancelledErr } = await sc
    .from("trip_join_requests")
    .update({ status: "cancelled" })
    .eq("id", requestId)
    .select("id");
  if (cancelledErr) { sendError(res, "db_error", cancelledErr.message); return; }
  if ((cancelledRows ?? []).length === 0) { sendError(res, "not_found", "Join request not found"); return; }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can revoke invite links"); return; }

  const { data: link, error: linkErr } = await sc
    .from("trip_invite_links")
    .select("id")
    .eq("id", linkId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (linkErr) throw readUnavailable("trip_invite_links", linkErr);

  if (!link) { sendError(res, "not_found", "Invite link not found"); return; }

  // The one on this list with a security consequence: 204 told the owner the
  // link was revoked while the link went on admitting strangers to their trip.
  // `.error` was unbound and the bodyless UPDATE reported no row count, so a
  // failed revoke and a successful one were the same 204.
  const { data: revokedRows, error: revokedErr } = await sc
    .from("trip_invite_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", linkId)
    .select("id");
  if (revokedErr) { sendError(res, "db_error", revokedErr.message); return; }
  if ((revokedRows ?? []).length === 0) { sendError(res, "not_found", "Invite link not found"); return; }
  res.status(204).send();
});

// GET /api/trips/:tripId/invite-links  — list all invite links (owner only)
router.get("/trips/:tripId/invite-links", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can view invite links"); return; }

  const { data: links, error: linksErr } = await sc
    .from("trip_invite_links")
    .select("id, token, use_count, max_uses, expires_at, created_at, revoked_at")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });
  if (linksErr) throw readUnavailable("trip_invite_links", linksErr);

  if (!links || links.length === 0) { res.json([]); return; }

  // Pull who joined via each link from the activity log
  // Enrichment only: the joiner list decorates each link row. An unreadable
  // `trip_activity_log` renders `joiners: []`, which understates who used a
  // link but never overstates it, and the link's own use_count (read above,
  // and now bound) is the authoritative number the owner acts on.
  const { data: activityRows } = await sc
    .from("trip_activity_log")
    .select("actor_id, metadata")
    .eq("trip_id", tripId)
    .eq("event_type", "joined_via_invite_link");

  const joinersByLink = new Map<string, string[]>();
  for (const row of (activityRows ?? []) as any[]) {
    const linkId = (row.metadata as any)?.linkId as string | undefined;
    if (!linkId) continue;
    if (!joinersByLink.has(linkId)) joinersByLink.set(linkId, []);
    joinersByLink.get(linkId)!.push(row.actor_id as string);
  }

  const allJoinerIds = [...new Set([...joinersByLink.values()].flat())];
  const profileMap = new Map<string, { id: string; name: string | null; handle: string | null; avatarUrl: string | null }>();

  if (allJoinerIds.length > 0) {
    // Enrichment only: an unreadable `profiles` leaves each joiner as
    // `{ id, name: null, handle: null, avatarUrl: null }` (the fallback below).
    // The joiner's id and their `removed` flag — the two facts the owner acts
    // on — come from trip_activity_log and trip_members, not from here.
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, display_name, name, full_name, username, avatar_url")
      .in("id", allJoinerIds);
    const allowedNames = await nameVisibilitySet(sc, allJoinerIds);
    for (const p of (profiles ?? []) as any[]) {
      const nameAllowed = (p.id as string) === user.id || allowedNames.has(p.id as string);
      profileMap.set(p.id as string, {
        id: p.id as string,
        name: presentedName(p, nameAllowed),
        handle: (p.username as string) ?? null,
        avatarUrl: (p.avatar_url as string) ?? null,
      });
    }
  }

  // Cross-check joiners against current trip_members so removed users can be flagged
  const currentMemberIds = new Set<string>();
  if (allJoinerIds.length > 0) {
    const { data: members, error: membersErr } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .in("user_id", allJoinerIds);
    if (membersErr) throw readUnavailable("trip_members", membersErr);
    for (const m of (members ?? []) as any[]) {
      currentMemberIds.add(m.user_id as string);
    }
  }

  const now = new Date();
  const result = (links as any[]).map((lk) => {
    const isRevoked   = Boolean(lk.revoked_at);
    const isExpired   = !isRevoked && Boolean(lk.expires_at) && new Date(lk.expires_at as string) < now;
    const isExhausted = !isRevoked && !isExpired && lk.max_uses !== null && (lk.use_count as number) >= (lk.max_uses as number);
    return {
      id:        lk.id as string,
      token:     lk.token as string,
      useCount:  (lk.use_count as number) ?? 0,
      maxUses:   (lk.max_uses as number) ?? null,
      expiresAt: (lk.expires_at as string) ?? null,
      createdAt: lk.created_at as string,
      revokedAt: (lk.revoked_at as string) ?? null,
      isActive:  !isRevoked && !isExpired && !isExhausted,
      isRevoked,
      isExpired,
      isExhausted,
      joiners: (joinersByLink.get(lk.id as string) ?? []).map((uid) => ({
        ...(profileMap.get(uid) ?? { id: uid, name: null, handle: null, avatarUrl: null }),
        removed: !currentMemberIds.has(uid),
      })),
    };
  });

  res.json(result);
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

  const { data: link, error: linkErr } = await sc
    .from("trip_invite_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (linkErr) throw readUnavailable("trip_invite_links", linkErr);

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

  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id, visibility, status, max_members")
    .eq("id", lk.trip_id)
    .maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const tripStatus = (trip as any).status as string | null;
  const endDate    = (trip as any).end_date as string | null;
  const today      = new Date().toISOString().slice(0, 10);

  // Return 410 when the trip itself is in a terminal state so the client can
  // show "This trip is no longer active" instead of a generic link-gone message.
  const isTerminal =
    tripStatus === "cancelled" ||
    tripStatus === "archived"  ||
    (endDate != null && endDate < today);

  if (isTerminal) {
    res.status(410).json({
      error: "gone",
      reason: "trip_inactive",
      trip: {
        title:              (trip as any).title ?? null,
        destinationCity:    (trip as any).destination_city ?? null,
        destinationCountry: (trip as any).destination_country ?? null,
        startDate:          (trip as any).start_date ?? null,
        endDate:            endDate,
        coverUrl:           (trip as any).cover_url ?? null,
      },
    });
    return;
  }

  // Is the caller already a member?
  const membership = await requireTripMember(sc, lk.trip_id, user.id, { status: "any" });

  // Compute isFull so the client can show a warning before the user taps Accept.
  // Only meaningful when max_members is set; counts accepted members only.
  const maxMembers = (trip as any).max_members as number | null;
  let isFull = false;
  if (maxMembers != null) {
    const { data: memberRows, error: memberRowsErr } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", lk.trip_id)
      .eq("status", "accepted");
    if (memberRowsErr) throw readUnavailable("trip_members", memberRowsErr);
    isFull = (memberRows?.length ?? 0) >= maxMembers;
  }

  res.json({
    tripId:             (trip as any).id,
    tripTitle:          (trip as any).title,
    destinationCity:    (trip as any).destination_city,
    destinationCountry: (trip as any).destination_country ?? null,
    startDate:          (trip as any).start_date ?? null,
    endDate:            endDate,
    coverUrl:           (trip as any).cover_url ?? null,
    alreadyMember:      Boolean(membership),
    linkId:             lk.id,
    expiresAt:          lk.expires_at ?? null,
    tripStatus:         tripStatus,
    // Always false on the 200 path — terminal trips return 410 above. Emitted
    // explicitly so clients (and the preview contract tests) can rely on it.
    isTerminal:         false,
    isFull:             isFull,
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

  const { data: link, error: linkErr } = await sc
    .from("trip_invite_links")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (linkErr) throw readUnavailable("trip_invite_links", linkErr);

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
  // Note: max_uses capacity is NOT checked here.  The claim function
  // (claim_invite_link_slot_for_user) handles it atomically together with
  // the per-user attempt ledger.  Checking it here would bypass the ledger
  // for users who are retrying a partial failure — their slot is already
  // consumed in use_count but their attempt row signals it was never completed.
  const tripId = lk.trip_id as string;

  // Block check against owner
  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, status, end_date, max_members").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const blocked = await isBlocked(sc, user.id, (trip as any).owner_id);
  if (blocked) { sendError(res, "forbidden", "Blocked"); return; }

  // Terminal-state guard: cannot join a trip that has been cancelled or archived.
  const tripStatus = (trip as any).status as string | null;
  if (tripStatus === "cancelled" || tripStatus === "archived") {
    res.status(410).json({ error: "gone", message: "This trip is no longer active" });
    return;
  }

  // Past-trip guard: cannot join a trip whose end date has already passed.
  // end_date is stored as a YYYY-MM-DD date string; compare lexicographically
  // to today's ISO date so no timezone ambiguity is introduced.
  const endDate = (trip as any).end_date as string | null;
  if (endDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (endDate < today) {
      res.status(410).json({ error: "gone", message: "This trip has already ended" });
      return;
    }
  }

  // Already a member?
  const membership = await requireTripMember(sc, tripId, user.id, { status: "any" });
  if (membership) {
    res.json({ status: "already_member", tripId, idempotent: true });
    return;
  }

  // Member-capacity guard: if the trip has a max_members cap, check that it
  // has not been reached before consuming a slot.  This guard runs after the
  // already-member check so that an already-joined user's idempotent retry is
  // never blocked by a later capacity squeeze.
  const maxMembers = (trip as any).max_members as number | null;
  if (maxMembers != null) {
    const { data: memberRows, error: memberRowsErr } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("status", "accepted");
    if (memberRowsErr) throw readUnavailable("trip_members", memberRowsErr);
    if ((memberRows?.length ?? 0) >= maxMembers) {
      res.status(410).json({ error: "gone", reason: "trip_full", message: "This trip is already full" });
      return;
    }
  }

  // Trip Kernel gate (JOIN_VIA_LINK, contract v2 + migration 2500), read
  // BEFORE the slot is claimed so a malformed envelope is refused without
  // consuming or stranding a slot. The actor is the JOINER; the kernel's
  // `link_holder` capability is exactly what the claim below establishes: an
  // attempt row for (this link, this user) on a link that belongs to this trip.
  const kernelJoin = await tripKernel();
  const joinEnv = kernelJoin ? readCommandEnvelope(req) : null;
  if (joinEnv && !joinEnv.ok) { sendError(res, "invalid_payload", joinEnv.message); return; }

  // ── Capacity-enforcement guarantee ────────────────────────────────────────
  // claim_invite_link_slot_for_user is the SINGLE authoritative gate for slot
  // capacity.  It runs entirely inside one PostgreSQL transaction and uses a
  // conditional UPDATE (`WHERE use_count < max_uses`) which takes a row-level
  // lock, so no two concurrent callers can both see "slot available" and both
  // increment use_count past max_uses.  The function returns:
  //
  //   'claimed'           — slot consumed, attempt row recorded.
  //   'already_attempted' — prior slot already claimed; skip re-claiming and
  //                         retry the member insert using the dangling slot.
  //   'limit_reached'     — no slot available (max_uses exhausted).
  //
  // The max_members pre-flight check above is an optimistic early-return that
  // avoids consuming a slot when the trip is obviously full, but it is NOT a
  // reliable race guard.  Two concurrent accepts can both pass the pre-flight
  // check and only be serialized at the RPC boundary.  Never rely on the
  // pre-flight check alone to prevent over-subscription.
  //
  // Using a single DB function also closes the window that existed when claim
  // and attempt-row-insert were two separate operations: if the process crashed
  // between them, use_count would be stuck but there would be no attempt row
  // to detect it on retry.  Now both operations are atomic.
  const { data: claimResult, error: claimErr } = await sc.rpc(
    "claim_invite_link_slot_for_user",
    { p_link_id: lk.id, p_user_id: user.id }
  );

  const isRetryAttempt = claimResult === "already_attempted";

  if (claimErr || claimResult === "limit_reached") {
    // Slot limit reached.  Re-check membership before returning 410 — the
    // first request may have fully succeeded but its response was lost in
    // transit and the "already_member" guard at the top ran before the commit
    // was visible.  A concurrent request that committed between the two checks
    // is also caught here.
    const retryMembership = await requireTripMember(sc, tripId, user.id, { status: "any" });
    if (retryMembership) {
      res.json({ status: "already_member", tripId, idempotent: true });
      return;
    }
    res.status(410).json({ error: "gone", message: "This invite link has reached its usage limit" });
    return;
  }

  // Trip member cap reached (enforced atomically inside the DB function via
  // SELECT … FOR UPDATE on the trips row).  This is the authoritative guard
  // for max_members — two concurrent requests serialise on the trip row lock
  // so only the first one through sees the count as under-capacity.
  if (claimResult === "trip_full") {
    res.status(410).json({ error: "gone", reason: "trip_full", message: "This trip is already full" });
    return;
  }

  // Helper: clean up the attempt row (best-effort; failure is non-fatal).
  const clearAttempt = () =>
    sc.from("trip_invite_link_attempts")
      .delete()
      .eq("link_id", lk.id)
      .eq("user_id", user.id);

  // Kernel twin of the insert: a rejection is mapped onto the SAME error shapes
  // the legacy insert produces, so every compensation branch below (release the
  // freshly claimed slot, clear the attempt row, answer already_member / 410)
  // runs unchanged for both paths. TRIP_PARTICIPANT_ALREADY_EXISTS is the
  // unique-violation case; TRIP_PARTICIPANT_CAPACITY_REACHED is the trigger's
  // trip_full; anything else reaches the generic branch, which then answers
  // with the kernel's reason instead of db_error.
  const kernelJoinOutcome: { rejection: Extract<TripKernelResult, { ok: false }> | null } = { rejection: null };
  const joinViaKernel = async (): Promise<{ error: { code?: string; message: string } | null }> => {
    const r = await executeTripCommand(kernelJoin, {
      commandId: crypto.randomUUID(),
      tripId,
      actorUserId: user.id,
      expectedTripVersion: joinEnv!.ok ? joinEnv!.expectedTripVersion : null,
      idempotencyKey: joinEnv!.ok ? joinEnv!.idempotencyKey : crypto.randomUUID(),
      type: "JOIN_VIA_LINK",
      payload: { invite_link_id: lk.id, joined_at: new Date().toISOString() },
    });
    if (r.ok) { setTripVersionHeader(res, r.version); return { error: null }; }
    if (r.reason === "TRIP_PARTICIPANT_ALREADY_EXISTS") return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    if (r.reason === "TRIP_PARTICIPANT_CAPACITY_REACHED") return { error: { code: "P0001", message: "trip_full" } };
    kernelJoinOutcome.rejection = r;
    return { error: { code: "TRIP_KERNEL", message: r.detail ?? r.reason } };
  };

  // Add member
  // trip-kernel:legacy-path — the flag-off twin of JOIN_VIA_LINK above.
  const { error: memErr } = kernelJoin ? await joinViaKernel() : await sc
    .from("trip_members")
    .insert({ trip_id: tripId, user_id: user.id, role: "member", status: "accepted", joined_at: new Date().toISOString(), invite_link_id: lk.id });

  if (memErr) {
    // Unique-constraint violation (23505): a concurrent first attempt already
    // committed this member row.  Release the slot only if we freshly claimed
    // one (not when reusing a prior dangling slot), then clean up the attempt
    // row and return idempotent success.
    if ((memErr as { code?: string }).code === "23505") {
      if (!isRetryAttempt) {
        const { error: releaseErr } = await sc.rpc("release_invite_link_slot", { link_id: lk.id });
        if (releaseErr) {
          req.log.error(
            { linkId: lk.id, userId: user.id, releaseError: releaseErr.message },
            "release_invite_link_slot failed after duplicate-member conflict — slot may be stranded"
          );
        }
      }
      await clearAttempt();
      res.json({ status: "already_member", tripId, idempotent: true });
      return;
    }
    // Trip member cap enforced by the BEFORE INSERT trigger (migration 0115).
    // The trigger raises SQLSTATE P0001 with message 'trip_full' when another
    // request committed a member row between our claim and our INSERT, pushing
    // the accepted-member count to max_members.  Release the freshly claimed
    // slot (so use_count is not permanently bumped) and return 410.
    //
    // The claim RPC's 'trip_full' fast-path (above) skips the INSERT entirely
    // when the trip is obviously full at claim time.  This branch catches the
    // residual race where two requests both receive 'claimed' but only one's
    // INSERT commits — the trigger serialises the concurrent inserts and the
    // second one reaches this error path.
    if ((memErr as { code?: string }).code === "P0001" && memErr.message === "trip_full") {
      if (!isRetryAttempt) {
        const { error: releaseErr } = await sc.rpc("release_invite_link_slot", { link_id: lk.id });
        if (releaseErr) {
          req.log.error(
            { linkId: lk.id, userId: user.id, releaseError: releaseErr.message },
            "release_invite_link_slot failed after trigger trip_full — slot may be stranded"
          );
        }
      }
      await clearAttempt();
      res.status(410).json({ error: "gone", reason: "trip_full", message: "This trip is already full" });
      return;
    }
    // Any other DB error: release the slot if it was freshly claimed.  When
    // retrying a partial failure (isRetryAttempt=true), intentionally leave the
    // attempt row so subsequent retries can still skip the slot claim; the
    // client's 5xx retry loop will try again.
    if (!isRetryAttempt) {
      const { error: releaseErr } = await sc.rpc("release_invite_link_slot", { link_id: lk.id });
      if (releaseErr) {
        req.log.error(
          { linkId: lk.id, userId: user.id, releaseError: releaseErr.message },
          "release_invite_link_slot failed after member-insert error — slot may be stranded"
        );
      }
      await clearAttempt();
    }
    if (kernelJoinOutcome.rejection) { sendKernelRejection(res, kernelJoinOutcome.rejection, req.log); return; }
    sendError(res, "db_error", memErr.message);
    return;
  }

  // Success: clean up the attempt row so a future link re-use is not blocked.
  await clearAttempt();

  await logActivity(sc, tripId, user.id, "joined_via_invite_link", { linkId: lk.id });

  res.status(201).json({ status: "joined", tripId, role: "member" });
});

// ===========================================================================
// GET /api/trips/:tripId/nearby-places  — discovery places near the trip destination
// ===========================================================================
router.get("/trips/:tripId/nearby-places", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("owner_id, status, visibility, destination_city, destination_country, destination_lat, destination_lng")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const t = trip as any;
  const isPublic = t.visibility === "public";
  if (!isPublic) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership && t.owner_id !== user.id) { sendError(res, "not_member", "Not a trip member"); return; }
  }

  if (!t.destination_city) {
    res.json({ places: [], message: "No destination set for this trip" });
    return;
  }

  // Return discovery places matching the destination city
  const { data: places, error: placesErr } = await sc
    .from("discovery_places")
    .select("id, name, category, lat, lng, city, image_url, rating")
    .ilike("city", `%${t.destination_city}%`)
    .order("rating", { ascending: false })
    .limit(30);
  if (placesErr) throw readUnavailable("discovery_places", placesErr);

  // Live discovery_places has image_url (not cover_url) and no country column —
  // preserve the response shape the client expects.
  const shapedPlaces = ((places ?? []) as any[]).map((p) => ({
    ...p,
    cover_url: p.image_url ?? null,
    country: t.destination_country ?? null,
  }));

  res.json({ places: shapedPlaces, destination: { city: t.destination_city, country: t.destination_country ?? null } });
});

// ===========================================================================
// Destinations routes  (trip_destinations table — created by migration 0079)
// ===========================================================================

// GET /api/trips/:tripId/destinations  — list all destinations for trip members
router.get("/trips/:tripId/destinations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }
  }

  const { data, error } = await sc
    .from("trip_destinations")
    .select("id, city, country, lat, lng, place_id, arrival_date, departure_date, position, created_at")
    .eq("trip_id", tripId)
    .order("position", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ destinations: data ?? [] });
});

// POST /api/trips/:tripId/destinations  — add a destination (owner + co_host only)
const DestinationSchema = z.object({
  city:          z.string().min(1).max(200),
  country:       z.string().max(100).nullable().optional(),
  lat:           z.number().nullable().optional(),
  lng:           z.number().nullable().optional(),
  placeId:       z.string().max(300).nullable().optional(),
  arrivalDate:   z.string().nullable().optional(),
  departureDate: z.string().nullable().optional(),
  position:      z.number().int().default(0),
});

router.post("/trips/:tripId/destinations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = DestinationSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Only the trip owner or co-host can add destinations");
      return;
    }
  }

  const { data, error } = await sc
    .from("trip_destinations")
    .insert({
      trip_id:        tripId,
      city:           b.city,
      country:        b.country ?? null,
      lat:            b.lat ?? null,
      lng:            b.lng ?? null,
      place_id:       b.placeId ?? null,
      arrival_date:   b.arrivalDate ?? null,
      departure_date: b.departureDate ?? null,
      position:       b.position,
    })
    .select("id, city, country, lat, lng, place_id, arrival_date, departure_date, position, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  await logActivity(sc, tripId, user.id, "destination_added", { city: b.city });
  res.status(201).json(data);
});

// ===========================================================================
// POST /api/trips/:tripId/destinations/reorder
// POST /api/trips/:tripId/items/reorder  (alias — same handler)
// ===========================================================================
async function handleDestinationsReorder(req: any, res: any): Promise<void> {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return; }
  if (!["owner", "co_host", "member"].includes(membership.role)) {
    sendError(res, "forbidden", "Viewers cannot reorder destinations"); return;
  }

  const OrderSchema = z.object({
    order: z.array(z.string().regex(UUID_RE)).min(1),
  });
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "order must be an array of UUIDs"); return; }

  const { order } = parsed.data;

  // Validate that all IDs belong to this trip
  const { data: existing, error: existingErr } = await sc
    .from("trip_destinations")
    .select("id")
    .eq("trip_id", tripId)
    .in("id", order);
  if (existingErr) throw readUnavailable("trip_destinations", existingErr);

  const existingIds = new Set((existing ?? []).map((r: any) => r.id as string));
  if (order.some((id) => !existingIds.has(id))) {
    sendError(res, "invalid_payload", "One or more destination IDs do not belong to this trip"); return;
  }

  // Apply positions sequentially.
  //
  // The `.then(undefined, () => {})` here was doing nothing useful and hiding
  // something real: a PostgREST builder RESOLVES on a database error, so the
  // rejection handler never fires, and the resolved `{ error }` was thrown away
  // with the value. Every one of these updates could fail and the route still
  // answered {status:"reordered", count:N} — a reorder the client then renders
  // optimistically and the server never performed. `.select("id")` also makes
  // the affected-row count observable, so an id that matched nothing (a
  // destination deleted between the validation read above and here) is caught
  // rather than counted as reordered.
  const positionWrites = await Promise.all(
    order.map((id, idx) =>
      sc.from("trip_destinations").update({ position: idx + 1 }).eq("id", id).eq("trip_id", tripId).select("id"),
    ),
  );
  const failed = positionWrites.filter((w: any) => w.error);
  if (failed.length > 0) {
    req.log?.error({ tripId, failed: failed.length, of: order.length, err: (failed[0] as any).error },
      "trip_destinations reorder partially failed — positions are now inconsistent");
    sendError(res, "db_error", String((failed[0] as any).error?.message ?? "reorder failed"));
    return;
  }
  const missed = positionWrites.filter((w: any) => ((w.data ?? []) as any[]).length === 0);
  if (missed.length > 0) {
    sendError(res, "invalid_payload", "One or more destination IDs do not belong to this trip");
    return;
  }

  res.json({ status: "reordered", tripId, count: order.length });
}

router.post("/trips/:tripId/destinations/reorder", handleDestinationsReorder);
router.post("/trips/:tripId/items/reorder", handleDestinationsReorder);

// ===========================================================================
// DELETE /api/trips/:tripId/destinations/:destId  — remove a destination
// (owner + co_host only)
// ===========================================================================
router.delete("/trips/:tripId/destinations/:destId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, destId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }
  if (!UUID_RE.test(destId)) { sendError(res, "invalid_payload", "Invalid destId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Only the trip owner or co-host can remove destinations");
      return;
    }
  }

  // Verify the destination belongs to this trip before deleting.
  const { data: dest, error: destErr } = await sc
    .from("trip_destinations")
    .select("id")
    .eq("id", destId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (destErr) throw readUnavailable("trip_destinations", destErr);

  if (!dest) { sendError(res, "not_found", "Destination not found"); return; }

  const { error } = await sc
    .from("trip_destinations")
    .delete()
    .eq("id", destId)
    .eq("trip_id", tripId);

  if (error) { sendError(res, "db_error", error.message); return; }
  await logActivity(sc, tripId, user.id, "destination_removed", { destId });
  res.json({ status: "deleted", destId });
});

// ===========================================================================
// PATCH /api/trips/:tripId/destinations/:destId  — update arrival/departure dates
// (owner + co_host + member)
// ===========================================================================
const PatchDestinationSchema = z.object({
  arrivalDate:   z.string().nullable().optional(),
  departureDate: z.string().nullable().optional(),
});

router.patch("/trips/:tripId/destinations/:destId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, destId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }
  if (!UUID_RE.test(destId)) { sendError(res, "invalid_payload", "Invalid destId"); return; }

  const parsed = PatchDestinationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  // Require trip membership (owner, co_host, or member)
  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host", "member"].includes(membership.role)) {
      sendError(res, "forbidden", "Only trip members can update destination dates");
      return;
    }
  }

  // Verify the destination belongs to this trip
  const { data: dest, error: destErr } = await sc
    .from("trip_destinations")
    .select("id")
    .eq("id", destId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (destErr) throw readUnavailable("trip_destinations", destErr);

  if (!dest) { sendError(res, "not_found", "Destination not found"); return; }

  const patch: Record<string, any> = {};
  if (b.arrivalDate   !== undefined) patch.arrival_date   = b.arrivalDate;
  if (b.departureDate !== undefined) patch.departure_date = b.departureDate;

  const { data: updated, error } = await sc
    .from("trip_destinations")
    .update(patch)
    .eq("id", destId)
    .eq("trip_id", tripId)
    .select("*")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json(updated);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Budget is only visible to the trip owner and co-hosts"); return;
    }
  }

  const { data: budget, error: budgetErr } = await sc
    .from("trip_budget")
    .select("*")
    .eq("trip_id", tripId)
    .maybeSingle();
  if (budgetErr) throw readUnavailable("trip_budget", budgetErr);

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const isPutOwner = (trip as any).owner_id === user.id;
  if (!isPutOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership || !["owner", "co_host"].includes(membership.role)) {
      sendError(res, "forbidden", "Only the trip owner or co-host can update the budget"); return;
    }
  }

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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
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

// GET /api/trips/:tripId/documents/:docId  — one document, WITH its content
//
// THE GAP THIS CLOSES. `trip_documents.content` is written by POST and by PATCH
// and was returned by NOTHING: the list route selects
// `id, title, document_type, is_private, creator_id, created_at, updated_at`,
// POST and PATCH return the same column set, and there was no by-id route at
// all. A client could store a document's body and could never read it back —
// so "no mobile consumer" was a symptom here, not the disease. The listing
// deliberately stays lean (a packing list or an itinerary body does not belong
// in a collection response); this is where the body lives.
//
// Visibility is the SAME rule the listing enforces, restated here because a
// by-id route cannot inherit an or-filter: the trip owner reads every document;
// anyone else reads a document only if it is not private or they created it.
router.get("/trips/:tripId/documents/:docId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId, docId } = req.params;
  if (!UUID_RE.test(tripId) || !UUID_RE.test(docId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  const isOwner = (trip as any).owner_id === user.id;
  if (!membership && !isOwner) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data: doc, error: docErr } = await sc
    .from("trip_documents")
    .select("id, title, content, document_type, is_private, creator_id, created_at, updated_at")
    .eq("id", docId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (docErr) throw readUnavailable("trip_documents", docErr);
  if (!doc) { sendError(res, "not_found", "Document not found"); return; }

  const d = doc as any;
  // A private document the caller did not create is answered 404, not 403: a
  // 403 would confirm that a document with this id exists on this trip, which
  // is exactly what the privacy flag is withholding.
  if (!isOwner && d.is_private === true && d.creator_id !== user.id) {
    sendError(res, "not_found", "Document not found");
    return;
  }

  res.json(d);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: doc, error: docErr } = await sc.from("trip_documents").select("creator_id").eq("id", docId).eq("trip_id", tripId).maybeSingle();
  if (docErr) throw readUnavailable("trip_documents", docErr);
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
  // `.maybeSingle()` on an UPDATE that matched nothing gives `data: null` with
  // `error: null`, and the route sent that straight out as a 200 whose body is
  // literally `null` — a success answer for a document that was not updated.
  if (!updated) { sendError(res, "not_found", "Document not found"); return; }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const { data: doc, error: docErr } = await sc.from("trip_documents").select("creator_id").eq("id", docId).eq("trip_id", tripId).maybeSingle();
  if (docErr) throw readUnavailable("trip_documents", docErr);
  if (!doc) { sendError(res, "not_found", "Document not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (doc as any).creator_id === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot delete this document"); return; }

  // A DELETE that matched no row is genuinely idempotent here — the row was just
  // read and authorized two statements above — so a zero-row delete keeps its
  // 204. A DELETE that FAILED is not idempotent and is not a 204: `.error` was
  // unbound, so a refused or errored delete answered "deleted" and the client
  // dropped the item from its list.
  const { error: docDelErr } = await sc.from("trip_documents").delete().eq("id", docId);
  if (docDelErr) { sendError(res, "db_error", docDelErr.message); return; }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: note, error: noteErr } = await sc.from("trip_notes").select("author_id").eq("id", noteId).eq("trip_id", tripId).maybeSingle();
  if (noteErr) throw readUnavailable("trip_notes", noteErr);
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
  // Same as the document PATCH above: a zero-row UPDATE answered 200 `null`.
  if (!updated) { sendError(res, "not_found", "Note not found"); return; }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: note, error: noteErr } = await sc.from("trip_notes").select("author_id").eq("id", noteId).eq("trip_id", tripId).maybeSingle();
  if (noteErr) throw readUnavailable("trip_notes", noteErr);
  if (!note) { sendError(res, "not_found", "Note not found"); return; }

  const isOwner  = (trip as any).owner_id === user.id;
  const isAuthor = (note as any).author_id === user.id;
  if (!isOwner && !isAuthor) { sendError(res, "forbidden", "Cannot delete this note"); return; }

  // A DELETE that matched no row is genuinely idempotent here — the row was just
  // read and authorized two statements above — so a zero-row delete keeps its
  // 204. A DELETE that FAILED is not idempotent and is not a 204: `.error` was
  // unbound, so a refused or errored delete answered "deleted" and the client
  // dropped the item from its list.
  const { error: noteDelErr } = await sc.from("trip_notes").delete().eq("id", noteId);
  if (noteDelErr) { sendError(res, "db_error", noteDelErr.message); return; }
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

  // Duplicate prevention.
  // supabase-js RESOLVES on a DB error, so an unbound `error` read an
  // unreadable trip_saved_places as "not saved yet" and inserted a second copy
  // of the same place for the same member — the 409 this block owes the client
  // becomes a 201, and the trip's saved-places list grows a duplicate that only
  // manual deletion removes.
  if (b.placeId) {
    const { data: dup, error: dupErr } = await sc
      .from("trip_saved_places")
      .select("id")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .eq("place_id", b.placeId)
      .maybeSingle();
    if (dupErr) {
      req.log?.error({ err: dupErr, tripId, placeId: b.placeId }, "trip_saved_places duplicate check failed — refusing to save");
      sendError(res, "db_error", dupErr.message);
      return;
    }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: entry, error: entryErr } = await sc.from("trip_saved_places").select("user_id").eq("id", placeEntryId).eq("trip_id", tripId).maybeSingle();
  if (entryErr) throw readUnavailable("trip_saved_places", entryErr);
  if (!entry) { sendError(res, "not_found", "Saved place not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (entry as any).user_id === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot remove this saved place"); return; }

  // A DELETE that matched no row is genuinely idempotent here — the row was just
  // read and authorized two statements above — so a zero-row delete keeps its
  // 204. A DELETE that FAILED is not idempotent and is not a 204: `.error` was
  // unbound, so a refused or errored delete answered "deleted" and the client
  // dropped the item from its list.
  const { error: placeDelErr } = await sc.from("trip_saved_places").delete().eq("id", placeEntryId);
  if (placeDelErr) { sendError(res, "db_error", placeDelErr.message); return; }
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
    const { data: items, error: itemsErr } = await sc
      .from("trip_checklist_items")
      .select("id, checklist_id, label, is_done, assigned_to, due_date, sort_order")
      .in("checklist_id", listIds)
      .order("sort_order", { ascending: true });
    if (itemsErr) throw readUnavailable("trip_checklist_items", itemsErr);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const { data: list, error: listErr } = await sc.from("trip_checklists").select("created_by").eq("id", checklistId).eq("trip_id", tripId).maybeSingle();
  if (listErr) throw readUnavailable("trip_checklists", listErr);
  if (!list) { sendError(res, "not_found", "Checklist not found"); return; }

  const isOwner   = (trip as any).owner_id === user.id;
  const isCreator = (list as any).created_by === user.id;
  if (!isOwner && !isCreator) { sendError(res, "forbidden", "Cannot delete this checklist"); return; }

  // Two writes, neither bound. The dangerous ordering is items-then-list: if the
  // items delete failed and the list delete succeeded, the items are ORPHANED
  // (no checklist row to reach them by) and the caller was told 204. Refuse on
  // the first failure so the list is still there to retry against.
  const { error: itemsDelErr } = await sc.from("trip_checklist_items").delete().eq("checklist_id", checklistId);
  if (itemsDelErr) { sendError(res, "db_error", itemsDelErr.message); return; }
  const { error: listDelErr } = await sc.from("trip_checklists").delete().eq("id", checklistId);
  if (listDelErr) { sendError(res, "db_error", listDelErr.message); return; }
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

  const { data: list, error: listErr } = await sc.from("trip_checklists").select("id").eq("id", checklistId).eq("trip_id", tripId).maybeSingle();
  if (listErr) throw readUnavailable("trip_checklists", listErr);
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const { data: item, error: itemErr } = await sc
    .from("trip_checklist_items")
    .select("id, assigned_to")
    .eq("id", itemId)
    .eq("checklist_id", checklistId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (itemErr) throw readUnavailable("trip_checklist_items", itemErr);
  if (!item) { sendError(res, "not_found", "Checklist item not found"); return; }

  const isOwner = (trip as any).owner_id === user.id;
  const membership = isOwner ? null : await requireTripMember(sc, tripId, user.id);
  if (!isOwner && (!membership || !["owner", "co_host", "member"].includes(membership.role))) {
    sendError(res, "forbidden", "Not a trip member"); return;
  }

  // A DELETE that matched no row is genuinely idempotent here — the row was just
  // read and authorized two statements above — so a zero-row delete keeps its
  // 204. A DELETE that FAILED is not idempotent and is not a 204: `.error` was
  // unbound, so a refused or errored delete answered "deleted" and the client
  // dropped the item from its list.
  const { error: itemDelErr } = await sc.from("trip_checklist_items").delete().eq("id", itemId).eq("trip_id", tripId);
  if (itemDelErr) { sendError(res, "db_error", itemDelErr.message); return; }
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
  // `assigned_to` and `due_date` were WRITE-ONCE: POST .../items accepts both
  // and the list route returns both, but this PATCH accepted neither, so an
  // item assigned to the wrong person or given the wrong date could only be
  // corrected by deleting and recreating it (which loses its id and its place
  // in the list). `null` clears the field, which is the only way to unassign.
  if (req.body?.assignedTo === null)                  patch.assigned_to = null;
  else if (typeof req.body?.assignedTo === "string") {
    if (!UUID_RE.test(req.body.assignedTo)) { sendError(res, "invalid_payload", "assignedTo must be a UUID or null"); return; }
    patch.assigned_to = req.body.assignedTo;
  }
  if (req.body?.dueDate === null)                     patch.due_date = null;
  else if (typeof req.body?.dueDate === "string")     patch.due_date = req.body.dueDate;

  if (Object.keys(patch).length === 0) { sendError(res, "invalid_payload", "No fields to update"); return; }

  const { data, error } = await sc
    .from("trip_checklist_items")
    .update(patch)
    .eq("id", itemId)
    .eq("checklist_id", checklistId)
    .eq("trip_id", tripId)
    .select("id, label, is_done, assigned_to, due_date, sort_order")
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

  const { data: rem, error: remErr } = await sc
    .from("trip_reminders")
    .select("user_id")
    .eq("id", reminderId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (remErr) throw readUnavailable("trip_reminders", remErr);

  if (!rem) { sendError(res, "not_found", "Reminder not found"); return; }
  if ((rem as any).user_id !== user.id) { sendError(res, "forbidden", "Can only delete your own reminders"); return; }

  // A DELETE that matched no row is genuinely idempotent here — the row was just
  // read and authorized two statements above — so a zero-row delete keeps its
  // 204. A DELETE that FAILED is not idempotent and is not a 204: `.error` was
  // unbound, so a refused or errored delete answered "deleted" and the client
  // dropped the item from its list.
  const { error: remDelErr } = await sc.from("trip_reminders").delete().eq("id", reminderId);
  if (remDelErr) { sendError(res, "db_error", remDelErr.message); return; }
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

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) throw readUnavailable("trips", tripErr);
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

  // Auth is optional — unauthenticated callers can read public trips.
  const auth = await optionalUser(req);
  const user = auth?.user ?? null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip, error } = await sc
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();

  // `error || !trip` conflated two different facts and reported both as the
  // same sentence: an unreadable `trips` told an unauthenticated deep-link
  // visitor (and a MEMBER) that the trip does not exist. Absent is an answer;
  // unreadable is not.
  if (error) throw readUnavailable("trips", error);
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const t = trip as any;

  // §6.1 canViewTrip decides the whole §6.3 ladder — block first (blocking
  // overrides membership), then crew/owner, then public / buddies / private.
  // The route only RENDERS the decision. Two renderings are deliberate:
  //
  //   TRIP_AUTH_BLOCKED   → 404 "Trip not found", with NO reason on the wire.
  //                         The policy says why; the client must not be told,
  //                         because "you are blocked" reveals the block.
  //                         sendTripRefusal would throw on this reason, so it
  //                         goes through plain sendError on purpose.
  //   TRIP_PRIVACY_*      → the LockedTripPreview sentinel deep-link handlers
  //                         expect (200, `locked: true`, nothing else about the
  //                         trip), now carrying the Appendix B reason.
  const view = await canViewTrip(sc, { userId: user?.id ?? null }, tripId, { trip: t });

  if (!view.allowed && view.reason === "TRIP_AUTH_BLOCKED") {
    sendError(res, "not_found", "Trip not found");
    return;
  }

  // Helper: fetch the viewer's pending join-request status (fail-open).
  const getJoinRequestStatus = async (): Promise<string | null> => {
    if (!user) return null;
    try {
      const { data: jr } = await sc
        .from("trip_join_requests")
        .select("status")
        .eq("trip_id", tripId)
        .eq("user_id", user.id)
        .maybeSingle();
      return (jr as any)?.status ?? null;
    } catch { return null; }
  };

  if (view.allowed && view.view === "authorized") {
    // Members / owner always get the full authorized view regardless of visibility.
    res.json(toAuthorizedTripView(t));
    return;
  }
  if (view.allowed) {
    // public, or buddies with a mutual follow: the stripped shape.
    res.json(toPrivateTripPreview(t, await getJoinRequestStatus()));
    return;
  }

  // All other cases (invite/private, not a member, not a mutual buddy):
  // return a LockedTripPreview sentinel so deep-link handlers can render a
  // private-wall screen rather than a generic "not found" error.
  // No title, destination, dates, or member information is included.
  res.status(200).json({ locked: true, tripId, reason: view.reason });
});

export default router;
