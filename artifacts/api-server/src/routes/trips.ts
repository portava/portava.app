import { Router } from "express";
import { isBlockedBetween } from "../lib/blockGuard.js";
import { computeTripStatus } from "../lib/tripStatus.js";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient, isServiceClientReady } from "../lib/supabase";
import { detectAndStoreLanguage, invalidateContentTranslations } from "../services/contentTranslation.js";
import { requireUser, isAcceptedTripMember, requireTripMember, sendError, canEditPlanItem, canEditPlan, type PlanEditPermission } from "../lib/http.js";
import { toCamel } from "./plan.js";
import { syncTripChatMembers } from "../lib/chatSync.js";
import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { awardStamp, type StampLogger } from "../services/passport/StampAwardEngine.js";
import { nameVisibilitySet, sanitizeIdentity, nameVisibleFor } from "../lib/publicIdentity";
import { truncateDisplayName } from "../lib/displayName.js";

const router = Router();

/**
 * Explicit column list for all trip selects.
 * Intentionally avoids SELECT * so new internal columns (e.g. internal_notes,
 * moderation_status) never accidentally reach clients.
 */
const TRIP_COLUMNS =
  "id, owner_id, title, destination_city, destination_country, destination_lat, " +
  "destination_lng, destination_place_id, start_date, end_date, status, visibility, " +
  "cover_url, cover_media_type, trip_type, timezone, travel_style, open_to_meet, trip_notes, " +
  "show_on_profile, show_in_discovery, allow_friend_suggestions, allow_trip_crew_invites, " +
  "allow_join_requests, show_exact_dates, show_destination_city, delayed_posting_default, " +
  "precise_location_visible, plan_edit_permission, progress, created_at, updated_at";


// ── Trip-completion stamp awards ──────────────────────────────────────────────
// Called fire-and-forget (non-fatal) when a trip transitions → "completed".
//
// Every award routes through POST /stamps/award (internal HTTP endpoint) so the
// endpoint is exercised by a real server-side trigger.  If INTERNAL_API_SECRET
// is not set (local dev without the env var) we fall back to calling awardStamp()
// directly — stamps still work, only the HTTP path is skipped.
//
// awardStamp() / the endpoint are fully idempotent via
// (userId:definitionId:sourceType:sourceId) key, so re-runs are safe.

async function callInternalStampAward(
  input: {
    userId: string;
    definitionSlug: string;
    sourceType: string;
    sourceId: string;
    city?: string;
    country?: string;
  },
  sc: SupabaseClient,
): Promise<void> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    // Env var not configured (e.g. local dev) — fall back to direct engine call
    await awardStamp(sc, input);
    return;
  }
  const port = process.env.PORT ?? "8080";
  await fetch(`http://localhost:${port}/api/stamps/award`, {
    method:  "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Internal-Secret": secret,
    },
    body: JSON.stringify(input),
  });
  // Non-fatal: HTTP errors are intentionally swallowed here — the caller uses
  // Promise.allSettled, so any individual failure does not block others.
}

async function awardTripCompletionStamps(
  sc: SupabaseClient,
  tripId: string,
  ownerId: string,
  trip: Record<string, any>,
  log?: StampLogger,
): Promise<void> {
  // Only accepted participants earn completion stamps — exclude pending invitees.
  const { data: membersData } = await sc
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member"]);

  const memberIds: string[] = (membersData ?? []).map((m: any) => m.user_id as string);
  if (!memberIds.includes(ownerId)) memberIds.push(ownerId);
  const memberCount = memberIds.length;

  const city: string | undefined    = trip["destination_city"]    ?? undefined;
  const country: string | undefined = trip["destination_country"] ?? undefined;
  const startDate: string | undefined = trip["start_date"] ?? undefined;
  const endDate:   string | undefined = trip["end_date"]   ?? undefined;

  // Duration in full days (0 = same-day trip)
  let tripDays = 0;
  if (startDate && endDate) {
    const s = new Date(startDate + "T00:00:00Z");
    const e = new Date(endDate   + "T00:00:00Z");
    tripDays = Math.max(0, Math.round((e.getTime() - s.getTime()) / 86_400_000));
  }

  // Weekend trip: ≤3-day range that passes through at least one Sat (6) or Sun (0)
  let isWeekendTrip = false;
  if (tripDays <= 3 && startDate) {
    const s   = new Date(startDate + "T00:00:00Z");
    const end = endDate ? new Date(endDate + "T00:00:00Z") : new Date(s);
    for (const d = new Date(s); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { isWeekendTrip = true; break; }
    }
  }

  const awards: Array<{ userId: string; slug: string }> = [];

  // ── Per-member stamps ──────────────────────────────────────────────────────
  // Slugs use the v2 naming convention (first_trip_completed, weekend_wanderer,
  // solo_traveler, group_tripper) so they coexist cleanly with first_trip_created.
  for (const uid of memberIds) {
    awards.push({ userId: uid, slug: "first_trip_completed" });
    if (tripDays > 14)  awards.push({ userId: uid, slug: "long_haul" });
    if (isWeekendTrip)  awards.push({ userId: uid, slug: "weekend_wanderer" });
    if (country)        awards.push({ userId: uid, slug: "international_voyager" });
  }

  // ── Owner-only stamps ──────────────────────────────────────────────────────
  if (memberCount === 1) awards.push({ userId: ownerId, slug: "solo_traveler" });
  if (memberCount >= 3)  awards.push({ userId: ownerId, slug: "group_tripper" });
  // good_host: owner hosted a trip that completed with at least one other participant
  if (memberCount >= 2)  awards.push({ userId: ownerId, slug: "good_host" });

  // Milestone stamps — count owner's completed trips (patch has already committed)
  const { count: completedCount } = await sc
    .from("trips")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .eq("status", "completed");

  const n = completedCount ?? 0;
  if (n >= 5)  awards.push({ userId: ownerId, slug: "road_warrior" });
  if (n >= 10) awards.push({ userId: ownerId, slug: "frequent_flyer" });

  // ── Call awardStamp() directly to collect results, then batch notifications ─
  // Direct engine calls (not HTTP) so we get AwardResult back for notification logic.
  // awardStamp is idempotent via (user:def:sourceType:sourceId) key — re-runs are safe.
  const settled = await Promise.allSettled(
    awards.map(({ userId, slug }) =>
      awardStamp(sc, {
        userId,
        definitionSlug: slug,
        sourceType: "trips",
        sourceId: tripId,
        city,
        country,
      }, log).then((result) => ({ userId, slug, ...result })),
    ),
  );

  // Group awarded slugs by userId — send ONE notification per user, not one per stamp.
  const awardedByUser = new Map<string, string[]>();
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.awarded) {
      const { userId, slug } = r.value;
      if (!awardedByUser.has(userId)) awardedByUser.set(userId, []);
      awardedByUser.get(userId)!.push(slug);
    }
  }

  if (awardedByUser.size > 0) {
    const { NotificationService } = await import("../services/notifications/NotificationService.js");
    const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
    await Promise.allSettled(
      [...awardedByUser.entries()].map(async ([userId, slugs]) => {
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);
        const row = await notifSvc.create({
          userId,
          eventType:  "passport.stamp_earned",
          sourceType: "trips",
          sourceId:   tripId,
          params:     {
            location: city ?? country ?? "your trip",
            stamps:   slugs.join(","),
            count:    String(slugs.length),
          },
        });
        if (row) await notifRouter.route(row);
      }),
    );
  }
}

router.post("/trips", async (req, res) => {
  // requireUser does the readiness check, the header check and the JWT
  // verification — and, critically, the ban/suspend gate, which is enforced
  // NOWHERE else. Banning writes profiles.account_status and does not revoke
  // sessions, so a route that verifies the token itself lets a banned user keep
  // creating trips with the token they already hold.
  //
  // It verifies via Supabase Auth directly, which is what the old inline code
  // was for: it works regardless of whether PostgREST supports ECC P-256 JWT
  // verification.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // Trust Engine: check if user is restricted from hosting.
  // canHost=false means one of two different things, and they must never be
  // shown the same message: a real restriction, or a degraded read that
  // failed CLOSED as a precaution (the check itself could not be performed).
  // Labelling the latter as "restricted" tells a user something false about
  // their account. A degraded read that failed OPEN never reaches here at
  // all — canHost is true in that case, same as a clean allowed read.
  const trustState = await getRestrictionState(client, user.id);
  if (!trustState.canHost) {
    if (trustState.degradedReason === "fail_closed") {
      sendError(
        res,
        "degraded_unavailable",
        "We could not verify your permissions right now. Please try again shortly.",
      );
      return;
    }
    res.status(403).json({ error: "trust_restriction", message: "Your account is currently restricted from creating trips." });
    return;
  }

  const { title, destinationCity, destinationCountry, startDate, endDate, visibility, coverUrl, coverMediaType, coverImageWidth, coverImageHeight, tripNotes, showHeaderPublicly } = req.body;

  // Date conflict check — applies even when title/city are absent (draft support)
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    res.status(400).json({ error: "invalid_payload", message: "end_date must be ≥ start_date" });
    return;
  }

  // Status is server-authoritative — never accept client-supplied status on create.
  // Trips without title/city are saved as drafts.
  const computedStatus = computeTripStatus(title ?? null, destinationCity ?? null, startDate ?? null, endDate ?? null, "planning");

  const { data, error } = await client
    .from("trips")
    .insert({
      owner_id: user.id,
      title,
      destination_city: destinationCity,
      destination_country: destinationCountry ?? null,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
      status: computedStatus,
      visibility: visibility ?? "private",
      cover_url: coverUrl ?? null,
      cover_media_type: coverMediaType ?? null,
      cover_image_width: (coverImageWidth as number | null | undefined) ?? null,
      cover_image_height: (coverImageHeight as number | null | undefined) ?? null,
      trip_notes: tripNotes ?? null,
      // Public trips always show header publicly; respect client preference for private/buddies.
      show_header_publicly: typeof showHeaderPublicly === "boolean"
        ? showHeaderPublicly
        : (visibility ?? "private") === "public",
    })
    .select(TRIP_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert trip");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json(data);

  // Language detection — fire-and-forget; sets trips.original_language for translation.
  const newTripIdForLang = (data as any)?.id;
  if (newTripIdForLang && (title ?? '').trim()) {
    const _sc = getServiceClient();
    if (_sc) {
      const textToDetect = tripNotes ? `${title} ${tripNotes}` : title;
      detectAndStoreLanguage(_sc, 'trip', newTripIdForLang, textToDetect, req.log).catch(() => {});
    }
  }

  // Wire chat sync: ensure trip chat thread exists with the owner as first member.
  const newTripId = (data as any)?.id;
  if (newTripId) {
    syncTripChatMembers(newTripId, client).catch(() => {});
  }

  // Fire-and-forget: award first_trip_created + trip_planner stamps when a user creates
  // their first non-draft trip. Fully idempotent via awardStamp's (user:def:source) key.
  if (newTripId && computedStatus !== "draft") {
    void (async () => {
      try {
        const { NotificationService } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");

        const settled = await Promise.allSettled([
          awardStamp(client, {
            userId: user.id,
            definitionSlug: "first_trip_created",
            sourceType: "trips",
            sourceId: newTripId,
            city: destinationCity ?? undefined,
            country: destinationCountry ?? undefined,
          }).then((r) => ({ slug: "first_trip_created", ...r })),
          // trip_planner: awarded for creating and publishing any trip plan
          awardStamp(client, {
            userId: user.id,
            definitionSlug: "trip_planner",
            sourceType: "trips",
            sourceId: newTripId,
            city: destinationCity ?? undefined,
            country: destinationCountry ?? undefined,
          }).then((r) => ({ slug: "trip_planner", ...r })),
        ]);

        const awardedSlugs = settled
          .filter((r) => r.status === "fulfilled" && (r as any).value.awarded)
          .map((r) => (r as any).value.slug as string);

        if (awardedSlugs.length > 0) {
          const notifSvc    = new NotificationService(client);
          const notifRouter = new NotificationRouter(client);
          const row = await notifSvc.create({
            userId:     user.id,
            eventType:  "passport.stamp_earned",
            sourceType: "trips",
            sourceId:   newTripId,
            params: {
              location: destinationCity ?? destinationCountry ?? "your journey",
              stamps:   awardedSlugs.join(","),
              count:    String(awardedSlugs.length),
            },
          });
          if (row) await notifRouter.route(row);
        }
      } catch {}
    })();
  }
});

/* ===========================================================================
 * GET /trips/:tripId/members  — list accepted trip members (for invite picker)
 * ===========================================================================
 * Returns profiles of all accepted members (role = owner|member), excluding
 * the caller. Caller must be an accepted trip member themselves.
 */
router.get("/trips/:tripId/members", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const ok = await isAcceptedTripMember(client, tripId, user.id);
  if (!ok) { sendError(res, "forbidden", "Not a trip member"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error: rowsErr } = await sc
    .from("trip_members")
    .select("user_id, role")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member", "invited"]);

  if (rowsErr) { sendError(res, "db_error", rowsErr.message); return; }

  const memberIds = (rows ?? [])
    .filter((r: any) => r.role === "owner" || r.role === "member")
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id);

  const invitedIds = (rows ?? [])
    .filter((r: any) => r.role === "invited")
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id);

  const allIds = [...memberIds, ...invitedIds];
  if (allIds.length === 0) { res.status(200).json({ members: [], invited: [] }); return; }

  const [{ data: profiles, error: profErr }, { data: theyFollowMe }, { data: iFollowThem }] = await Promise.all([
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", allIds),
    sc.from("user_follows").select("follower_id").eq("following_id", user.id).in("follower_id", allIds),
    sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", allIds),
  ]);

  if (profErr) { sendError(res, "db_error", profErr.message); return; }

  const allowedNames = await nameVisibilitySet(sc, allIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);

  const followsYouSet = new Set<string>((theyFollowMe ?? []).map((r: any) => r.follower_id as string));
  const youFollowSet = new Set<string>((iFollowThem ?? []).map((r: any) => r.following_id as string));

  const toUser = (id: string) => {
    const p = profileMap[id];
    return {
      id,
      handle: (p?.handle as string) ?? "",
      name: (p?.name as string) ?? "",
      avatarUrl: (p?.avatar_url as string | null) ?? null,
      followsYou: followsYouSet.has(id),
      youFollow: youFollowSet.has(id),
    };
  };

  res.status(200).json({
    members: memberIds.map(toUser),
    invited: invitedIds.map(toUser),
  });
});

/* ===========================================================================
 * GET /trips/:tripId/invitable-users  — grouped invite picker data
 * ===========================================================================
 * Returns trip members (groupMembers) + caller's friends not in the trip
 * (otherFollowers), so the invite picker can render two labelled sections.
 * Caller must be an accepted trip member.
 */
router.get("/trips/:tripId/invitable-users", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  const [{ data: memberRows }, { data: friendsAsA }, { data: friendsAsB }, blockResult] = await Promise.all([
    sc.from("trip_members").select("user_id").eq("trip_id", tripId).in("role", ["owner", "member"]),
    sc.from("user_friendships").select("user_b").eq("user_a", user.id),
    sc.from("user_friendships").select("user_a").eq("user_b", user.id),
    sc.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`),
  ]);

  const blockedSet = new Set<string>();
  for (const b of (blockResult.data ?? [])) {
    if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
    else blockedSet.add((b as any).blocker_id);
  }

  const groupMemberIds = (memberRows ?? [])
    .map((r: any) => r.user_id as string)
    .filter((id) => id !== user.id && !blockedSet.has(id));

  const groupMemberSet = new Set(groupMemberIds);
  const otherFollowerIds = [
    ...(friendsAsA ?? []).map((r: any) => r.user_b as string),
    ...(friendsAsB ?? []).map((r: any) => r.user_a as string),
  ].filter((id) => id !== user.id && !groupMemberSet.has(id) && !blockedSet.has(id));

  const allIds = [...groupMemberIds, ...otherFollowerIds];
  const profileMap: Record<string, any> = {};
  if (allIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", allIds);
    const allowedNames = await nameVisibilitySet(sc, allIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);
  }

  const toUser = (id: string) => {
    const p = profileMap[id];
    if (!p) return null;
    return { id: p.id as string, handle: p.handle as string, name: p.name as string, avatarUrl: (p.avatar_url as string | null) ?? null };
  };

  res.status(200).json({
    groupMembers:   groupMemberIds.map(toUser).filter(Boolean),
    otherFollowers: [...new Set(otherFollowerIds)].map(toUser).filter(Boolean),
  });
});

/* ===========================================================================
 * GET /me/trip-invites/pending  — list pending trip invitations for the caller
 * ===========================================================================
 * Returns every trip_members row where role = 'invited' for the current user,
 * enriched with trip details (name, destination, dates) and inviter profile.
 */
router.get("/me/trip-invites/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Get all invited memberships for this user
  const { data: inviteRows, error: invErr } = await sc
    .from("trip_members")
    .select("trip_id, created_at")
    .eq("user_id", user.id)
    .eq("role", "invited");

  if (invErr) { sendError(res, "db_error", invErr.message); return; }
  if (!inviteRows || inviteRows.length === 0) {
    res.status(200).json({ invites: [] });
    return;
  }

  const tripIds = inviteRows.map((r: any) => r.trip_id as string);

  // Fetch trip details
  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, cover_media_type, owner_id, visibility, trip_type, show_exact_dates, show_destination_city")
    .in("id", tripIds);

  if (tripsErr) { sendError(res, "db_error", tripsErr.message); return; }

  const tripMap: Record<string, any> = {};
  for (const t of trips ?? []) tripMap[(t as any).id] = t;

  // Count accepted members per trip (for invite preview)
  const { data: memberCountData } = await sc
    .from("trip_members")
    .select("trip_id")
    .in("trip_id", tripIds)
    .in("role", ["owner", "member"]);

  const memberCountMap: Record<string, number> = {};
  for (const mr of memberCountData ?? []) {
    const tid = (mr as any).trip_id as string;
    memberCountMap[tid] = (memberCountMap[tid] ?? 0) + 1;
  }

  // Collect unique owner IDs to resolve inviter profiles
  const ownerIds = [...new Set((trips ?? []).map((t: any) => t.owner_id as string))];
  const profileMap: Record<string, any> = {};
  if (ownerIds.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", ownerIds);
    const allowedNames = await nameVisibilitySet(sc, ownerIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = sanitizeIdentity(p as any, allowedNames, user.id);
  }

  const invites = inviteRows
    .map((row: any) => {
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
        coverMediaType:     trip.cover_media_type ?? null,
        invitedAt:          row.created_at,
        visibility:         (trip.visibility as string) ?? null,
        memberCount:        memberCountMap[row.trip_id] ?? null,
        inviter: inviter ? {
          id:        inviter.id,
          name:      inviter.name,
          handle:    inviter.handle,
          avatarUrl: inviter.avatar_url ?? null,
        } : null,
      };
    })
    .filter(Boolean);

  res.status(200).json({ invites });
});

/* ===========================================================================
 * PATCH /trips/:tripId  — update trip plan-edit permission (owner only)
 * ===========================================================================
 * Accepts: { planEditPermission, planEditors? }
 * planEditors is the full replacement list of user IDs for specific_members mode.
 */
const PlanEditPermissionEnum = ["owner_only", "all_members", "specific_members"] as const;
const UUID_RE = /^[0-9a-f-]{36}$/i;

const TripStatusEnum = ["draft", "upcoming", "active", "planning", "completed", "cancelled", "archived"] as const;

const PatchTripSchema = z.object({
  // Plan edit settings
  planEditPermission: z.enum(PlanEditPermissionEnum).optional(),
  planEditors:        z.array(z.string().regex(UUID_RE)).optional(),
  // Status (server-authoritative via computeTripStatus)
  status:             z.enum(TripStatusEnum).optional(),
  // Core trip fields
  title:                   z.string().min(1).max(200).optional(),
  destinationCity:         z.string().max(100).optional(),
  destinationCountry:      z.string().max(100).nullable().optional(),
  destinationLat:          z.number().nullable().optional(),
  destinationLng:          z.number().nullable().optional(),
  destinationPlaceId:      z.string().nullable().optional(),
  startDate:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate:                 z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  visibility:              z.enum(["public", "private", "buddies", "invite"]).optional(),
  tripType:                z.string().optional(),
  timezone:                z.string().nullable().optional(),
  travelStyle:             z.string().nullable().optional(),
  openToMeet:              z.boolean().optional(),
  coverUrl:                z.string().url().nullable().optional(),
  coverMediaType:          z.enum(['image', 'video']).nullable().optional(),
  coverImageWidth:         z.number().int().positive().nullable().optional(),
  coverImageHeight:        z.number().int().positive().nullable().optional(),
  tripNotes:               z.string().nullable().optional(),
  showOnProfile:           z.boolean().optional(),
  showInDiscovery:         z.boolean().optional(),
  allowFriendSuggestions:  z.boolean().optional(),
  allowTripCrewInvites:    z.boolean().optional(),
  allowJoinRequests:       z.boolean().optional(),
  showExactDates:          z.boolean().optional(),
  showDestinationCity:     z.boolean().optional(),
  delayedPostingDefault:   z.boolean().optional(),
  preciseLocationVisible:  z.boolean().optional(),
  progress:                z.number().int().min(0).max(100).optional(),
  showHeaderPublicly:      z.boolean().optional(),
});

router.patch("/trips/:tripId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = PatchTripSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Only the trip owner may change trip settings
  const { data: trip } = await sc.from("trips").select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, plan_edit_permission").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const t = trip as any;
  if (t.owner_id !== user.id) { sendError(res, "forbidden", "Only the trip owner can update this trip"); return; }

  // Date conflict check across current + incoming values
  const newStart = b.startDate !== undefined ? b.startDate : (t.start_date ?? null);
  const newEnd   = b.endDate   !== undefined ? b.endDate   : (t.end_date   ?? null);
  if (newStart && newEnd && new Date(newStart) > new Date(newEnd)) {
    sendError(res, "invalid_payload", "end_date must be ≥ start_date"); return;
  }

  // Build the patch object — only include fields explicitly provided
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
  if (b.coverMediaType         !== undefined) patch.cover_media_type         = b.coverMediaType;
  if (b.coverImageWidth        !== undefined) patch.cover_image_width        = b.coverImageWidth;
  if (b.coverImageHeight       !== undefined) patch.cover_image_height       = b.coverImageHeight;
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
  if (b.progress               !== undefined) patch.progress                 = b.progress;
  if (b.showHeaderPublicly     !== undefined) patch.show_header_publicly     = b.showHeaderPublicly;

  // Compute server-authoritative status from effective field values
  const effectiveTitle = (b.title ?? t.title) as string | null;
  const effectiveCity  = (b.destinationCity ?? t.destination_city) as string | null;
  const effectiveStatus = b.status ?? t.status;
  patch.status = computeTripStatus(
    effectiveTitle,
    effectiveCity,
    newStart as string | null,
    newEnd as string | null,
    effectiveStatus,
    (b.timezone ?? t.timezone ?? null) as string | null,
  );

  const { data: updated, error: patchErr } = await sc
    .from("trips")
    .update(patch)
    .eq("id", tripId)
    .select(TRIP_COLUMNS)
    .single();

  if (patchErr) { sendError(res, "db_error", patchErr.message); return; }

  // Replace plan_editors list when provided (always a full replacement)
  if (b.planEditors !== undefined) {
    const { error: delErr } = await sc.from("plan_editors").delete().eq("trip_id", tripId);
    if (delErr) { sendError(res, "db_error", delErr.message); return; }
    if (b.planEditors.length > 0) {
      const { error: insErr } = await sc.from("plan_editors").insert(b.planEditors.map((uid) => ({ trip_id: tripId, user_id: uid })));
      if (insErr) { sendError(res, "db_error", insErr.message); return; }
    }
  }

  // Post-attendance review prompt — fire-and-forget when trip transitions to completed
  if (patch.status === "completed" && t.status !== "completed") {
    void (async () => {
      try {
        // Only accepted participants get the review prompt — exclude pending
        // invitees and removed members (mirrors awardTripCompletionStamps).
        const { data: members } = await sc
          .from("trip_members")
          .select("user_id")
          .eq("trip_id", tripId)
          .in("role", ["owner", "member"]);
        if (members && (members as any[]).length > 0) {
          const memberIds: string[] = (members as any[]).map((m: any) => m.user_id);
          const tripTitle: string = (updated as any)?.title ?? "your trip";
          // §20 ledger (TABLE 21): a COMPLETED trip is the verified moment for
          // `trip_crew_participation` — a positive event that adds to the
          // contributor level. It had no writer anywhere before 2026-09-05.
          // Same accepted-participant set as the review prompt (owner/member,
          // never a pending invitee), keyed on the trip so re-completing it
          // cannot double-credit.
          const { recordContributionIfEnabled } = await import(
            "../services/passport/PassportContributionService.js"
          );
          const crewCity: string | null = (updated as any)?.destination_city ?? null;
          await Promise.allSettled(
            memberIds.map((uid) =>
              recordContributionIfEnabled(sc, {
                userId: uid,
                eventType: "trip_crew_participation",
                sourceType: "trips",
                sourceId: tripId,
                verificationLevel: "crew",
                metadata: { city: crewCity, category: "trip" },
              }),
            ),
          );
          // Route through NotificationService so the privacy guard + dedup run.
          // notifRouter.route() is intentionally NOT called here; push is sent
          // below via sendPushWithRetry to avoid double-delivery.
          const { NotificationService } = await import("../services/notifications/NotificationService.js");
          const notifSvc = new NotificationService(sc);
          await Promise.allSettled(
            memberIds.map((uid) =>
              notifSvc.create({
                userId: uid,
                actorId: user.id,
                eventType: "trip.review_prompt",
                category: "trips",
                title: "How was the trip?",
                body: `Leave a review for "${tripTitle}" — your feedback helps the community.`,
                sourceType: "trips",
                sourceId: tripId,
                tripId,
                metadata: { entityType: "trip", entityId: tripId, entityName: tripTitle },
              }),
            ),
          );
          // Push tokens live on profiles.expo_push_token (notification_devices is empty)
          const { data: devices } = await sc.from("profiles").select("id, expo_push_token").in("id", memberIds);
          const tokensByUser = new Map<string, (string | null | undefined)[]>();
          for (const d of (devices as any[]) ?? []) {
            const uid = d.id as string;
            if (!tokensByUser.has(uid)) tokensByUser.set(uid, []);
            tokensByUser.get(uid)!.push(d.expo_push_token);
          }
          const recipients = [...tokensByUser.entries()].map(([userId, tokens]) => ({ userId, tokens }));
          if (recipients.length > 0) {
            await sendPushWithRetry(sc, recipients, {
              title: "How was the trip?",
              body: `Leave a review for "${tripTitle}" — your feedback helps the community.`,
              data: { type: "review_prompt", entityType: "trip", entityId: tripId, entityName: tripTitle },
            });
          }
        }
      } catch {}
    })();

    // Passport stamp awards — fire-and-forget, fully idempotent
    void awardTripCompletionStamps(sc, tripId, user.id, updated as Record<string, any>, req.log).catch(() => {});
  }

  // Translation: invalidate + re-detect when title/trip_notes change.
  if (b.title !== undefined || b.tripNotes !== undefined) {
    const scTx = getServiceClient();
    if (scTx) {
      invalidateContentTranslations(scTx, 'trip', tripId).catch(() => {});
      const textForDetect = [b.title ?? t.title, b.tripNotes ?? t.trip_notes]
        .filter(Boolean).join(' ');
      if (textForDetect.trim()) {
        detectAndStoreLanguage(scTx, 'trip', tripId, textForDetect, req.log).catch(() => {});
      }
    }
  }

  res.json(updated);
});


/* ===========================================================================
 * GET /trips/:tripId/plan-permission  — get current plan permission for caller
 * ===========================================================================
 * Returns { planEditPermission, planEditors, canEdit } for the calling user.
 */
router.get("/trips/:tripId/plan-permission", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "Not a trip member"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("owner_id, plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const perm    = ((trip as any).plan_edit_permission as PlanEditPermission) ?? "all_members";
  const ownerId = (trip as any).owner_id as string;

  const { data: editorRows } = await sc
    .from("plan_editors")
    .select("user_id")
    .eq("trip_id", tripId);

  const editorIds = (editorRows ?? []).map((r: any) => r.user_id as string);

  let canEdit = false;
  if (user.id === ownerId)           canEdit = true;
  else if (perm === "all_members")   canEdit = true;
  else if (perm === "owner_only")    canEdit = false;
  else canEdit = editorIds.includes(user.id);

  res.json({ planEditPermission: perm, planEditors: editorIds, canEdit, isOwner: user.id === ownerId });
});

/* ===========================================================================
 * POST /trips/:tripId/invite  — trip owner invites a user
 * ===========================================================================
 * Reuses the existing trip_members table with role='invited'.
 * Friendship alone NEVER creates this row — only explicit owner invitation.
 */
router.post("/trips/:tripId/invite", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "server_not_configured" });
    return;
  }
  // requireUser (lib/http.ts) is the ONLY place the ban/suspend gate is applied,
  // and there is no session revocation on ban — profiles.account_status is the
  // whole mechanism. Hand-rolling auth.getUser() here skipped it, so a banned
  // user kept full write access to this route.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const userId = req.body?.userId;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) { res.status(400).json({ error: "invalid_payload", message: "userId must be a valid UUID" }); return; }
  if (userId === user.id) { res.status(400).json({ error: "invalid_payload", message: "You cannot invite yourself" }); return; }

  // Only the trip owner may invite
  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { res.status(404).json({ error: "not_found", message: "Trip not found" }); return; }
  if ((trip as any).owner_id !== user.id) { res.status(403).json({ error: "forbidden", message: "Only the trip owner can invite members" }); return; }

  // Blocked-user guard: cannot invite a user with an active block in either
  // direction. Fail-closed shared helper — the previous .maybeSingle() raised on
  // the two-row mutual-block state and, with the error ignored, let the invite
  // through exactly when a mutual block existed. See lib/blockGuard.ts.
  if (await isBlockedBetween(client, user.id, userId)) {
    res.status(403).json({ error: "forbidden", message: "Cannot invite a blocked user" }); return;
  }

  // Idempotent: check existing membership
  const { data: existing } = await client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
  if (existing) { res.status(200).json({ status: "already_member", role: (existing as any).role, idempotent: true }); return; }

  const { error } = await client.from("trip_members").insert({ trip_id: tripId, user_id: userId, role: "invited" });
  if (error) { req.log.error({ err: error }, "trip invite: insert failed"); sendError(res, "db_error", error.message); return; }

  // Fire-and-forget: notify the invitee they've been invited.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const [{ data: tripRow }, { data: inviterRow }, { data: inviteeRow }] = await Promise.all([
        sc2.from("trips").select("title").eq("id", tripId).maybeSingle(),
        sc2.from("profiles").select("display_name, handle").eq("id", user.id).maybeSingle(),
        sc2.from("profiles").select("expo_push_token").eq("id", userId).maybeSingle(),
      ]);
      const tripTitle   = (tripRow as any)?.title   ?? "a trip";
      const inviterNameAllowed = await nameVisibleFor(sc2, user.id);
      const inviterName = truncateDisplayName(inviterNameAllowed
        ? ((inviterRow as any)?.display_name ?? ((inviterRow as any)?.handle ? `@${(inviterRow as any).handle}` : "Someone"))
        : ((inviterRow as any)?.handle ? `@${(inviterRow as any).handle}` : "Someone"));
      await sendPushWithRetry(sc2, { userId, tokens: [(inviteeRow as any)?.expo_push_token] }, {
        title: "Trip invitation",
        // Privacy: do not include the trip name or destination in the push body —
        // the invitee has not accepted yet and the content may be private.
        // Full details are available after the user opens the app.
        body:  "You received a trip invitation.",
        data:  { type: "trip_invite_received", tripId },
      });
      // In-app notification: store with generic text — no trip name in params.
      // notifRouter.route() is intentionally NOT called here; push was already
      // sent above via sendPushWithRetry to avoid double-delivery.
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const notifSvc = new NotificationService(sc2);
      await notifSvc.create({
        userId,
        eventType:  "trip.invite_received",
        sourceType: "trips",
        sourceId:   tripId,
        actorId:    user.id,
        // Privacy: params deliberately contain NO trip title or destination.
        params: { actor: inviterName, tripId },
      });
    } catch { /* best-effort */ }
  })();

  res.status(201).json({ status: "invited", tripId, userId });
});

/* ===========================================================================
 * POST /trips/:tripId/accept-invite  — invitee accepts their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/accept-invite", async (req, res) => {
  // requireUser (lib/http.ts) is the ONLY place the ban/suspend gate is applied,
  // and there is no session revocation on ban — profiles.account_status is the
  // whole mechanism. Hand-rolling auth.getUser() here skipped it, so a banned
  // user kept full write access to this route.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: `Already a ${(membership as any).role}` }); return; }

  const { error } = await client.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { req.log.error({ err: error }, "trip invite accept: update failed"); sendError(res, "db_error", error.message); return; }

  // Fire-and-forget: sync group chat membership for this trip.
  syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));

  // Fire-and-forget: notify trip owner their invite was accepted (#129).
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const { data: tripRow } = await sc2.from("trips").select("title, owner_id").eq("id", tripId).maybeSingle();
      if (!tripRow || (tripRow as any).owner_id === user.id) return; // skip if caller IS owner
      const [{ data: ownerRow }, { data: acceptorRow }] = await Promise.all([
        sc2.from("profiles").select("expo_push_token").eq("id", (tripRow as any).owner_id).maybeSingle(),
        sc2.from("profiles").select("display_name, handle").eq("id", user.id).maybeSingle(),
      ]);
      const acceptorNameAllowed = await nameVisibleFor(sc2, user.id);
      const acceptorName = truncateDisplayName(acceptorNameAllowed
        ? ((acceptorRow as any)?.display_name ?? ((acceptorRow as any)?.handle ? `@${(acceptorRow as any).handle}` : "Someone"))
        : ((acceptorRow as any)?.handle ? `@${(acceptorRow as any).handle}` : "Someone"));
      await sendPushWithRetry(sc2, { userId: (tripRow as any).owner_id as string, tokens: [(ownerRow as any)?.expo_push_token] }, {
        title: (tripRow as any).title ?? "Your trip",
        body: `${acceptorName} joined your trip!`,
        data: { type: "trip_invite_accepted", tripId },
      });
    } catch { /* best-effort */ }
  })();

  res.status(200).json({ status: "accepted", tripId, role: "member" });
});

/* ===========================================================================
 * POST /trips/:tripId/decline-invite  — invitee declines their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/decline-invite", async (req, res) => {
  // requireUser (lib/http.ts) is the ONLY place the ban/suspend gate is applied,
  // and there is no session revocation on ban — profiles.account_status is the
  // whole mechanism. Hand-rolling auth.getUser() here skipped it, so a banned
  // user kept full write access to this route.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: "Cannot decline — you are already a member" }); return; }

  const { error } = await client.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { req.log.error({ err: error }, "trip invite decline: delete failed"); sendError(res, "db_error", error.message); return; }

  // Fire-and-forget: notify trip owner that their invitation was declined.
  (async () => {
    try {
      const sc2 = getServiceClient();
      if (!sc2) return;
      const [{ data: tripRow }, { data: declinerRow }] = await Promise.all([
        sc2.from("trips").select("title, owner_id").eq("id", tripId).maybeSingle(),
        sc2.from("profiles").select("display_name, handle").eq("id", user.id).maybeSingle(),
      ]);
      const ownerId = (tripRow as any)?.owner_id as string | undefined;
      if (!ownerId || ownerId === user.id) return;
      const { data: ownerRow } = await sc2.from("profiles").select("expo_push_token").eq("id", ownerId).maybeSingle();
      const declinerNameAllowed = await nameVisibleFor(sc2, user.id);
      const declinerName = truncateDisplayName(declinerNameAllowed
        ? ((declinerRow as any)?.display_name ?? ((declinerRow as any)?.handle ? `@${(declinerRow as any).handle}` : "Someone"))
        : ((declinerRow as any)?.handle ? `@${(declinerRow as any).handle}` : "Someone"));
      await sendPushWithRetry(sc2, { userId: ownerId, tokens: [(ownerRow as any)?.expo_push_token] }, {
        title: "Invite declined",
        body:  `${declinerName} declined your invitation to ${(tripRow as any)?.title ?? "your trip"}`,
        data:  { type: "trip_invite_declined", tripId },
      });
    } catch { /* best-effort */ }
  })();

  res.status(200).json({ status: "declined", tripId });
});

/* ===========================================================================
 * GET /me/plan-editable-trips  — trips where caller has plan-edit permission
 * ===========================================================================
 * Returns only trips where the calling user can add/edit plan items.
 * Respects plan_edit_permission: owner_only | all_members | specific_members.
 */
router.get("/me/plan-editable-trips", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Get all trip memberships for this user (any accepted role — owner, member,
  // co_host, viewer). Must match the RLS trips_select policy and countUserTrips'
  // "not invited" definition, or accepted members with a co_host/viewer role
  // silently vanish from this picker even though they see the trip everywhere else.
  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id, role")
    .eq("user_id", user.id)
    .neq("role", "invited");

  if (memErr) { sendError(res, "db_error", memErr.message); return; }
  if (!memberRows || memberRows.length === 0) { res.json({ trips: [] }); return; }

  const tripIds = memberRows.map((r: any) => r.trip_id as string);

  // Fetch trip details including plan_edit_permission
  const { data: trips, error: tripsErr } = await sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, cover_media_type, owner_id, plan_edit_permission, trip_type, timezone, trip_notes, show_on_profile, show_in_discovery, allow_friend_suggestions, allow_trip_crew_invites, allow_join_requests, show_exact_dates, show_destination_city, delayed_posting_default, precise_location_visible, destination_lat, destination_lng, destination_place_id")
    .in("id", tripIds);

  if (tripsErr) { sendError(res, "db_error", tripsErr.message); return; }
  if (!trips || trips.length === 0) { res.json({ trips: [] }); return; }

  // Collect plan_editors for trips with specific_members permission
  const specificIds = trips
    .filter((t: any) => t.plan_edit_permission === "specific_members")
    .map((t: any) => t.id as string);

  const editorMap: Record<string, string[]> = {};
  if (specificIds.length > 0) {
    const { data: editorRows } = await sc
      .from("plan_editors")
      .select("trip_id, user_id")
      .in("trip_id", specificIds);
    for (const e of editorRows ?? []) {
      const eid = (e as any).trip_id as string;
      if (!editorMap[eid]) editorMap[eid] = [];
      editorMap[eid].push((e as any).user_id as string);
    }
  }

  const editable = (trips as any[]).filter((trip) => {
    if (trip.owner_id === user.id) return true;
    const perm: string = trip.plan_edit_permission ?? "all_members";
    if (perm === "all_members") return true;
    if (perm === "owner_only")  return false;
    return (editorMap[trip.id] ?? []).includes(user.id);
  });

  res.json({
    trips: editable.map((t: any) => ({
      id:                 t.id,
      title:              t.title,
      destinationCity:    t.destination_city,
      destinationCountry: t.destination_country ?? null,
      startDate:          t.start_date ?? null,
      endDate:            t.end_date ?? null,
      coverUrl:           t.cover_url ?? null,
      coverMediaType:     t.cover_media_type ?? null,
    })),
  });
});

// ── Zod schemas for plan items ────────────────────────────────────────────────

const UUID = /^[0-9a-f-]{36}$/i;

const CATEGORIES = ["accommodation","activity","dining","transport","free_time","meeting_point","other"] as const;
const STATUSES   = ["confirmed","tentative","done","cancelled"] as const;
const SOURCE_TYPES = ["manual","place","meetup"] as const;

const CreatePlanItemSchema = z.object({
  title:             z.string().min(1).max(200),
  category:          z.enum(CATEGORIES).default("activity"),
  status:            z.enum(STATUSES).default("tentative"),
  sourceType:        z.enum(SOURCE_TYPES).default("manual"),
  sourceId:          z.string().optional(),
  dayDate:           z.string().optional(),
  startsAt:          z.string().optional(),
  endsAt:            z.string().optional(),
  locationName:      z.string().max(300).optional(),
  lat:               z.number().nullable().optional(),
  lng:               z.number().nullable().optional(),
  locationIsPrivate: z.boolean().default(false),
  notes:             z.string().max(1000).optional(),
  sortOrder:         z.number().int().default(0),
  lockType:          z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

const UpdatePlanItemSchema = z.object({
  title:             z.string().min(1).max(200).optional(),
  category:          z.enum(CATEGORIES).optional(),
  status:            z.enum(STATUSES).optional(),
  dayDate:           z.string().nullable().optional(),
  startsAt:          z.string().nullable().optional(),
  endsAt:            z.string().nullable().optional(),
  locationName:      z.string().max(300).nullable().optional(),
  lat:               z.number().nullable().optional(),
  lng:               z.number().nullable().optional(),
  locationIsPrivate: z.boolean().optional(),
  notes:             z.string().max(1000).nullable().optional(),
  sortOrder:         z.number().int().optional(),
  lockType:          z.enum(["fixed", "flexible", "optional"]).optional(),
});

const ReorderSchema = z.object({
  sortOrder: z.number().int(),
});

// Optimize Today (§11) accepts a whole-day ordering, not one item at a time.
const ReorderBatchSchema = z.object({
  orderedItemIds: z.array(z.string().regex(UUID)).min(1).max(200),
});

// ── Conflict detection helper ─────────────────────────────────────────────────

function computeWarnings(
  items: any[],
  tripStartDate: string | null | undefined,
  tripEndDate: string | null | undefined,
  cancelledMeetupIds: Set<string> = new Set(),
): Map<string, string[]> {
  const warnMap = new Map<string, string[]>();
  for (const item of items) warnMap.set(item.id, []);

  // 1. Duplicate source_id across active items
  const sourceCount = new Map<string, number>();
  for (const item of items) {
    if (item.source_id) sourceCount.set(item.source_id, (sourceCount.get(item.source_id) ?? 0) + 1);
  }
  for (const item of items) {
    if (item.source_id && (sourceCount.get(item.source_id) ?? 0) > 1) {
      warnMap.get(item.id)!.push("duplicate");
    }
  }

  // 2. Time overlap: items on same day with truly overlapping time windows (not just start proximity)
  const byDay = new Map<string, any[]>();
  for (const item of items) {
    if (item.day_date && item.starts_at) {
      if (!byDay.has(item.day_date)) byDay.set(item.day_date, []);
      byDay.get(item.day_date)!.push(item);
    }
  }
  for (const dayItems of byDay.values()) {
    for (let i = 0; i < dayItems.length; i++) {
      for (let j = i + 1; j < dayItems.length; j++) {
        const a = dayItems[i], b = dayItems[j];
        const aStart = new Date(a.starts_at).getTime();
        const bStart = new Date(b.starts_at).getTime();
        // Default 1-hour duration when ends_at is absent
        const aEnd = a.ends_at ? new Date(a.ends_at).getTime() : aStart + 3_600_000;
        const bEnd = b.ends_at ? new Date(b.ends_at).getTime() : bStart + 3_600_000;
        if (aStart < bEnd && bStart < aEnd) {
          if (!warnMap.get(a.id)!.includes("time_overlap")) warnMap.get(a.id)!.push("time_overlap");
          if (!warnMap.get(b.id)!.includes("time_overlap")) warnMap.get(b.id)!.push("time_overlap");
        }
      }
    }
  }

  // 3. Outside trip dates
  if (tripStartDate && tripEndDate) {
    const start = new Date(tripStartDate + "T00:00:00Z").getTime();
    const end   = new Date(tripEndDate   + "T23:59:59Z").getTime();
    for (const item of items) {
      if (item.day_date) {
        const ms = new Date(item.day_date + "T00:00:00Z").getTime();
        if (ms < start || ms > end) warnMap.get(item.id)!.push("outside_trip_dates");
      }
    }
  }

  // 4. Unmapped location: has a location name but no coordinates (can't appear on map).
  //    An item with NO location info at all (no name, no coordinates) is not warned —
  //    the user simply hasn't set a location for it, which isn't a data problem.
  //    This is a distinct code from the old single "missing_location" warning: that
  //    warning previously fired whenever coordinates were absent regardless of whether
  //    a location name was known, producing a "No location" badge on items that clearly
  //    display a location name — a direct self-contradiction in the UI.
  for (const item of items) {
    const hasCoords = item.lat != null && item.lng != null;
    if (item.location_name && !hasCoords) {
      warnMap.get(item.id)!.push("unmapped_location");
    }
  }

  // 5. Cancelled source: meetup-sourced item from a cancelled meetup
  for (const item of items) {
    if (item.source_type === "meetup" && item.source_id && cancelledMeetupIds.has(item.source_id)) {
      warnMap.get(item.id)!.push("cancelled_source");
    }
  }

  return warnMap;
}

// ── GET /trips/:tripId/plan ───────────────────────────────────────────────────

router.get("/trips/:tripId/plan", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view the plan"); return; }

  // Fetch trip metadata (dates + plan permission)
  const { data: trip } = await client
    .from("trips")
    .select("start_date,end_date,owner_id,plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();
  const tripStartDate = (trip as any)?.start_date ?? null;
  const tripEndDate   = (trip as any)?.end_date   ?? null;

  // Resolve caller's edit permission for this trip
  const editAllowed = await canEditPlan(client, tripId, user.id);
  const canEdit = editAllowed === true;

  // perf-trim: explicit column list replaces SELECT * — only columns consumed by toCamel()
  // are fetched; removed_at is a filter (WHERE), not needed in the result set
  const { data, error } = await client
    .from("trip_plan_items")
    .select(
      "id, trip_id, creator_id, title, category, status, source_type, source_id, " +
      "day_date, starts_at, ends_at, location_name, notes, sort_order, visibility, " +
      "lock_type, location_is_private, lat, lng, created_at, updated_at",
    )
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false })
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true });

  if (error) { req.log.error({ err: error }, "get trip plan"); sendError(res, "db_error", error.message); return; }

  // Cast to any[] — explicit SELECT string causes Supabase TS to infer GenericStringError
  // for narrowed column sets; the DB-side trim is still in effect at runtime.
  const rows = (data as any[]) ?? [];

  // Fetch cancelled meetup IDs for cancelled_source advisory warning
  const meetupSourceIds = rows
    .filter((i) => i.source_type === "meetup" && i.source_id)
    .map((i) => i.source_id as string);
  const cancelledMeetupIds = new Set<string>();
  if (meetupSourceIds.length > 0) {
    const { data: meetups } = await client
      .from("meetups")
      .select("id, status")
      .in("id", meetupSourceIds);
    for (const m of (meetups ?? [])) {
      if ((m as any).status === "cancelled") cancelledMeetupIds.add(m.id);
    }
  }

  const warnMap = computeWarnings(rows, tripStartDate, tripEndDate, cancelledMeetupIds);

  res.json({
    items: rows.map((row) => toCamel(row, { warnings: warnMap.get(row.id) ?? [] })),
    canEdit,
  });
});

// ── GET /trips/:tripId/plan/map — only items with safe public coordinates ──────

router.get("/trips/:tripId/plan/map", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view the map"); return; }

  const { data, error } = await client
    .from("trip_plan_items")
    .select("*")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("sort_order", { ascending: true });

  if (error) { req.log.error({ err: error }, "get trip plan map"); sendError(res, "db_error", error.message); return; }

  // Only items with safe public coordinates
  const mapItems = (data ?? [])
    .filter((row) => !row.location_is_private && row.lat != null && row.lng != null)
    .map((row) => toCamel(row, {}));

  res.json({ items: mapItems });
});

// ── POST /trips/:tripId/plan/items ────────────────────────────────────────────

router.post("/trips/:tripId/plan/items", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to add plan items on this trip"); return; }

  const parsed = CreatePlanItemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Duplicate guard for sourced items
  if (b.sourceId) {
    const { data: dup } = await client
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", tripId)
      .eq("source_type", b.sourceType)
      .eq("source_id", b.sourceId)
      .is("removed_at", null)
      .maybeSingle();
    if (dup) { res.status(409).json({ error: "duplicate", message: "This item is already in the plan" }); return; }
  }

  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id:             tripId,
      creator_id:          user.id,   // always from token
      title:               b.title,
      category:            b.category,
      status:              b.status,
      source_type:         b.sourceType,
      source_id:           b.sourceId ?? null,
      day_date:            b.dayDate ?? null,
      starts_at:           b.startsAt ?? null,
      ends_at:             b.endsAt ?? null,
      location_name:       b.locationName ?? null,
      lat:                 b.lat ?? null,
      lng:                 b.lng ?? null,
      location_is_private: b.locationIsPrivate ?? false,
      notes:               b.notes ?? null,
      sort_order:          b.sortOrder,
      lock_type:           b.lockType,
      visibility:          "members",
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create plan item"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
});

// ── PATCH /trips/:tripId/plan/items/:itemId ───────────────────────────────────

router.patch("/trips/:tripId/plan/items/:itemId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const parsed = UpdatePlanItemSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const patch = parsed.data;

  // Check trip-level plan edit permission first
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  const dbPatch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.title             !== undefined) dbPatch.title               = patch.title;
  if (patch.category          !== undefined) dbPatch.category            = patch.category;
  if (patch.status            !== undefined) dbPatch.status              = patch.status;
  if (patch.dayDate           !== undefined) dbPatch.day_date            = patch.dayDate;
  if (patch.lockType          !== undefined) dbPatch.lock_type           = patch.lockType;
  if (patch.startsAt          !== undefined) dbPatch.starts_at           = patch.startsAt;
  if (patch.endsAt            !== undefined) dbPatch.ends_at             = patch.endsAt;
  if (patch.locationName      !== undefined) dbPatch.location_name       = patch.locationName;
  if (patch.lat               !== undefined) dbPatch.lat                 = patch.lat;
  if (patch.lng               !== undefined) dbPatch.lng                 = patch.lng;
  if (patch.locationIsPrivate !== undefined) dbPatch.location_is_private = patch.locationIsPrivate;
  if (patch.notes             !== undefined) dbPatch.notes               = patch.notes;
  if (patch.sortOrder         !== undefined) dbPatch.sort_order          = patch.sortOrder;

  const { data: updated, error } = await client
    .from("trip_plan_items")
    .update(dbPatch)
    .eq("id", itemId)
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "update plan item"); sendError(res, "db_error", error.message); return; }

  res.json(toCamel(updated));
});

// ── PATCH /trips/:tripId/plan/items/:itemId/remove — soft-delete ──────────────

router.patch("/trips/:tripId/plan/items/:itemId/remove", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  // Soft-delete only — source record is NOT deleted
  const { error } = await client
    .from("trip_plan_items")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", itemId);

  if (error) { req.log.error({ err: error }, "remove plan item"); sendError(res, "db_error", error.message); return; }

  res.json({ status: "removed", itemId });
});

// ── DELETE /trips/:tripId/plan/items/:itemId — REST soft-delete ───────────────

router.delete("/trips/:tripId/plan/items/:itemId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You do not have permission to edit plan items on this trip"); return; }

  const auth = await canEditPlanItem(client, tripId, itemId, user.id);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  const { error } = await client
    .from("trip_plan_items")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", itemId);

  if (error) { req.log.error({ err: error }, "delete plan item"); sendError(res, "db_error", error.message); return; }

  res.status(204).send();
});

// ── POST /trips/:tripId/plan/items/:itemId/reorder — plan-edit permission ─────

/* ===========================================================================
 * POST /trips/:tripId/members  — owner directly adds a user as a member
 * ===========================================================================
 * Body: { userId: string, role?: "member" | "invited" }
 * Only the trip owner may call this. Idempotent if the user already has the
 * requested role.
 */
router.post("/trips/:tripId/members", async (req, res) => {
  // requireUser (lib/http.ts) is the ONLY place the ban/suspend gate is applied,
  // and there is no session revocation on ban — profiles.account_status is the
  // whole mechanism. Hand-rolling auth.getUser() here skipped it, so a banned
  // user kept full write access to this route.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { userId, role = "member" } = req.body ?? {};
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) { res.status(400).json({ error: "invalid_payload", message: "userId must be a valid UUID" }); return; }
  if (role !== "member" && role !== "invited") { res.status(400).json({ error: "invalid_payload", message: "role must be 'member' or 'invited'" }); return; }
  if (userId === user.id) { res.status(400).json({ error: "invalid_payload", message: "Cannot add yourself" }); return; }

  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { res.status(404).json({ error: "not_found", message: "Trip not found" }); return; }
  if ((trip as any).owner_id !== user.id) { res.status(403).json({ error: "forbidden", message: "Only the trip owner can add members" }); return; }

  const { data: existing } = await client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
  if (existing && (existing as any).role === role) { res.status(200).json({ status: "already_member", role, idempotent: true }); return; }

  if (existing) {
    const { error } = await client.from("trip_members").update({ role }).eq("trip_id", tripId).eq("user_id", userId);
    if (error) { req.log.error({ err: error }, "trip member role update failed"); sendError(res, "db_error", error.message); return; }
    syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));
    res.status(200).json({ status: "updated", tripId, userId, role });
    return;
  }

  const { error } = await client.from("trip_members").insert({ trip_id: tripId, user_id: userId, role });
  if (error) { req.log.error({ err: error }, "trip member add: insert failed"); sendError(res, "db_error", error.message); return; }

  syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));

  res.status(201).json({ status: "added", tripId, userId, role });
});

/* ===========================================================================
 * DELETE /trips/:tripId/members/:userId  — owner removes a member from a trip
 * ===========================================================================
 * Only the trip owner may call this. The owner cannot remove themselves.
 */
router.delete("/trips/:tripId/members/:userId", async (req, res) => {
  // requireUser (lib/http.ts) is the ONLY place the ban/suspend gate is applied,
  // and there is no session revocation on ban — profiles.account_status is the
  // whole mechanism. Hand-rolling auth.getUser() here skipped it, so a banned
  // user kept full write access to this route.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId, userId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid user id" }); return; }

  if (userId === user.id) { res.status(400).json({ error: "invalid_payload", message: "Cannot remove yourself" }); return; }

  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { res.status(404).json({ error: "not_found", message: "Trip not found" }); return; }
  if ((trip as any).owner_id !== user.id) { res.status(403).json({ error: "forbidden", message: "Only the trip owner can remove members" }); return; }

  const { data: memberRow } = await client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
  if (!memberRow) { res.status(404).json({ error: "not_found", message: "Member not found on this trip" }); return; }
  if ((memberRow as any).role === "owner") { res.status(400).json({ error: "invalid_payload", message: "Cannot remove the trip owner" }); return; }

  const { error } = await client.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", userId);
  if (error) { req.log.error({ err: error }, "trip member remove: delete failed"); sendError(res, "db_error", error.message); return; }

  syncTripChatMembers(tripId, client).catch((e) => req.log?.error({ err: e }, "syncTripChatMembers failed"));

  const { revokeAccessForMember } = await import("../services/tripCrew/TripCrewLiveShareService.js");
  revokeAccessForMember(client, tripId, userId).catch((e: unknown) => req.log?.error({ err: e }, "revokeAccessForMember failed"));

  res.status(200).json({ status: "removed", tripId, userId });
});

router.post("/trips/:tripId/plan/items/:itemId/reorder", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId, itemId } = req.params;
  if (!UUID.test(tripId) || !UUID.test(itemId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const parsed = ReorderSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "sortOrder must be an integer"); return; }

  // Reorder is owner-only: any accepted member can view/add/edit, but only
  // the trip owner may change the global sort order.
  const auth = await canEditPlanItem(client, tripId, itemId, user.id, true);
  if (!auth.permitted) { sendError(res, auth.code, auth.message); return; }

  const { data: updated, error } = await client
    .from("trip_plan_items")
    .update({ sort_order: parsed.data.sortOrder, updated_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .select("id")
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "reorder plan item"); sendError(res, "db_error", error.message); return; }
  if (!updated) { sendError(res, "not_found", "Plan item not found in this trip"); return; }

  res.json({ status: "reordered", itemId, sortOrder: parsed.data.sortOrder });
});

// ── POST /trips/:tripId/plan/reorder — batch reorder (owner-only) ──────────────
//
// Optimize Today (§11) accepts a whole-day re-ordering, not one item at a time.
// This is the Trips write path that acceptance persists through, so the Trip Map
// is never left claiming a reorder it never saved. Like the single-item reorder,
// it is OWNER-ONLY: only the trip owner may change the global sort order.
//
// SLOT-PRESERVING. The provided ids are reassigned only among the sort_order
// SLOTS they already collectively occupy (their current sort_order values, sorted
// ascending and re-paired to the accepted order). Plan items NOT in the list —
// other days, unmapped or private items — keep their exact sort_order, so
// accepting a map reorder never silently moves a stop the user did not see on the
// map. §11: "the map should not silently rewrite the canonical Trip."
router.post("/trips/:tripId/plan/reorder", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = ReorderBatchSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "orderedItemIds must be a non-empty array of item ids"); return; }
  const orderedItemIds = parsed.data.orderedItemIds;
  if (new Set(orderedItemIds).size !== orderedItemIds.length) {
    sendError(res, "invalid_payload", "orderedItemIds must not contain duplicates"); return;
  }

  // Owner-only (matches the single-item reorder): the global sort order is the
  // trip owner's prerogative, not any accepted member's.
  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  if ((trip as { owner_id: string }).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can reorder plan items"); return;
  }

  // Current sort_order of exactly the requested items, scoped to this trip and
  // excluding soft-deleted rows.
  const { data: rows, error: readErr } = await client
    .from("trip_plan_items")
    .select("id, sort_order")
    .in("id", orderedItemIds)
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (readErr) { req.log.error({ err: readErr }, "reorder batch read"); sendError(res, "db_error", readErr.message); return; }

  const found = new Map(
    (rows ?? []).map((r) => [(r as { id: string }).id, (r as { sort_order: number }).sort_order] as const),
  );
  // Every id must belong to this trip and still be live — refuse to reorder a set
  // that references an item from another trip or a removed one.
  const missing = orderedItemIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    sendError(res, "invalid_payload", "One or more items are not live plan items on this trip"); return;
  }

  // The slots these items collectively hold, ascending, re-paired to the accepted
  // order. Items outside the list keep their slots untouched.
  const slots = orderedItemIds.map((id) => found.get(id) as number).sort((a, b) => a - b);

  const updates: Array<{ itemId: string; sortOrder: number }> = [];
  const stamp = new Date().toISOString();
  for (let i = 0; i < orderedItemIds.length; i += 1) {
    const itemId = orderedItemIds[i];
    const nextSort = slots[i];
    if (found.get(itemId) === nextSort) continue; // already in place — no write
    const { error: upErr } = await client
      .from("trip_plan_items")
      .update({ sort_order: nextSort, updated_at: stamp })
      .eq("id", itemId)
      .eq("trip_id", tripId);
    if (upErr) { req.log.error({ err: upErr }, "reorder batch update"); sendError(res, "db_error", upErr.message); return; }
    updates.push({ itemId, sortOrder: nextSort });
  }

  res.json({ status: "reordered", count: updates.length, order: orderedItemIds });
});

export default router;
