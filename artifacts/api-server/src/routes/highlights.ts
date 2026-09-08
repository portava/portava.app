import { Router } from "express";
import type { Response } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { canViewHighlight, type HighlightVisibility, type HighlightRecord } from "../lib/highlightPermissions";
import { canMessage } from "../lib/messagingPermissions";
import { isFlagEnabled } from "../lib/featureFlags";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

/* ============================================================================
 * Trip membership — the definition of record, not a local approximation.
 *
 * Every trip_only read on this surface used to compute "shares a trip" as
 *
 *     trip_members WHERE role IN ('owner','member')      -- and nothing else
 *
 * on BOTH sides of the join. That is not what the API means by a trip member.
 * lib/http.ts requireTripMember (the definition of record, http.ts:430-478)
 * accepts a viewer when a trip_members row exists with
 *     role IN ('owner','co_host','member','viewer')
 *     AND (status IS NULL OR status = 'accepted')
 * and, when NO row exists, when trips.owner_id is the viewer. trip_members
 * encodes "pending" in TWO columns — the legacy role='invited' and the current
 * status='invited' — so a predicate reading only one of them is defective.
 *
 * The old predicate therefore ran wrong in both directions at once:
 *   FAIL-OPEN   role='member', status='invited' (a PENDING invitee) and
 *               role='member', status='removed' (REMOVED from the trip) both
 *               passed, so they read the trip_only highlights of everyone on a
 *               trip they had not joined or had been removed from.
 *   FAIL-CLOSED co_host and viewer are accepted crew everywhere else and were
 *               omitted; a trip owner holding no trip_members row was omitted.
 *
 * Migration 2337 measured the same defect in the RLS policy behind this table
 * (highlights_select_active) and built authz.shares_accepted_trip(uuid) for it;
 * migration 2530 applies it. This is the app-side half of that fix, and it is
 * the ONLY place on this surface that decides trip membership.
 *
 * FAIL CLOSED. supabase-js RESOLVES on a database error, so an unchecked
 * `.data` reads as an empty result. Every read here checks `.error` and
 * returns { ok: false }; callers then withhold every trip_only highlight rather
 * than serving one on the strength of a lookup that did not happen. That is the
 * same answer a genuine "not shared" produces, so the response shape is
 * unchanged — only the log line distinguishes them.
 * ============================================================================ */
const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

function isAcceptedMembershipRow(r: { role?: string | null; status?: string | null }): boolean {
  if (!r.role || !ACCEPTED_TRIP_ROLES.has(r.role)) return false;
  return r.status == null || r.status === "accepted";
}

type SharesTripResult =
  | { ok: true; shared: Set<string> }
  | { ok: false; error: unknown };

/**
 * Which of `ownerIds` are accepted crew of a trip that `viewerId` is ALSO
 * accepted crew of, by requireTripMember's rule applied to BOTH people.
 * Four reads, each `.error`-checked: the viewer's membership rows and owned
 * trips (to derive the viewer's accepted trips, owner fallback included), then
 * the owners' rows and ownerships on exactly those trips.
 */
async function sharesAcceptedTrip(
  sc: SupabaseClient,
  viewerId: string,
  ownerIds: string[],
): Promise<SharesTripResult> {
  const shared = new Set<string>();
  const others = [...new Set(ownerIds.filter((id) => id && id !== viewerId))];
  if (others.length === 0) return { ok: true, shared };

  const [viewerRows, viewerOwned] = await Promise.all([
    sc.from("trip_members").select("trip_id, role, status").eq("user_id", viewerId),
    sc.from("trips").select("id").eq("owner_id", viewerId),
  ]);
  if (viewerRows.error) return { ok: false, error: viewerRows.error };
  if (viewerOwned.error) return { ok: false, error: viewerOwned.error };

  // requireTripMember consults the row when one exists and falls back to
  // trips.owner_id ONLY when none does — an owner whose own row says
  // status='removed' is denied. Same shape here.
  const viewerRowTrips = new Set<string>();
  const viewerTrips = new Set<string>();
  for (const r of (viewerRows.data ?? []) as any[]) {
    viewerRowTrips.add(r.trip_id as string);
    if (isAcceptedMembershipRow(r)) viewerTrips.add(r.trip_id as string);
  }
  for (const t of (viewerOwned.data ?? []) as any[]) {
    if (!viewerRowTrips.has(t.id as string)) viewerTrips.add(t.id as string);
  }
  if (viewerTrips.size === 0) return { ok: true, shared };
  const tripIds = [...viewerTrips];

  const [ownerRows, ownerOwned] = await Promise.all([
    sc.from("trip_members").select("trip_id, user_id, role, status").in("trip_id", tripIds).in("user_id", others),
    sc.from("trips").select("id, owner_id").in("id", tripIds).in("owner_id", others),
  ]);
  if (ownerRows.error) return { ok: false, error: ownerRows.error };
  if (ownerOwned.error) return { ok: false, error: ownerOwned.error };

  const ownerRowKeys = new Set<string>();
  for (const r of (ownerRows.data ?? []) as any[]) {
    ownerRowKeys.add(`${r.trip_id}:${r.user_id}`);
    if (isAcceptedMembershipRow(r)) shared.add(r.user_id as string);
  }
  for (const t of (ownerOwned.data ?? []) as any[]) {
    if (!ownerRowKeys.has(`${t.id}:${t.owner_id}`)) shared.add(t.owner_id as string);
  }
  return { ok: true, shared };
}

/**
 * The accepted crew of one trip, by the same rule: accepted rows plus the
 * trips.owner_id fallback when the owner holds no row. Used only to scope the
 * `?tripId=` filter on /highlights/active; the per-highlight permission check
 * still runs on top of it.
 */
async function acceptedMemberIdsOfTrip(
  sc: SupabaseClient,
  tripId: string,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: unknown }> {
  const [rows, trip] = await Promise.all([
    sc.from("trip_members").select("user_id, role, status").eq("trip_id", tripId),
    sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
  ]);
  if (rows.error) return { ok: false, error: rows.error };
  if (trip.error) return { ok: false, error: trip.error };
  const ids = new Set<string>();
  const rowUsers = new Set<string>();
  for (const r of (rows.data ?? []) as any[]) {
    rowUsers.add(r.user_id as string);
    if (isAcceptedMembershipRow(r)) ids.add(r.user_id as string);
  }
  const ownerId = (trip.data as any)?.owner_id as string | null | undefined;
  if (ownerId && !rowUsers.has(ownerId)) ids.add(ownerId);
  return { ok: true, ids };
}

/* ============================================================================
 * Internal helper — resolve whether viewerId can access highlightId.
 * Checks blocks, loads highlight, resolves circle/trip membership, and calls
 * canViewHighlight. Returns null + sends the error response on failure.
 * ============================================================================ */
async function resolveViewAccess(
  sc: SupabaseClient,
  viewerId: string,
  highlightId: string,
  res: Response,
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<{ h: HighlightRecord } | null> {
  // An unreadable `highlights` table is NOT a missing highlight. supabase-js
  // RESOLVES on a DB error, so `const { data: h }` bound null and this helper —
  // the gate in front of view, like, unlike, reply and report — answered a table
  // outage with "Highlight not found". That is not a permission verdict and it
  // discloses nothing to say so: we do not know whether the row exists, so
  // db_error is both the honest answer and the safe one. §28.11.
  const { data: h, error: hErr } = await sc
    .from("highlights")
    .select("id, owner_id, visibility, expires_at, deleted_at")
    .eq("id", highlightId)
    .maybeSingle();

  if (hErr) {
    log?.error({ err: hErr, highlightId }, "highlights: highlight read failed — cannot resolve access");
    sendError(res, "db_error", hErr.message);
    return null;
  }
  if (!h) {
    sendError(res, "not_found", "Highlight not found");
    return null;
  }

  const record = h as HighlightRecord;
  const ownerId = record.owner_id;

  // Block check (both directions). FAIL CLOSED.
  //
  // supabase-js RESOLVES rather than throws on a DB error, so `.data` is null on
  // a failed query and the old `if (blockedByMe.data || blockingMe.data)` read a
  // blocks-table failure as "these two users are not blocked" — the highlight,
  // and every engagement action gated by this helper, was served. That is the
  // MEM·M6 defect that routes/memories.ts fixed on the memories surface
  // (isBlocked() there returns true on either error); the highlights surface
  // never got the same treatment, in this helper or in the three feed routes.
  // Spec §10: "blocking and account deletion must suppress future social
  // resurfacing"; §28.11: never swallow a failure into a plausible-looking
  // permissive answer.
  if (viewerId !== ownerId) {
    const [blockedByMe, blockingMe] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId).eq("blocked_id", ownerId).maybeSingle(),
      sc.from("blocks").select("blocker_id").eq("blocker_id", ownerId).eq("blocked_id", viewerId).maybeSingle(),
    ]);
    if (blockedByMe.error || blockingMe.error || blockedByMe.data || blockingMe.data) {
      sendError(res, "not_found", "Highlight not found");
      return null;
    }
  }

  // Resolve circle/trip membership when needed
  let viewerFollowsOwner = viewerId === ownerId;
  let sharesTrip = viewerId === ownerId;

  if (viewerId !== ownerId && record.visibility === "circle_only") {
    // `Boolean(circleMember.data)` read a resolved DB error as "not in the
    // circle". The deny is right — withholding is the safe answer — but nothing
    // could tell it apart from a real one, which is the entry this site carries
    // on the unchecked-reads ledger. Same treatment as the trip_only branch
    // below: withhold, and say why.
    const circleMember = await sc
      .from("circle_memberships").select("other_id").eq("user_id", ownerId).eq("other_id", viewerId).maybeSingle();
    if (circleMember.error) {
      log?.error({ err: circleMember.error, highlightId }, "highlights: circle membership lookup failed — withholding circle_only highlight");
      viewerFollowsOwner = false;
    } else {
      viewerFollowsOwner = Boolean(circleMember.data);
    }
  }

  if (viewerId !== ownerId && record.visibility === "trip_only") {
    const shares = await sharesAcceptedTrip(sc, viewerId, [ownerId]);
    if (shares.ok) {
      sharesTrip = shares.shared.has(ownerId);
    } else {
      // Withhold: sharesTrip stays false and the highlight reads as not found.
      log?.error({ err: shares.error, highlightId }, "highlights: trip membership lookup failed — withholding trip_only highlight");
    }
  }

  if (!canViewHighlight(viewerId, record, { viewerFollowsOwner, sharesTrip })) {
    sendError(res, "not_found", "Highlight not found");
    return null;
  }

  return { h: record };
}

/**
 * §12 finiteness bounds for GET /highlights/following-feed, engaged only when
 * `highlights_feed_bounded_enabled` is on (migration 2339). 60 is a page of
 * highlights, not a policy about how many Highlights a person may have.
 */
const FOLLOWING_FEED_DEFAULT_LIMIT = 60;
const FOLLOWING_FEED_MAX_LIMIT = 200;

const EXPIRY_HOURS = [3, 6, 12, 24, 48] as const;
const MAX_VIDEO_DURATION_SECONDS = 10;

const KNOWN_FILTER_IDS = [
  'original', 'wanderlust', 'golden_hour', 'deep_ocean', 'mist', 'polaroid',
  'noir', 'safari', 'vivid', 'sunset', 'arctic', 'velvet',
] as const;

const createHighlightSchema = z.object({
  mediaUrl: z.string().min(1, "media_url is required"),
  mediaType: z.string().min(1),
  videoDurationSeconds: z.number().nullable().optional(),
  caption: z.string().max(500).nullable().optional(),
  locationName: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(100).nullable().optional(),
  locationCountry: z.string().max(100).nullable().optional(),
  visibility: z
    .enum(["public", "travelers_nearby", "circle_only", "trip_only", "private"])
    .default("public"),
  expiresInHours: z.number().int().refine((h) => EXPIRY_HOURS.includes(h as any), {
    message: `expiresInHours must be one of: ${EXPIRY_HOURS.join(", ")}`,
  }).default(24),
  filterId: z.enum(KNOWN_FILTER_IDS).optional().default('original'),
  filterIntensity: z.number().int().min(0).max(100).optional().default(100),
  mediaThumbnailUrl: z.string().min(1).nullable().optional(),
  mediaDurationSeconds: z.number().int().min(0).max(10).nullable().optional(),
});

/* ============================================================================
 * POST /highlights — create a highlight
 * ============================================================================ */
router.post("/highlights", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = createHighlightSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  // Reject video highlights longer than 10 seconds, or with missing duration
  if (d.mediaType.startsWith("video/")) {
    if (d.videoDurationSeconds == null) {
      sendError(res, "invalid_payload", "videoDurationSeconds is required for video highlights.");
      return;
    }
    if (d.videoDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
      sendError(res, "invalid_payload", `Highlights and video Postcards can be up to ${MAX_VIDEO_DURATION_SECONDS} seconds.`);
      return;
    }
  }

  const expiresAt = new Date(Date.now() + d.expiresInHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from("highlights")
    .insert({
      owner_id: user.id,
      media_url: d.mediaUrl,
      media_type: d.mediaType,
      video_duration_seconds: d.videoDurationSeconds ?? null,
      caption: d.caption ?? null,
      location_name: d.locationName ?? null,
      location_city: d.locationCity ?? null,
      location_country: d.locationCountry ?? null,
      visibility: d.visibility,
      expires_at: expiresAt,
      // filter_id / filter_intensity DO exist on the live highlights table.
      //
      // The comment that used to sit here said they did not, and it was wrong —
      // measured 2026-09-07 against production (ajrurzioarfkagpuxfnb): both
      // columns are present, NOT NULL, defaulting to 'original' / 100. They were
      // added deliberately by migration 0164_write_path_drift_columns_2.sql,
      // whose own header names this exact pair as "written by the save-story-to-
      // highlight insert" — and routes/stories.ts does write them. So the schema
      // was fixed, one of the two writers was updated, and this one was left
      // validating the client's chosen filter against KNOWN_FILTER_IDS and then
      // discarding it. Every highlight created through this route has been
      // stored as 'original' at intensity 100 regardless of what the user chose.
      filter_id: d.filterId,
      filter_intensity: d.filterIntensity,
      // media_thumbnail_url / media_duration_seconds genuinely do NOT exist
      // live (re-measured the same day): accepted in the payload for client
      // compatibility and deliberately not persisted. One unknown column fails
      // the WHOLE insert (PGRST204), so this distinction is load-bearing.
    })
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to create highlight");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({
    ...(data as any),
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
  });
});

/* ============================================================================
 * GET /users/:userId/highlights — active highlights for a user
 * Filtered by viewer permissions + blocks.
 * ============================================================================ */
router.get("/users/:userId/highlights", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const targetId = req.params.userId;
  if (!UUID.test(targetId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  // Check blocks in both directions. FAIL CLOSED — see resolveViewAccess above:
  // an errored lookup used to read as "not blocked" and serve the profile's
  // highlights. Serving an EMPTY list on an unresolvable block state is the safe
  // answer here (it is what a genuine block returns) and keeps the route's
  // contract; it does not pretend the user has no highlights, it declines to
  // decide who may see them.
  const [blocker, blocked] = await Promise.all([
    client.from("blocks").select("blocked_id").eq("blocker_id", user.id).eq("blocked_id", targetId).maybeSingle(),
    client.from("blocks").select("blocked_id").eq("blocker_id", targetId).eq("blocked_id", user.id).maybeSingle(),
  ]);
  if (blocker.error || blocked.error) {
    req.log.error({ err: blocker.error ?? blocked.error }, "highlights: block lookup failed — failing closed");
    res.status(200).json({ highlights: [] });
    return;
  }
  if (blocker.data || blocked.data) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const isOwnProfile = user.id === targetId;

  // Load active (non-expired, non-deleted) highlights for target user
  const { data: rows, error } = await client
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .eq("owner_id", targetId)
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    req.log.error({ err: error }, "Failed to load user highlights");
    sendError(res, "db_error", error.message);
    return;
  }

  const highlights = (rows ?? []) as any[];

  // For non-owners, check circle (follows) + trip membership to filter restricted visibility
  let viewerFollowsOwner = false;
  let sharesTrip = false;

  if (!isOwnProfile && highlights.some((h) => ["circle_only", "trip_only"].includes(h.visibility))) {
    const sc = getServiceClient();
    if (sc) {
      const circleMember = await sc
        .from("circle_memberships").select("other_id").eq("user_id", targetId).eq("other_id", user.id).maybeSingle();
      if (circleMember.error) {
        req.log.error({ err: circleMember.error, targetId }, "highlights: circle membership lookup failed — withholding circle_only highlights");
        viewerFollowsOwner = false;
      } else {
        viewerFollowsOwner = Boolean(circleMember.data);
      }

      if (highlights.some((h) => h.visibility === "trip_only")) {
        const shares = await sharesAcceptedTrip(sc, user.id, [targetId]);
        if (shares.ok) {
          sharesTrip = shares.shared.has(targetId);
        } else {
          // Withhold the trip_only ones; everything else on the profile is
          // still decided on its own merits.
          req.log.error({ err: shares.error, targetId }, "highlights: trip membership lookup failed — withholding trip_only highlights");
        }
      }
    }
  }

  if (isOwnProfile) {
    viewerFollowsOwner = true;
    sharesTrip = true;
  }

  // Filter by permission
  const visible = highlights.filter((h) =>
    canViewHighlight(user.id, h as any, { viewerFollowsOwner, sharesTrip }),
  );

  if (visible.length === 0) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const highlightIds = visible.map((h: any) => h.id as string);

  // Batch-fetch view + like counts + viewer status
  const [viewRows, likeRows, viewedRows, likedRows] = await Promise.all([
    client.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    client.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    client.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    client.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows.data ?? []).map((r: any) => r.highlight_id as string));

  // Fetch author profile once
  const sc = getServiceClient();
  let author: any = null;
  if (sc) {
    const { data: p } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", targetId).maybeSingle();
    if (p) {
      const allowedNames = await nameVisibilitySet(sc, [targetId]);
      author = { id: (p as any).id, handle: (p as any).handle, name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)), avatarUrl: (p as any).avatar_url ?? null };
    }
  }

  const result = visible.map((h: any) => ({
    ...h,
    author,
    viewCount: viewCountMap[h.id] ?? 0,
    likeCount: likeCountMap[h.id] ?? 0,
    viewedByMe: viewedSet.has(h.id),
    likedByMe: likedSet.has(h.id),
  }));

  res.status(200).json({ highlights: result });
});

/* ============================================================================
 * GET /highlights/active — all active highlights visible to current user
 * Supports ?userId=, ?city=, ?tripId=, ?limit=
 * ============================================================================ */
router.get("/highlights/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const filterUserId = typeof req.query.userId === "string" && UUID.test(req.query.userId) ? req.query.userId : null;
  const filterCity = typeof req.query.city === "string" ? req.query.city : null;
  const filterTripId = typeof req.query.tripId === "string" && UUID.test(req.query.tripId) ? req.query.tripId : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Resolve the trip's ACCEPTED crew when a tripId filter is provided. This
  // scopes the query to that crew's highlights; the per-highlight permission
  // check below still decides each one. FAIL CLOSED: an unreadable membership
  // is an error, and a trip with no accepted crew (or no such trip) is an empty
  // page — it used to be an UNFILTERED page, because `data ?? []` on an errored
  // or empty read produced a zero-size set and the filter was skipped.
  let tripMemberIds: Set<string> | null = null;

  if (filterTripId) {
    const members = await acceptedMemberIdsOfTrip(sc, filterTripId);
    if (!members.ok) {
      req.log.error({ err: members.error, tripId: filterTripId }, "highlights: trip crew lookup failed — failing closed");
      sendError(res, "db_error", "Could not resolve trip membership");
      return;
    }
    if (members.ids.size === 0) {
      res.status(200).json({ highlights: [] });
      return;
    }
    tripMemberIds = members.ids;
  }

  // Get blocks list for this user (both directions). FAIL CLOSED.
  //
  // `data ?? []` on an errored query yields an EMPTY block set — nothing
  // filtered — which is indistinguishable at the call site from "this viewer
  // has blocked nobody". A transient blocks-table failure therefore served
  // blocked owners' highlights into the feed. Same defect, same fix, as
  // routes/memories.ts's discovery feed.
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  if (blockedByMe.error || blockingMe.error) {
    req.log.error(
      { err: blockedByMe.error ?? blockingMe.error },
      "highlights: block lookup failed — failing closed",
    );
    sendError(res, "db_error", "Could not resolve block state");
    return;
  }
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);

  // Build query — include trip_only so trip members can see them
  let q = sc
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString())
    .in("visibility", ["public", "travelers_nearby", "circle_only", "trip_only"])
    .order("created_at", { ascending: false })
    .limit(limit * 5); // over-fetch to account for permission filtering

  if (filterUserId) {
    (q as any) = (q as any).eq("owner_id", filterUserId);
  }
  if (filterCity) {
    (q as any) = (q as any).ilike("location_city", `%${filterCity}%`);
  }
  if (tripMemberIds && tripMemberIds.size > 0) {
    (q as any) = (q as any).in("owner_id", [...tripMemberIds]);
  }

  const { data: rows, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to load active highlights");
    sendError(res, "db_error", error.message);
    return;
  }

  // Filter out blocked users
  const unblocked = (rows ?? []).filter((h: any) => !blockedIds.has(h.owner_id as string));

  // For circle_only highlights, check circle_memberships (not general follows)
  const circleOwnerIds = [...new Set(
    unblocked.filter((h: any) => h.visibility === "circle_only").map((h: any) => h.owner_id as string)
  )];
  const followingSet = new Set<string>();
  if (circleOwnerIds.length > 0) {
    const { data: circleRows, error: circleErr } = await sc
      .from("circle_memberships")
      .select("user_id")
      .eq("other_id", user.id)
      .in("user_id", circleOwnerIds);
    if (circleErr) {
      // `circleRows ?? []` on an error left followingSet empty, which withholds
      // — right answer, silent. Withhold and say so.
      req.log.error({ err: circleErr }, "highlights: circle membership lookup failed — withholding circle_only highlights");
    }
    for (const r of circleRows ?? []) followingSet.add((r as any).user_id as string);
  }

  // For trip_only highlights, determine which owners share a trip with the viewer
  const tripOnlyOwnerIds = [...new Set(
    unblocked.filter((h: any) => h.visibility === "trip_only").map((h: any) => h.owner_id as string)
  )];
  let sharesTripSet = new Set<string>();
  if (tripOnlyOwnerIds.length > 0) {
    const shares = await sharesAcceptedTrip(sc, user.id, tripOnlyOwnerIds);
    if (shares.ok) {
      sharesTripSet = shares.shared;
    } else {
      req.log.error({ err: shares.error }, "highlights: trip membership lookup failed — withholding trip_only highlights");
    }
  }

  // Permission filter
  const visible = unblocked.filter((h: any) => {
    if (h.owner_id === user.id) return true;
    if (h.visibility === "public" || h.visibility === "travelers_nearby") return true;
    if (h.visibility === "circle_only") return followingSet.has(h.owner_id as string);
    if (h.visibility === "trip_only") return sharesTripSet.has(h.owner_id as string);
    return false;
  }).slice(0, limit);

  if (visible.length === 0) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const highlightIds = visible.map((h: any) => h.id as string);
  const ownerIds = [...new Set(visible.map((h: any) => h.owner_id as string))];

  // Batch metrics + author profiles
  const [viewRows, likeRows, viewedRows, likedRows, profileRows] = await Promise.all([
    sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows.data ?? []).map((r: any) => r.highlight_id as string));

  const allowedNames = await nameVisibilitySet(sc, ownerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) {
    profileMap[(p as any).id] = { id: (p as any).id, handle: (p as any).handle, name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)), avatarUrl: (p as any).avatar_url ?? null };
  }

  const result = visible.map((h: any) => ({
    ...h,
    author: profileMap[h.owner_id] ?? null,
    viewCount: viewCountMap[h.id] ?? 0,
    likeCount: likeCountMap[h.id] ?? 0,
    viewedByMe: viewedSet.has(h.id),
    likedByMe: likedSet.has(h.id),
  }));

  res.status(200).json({ highlights: result });
});

/* ============================================================================
 * DELETE /highlights/:id — owner soft-delete
 * ============================================================================ */
router.delete("/highlights/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const { data: existing, error: existingErr } = await client
    .from("highlights")
    .select("id, owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (existingErr) {
    req.log.error({ err: existingErr, highlightId: id }, "highlights: delete pre-read failed");
    sendError(res, "db_error", existingErr.message);
    return;
  }
  if (!existing) { sendError(res, "not_found", "Highlight not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete this highlight"); return; }

  // `.select("id")` is what turns this into an answer.
  //
  // An UPDATE with no .select() returns `data: null` and says NOTHING about how
  // many rows it touched, so `error === null` is not "it worked" — it is "the
  // statement ran". This runs under the caller's own RLS context, so a policy
  // that no longer admits the row matches zero rows, errors nothing, and this
  // handler answered 204 for a highlight still live on the owner's profile.
  // Taking your own content down is exactly the operation that must not lie.
  const { data: deleted, error } = await client
    .from("highlights")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select("id");

  if (error) {
    req.log.error({ err: error }, "Failed to delete highlight");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!deleted || (deleted as any[]).length === 0) {
    req.log.error({ highlightId: id, ownerId: user.id }, "highlights: delete matched zero rows — highlight NOT deleted");
    sendError(res, "db_error", "The highlight could not be deleted. Please try again.", { exposeDetail: true });
    return;
  }
  res.status(204).send();
});

/* ============================================================================
 * POST /highlights/:id/view — idempotent view upsert
 * ============================================================================ */
router.post("/highlights/:id/view", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify viewer has permission to see this highlight
  const access = await resolveViewAccess(sc, user.id, id, res, req.log);
  if (!access) return;

  // Idempotent upsert
  const { error } = await sc
    .from("highlight_views")
    .upsert({ highlight_id: id, viewer_id: user.id, viewed_at: new Date().toISOString() }, { onConflict: "highlight_id,viewer_id" });

  if (error) {
    req.log.error({ err: error }, "Failed to record highlight view");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json({ viewed: true });
});

/* ============================================================================
 * POST /highlights/:id/like — like a highlight
 * ============================================================================ */
router.post("/highlights/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing engagement
  const access = await resolveViewAccess(sc, user.id, id, res, req.log);
  if (!access) return;

  if (access.h.owner_id === user.id) {
    sendError(res, "invalid_payload", "Cannot like your own highlight");
    return;
  }

  // The upsert result was discarded. It IS issued (the await sends it), but a
  // failed write resolved rather than threw, and this handler then answered
  // 200 { likedByMe: true } with nothing stored — the client renders a filled
  // heart for a like the database never took, and it survives until the next
  // refresh contradicts it.
  const { error: likeErr } = await sc
    .from("highlight_likes")
    .upsert({ highlight_id: id, user_id: user.id }, { onConflict: "highlight_id,user_id", ignoreDuplicates: true });
  if (likeErr) {
    req.log.error({ err: likeErr, highlightId: id }, "highlights: like write failed");
    sendError(res, "db_error", "Could not record the like. Please try again.", { exposeDetail: true });
    return;
  }

  // `count ?? 0` on an errored count is a fabricated zero. The like DID land,
  // so the request succeeded; the count is reported as null rather than as a
  // number nobody measured.
  const { count, error: countErr } = await sc
    .from("highlight_likes")
    .select("*", { count: "exact", head: true })
    .eq("highlight_id", id);
  if (countErr) req.log.warn({ err: countErr, highlightId: id }, "highlights: like count unreadable after a successful like");

  res.status(200).json({ likedByMe: true, likeCount: countErr ? null : (count ?? 0) });
});

/* ============================================================================
 * DELETE /highlights/:id/like — unlike a highlight
 * ============================================================================ */
router.delete("/highlights/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing engagement
  const access = await resolveViewAccess(sc, user.id, id, res, req.log);
  if (!access) return;

  const { error: unlikeErr } = await sc
    .from("highlight_likes").delete().eq("highlight_id", id).eq("user_id", user.id);
  if (unlikeErr) {
    req.log.error({ err: unlikeErr, highlightId: id }, "highlights: unlike write failed");
    sendError(res, "db_error", "Could not remove the like. Please try again.", { exposeDetail: true });
    return;
  }

  const { count, error: countErr } = await sc
    .from("highlight_likes")
    .select("*", { count: "exact", head: true })
    .eq("highlight_id", id);
  if (countErr) req.log.warn({ err: countErr, highlightId: id }, "highlights: like count unreadable after a successful unlike");

  res.status(200).json({ likedByMe: false, likeCount: countErr ? null : (count ?? 0) });
});

/* ============================================================================
 * GET /highlights/:id/viewers — owner-only list of viewers
 * ============================================================================ */
router.get("/highlights/:id/viewers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const { data: h, error: hErr } = await client
    .from("highlights")
    .select("id, owner_id")
    .eq("id", id)
    .maybeSingle();

  if (hErr) {
    req.log.error({ err: hErr, highlightId: id }, "highlights: viewers pre-read failed");
    sendError(res, "db_error", hErr.message);
    return;
  }
  if (!h) { sendError(res, "not_found", "Highlight not found"); return; }
  if ((h as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can see viewers"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: viewRows, error } = await sc
    .from("highlight_views")
    .select("viewer_id, viewed_at")
    .eq("highlight_id", id)
    .order("viewed_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "Failed to load highlight viewers");
    sendError(res, "db_error", error.message);
    return;
  }

  const viewerIds = (viewRows ?? []).map((r: any) => r.viewer_id as string);
  if (viewerIds.length === 0) {
    res.status(200).json({ viewers: [] });
    return;
  }

  const [profileRows, likeRows] = await Promise.all([
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", viewerIds),
    sc.from("highlight_likes").select("user_id").eq("highlight_id", id).in("user_id", viewerIds),
  ]);

  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) profileMap[(p as any).id] = p;
  const likedSet = new Set<string>((likeRows.data ?? []).map((r: any) => r.user_id as string));
  const allowedNames = await nameVisibilitySet(sc, viewerIds);

  const viewers = (viewRows ?? []).map((r: any) => {
    const p = profileMap[r.viewer_id] ?? {};
    return {
      user_id: r.viewer_id,
      handle: (p as any).handle ?? null,
      name: presentedName(p as any, r.viewer_id === user.id || allowedNames.has(r.viewer_id as string)),
      avatar_url: (p as any).avatar_url ?? null,
      viewed_at: r.viewed_at,
      liked: likedSet.has(r.viewer_id as string),
    };
  });

  res.status(200).json({ viewers });
});

/* ============================================================================
 * POST /highlights/:id/reply — create a Telegraph DM thread for a highlight reply
 * ============================================================================ */
router.post("/highlights/:id/reply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) { sendError(res, "invalid_payload", "message is required"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing reply
  const access = await resolveViewAccess(sc, user.id, id, res, req.log);
  if (!access) return;

  const ownerId = access.h.owner_id;
  if (ownerId === user.id) {
    sendError(res, "invalid_payload", "Cannot reply to your own highlight");
    return;
  }

  // Enforce messaging permissions — honour the recipient's privacy settings and block rules.
  // This mirrors the canMessage gate used by POST /api/users/:userId/open-thread.
  const msgVerdict = await canMessage(sc, user.id, ownerId);
  if (!msgVerdict.allowed) {
    if (msgVerdict.verdict === "requires_request") {
      sendError(res, "forbidden", "You must send a message request before replying to this highlight");
    } else {
      sendError(res, "forbidden", "You cannot send messages to this user");
    }
    return;
  }

  // Find or create a DM thread between replier and highlight owner.
  // Mirrors the pattern used by POST /api/users/:userId/open-thread in messaging.ts:
  //   - look up all threads the replier is in
  //   - find one where BOTH users are members (2-person DM)
  //   - create a new one if none exists
  // These two reads decide whether a DM thread ALREADY EXISTS. `?? []` on an
  // errored read is an empty membership list, which is indistinguishable from
  // "these two have never spoken" — so a transient failure here did not lose a
  // message, it CREATED A SECOND THREAD between the same two people, splitting
  // their conversation permanently. A duplicate thread cannot be undone by
  // retrying, so this refuses rather than guesses.
  const { data: myMemberships, error: myMemErr } = await sc
    .from("message_thread_members")
    .select("thread_id")
    .eq("user_id", user.id);
  if (myMemErr) {
    req.log.error({ err: myMemErr, ownerId }, "highlight reply: thread lookup failed — refusing rather than creating a duplicate DM thread");
    sendError(res, "degraded_unavailable", "We could not open the conversation right now. Please try again.");
    return;
  }

  const myThreadIds = (myMemberships ?? []).map((m: any) => m.thread_id as string);
  let threadId: string | null = null;

  if (myThreadIds.length > 0) {
    const { data: allMembers, error: allMemErr } = await sc
      .from("message_thread_members")
      .select("thread_id, user_id")
      .in("thread_id", myThreadIds);
    if (allMemErr) {
      req.log.error({ err: allMemErr, ownerId }, "highlight reply: thread member lookup failed — refusing rather than creating a duplicate DM thread");
      sendError(res, "degraded_unavailable", "We could not open the conversation right now. Please try again.");
      return;
    }

    const membersByThread: Record<string, Set<string>> = {};
    for (const m of (allMembers ?? []) as any[]) {
      if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = new Set();
      membersByThread[m.thread_id].add(m.user_id as string);
    }
    for (const [tid, members] of Object.entries(membersByThread)) {
      if (members.size === 2 && members.has(user.id) && members.has(ownerId)) {
        threadId = tid;
        break;
      }
    }
  }

  // Create a new DM thread if none exists (same schema as messaging route)
  if (!threadId) {
    const now = new Date().toISOString();
    const { data: newThread, error: threadErr } = await sc
      .from("message_threads")
      .insert({ created_at: now, updated_at: now })
      .select("id")
      .single();
    if (threadErr || !newThread) {
      req.log.error({ err: threadErr }, "Failed to create DM thread for highlight reply");
      sendError(res, "db_error", "Could not create message thread", { exposeDetail: true });
      return;
    }
    threadId = (newThread as any).id as string;
    const now2 = new Date().toISOString();
    // supabase-js resolves rather than throws on a write error — membership is
    // the only gate on the thread, so an unchecked failure here creates a
    // permanently-unreadable orphan thread (same defect as audit M1 in
    // messaging.ts). Check it and roll the just-created thread back.
    const { error: memErr } = await sc.from("message_thread_members").insert([
      { thread_id: threadId, user_id: user.id, joined_at: now2 },
      { thread_id: threadId, user_id: ownerId, joined_at: now2 },
    ]);
    if (memErr) {
      req.log.error({ err: memErr, threadId }, "highlight reply: thread members insert failed — rolling back orphan thread");
      await sc.from("message_threads").delete().eq("id", threadId);
      sendError(res, "db_error", "Could not create message thread", { exposeDetail: true });
      return;
    }
  }

  // Send a system context message linking to the highlight (cosmetic — a
  // failure is logged but does not block the actual reply below).
  const { error: ctxErr } = await sc.from("messages").insert({
    thread_id: threadId,
    sender_id: user.id,
    body: `↩ Replied to your highlight`,
    msg_type: "highlight_reply",
    subtype: id,
  });
  if (ctxErr) {
    req.log.warn({ err: ctxErr, threadId }, "highlight reply: context message insert failed");
  }

  // Send the actual reply message. Unchecked, this returned 200 {threadId} with
  // NOTHING sent — the sender believed the reply was delivered.
  const { error: msgErr } = await sc.from("messages").insert({
    thread_id: threadId,
    sender_id: user.id,
    body: message,
    msg_type: "text",
  });
  if (msgErr) {
    req.log.error({ err: msgErr, threadId }, "highlight reply: message insert failed");
    sendError(res, "db_error", "Could not send the reply", { exposeDetail: true });
    return;
  }

  // Record the reply in highlight_replies (best-effort, but observable)
  const { error: recErr } = await sc
    .from("highlight_replies")
    .insert({ highlight_id: id, replier_id: user.id, thread_id: threadId });
  if (recErr) {
    req.log.warn({ err: recErr, highlightId: id }, "highlight_replies insert failed — reply not recorded on the highlight");
  }

  res.status(200).json({ threadId });
});

/* ============================================================================
 * POST /highlights/:id/report
 * ============================================================================ */
router.post("/highlights/:id/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "inappropriate";

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access — can only report highlights you can actually see
  const access = await resolveViewAccess(sc, user.id, id, res, req.log);
  if (!access) return;

  if (access.h.owner_id === user.id) {
    sendError(res, "invalid_payload", "Cannot report your own highlight");
    return;
  }

  // The report write was discarded. A 204 told the reporter their report was
  // filed; on a failure nothing was filed, and a report nobody receives is the
  // one kind of silence a safety surface must never produce. The compass
  // signals below are deliberately best-effort and stay that way — they follow
  // the report, they are not the report.
  const { error: reportErr } = await sc
    .from("highlight_reports")
    .upsert({ highlight_id: id, reporter_id: user.id, reason }, { onConflict: "highlight_id,reporter_id" });
  if (reportErr) {
    req.log.error({ err: reportErr, highlightId: id, reporterId: user.id }, "highlights: report write failed — the report was NOT filed");
    sendError(res, "db_error", "Could not submit the report. Please try again.", { exposeDetail: true });
    return;
  }

  // Compass: record negative signal + immediately end fair exposure for the reported author.
  // Import lazily to keep highlights.ts independent of the compass subsystem.
  const authorId: string = access.h.owner_id;
  import("../compass/CompassActiveUserRewardEngine.js").then(({ recordActivityEvent }) => {
    recordActivityEvent(sc, authorId, "report_received");
  }, () => {});
  import("../compass/CompassFairExposureEngine.js").then(({ endFairExposure }) => {
    endFairExposure(sc, authorId, "report");
  }, () => {});

  // Invalidate compass cache for the reporter (their feed should not continue to
  // surface content they reported) and the reported author (exposure adjusted).
  await Promise.allSettled([
    invalidateCompassCache(sc, user.id,   "highlight_report_submitted"),
    invalidateCompassCache(sc, authorId,  "highlight_report_received"),
  ]);

  res.status(204).send();
});

/* ============================================================================
 * GET /highlights/following-feed
 * Returns users the current user follows who have active highlights,
 * grouped per user with their full highlight objects.
 * ============================================================================ */
router.get("/highlights/following-feed", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // 1. Get followed user IDs.
  //
  // "NOBODY YOU FOLLOW HAS AN ACTIVE HIGHLIGHT" IS A CLAIM ABOUT OTHER PEOPLE,
  // AND IT MUST BE TRUE. supabase-js RESOLVES on a database error, so
  // `(followRows ?? [])` on an unreadable user_follows is an EMPTY LIST and the
  // very next line answers `{ users: [] }` — the whole feed reported as empty
  // from a lookup that never happened. It is the shape a sibling lane found in
  // the Wall ("you're all caught up" with an unreadable follow graph) and in the
  // passport ("zero stamps" for an unreadable table). §28.11.
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts): the follow graph scopes the
  // ENTIRE response, so there is no narrower part left to serve honestly.
  // `degraded_unavailable` (503, retryable) is the code for "the read could not
  // be performed", and it is what the block read further down this same handler
  // already does — that one refuses, this one did not.
  //
  // A genuinely empty follow list is still `{ users: [] }`, unchanged. The two
  // cases are indistinguishable in the data and were indistinguishable in the
  // response; only one of them is now.
  const { data: followRows, error: followErr } = await sc
    .from("user_follows")
    .select("following_id")
    .eq("follower_id", user.id);

  if (followErr) {
    req.log.error({ err: followErr, viewerId: user.id },
      "highlights: following-feed follow graph unreadable — refusing rather than reporting an empty feed");
    sendError(res, "degraded_unavailable", "We could not load your highlights feed. Please try again.");
    return;
  }

  const followingIds = (followRows ?? []).map((r: any) => r.following_id as string);
  if (followingIds.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 2. Resolve blocked users (both directions) and filter them out. FAIL CLOSED
  //    — see /highlights/active above for why `data ?? []` on an error is a leak.
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  if (blockedByMe.error || blockingMe.error) {
    req.log.error(
      { err: blockedByMe.error ?? blockingMe.error },
      "highlights: following-feed block lookup failed — failing closed",
    );
    sendError(res, "db_error", "Could not resolve block state");
    return;
  }
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);
  const eligibleIds = followingIds.filter((id: string) => !blockedIds.has(id));
  if (eligibleIds.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 3. Fetch active (non-expired, non-deleted, non-private) highlights from
  //    followed users.
  //
  //    §12: "Highlights should remain finite and contextual. Do not turn the
  //    surface into an endless feed." This query has no `.limit()` and no
  //    cursor: it returns every active highlight of every followed user in one
  //    response, bounded only by the 24-hour expiry. Every sibling read is
  //    bounded — /highlights/active caps at 100, the memories discovery feed
  //    caps at 100 — so the omission is an oversight, not a design.
  //
  //    Capping a feed that is uncapped today can only REMOVE highlights from
  //    somebody's screen, and how many is finite-enough is a product decision
  //    §12 does not make. So the cap ships behind
  //    `highlights_feed_bounded_enabled` (migration 2339), seeded FALSE: off,
  //    this is the unbounded query it has always been; on, it is capped and
  //    paginated. isFlagEnabled is false-on-error, so an unreadable flag leaves
  //    the feed unbounded rather than silently truncating it.
  const bounded = await isFlagEnabled(sc, "highlights_feed_bounded_enabled");
  const feedLimit = bounded
    ? Math.min(Math.max(Number(req.query.limit ?? FOLLOWING_FEED_DEFAULT_LIMIT) || FOLLOWING_FEED_DEFAULT_LIMIT, 1), FOLLOWING_FEED_MAX_LIMIT)
    : null;
  const feedCursor = bounded && typeof req.query.cursor === "string" ? req.query.cursor : null;

  let feedQuery = sc
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .in("owner_id", eligibleIds)
    .is("deleted_at", null)
    .gt("expires_at", new Date().toISOString())
    .neq("visibility", "private")
    .order("created_at", { ascending: true });

  if (feedLimit != null) {
    // Over-fetch, because the visibility filter in step 5 runs after this query
    // and would otherwise shrink the page — the same defect the memories
    // discovery feed had. `slice(0, feedLimit)` below trims the FILTERED set.
    (feedQuery as any) = (feedQuery as any).limit(feedLimit * 5);
  }
  if (feedCursor) {
    (feedQuery as any) = (feedQuery as any).gt("created_at", feedCursor);
  }

  const { data: rows, error } = await feedQuery;

  if (error) {
    req.log.error({ err: error }, "Failed to load following highlights feed");
    sendError(res, "db_error", error.message);
    return;
  }

  const allHighlights = (rows ?? []) as any[];
  if (allHighlights.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 4. Resolve restricted visibility (circle_only / trip_only) in batch
  const circleOwnerIds = [...new Set(
    allHighlights.filter((h) => h.visibility === "circle_only").map((h) => h.owner_id as string),
  )];
  const tripOnlyOwnerIds = [...new Set(
    allHighlights.filter((h) => h.visibility === "trip_only").map((h) => h.owner_id as string),
  )];

  const circleApprovedSet = new Set<string>();
  let sharesTripSet = new Set<string>();

  const [circleRows, shares] = await Promise.all([
    circleOwnerIds.length > 0
      ? sc.from("circle_memberships").select("user_id").eq("other_id", user.id).in("user_id", circleOwnerIds)
      : Promise.resolve(null),
    tripOnlyOwnerIds.length > 0
      ? sharesAcceptedTrip(sc, user.id, tripOnlyOwnerIds)
      : Promise.resolve(null),
  ]);
  if ((circleRows as any)?.error) {
    // `?? []` left circleApprovedSet empty, which withholds — the right answer,
    // silently. Withhold and say so.
    req.log.error({ err: (circleRows as any).error }, "highlights: following-feed circle membership lookup failed — withholding circle_only highlights");
  }
  for (const r of (circleRows as any)?.data ?? []) circleApprovedSet.add((r as any).user_id as string);
  if (shares) {
    if (shares.ok) {
      sharesTripSet = shares.shared;
    } else {
      req.log.error({ err: shares.error }, "highlights: following-feed trip membership lookup failed — withholding trip_only highlights");
    }
  }

  // 5. Permission filter, then (when bounded) the finite page.
  const permitted = allHighlights.filter((h) => {
    if (h.visibility === "public" || h.visibility === "travelers_nearby") return true;
    if (h.visibility === "circle_only") return circleApprovedSet.has(h.owner_id as string);
    if (h.visibility === "trip_only") return sharesTripSet.has(h.owner_id as string);
    return false;
  });
  const visible = feedLimit != null ? permitted.slice(0, feedLimit) : permitted;
  const nextCursor = feedLimit != null && visible.length === feedLimit
    ? (visible[visible.length - 1]?.created_at ?? null)
    : null;

  if (visible.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 6. Batch metrics + author profiles
  const highlightIds = visible.map((h: any) => h.id as string);
  const ownerIds = [...new Set(visible.map((h: any) => h.owner_id as string))];

  const [viewRows2, likeRows2, viewedRows2, likedRows2, profileRows] = await Promise.all([
    sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows2.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows2.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows2.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows2.data ?? []).map((r: any) => r.highlight_id as string));

  const allowedNames = await nameVisibilitySet(sc, ownerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) {
    profileMap[(p as any).id] = {
      userId: (p as any).id,
      handle: (p as any).handle ?? null,
      name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)),
      avatarUrl: (p as any).avatar_url ?? null,
    };
  }

  // 7. Group by owner, preserving the order highlights came back
  const grouped = new Map<string, { profile: any; highlights: any[] }>();
  for (const h of visible) {
    const ownerId = h.owner_id as string;
    if (!grouped.has(ownerId)) {
      grouped.set(ownerId, { profile: profileMap[ownerId] ?? null, highlights: [] });
    }
    const author = profileMap[ownerId]
      ? { id: profileMap[ownerId].userId, handle: profileMap[ownerId].handle, name: profileMap[ownerId].name, avatarUrl: profileMap[ownerId].avatarUrl }
      : null;
    grouped.get(ownerId)!.highlights.push({
      ...h,
      author,
      viewCount: viewCountMap[h.id] ?? 0,
      likeCount: likeCountMap[h.id] ?? 0,
      viewedByMe: viewedSet.has(h.id),
      likedByMe: likedSet.has(h.id),
    });
  }

  const users = [...grouped.values()]
    .filter((g) => g.profile !== null)
    .map((g) => ({
      userId: g.profile.userId,
      handle: g.profile.handle,
      name: g.profile.name,
      avatarUrl: g.profile.avatarUrl,
      highlights: g.highlights,
    }));

  // nextCursor is present only while the cap is engaged; unbounded responses
  // keep the exact shape they had before 2339.
  res.status(200).json(feedLimit != null ? { users, nextCursor } : { users });
});

export default router;
