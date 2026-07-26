/**
 * mediaFeed — Watch mode (fullscreen vertical media) feed routes.
 *
 *   GET  /api/media/feed           — paginated feed (for_you | following)
 *   GET  /api/media/:id            — single item hydration
 *   POST /api/media/:id/view       — impression / view tracking
 *
 * All routes require auth. Feed routes are gated by feature flags:
 *   MEDIA_RANKING_ENABLED       — gates view tracking
 *   MEDIA_FOR_YOU_ENABLED       — gates for_you feed
 *   MEDIA_FOLLOWING_ENABLED     — gates following feed
 *
 * Eligibility (mediaEligibility.ts) runs before scoring. Scoring uses
 * portavaRank with CandidateKind 'post'. Creator caps via
 * MediaFeedRankingService (which handles creator caps internally). Pagination via opaque stable cursors
 * (mediaCursor.ts).
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  filterEligibleMediaCandidates,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import {
  hydrateMediaFeedItem,
  stripPrivateEventFields,
  stripPrivateTripFields,
  hydrateGemFeedItem,
  type MediaFeedItem,
  type MediaFeedLinkedEntity,
} from "../lib/mediaFeedItem.js";
import {
  findNearbyGems,
} from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import {
  reportGem,
} from "../services/hiddenGems/HiddenGemModerationService.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import {
  encodeCursor,
  decodeCursor,
  applyCursorFilter,
} from "../lib/mediaCursor.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  rankMediaFeed,
  loadMediaRankingFlags,
  loadMediaSignals,
  loadCreatorSignals,
  storeRankingSnapshots,
  type MediaFeedItem as RankingMediaFeedItem,
  type MediaSessionState,
} from "../services/ranking/MediaFeedRankingService.js";
import { recordMediaEvent } from "../lib/mediaAnalytics.js";

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max items fetchable per page. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/** Minimum watch duration (ms) to count as a qualified view. */
const QUALIFIED_VIEW_MIN_MS = 3_000;
/** Minimum completion fraction to count as a completion view. */
const COMPLETION_VIEW_MIN_MS = 10_000;

/**
 * In-memory deduplication window for view events.
 * Key: `${userId}:${mediaId}:${type}`, value: timestamp of last recorded event.
 * Evicted after TTL_MS to allow legitimate re-watches.
 */
const VIEW_DEDUP_TTL_MS = 60_000; // 1 minute
const viewDedupMap = new Map<string, number>();

/** Prune stale dedup entries (called on each view request, not on a timer). */
function pruneViewDedup(): void {
  const now = Date.now();
  for (const [key, ts] of viewDedupMap) {
    if (now - ts > VIEW_DEDUP_TTL_MS) viewDedupMap.delete(key);
  }
  // Hard cap to prevent unbounded growth
  if (viewDedupMap.size > 10_000) {
    const oldest = viewDedupMap.keys().next().value as string | undefined;
    if (oldest) viewDedupMap.delete(oldest);
  }
}

/** Columns projected from posts for media feed (never include exact GPS). */
const FEED_POST_COLUMNS =
  "id, author_id, trip_id, event_id, content, visibility, status, post_status, publish_at, " +
  "created_at, tags, category, " +
  "location_name, location_city, location_country, location_source, " +
  "save_count, like_count, comment_count, view_count, qualified_view_count, " +
  "has_video, primary_media_type, moderation_status, " +
  // Eligibility fields: geo + age restriction gates in filterEligibleMediaCandidates.
  // Both gates are fail-closed; omitting these fields would silently bypass them.
  "geo_restriction, age_restriction_enabled, age_min, age_max";

const POST_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, duration_seconds, " +
  "width, height, sort_order, processing_status, moderation_status, storage_path, storage_bucket";

const PROFILE_COLUMNS =
  "id, username, full_name, avatar_url, is_private, is_verified, bio, " +
  "followers_count, following_count, account_status";

// ── Linked entity resolution ──────────────────────────────────────────────────

/**
 * Columns fetched from the events table for linked-entity resolution.
 * Sensitive fields (address, coordinates, exact dates, attendees, invite codes)
 * are intentionally NOT included — the strip helpers operate only on these safe
 * columns and produce the MediaFeedLinkedEntity shape.
 */
const EVENT_LINKED_COLUMNS =
  "id, title, visibility, host_id, cover_url, show_header_publicly, " +
  "profiles!host_id(username, full_name)";

/**
 * Columns fetched from the trips table for linked-entity resolution.
 */
const TRIP_LINKED_COLUMNS =
  "id, title, visibility, owner_id, cover_url, show_header_publicly, " +
  "profiles!owner_id(username, full_name)";

/**
 * Batch-resolve linked entities (events and trips) for a page of posts.
 *
 * For each post that has an event_id or trip_id:
 *   1. Fetches the entity row (safe columns only).
 *   2. Checks if the viewer is a member/attendee.
 *   3. If private and viewer is not a member, applies the appropriate strip helper.
 *   4. If public, returns all safe header fields directly.
 *
 * Returns a Map<postId, MediaFeedLinkedEntity> (absent key = no linked entity).
 * Non-fatal: any DB error for an individual entity returns null (no entity).
 */
async function resolveLinkedEntities(
  page: Array<{ id: string; event_id?: string | null; trip_id?: string | null }>,
  viewerUserId: string,
  sc: any,
): Promise<Map<string, MediaFeedLinkedEntity>> {
  const result = new Map<string, MediaFeedLinkedEntity>();

  // Collect unique event_ids and trip_ids, mapping them back to post ids.
  const eventIdToPostIds = new Map<string, string[]>();
  const tripIdToPostIds = new Map<string, string[]>();
  for (const post of page) {
    if (post.event_id) {
      const list = eventIdToPostIds.get(post.event_id) ?? [];
      list.push(post.id);
      eventIdToPostIds.set(post.event_id, list);
    }
    if (post.trip_id) {
      const list = tripIdToPostIds.get(post.trip_id) ?? [];
      list.push(post.id);
      tripIdToPostIds.set(post.trip_id, list);
    }
  }

  const eventIds = [...eventIdToPostIds.keys()];
  const tripIds = [...tripIdToPostIds.keys()];

  if (eventIds.length === 0 && tripIds.length === 0) return result;

  // ── Batch fetch events, trips, and viewer membership in parallel ───────────
  const [
    eventRows,
    tripRows,
    viewerEventRsvpIds,
    viewerTripMemberIds,
  ] = await Promise.all([
    // Fetch events
    (async (): Promise<any[]> => {
      if (eventIds.length === 0) return [];
      try {
        const { data } = await sc
          .from("events")
          .select(EVENT_LINKED_COLUMNS)
          .in("id", eventIds);
        return (data as any[]) ?? [];
      } catch { return []; }
    })(),
    // Fetch trips
    (async (): Promise<any[]> => {
      if (tripIds.length === 0) return [];
      try {
        const { data } = await sc
          .from("trips")
          .select(TRIP_LINKED_COLUMNS)
          .in("id", tripIds);
        return (data as any[]) ?? [];
      } catch { return []; }
    })(),
    // Viewer's event RSVPs (going/maybe/interested qualify as membership)
    (async (): Promise<Set<string>> => {
      if (eventIds.length === 0) return new Set();
      try {
        const { data } = await sc
          .from("event_rsvps")
          .select("event_id")
          .eq("user_id", viewerUserId)
          .in("event_id", eventIds)
          .in("status", ["going", "maybe", "interested"]);
        const s = new Set<string>();
        for (const r of (data as any[]) ?? []) s.add(r.event_id as string);
        return s;
      } catch { return new Set(); }
    })(),
    // Viewer's trip memberships — role must be accepted AND status must be
    // 'accepted' (or null for legacy rows that pre-date the status column).
    // This mirrors the accepted-membership logic in circleAccessGuard.ts.
    (async (): Promise<Set<string>> => {
      if (tripIds.length === 0) return new Set();
      try {
        const { data } = await sc
          .from("trip_members")
          .select("trip_id, status")
          .eq("user_id", viewerUserId)
          .in("trip_id", tripIds)
          .in("role", ["owner", "co_host", "member", "viewer"]);
        const s = new Set<string>();
        for (const r of (data as any[]) ?? []) {
          // Accept null status (legacy rows) or explicitly 'accepted'.
          // All other statuses (invited, declined, removed, left) are outsiders.
          const status = (r as any).status as string | null | undefined;
          if (status == null || status === "accepted") {
            s.add((r as any).trip_id as string);
          }
        }
        return s;
      } catch { return new Set(); }
    })(),
  ]);

  // ── Resolve events ─────────────────────────────────────────────────────────
  for (const ev of eventRows) {
    const postIds = eventIdToPostIds.get(ev.id as string) ?? [];
    if (postIds.length === 0) continue;

    const hostProfile = Array.isArray(ev.profiles) ? ev.profiles[0] : ev.profiles;
    const entityBase = {
      ...ev,
      host_display_name: hostProfile?.full_name ?? null,
      host_username: hostProfile?.username ?? null,
    };

    const isPublic = (ev.visibility as string) !== "private";
    const viewerIsHost = (ev.host_id as string) === viewerUserId;
    const viewerIsMember = viewerIsHost || viewerEventRsvpIds.has(ev.id as string);

    let entity: MediaFeedLinkedEntity;
    if (isPublic || viewerIsMember) {
      // Expose all safe header fields
      entity = {
        type: "event",
        id: ev.id as string,
        title: ev.title as string,
        isPrivate: !isPublic,
        coverImageUrl: (ev.cover_url as string | null) ?? null,
        ownerDisplayName: (entityBase.host_display_name as string | null) ?? null,
        ownerUsername: (entityBase.host_username as string | null) ?? null,
      };
    } else {
      // Private and viewer is not a member — strip sensitive fields
      entity = stripPrivateEventFields(entityBase, {
        viewerIsHost: false,
        showHeaderPublicly: Boolean(ev.show_header_publicly),
      });
    }

    for (const postId of postIds) result.set(postId, entity);
  }

  // ── Resolve trips ──────────────────────────────────────────────────────────
  for (const trip of tripRows) {
    const postIds = tripIdToPostIds.get(trip.id as string) ?? [];
    if (postIds.length === 0) continue;

    const ownerProfile = Array.isArray(trip.profiles) ? trip.profiles[0] : trip.profiles;
    const entityBase = {
      ...trip,
      owner_display_name: ownerProfile?.full_name ?? null,
      owner_username: ownerProfile?.username ?? null,
    };

    const isPublic = (trip.visibility as string) !== "private";
    const viewerIsOwner = (trip.owner_id as string) === viewerUserId;
    const viewerIsMember = viewerIsOwner || viewerTripMemberIds.has(trip.id as string);

    let entity: MediaFeedLinkedEntity;
    if (isPublic || viewerIsMember) {
      entity = {
        type: "trip",
        id: trip.id as string,
        title: trip.title as string,
        isPrivate: !isPublic,
        coverImageUrl: (trip.cover_url as string | null) ?? null,
        ownerDisplayName: (entityBase.owner_display_name as string | null) ?? null,
        ownerUsername: (entityBase.owner_username as string | null) ?? null,
      };
    } else {
      entity = stripPrivateTripFields(entityBase, {
        viewerIsOwner: false,
        showHeaderPublicly: Boolean(trip.show_header_publicly),
      });
    }

    for (const postId of postIds) result.set(postId, entity);
  }

  return result;
}

// ── Query schemas ─────────────────────────────────────────────────────────────

const feedQuerySchema = z.object({
  mode: z.literal("fullscreen"),
  feedType: z.enum(["for_you", "following"]).optional().default("for_you"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  sessionId: z.string().optional(),
});

const gemsQuerySchema = z.object({
  mode: z.literal("hidden_gems"),
  areaMode: z.enum(["near_me", "this_city", "my_trip", "all"]).optional().default("all"),
  category: z.string().optional(),
  /** City name for areaMode=this_city. */
  city: z.string().optional(),
  /** Trip ID for areaMode=my_trip. */
  tripId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  sessionId: z.string().optional(),
});

/** Source types excluded from the Gems feed (no verified real-place grounding). */
const GEMS_EXCLUDED_SOURCE_TYPES = new Set(["ai_generated_generic"]);

/** Columns selected for gem submitter profiles. */
const GEM_PROFILE_COLUMNS =
  "id, username, full_name, avatar_url, is_private, is_verified, bio, " +
  "followers_count, following_count, account_status";

/**
 * Columns selected for the gems feed query (statically resolvable single-line
 * literal so check:write-path-columns can verify every column against the live
 * schema without needing an allowlist entry).
 */
// eslint-disable-next-line max-len
const GEM_FEED_COLUMNS = "id, name, category, city, country, neighborhood, description, latitude, longitude, approx_latitude, approx_longitude, vibe_tags, price_range, safety_notes, best_time_to_go, local_etiquette, layover_safe, minimum_layover_minutes, sensitivity_level, verification_level, status, moderation_status, submitted_by, guide_verified_by, save_count, visit_count, report_count, image_url, canonical_place_id, source_type, created_at, updated_at";

/** km radius used for near_me bounding-box pre-filter. */
const NEAR_ME_RADIUS_KM = 25;

const viewBodySchema = z.object({
  type: z.enum(["impression", "qualified_view", "completion", "rewatch"]),
  watchedMs: z.number().int().min(0).optional(),
  sessionId: z.string().optional(),
});

// ── GET /api/media/feed?mode=hidden_gems ─────────────────────────────────────

router.get("/media/gems-feed", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Feature flag gate
  if (!(await isFlagEnabled(sc, "MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED"))) {
    sendError(res, "feature_disabled", "Gems mode is not available");
    return;
  }

  const parsed = gemsQuerySchema.safeParse({ mode: "hidden_gems", ...req.query });
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { areaMode, category, city: cityParam, tripId, limit, sessionId: clientSessionId } = parsed.data;
  const sessionId = clientSessionId ?? randomUUID();

  // ── Near Me: requires nearby flag ─────────────────────────────────────────
  if (areaMode === "near_me" && !(await isFlagEnabled(sc, "MEDIA_HIDDEN_GEMS_NEARBY_ENABLED"))) {
    sendError(res, "feature_disabled", "Near Me mode is not available");
    return;
  }

  // ── Resolve area filter ────────────────────────────────────────────────────
  let resolvedCity: string | undefined;
  let userLat: number | undefined;
  let userLng: number | undefined;

  if (areaMode === "near_me") {
    // Viewer's location from client-supplied headers (set after permission grant).
    // Never stored or forwarded to other clients.
    const latHeader = req.headers["x-user-lat"];
    const lngHeader = req.headers["x-user-lng"];
    const parsedLat = latHeader ? parseFloat(String(latHeader)) : NaN;
    const parsedLng = lngHeader ? parseFloat(String(lngHeader)) : NaN;
    if (!isFinite(parsedLat) || !isFinite(parsedLng)) {
      sendError(res, "invalid_payload", "Near Me requires X-User-Lat and X-User-Lng headers");
      return;
    }
    userLat = parsedLat;
    userLng = parsedLng;
  } else if (areaMode === "this_city") {
    resolvedCity = cityParam;
  } else if (areaMode === "my_trip") {
    if (!tripId) {
      sendError(res, "invalid_payload", "my_trip areaMode requires tripId");
      return;
    }
    // Load trip destination city — requires membership
    const { data: tripRow } = await sc
      .from("trips")
      .select("id, destination_city, owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if (!tripRow) {
      sendError(res, "not_found", "Trip not found");
      return;
    }
    // Verify caller is a trip member
    const { data: memberRow } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!memberRow && (tripRow as any).owner_id !== user.id) {
      sendError(res, "forbidden", "Not a trip member");
      return;
    }
    resolvedCity = (tripRow as any).destination_city?.split(",")[0]?.trim();
  }
  // areaMode === "all": no city/location filter

  // ── DB-level keyset cursor: (created_at DESC, id DESC) ───────────────────
  // Cursor encodes JSON { ts: ISO string, id: UUID }.
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (parsed.data.cursor) {
    try {
      const rawC = Buffer.from(parsed.data.cursor, "base64url").toString("utf8");
      const c = JSON.parse(rawC) as { ts: string; id: string };
      cursorTs = c.ts;
      cursorId = c.id;
    } catch { /* invalid cursor — serve from top */ }
  }

  // ── Build DB query with all filters, ordering, and cursor pushed to DB ────
  // Eligibility gates applied at query time so the result set is correctly
  // bounded — no in-memory truncation that would silently skip items.
  //
  // source_type filter uses OR so that rows where source_type IS NULL are
  // included (NULL != 'ai_generated_generic' is NULL in SQL, not TRUE).
  let q = (sc as any)
    .from("hidden_gems")
    .select(GEM_FEED_COLUMNS)
    .eq("status", "active")
    .not("canonical_place_id", "is", null)
    .or("source_type.is.null,source_type.neq.ai_generated_generic")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1); // +1 to detect whether a next page exists

  // Area filter
  if (areaMode === "near_me" && userLat != null && userLng != null) {
    // Bounding-box pre-filter; keeps the result set local without disclosing
    // the viewer's exact coordinates.  Ordering remains (created_at DESC, id DESC)
    // across all modes for cursor consistency.
    const dLat = NEAR_ME_RADIUS_KM / 111.32;
    const dLng = NEAR_ME_RADIUS_KM / (111.32 * Math.max(0.2, Math.cos((userLat * Math.PI) / 180)));
    const box = {
      minLat: Number((userLat - dLat).toFixed(5)),
      maxLat: Number((userLat + dLat).toFixed(5)),
      minLng: Number((userLng - dLng).toFixed(5)),
      maxLng: Number((userLng + dLng).toFixed(5)),
    };
    q = q.or(
      `and(latitude.gte.${box.minLat},latitude.lte.${box.maxLat},longitude.gte.${box.minLng},longitude.lte.${box.maxLng}),` +
      `and(approx_latitude.gte.${box.minLat},approx_latitude.lte.${box.maxLat},approx_longitude.gte.${box.minLng},approx_longitude.lte.${box.maxLng})`,
    );
  } else if (resolvedCity) {
    q = q.ilike("city", resolvedCity);
  }

  if (category) q = q.eq("category", category);

  // Keyset cursor predicate — applied last so the DB index scan skips
  // everything at or before the previous page's last item.
  if (cursorTs && cursorId) {
    q = q.or(`created_at.lt.${cursorTs},and(created_at.eq.${cursorTs},id.lt.${cursorId})`);
  }

  const { data: rawRows, error: gemsError } = await q;
  if (gemsError) {
    req.log.error({ err: gemsError }, "gems feed: DB query failed");
    sendError(res, "db_error", gemsError.message);
    return;
  }

  const allRows = (rawRows ?? []) as any[];
  const hasMore = allRows.length > limit;
  const page: any[] = hasMore ? allRows.slice(0, limit) : allRows;
  const lastGem = page[page.length - 1];
  const nextCursor = lastGem && hasMore
    ? Buffer.from(JSON.stringify({ ts: lastGem.created_at, id: lastGem.id }), "utf8").toString("base64url")
    : null;

  // ── Hydration: load submitter profiles ────────────────────────────────────
  const submitterIds: string[] = [
    ...new Set(page.map((g: any) => g.submitted_by as string).filter(Boolean)),
  ];
  const profileMap = new Map<string, any>();
  if (submitterIds.length > 0) {
    try {
      const { data: profiles } = await sc
        .from("profiles")
        .select(GEM_PROFILE_COLUMNS)
        .in("id", submitterIds);
      for (const p of (profiles as any[]) ?? []) profileMap.set(p.id as string, p);
    } catch { /* non-fatal: profiles stay empty */ }
  }

  // Batch: saved gems, follows, display-name privacy
  const gemIds: string[] = page.map((g: any) => g.id as string);
  const [savedSet, followedCreatorIds, allowedRealNameIds] = await Promise.all([
    (async () => {
      const s = new Set<string>();
      if (gemIds.length === 0) return s;
      try {
        const { data } = await sc
          .from("hidden_gem_saves")
          .select("gem_id")
          .eq("user_id", user.id)
          .in("gem_id", gemIds);
        for (const r of (data as any[]) ?? []) s.add(r.gem_id as string);
      } catch { /* non-fatal */ }
      return s;
    })(),
    (async () => {
      const s = new Set<string>();
      if (submitterIds.length === 0) return s;
      try {
        const { data } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", user.id)
          .in("following_id", submitterIds);
        for (const r of (data as any[]) ?? []) s.add(r.following_id as string);
      } catch { /* non-fatal */ }
      return s;
    })(),
    nameVisibilitySet(sc, submitterIds),
  ]);

  const items: MediaFeedItem[] = page.map((gem: any) =>
    hydrateGemFeedItem({
      gem,
      viewerUserId: user.id,
      allowedRealNameIds,
      savedGemIds: savedSet,
      followedCreatorIds,
      submitterProfile: profileMap.get(gem.submitted_by) ?? null,
    }),
  );

  res.json({ items, nextCursor, sessionId });
}));

// ── POST /api/media/:id/report (wrong-place) ─────────────────────────────────

router.post("/media/:id/report", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const { id } = req.params;
  if (!id) { sendError(res, "invalid_payload", "Missing id"); return; }

  const reasonSchema = z.object({
    reason: z.string().max(100).default("media_does_not_match_place"),
    notes: z.string().max(500).optional(),
  });
  const parsed = reasonSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  try {
    const result = await reportGem(sc, id, user.id, parsed.data.reason, parsed.data.notes);
    res.json({ ok: result.ok, alreadyReported: result.alreadyReported });
  } catch (err: any) {
    req.log.error({ err }, "media/:id/report failed");
    sendError(res, "db_error", err.message);
  }
}));

// ── GET /api/media/feed ───────────────────────────────────────────────────────

router.get("/media/feed", asyncHandler(async (req, res) => {
  // Single clock read — all timestamp derivations in this handler use nowMs.
  const nowMs = Date.now();

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { feedType, limit, sessionId: clientSessionId } = parsed.data;
  const cursorToken = parsed.data.cursor;
  const sessionId = clientSessionId ?? randomUUID();

  // ── Feature flag gates ─────────────────────────────────────────────────────
  const flagName = feedType === "following" ? "MEDIA_FOLLOWING_ENABLED" : "MEDIA_FOR_YOU_ENABLED";
  if (!(await isFlagEnabled(sc, flagName))) {
    sendError(res, "feature_disabled", `${feedType} feed is not available`);
    return;
  }

  // ── Decode cursor ──────────────────────────────────────────────────────────
  const cursor = cursorToken ? decodeCursor(cursorToken) : null;
  if (cursorToken && !cursor) {
    sendError(res, "invalid_payload", "Invalid cursor");
    return;
  }

  // ── Resolve viewer context ─────────────────────────────────────────────────
  // Fetch followed creator IDs (for following feed) and viewer country in parallel.
  const followedCreatorIds = new Set<string>();
  let viewerCountry: string | null = null;

  await Promise.all([
    // Followed creator IDs — only needed for the following feed
    (async () => {
      if (feedType !== "following") return;
      try {
        const { data: followRows } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", user.id);
        for (const r of (followRows as any[]) ?? []) followedCreatorIds.add(r.following_id as string);
      } catch { /* non-fatal */ }
    })(),
    // Viewer's location country — used for SQL-level geo-restriction pre-filter.
    // Best-effort: if unavailable the in-memory gate in filterEligibleMediaCandidates
    // handles geo-restriction fail-closed.
    (async () => {
      try {
        const { data: viewerProfile } = await sc
          .from("profiles")
          .select("location_country")
          .eq("id", user.id)
          .maybeSingle();
        viewerCountry = (viewerProfile as any)?.location_country ?? null;
      } catch { /* non-fatal */ }
    })(),
  ]);

  if (feedType === "following" && followedCreatorIds.size === 0) {
    res.json({ items: [], nextCursor: null, sessionId });
    return;
  }

  // ── Fetch candidates ───────────────────────────────────────────────────────
  // Fetch more than `limit` to account for eligibility filtering
  const candidateLimit = Math.min(limit * 5, 200);

  // NOTE: These select strings compose constants and are intentionally
  // not static literals — they are listed in UNRESOLVED_ALLOWLIST in
  // checkWritePathColumns.ts. All columns are verified against the live schema.
  const feedSelect = `${FEED_POST_COLUMNS}, post_media(${POST_MEDIA_COLUMNS}), profiles!author_id(${PROFILE_COLUMNS})`;
  let query = sc
    .from("posts")
    .select(feedSelect)
    .eq("status", "active")
    .eq("has_video", true)  // Watch mode: video-first
    // Delayed posting: exclude items scheduled for future publication.
    // publish_at IS NULL covers posts with no scheduled time (most posts).
    // This is a belt-and-suspenders guard — post_status='published' is the
    // primary delayed-post gate; publish_at ensures the DB scheduler hasn't
    // already set the time but missed flipping post_status.
    .or("publish_at.is.null,publish_at.lte." + new Date(nowMs).toISOString())
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(candidateLimit);

  // Visibility constraint
  if (feedType === "for_you") {
    query = query.eq("visibility", "public");
  } else if (feedType === "following") {
    // Following feed: public OR private posts from followed creators
    query = query.in("author_id", [...followedCreatorIds]);
  }

  // SQL-level geo-restriction pre-filter: when viewer's country is known, exclude
  // rows where geo_restriction is set but does NOT include the viewer's country.
  // This prevents geo-restricted posts from ever leaving the DB on cache misses.
  //
  // Safety: ISO-3166-1 alpha-2 codes are exactly 2 chars, so ilike '%XX%' cannot
  // produce false positives against other well-formed 2-char codes in the list.
  // The in-memory gate in filterEligibleMediaCandidates is retained as the
  // authoritative belt-and-suspenders fallback.
  if (viewerCountry) {
    // viewerCountry is reassigned inside an async closure that TypeScript's
    // control-flow analysis cannot track; cast to string to satisfy the checker.
    const c = (viewerCountry as string).toUpperCase();
    query = query.or(`geo_restriction.is.null,geo_restriction.ilike.%${c}%`);
  }

  // Apply cursor filter for stable pagination
  if (cursor) {
    query = applyCursorFilter(query, cursor);
  }

  const { data: rawCandidates, error: fetchError } = await query;
  if (fetchError) {
    req.log.error({ err: fetchError }, "media/feed candidates query failed");
    sendError(res, "db_error", fetchError.message);
    return;
  }

  const candidates = (rawCandidates as MediaCandidate[]) ?? [];

  // ── Eligibility filter ─────────────────────────────────────────────────────
  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    candidates,
    { viewerUserId: user.id, feedType, followedCreatorIds, viewerCountry },
    sc,
  );

  if (blockFetchFailed) {
    req.log.warn({ userId: user.id }, "media/feed: block-state unknown — returning empty feed");
    res.json({ items: [], nextCursor: null, sessionId });
    return;
  }

  // ── Mutes (load separately for ranking context) ────────────────────────────
  // Note: mutes are already applied in filterEligibleMediaCandidates.
  // Load the viewer's interest tags for ranking.
  let interestTags = new Set<string>();
  try {
    const { data: prefRow } = await sc
      .from("compass_user_preferences")
      .select("interests")
      .eq("user_id", user.id)
      .maybeSingle();
    const interests: string[] = (prefRow as any)?.interests ?? [];
    interestTags = new Set(interests.map((t: string) => t.toLowerCase()));
  } catch { /* non-fatal */ }

  // ── Seen IDs (for fatigue penalty) ────────────────────────────────────────
  // Load recent impressions for the viewer so seen items are penalised.
  const seenIds = new Set<string>();
  try {
    const { data: seenRows } = await sc
      .from("rank_events")
      .select("item_id")
      .eq("user_id", user.id)
      .eq("surface", "watch_feed")
      .gte("served_at", new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(500);
    for (const r of (seenRows as any[]) ?? []) seenIds.add(r.item_id as string);
  } catch { /* non-fatal */ }

  // ── Load media ranking flags + signals ────────────────────────────────────
  const [mediaFlags, mediaSignalsMap, creatorSignalsMap] = await Promise.all([
    loadMediaRankingFlags(sc),
    loadMediaSignals(sc, eligible.map((c) => c.id)),
    loadCreatorSignals(sc, [...new Set(eligible.map((c) => c.author_id).filter(Boolean))]),
  ]);

  // ── Build ranking candidates (merge DB signals into candidate shape) ────────
  const rankCandidates: RankingMediaFeedItem[] = eligible.map((c) => {
    const mediaSig   = mediaSignalsMap.get(c.id) ?? {};
    const creatorSig = creatorSignalsMap.get(c.author_id) ?? {};
    return {
      id:       c.id,
      kind:     "post" as const,
      createdAt: c.created_at,
      authorId: c.author_id,
      city:     (c as any).location_city ?? null,
      category: (c as any).category ?? null,
      tags:     Array.isArray(c.tags) ? c.tags.map((t: string) => t.toLowerCase()) : [],
      likeCount:  Number((c as any).like_count ?? 0),
      joinCount:  0,
      ...mediaSig,
      ...creatorSig,
    };
  });

  // ── Session creator impressions (for per-session fatigue) ─────────────────
  // Load how many times this viewer has seen each creator already in this
  // session so the fatigue layer can deprioritise over-represented creators.
  // Only executed when the fatigue flag is on and a sessionId exists.
  const creatorImpressions = new Map<string, number>();
  if (sessionId && mediaFlags.creatorFatigueEnabled) {
    try {
      const { data: sessionRows } = await sc
        .from("rank_events")
        .select("item_id")
        .eq("user_id", user.id)
        .eq("session_id", sessionId)
        .eq("surface", "watch_feed");
      // Map item_id → author_id using the already-loaded eligible candidates.
      const itemToAuthor = new Map<string, string>(
        eligible.map((c) => [c.id, c.author_id]).filter(([, aid]) => Boolean(aid)) as [string, string][],
      );
      for (const r of (sessionRows as any[]) ?? []) {
        const authorId = itemToAuthor.get(r.item_id as string);
        if (authorId) {
          creatorImpressions.set(authorId, (creatorImpressions.get(authorId) ?? 0) + 1);
        }
      }
    } catch { /* non-fatal */ }
  }
  const mediaSession: MediaSessionState = { creatorImpressions };

  // ── Rank via MediaFeedRankingService ───────────────────────────────────────
  const rankedResults = rankMediaFeed({
    candidates: rankCandidates,
    viewer: {
      userId:       user.id,
      followedIds:  followedCreatorIds,
      interestTags,
      seenIds,
    },
    mode:         feedType === "for_you" ? "for_you" : "following",
    sessionState: mediaSession,
    flags:        mediaFlags,
  });

  // Map ranked IDs back to candidate rows
  const candidateById = new Map(eligible.map((c) => [c.id, c]));
  const capped = rankedResults
    .map((r) => candidateById.get(r.item.id))
    .filter((c): c is MediaCandidate => c !== undefined);

  // ── Apply limit + compute next cursor ─────────────────────────────────────
  // IMPORTANT: The cursor must advance past ALL candidates fetched in this
  // round (DB order), NOT the last item served (ranking order). Ranking
  // re-orders candidates within the fetched window, so using the last *served*
  // item's DB position as the cursor would cause page 2 to re-fetch (and
  // potentially re-serve) items that were fetched but ranked lower this round.
  //
  // Correct contract: nextCursor points to the DB position of the last
  // candidate fetched. The next page query starts after that position,
  // ensuring zero overlap with any item fetched in this round.
  const page = capped.slice(0, limit);
  // Use the last RAW CANDIDATE (by DB order) as the cursor anchor so the
  // next page begins after all candidates evaluated this round.
  const lastFetched = candidates[candidates.length - 1];
  const nextCursor = lastFetched && candidates.length >= candidateLimit
    ? encodeCursor({ created_at: lastFetched.created_at, id: lastFetched.id })
    : null;

  // ── Hydration ──────────────────────────────────────────────────────────────
  // Batch-fetch viewer state for all page items
  const pageIds = page.map((c) => c.id);
  const authorIds = page.map((c) => c.author_id);

  // Batch: saved posts, liked posts, follow state, follow requests, display-name privacy
  const [savedSet, likedSet, pendingFollowSet, allowedRealNameIds] =
    await Promise.all([
      (async () => {
        const s = new Set<string>();
        if (pageIds.length === 0) return s;
        try {
          const { data } = await sc
            .from("post_saves")
            .select("post_id")
            .eq("user_id", user.id)
            .in("post_id", pageIds);
          for (const r of (data as any[]) ?? []) s.add(r.post_id as string);
        } catch { /* non-fatal */ }
        return s;
      })(),
      (async () => {
        const s = new Set<string>();
        if (pageIds.length === 0) return s;
        try {
          const { data } = await sc
            .from("post_reactions")
            .select("post_id")
            .eq("user_id", user.id)
            .in("post_id", pageIds);
          for (const r of (data as any[]) ?? []) s.add(r.post_id as string);
        } catch { /* non-fatal */ }
        return s;
      })(),
      (async () => {
        const s = new Set<string>();
        if (authorIds.length === 0) return s;
        try {
          const { data } = await sc
            .from("friend_requests")
            .select("recipient_id")
            .eq("requester_id", user.id)
            .eq("status", "pending")
            .in("recipient_id", authorIds);
          for (const r of (data as any[]) ?? []) s.add(r.recipient_id as string);
        } catch { /* non-fatal */ }
        return s;
      })(),
      nameVisibilitySet(sc, authorIds),
    ]);

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  // API base URL for relay URLs (relative when empty — works in all environments).
  const apiBaseUrl = process.env.API_BASE_URL ?? "";

  // ── Linked entity resolution ───────────────────────────────────────────────
  const linkedEntityMap = await resolveLinkedEntities(page, user.id, sc);

  const items: MediaFeedItem[] = page.map((c) => {
    const postMedia = Array.isArray(c.post_media) ? c.post_media : [];
    return hydrateMediaFeedItem({
      row: c,
      sourceType: "post",
      viewerUserId: user.id,
      allowedRealNameIds,
      savedPostIds: savedSet,
      likedPostIds: likedSet,
      followedCreatorIds,
      pendingFollowRequestIds: pendingFollowSet,
      postMedia,
      useSignedUrls: true,
      supabaseUrl,
      apiBaseUrl,
      linkedEntity: linkedEntityMap.get(c.id) ?? null,
    });
  });

  // ── Log impressions (fire-and-forget) ──────────────────────────────────────
  void (async () => {
    try {
      if (items.length === 0) return;
      const servedAt = new Date(nowMs).toISOString();
      // Build a lookup of ranking features by item id for impression logging
      const rankedById = new Map(rankedResults.map((r) => [r.item.id, r]));
      const impressionRows = items.map((item, idx) => {
        const rankedItem = rankedById.get(item.id);
        return {
          user_id:    user.id,
          item_id:    item.id,
          item_kind:  "post",
          position:   idx,
          features:   rankedItem?.features ?? {},
          outcome:    "impression",
          served_at:  servedAt,
          surface:    "watch_feed",
          session_id: sessionId,
        };
      });
      await sc.from("rank_events").insert(impressionRows);

      // Store ranking snapshots for "Why This?" (fire-and-forget with warning on failure)
      if (mediaFlags.rankingEnabled) {
        const pageRanked = page.map((c) => rankedById.get(c.id)).filter(
          (r): r is NonNullable<typeof r> => r !== undefined,
        );
        storeRankingSnapshots(sc, user.id, sessionId, "watch_feed", pageRanked)
          .catch((e) => req.log.warn({ err: e }, "media/feed: ranking snapshot write failed"));
      }
    } catch { /* non-fatal */ }
  })();

  // ── Analytics (fire-and-forget) ────────────────────────────────────────────
  recordMediaEvent("impression", {
    viewer_id:  user.id,
    feed_type:  feedType,
    mode:       "watch",
    surface:    "watch_feed",
    session_id: sessionId,
  }, sc);

  res.json({ items, nextCursor, sessionId });
}));

// ── GET /api/media/:id ────────────────────────────────────────────────────────

router.get("/media/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const { id } = req.params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    sendError(res, "invalid_payload", "Invalid media id");
    return;
  }

  const { data: row, error } = await sc
    .from("posts")
    .select(`${FEED_POST_COLUMNS}, post_media(${POST_MEDIA_COLUMNS}), profiles!author_id(${PROFILE_COLUMNS})`)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "media/:id query failed");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!row) {
    sendError(res, "not_found", "Media item not found");
    return;
  }

  const authorId = (row as any).author_id as string | undefined;

  // ── Resolve relationship BEFORE eligibility ────────────────────────────────
  // Eligibility for private-profile posts depends on whether the viewer follows
  // the author. Load follow state first so we can pass the correct feedType and
  // followedCreatorIds into the eligibility filter.
  const [viewerFollowsAuthor, savedSet, likedSet, pendingFollowSet, allowedRealNameIds] =
    await Promise.all([
      // Does viewer follow author?
      (async (): Promise<boolean> => {
        if (!authorId) return false;
        try {
          const { data } = await sc
            .from("user_follows")
            .select("following_id")
            .eq("follower_id", user.id)
            .eq("following_id", authorId)
            .maybeSingle();
          return Boolean(data);
        } catch { return false; }
      })(),
      (async () => {
        const s = new Set<string>();
        try {
          const { data } = await sc.from("post_saves").select("post_id").eq("user_id", user.id).eq("post_id", id);
          if ((data as any[])?.length) s.add(id);
        } catch { /* non-fatal */ }
        return s;
      })(),
      (async () => {
        const s = new Set<string>();
        try {
          const { data } = await sc.from("post_reactions").select("post_id").eq("user_id", user.id).eq("post_id", id);
          if ((data as any[])?.length) s.add(id);
        } catch { /* non-fatal */ }
        return s;
      })(),
      (async () => {
        const s = new Set<string>();
        try {
          if (authorId) {
            const { data } = await sc.from("friend_requests").select("recipient_id").eq("requester_id", user.id).eq("recipient_id", authorId).eq("status", "pending");
            if ((data as any[])?.length) s.add(authorId);
          }
        } catch { /* non-fatal */ }
        return s;
      })(),
      nameVisibilitySet(sc, authorId ? [authorId] : []),
    ]);

  const followedIds = viewerFollowsAuthor && authorId
    ? new Set<string>([authorId])
    : new Set<string>();

  // Eligibility: honour actual relationship context.
  // A post by a private-profile author that the viewer follows must pass
  // "following" eligibility (not "for_you" which requires public visibility).
  const candidate = row as MediaCandidate;
  const singleItemFeedType = viewerFollowsAuthor ? "following" : "for_you";
  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    [candidate],
    { viewerUserId: user.id, feedType: singleItemFeedType, followedCreatorIds: followedIds },
    sc,
  );

  if (blockFetchFailed || eligible.length === 0) {
    sendError(res, "not_found", "Media item not found");
    return;
  }

  const postMedia = Array.isArray((row as any).post_media) ? (row as any).post_media : [];

  // Resolve linked entity (event or trip) for the single item
  const singleLinkedEntityMap = await resolveLinkedEntities([row as any], user.id, sc);

  const item = hydrateMediaFeedItem({
    row: row as any,
    sourceType: "post",
    viewerUserId: user.id,
    allowedRealNameIds,
    savedPostIds: savedSet,
    likedPostIds: likedSet,
    followedCreatorIds: followedIds,
    pendingFollowRequestIds: pendingFollowSet,
    postMedia,
    useSignedUrls: true,
    supabaseUrl: process.env.SUPABASE_URL ?? "",
    apiBaseUrl: process.env.API_BASE_URL ?? "",
    linkedEntity: singleLinkedEntityMap.get((row as any).id) ?? null,
  });

  res.json({ item });
}));

// ── POST /api/media/:id/view ──────────────────────────────────────────────────

router.post("/media/:id/view", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Feature flag gate
  if (!(await isFlagEnabled(sc, "MEDIA_RANKING_ENABLED"))) {
    // Silently accept but don't count (graceful degradation)
    res.json({ counted: false });
    return;
  }

  const { id } = req.params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    sendError(res, "invalid_payload", "Invalid media id");
    return;
  }

  const parsed = viewBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { type, watchedMs, sessionId } = parsed.data;

  // Reject off-screen / preload signals by checking minimum thresholds
  if (type === "qualified_view" && (watchedMs == null || watchedMs < QUALIFIED_VIEW_MIN_MS)) {
    res.json({ counted: false });
    return;
  }
  if (type === "completion" && (watchedMs == null || watchedMs < COMPLETION_VIEW_MIN_MS)) {
    res.json({ counted: false });
    return;
  }

  // Self-view rejection: verify the post exists and check authorship
  const { data: postRow, error: postErr } = await sc
    .from("posts")
    .select("id, author_id, status, visibility, post_status, has_video")
    .eq("id", id)
    .maybeSingle();

  if (postErr || !postRow) {
    sendError(res, "not_found", "Media item not found");
    return;
  }

  // Reject self-refresh
  if ((postRow as any).author_id === user.id) {
    res.json({ counted: false });
    return;
  }

  // Basic post eligibility
  const status = (postRow as any).status;
  const postStatus = (postRow as any).post_status;
  if (status !== "active" || (postStatus && postStatus !== "published")) {
    res.json({ counted: false });
    return;
  }

  // Prune stale dedup entries
  pruneViewDedup();

  // Single clock read — used for both dedup TTL and served_at timestamp
  const nowMs = Date.now();

  // Dedup: same user + item + type within TTL window
  const dedupKey = `${user.id}:${id}:${type}`;
  const lastTs = viewDedupMap.get(dedupKey);
  if (lastTs && nowMs - lastTs < VIEW_DEDUP_TTL_MS) {
    res.json({ counted: false });
    return;
  }
  viewDedupMap.set(dedupKey, nowMs);

  // ── Persist to rank_events (durable — counted reflects write success) ────────
  //
  // rank_events.outcome has a CHECK constraint: only legacy funnel values
  // (impression, tap, save, join, rsvp, attended) and 'analytics' are allowed.
  // Watch-specific subtypes are stored in event_type; outcome is normalized:
  //   impression → "impression"
  //   qualified_view / completion / rewatch → "analytics"
  //
  // watchedMs is stored via event_type suffix rather than a metadata column
  // (rank_events has no metadata column in the live schema).
  const dbOutcome: string = type === "impression" ? "impression" : "analytics";
  const dbEventType: string =
    type === "impression"     ? "watch_impression" :
    type === "qualified_view" ? "watch_qualified_view" :
    type === "completion"     ? "watch_completion" :
    "watch_rewatch";

  let counted = false;
  try {
    const { error: insertErr } = await sc.from("rank_events").insert({
      event_type:   dbEventType,
      item_id:      id,
      content_type: "post",
      surface:      "watch_feed",
      user_id:      user.id,
      session_id:   sessionId ?? null,
      served_at:    new Date(nowMs).toISOString(),
      outcome:      dbOutcome,
    });
    if (insertErr) {
      req.log.warn({ err: insertErr, type, itemId: id }, "media/view: rank_events insert failed");
      counted = false;
    } else {
      counted = true;
    }
  } catch (err) {
    req.log.warn({ err, type, itemId: id }, "media/view: rank_events insert threw");
    counted = false;
  }

  // ── Analytics (fire-and-forget) ────────────────────────────────────────────
  if (counted) {
    recordMediaEvent(
      type === "rewatch" ? "rewatch" :
      type === "completion" ? "completion" :
      type === "qualified_view" ? "qualified_view" : "impression",
      {
        media_id:    id,
        post_id:     id,
        viewer_id:   user.id,
        session_id:  sessionId ?? undefined,
        watched_ms:  watchedMs ?? undefined,
        mode:        "watch",
        surface:     "watch_feed",
        is_rewatch:  type === "rewatch",
      },
      sc,
    );
  }

  res.json({ counted });
}));

export default router;
