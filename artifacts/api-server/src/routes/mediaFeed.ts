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
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  filterEligibleMediaCandidates,
  loadViewerTripIds,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import { calculateUserAge } from "../lib/ageEligibility.js";
import { excludePrivateAuthorPosts } from "../lib/privacyFilter.js";
import {
  hydrateMediaFeedItem,
  hydrateMediaGridItem,
  stripPrivateEventFields,
  stripPrivateTripFields,
  hydrateGemFeedItem,
  type MediaFeedItem,
  type MediaFeedLinkedEntity,
  type MediaGridItem,
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
import { stampEntity, unstampEntity } from "../services/stamps/ContentStampService.js";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import {
  rankMediaFeed,
  loadMediaRankingFlags,
  loadMediaSignals,
  loadCreatorSignals,
  loadBucketMap,
  buildPlaceAffinities,
  storeRankingSnapshots,
  type MediaFeedItem as RankingMediaFeedItem,
  type MediaSessionState,
} from "../services/ranking/MediaFeedRankingService.js";
import { recordMediaEvent } from "../lib/mediaAnalytics.js";
import { resolveGemCoords, type GemCoordContext } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";

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

/**
 * Grid-mode post columns — strictly lightweight.
 * No captions (content), no reaction counts, no linked event/trip fields.
 * Includes only the fields needed to render a static poster tile.
 * location_lat / location_lng are included for the nearby radius filter;
 * they are never forwarded to the client (hydrateMediaGridItem omits them).
 */
const GRID_POST_COLUMNS =
  "id, author_id, trip_id, " +
  "location_name, location_city, location_country, location_verified, " +
  "location_lat, location_lng, " +
  "created_at, category, " +
  "status, post_status, visibility";

/**
 * Grid-mode post_media columns — includes relay fields so posterUrl and
 * videoUrl can be resolved through the private relay when storage_path is
 * present (relay-bucket assets have no accessible public_url).
 */
const GRID_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, thumbnail_storage_path, " +
  "duration_seconds, width, height, sort_order, processing_status, moderation_status, " +
  "storage_path, storage_bucket";

/**
 * Columns projected from posts for the Watch-mode feed.
 *
 * NOTE: posts has no `event_id` column in the live schema — a post can only
 * link to a trip (trip_id). Event linkage for posts does not exist yet (the
 * `event_id` column referenced in earlier versions of this file never
 * existed live and made every /media/feed request 500). Do not add it back
 * without first confirming the column exists via the live schema.
 */
const FEED_POST_COLUMNS =
  "id, author_id, trip_id, content, visibility, status, post_status, " +
  "created_at, category, " +
  "location_name, location_city, location_country, location_source, location_verified, " +
  "location_lat, location_lng, " +
  "save_count, like_count, comment_count, " +
  "canonical_place_id, post_buckets";

const POST_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, thumbnail_storage_path, duration_seconds, " +
  "width, height, sort_order, processing_status, moderation_status, storage_path, storage_bucket";

const PROFILE_COLUMNS =
  "id, username, full_name, avatar_url, is_private, verified, bio, account_status, is_official";

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

export type GridFilter = "all" | "videos" | "photos" | "following" | "saved" | "nearby";

const gridQuerySchema = z.object({
  mode: z.literal("grid"),
  filter: z.enum(["all", "videos", "photos", "following", "saved", "nearby"]).optional().default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  sessionId: z.string().optional(),
  /** Viewer latitude — required for filter=nearby to produce a real radius filter. */
  lat: z.coerce.number().min(-90).max(90).optional(),
  /** Viewer longitude — required for filter=nearby to produce a real radius filter. */
  lng: z.coerce.number().min(-180).max(180).optional(),
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
  "id, username, full_name, avatar_url, is_private, verified, bio, account_status, is_official";

/**
 * Columns selected for the gems feed query (statically resolvable single-line
 * literal so check:write-path-columns can verify every column against the live
 * schema without needing an allowlist entry).
 */
// eslint-disable-next-line max-len
const GEM_FEED_COLUMNS = "id, name, category, city, country, neighborhood, description, latitude, longitude, approx_latitude, approx_longitude, vibe_tags, price_range, safety_notes, best_time_to_go, local_etiquette, layover_safe, minimum_layover_minutes, sensitivity_level, verification_level, status, moderation_status, submitted_by, guide_verified_by, save_count, visit_count, report_count, image_url, canonical_place_id, source_type, created_at, updated_at";

/**
 * Strict shape checks for the gems-feed keyset cursor. Its two fields are
 * interpolated into a PostgREST `.or()` filter string, whose grammar treats
 * `, ( )` as structure — so only a canonical ISO-8601 timestamp and a UUID
 * are ever allowed through (same fail-closed stance as lib/mediaCursor.ts).
 */
const GEM_CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** km radius used for near_me bounding-box pre-filter. */
const NEAR_ME_RADIUS_KM = 25;

/** Radius (km) used by filter=nearby on the grid feed. */
const NEARBY_GRID_RADIUS_KM = 50;

/**
 * Haversine great-circle distance in kilometres.
 * Used for the in-memory precision pass after the DB bounding-box pre-filter.
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const viewBodySchema = z.object({
  type: z.enum(["impression", "qualified_view", "completion", "rewatch"]),
  watchedMs: z.number().int().min(0).optional(),
  sessionId: z.string().optional(),
});

// ── GET /api/media/feed?mode=grid ─────────────────────────────────────────────

/**
 * Grid mode feed handler.
 *
 * Returns lightweight MediaGridItem objects — no captions, comments, full
 * profiles, event/trip objects, or raw coordinates.
 *
 * Supported filter values:
 *   all       — all eligible public posts (images + videos)
 *   videos    — video posts only (has_video = true)
 *   photos    — image-only posts (has_video = false)
 *   following — posts from creators the viewer follows
 *   saved     — viewer's saved posts
 *   nearby    — all eligible posts (client gates the chip on location permission)
 *
 * No ranking is applied — items are returned in reverse-chronological order.
 * Cursor pagination is stable (same contract as Watch mode).
 */
async function handleGridFeed(req: any, res: any): Promise<void> {
  const nowMs = Date.now();

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Feature flag gate
  if (!(await isFlagEnabled(sc, "MEDIA_VIEW_MODE_GRID_ENABLED"))) {
    sendError(res, "feature_disabled", "Grid feed is not available");
    return;
  }

  const parsed = gridQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { filter, limit, sessionId: clientSessionId, lat: queryLat, lng: queryLng } = parsed.data;
  const cursorToken = parsed.data.cursor;
  const sessionId = clientSessionId ?? randomUUID();

  // Decode cursor
  const cursor = cursorToken ? decodeCursor(cursorToken) : null;
  if (cursorToken && !cursor) {
    sendError(res, "invalid_payload", "Invalid cursor");
    return;
  }

  // ── Pre-fetch viewer context for filter-specific queries ────────────────────
  const followedCreatorIds = new Set<string>();
  const savedPostIds = new Set<string>();

  await Promise.all([
    (async () => {
      if (filter === "following") {
        try {
          const { data } = await sc
            .from("user_follows")
            .select("following_id")
            .eq("follower_id", user.id);
          for (const r of (data as any[]) ?? []) followedCreatorIds.add(r.following_id as string);
        } catch { /* non-fatal */ }
      }
    })(),
    (async () => {
      if (filter === "saved") {
        try {
          const { data } = await sc
            .from("post_saves")
            .select("post_id")
            .eq("user_id", user.id);
          for (const r of (data as any[]) ?? []) savedPostIds.add(r.post_id as string);
        } catch { /* non-fatal */ }
      }
    })(),
  ]);

  // Following filter with zero followed creators → empty result
  if (filter === "following" && followedCreatorIds.size === 0) {
    res.json({ items: [], nextCursor: null, sessionId });
    return;
  }

  // Saved filter with no saved posts → empty result
  if (filter === "saved" && savedPostIds.size === 0) {
    res.json({ items: [], nextCursor: null, sessionId });
    return;
  }

  // ── Build candidate query ───────────────────────────────────────────────────
  const candidateLimit = Math.min(limit * 5, 200);
  const gridSelect = `${GRID_POST_COLUMNS}, post_media(${GRID_MEDIA_COLUMNS})`;

  let query = sc
    .from("posts")
    .select(gridSelect)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(candidateLimit);

  // Apply filter-specific constraints
  switch (filter) {
    case "videos":
      query = query.eq("visibility", "public").eq("has_video", true);
      break;
    case "photos":
      query = query.eq("visibility", "public").eq("has_video", false);
      break;
    case "following":
      // Include private posts from followed creators
      query = query.in("author_id", [...followedCreatorIds]);
      break;
    case "saved":
      query = query.in("id", [...savedPostIds]);
      break;
    case "all":
    default:
      query = query.eq("visibility", "public");
      break;
    case "nearby":
      query = query.eq("visibility", "public");
      // Bounding-box pre-filter at the DB level (fast index scan).
      // Posts without coordinates are excluded — they can't be "nearby" anything.
      // A second in-memory Haversine pass removes corner-of-the-box false positives.
      if (queryLat != null && queryLng != null) {
        const deltaLat = NEARBY_GRID_RADIUS_KM / 111.0;
        const deltaLng =
          NEARBY_GRID_RADIUS_KM / (111.0 * Math.cos(queryLat * (Math.PI / 180)));
        query = query
          .gte("location_lat", queryLat - deltaLat)
          .lte("location_lat", queryLat + deltaLat)
          .gte("location_lng", queryLng - deltaLng)
          .lte("location_lng", queryLng + deltaLng);
      }
      break;
  }

  if (cursor) {
    query = applyCursorFilter(query, cursor);
  }

  const { data: rawCandidates, error: fetchError } = await query;
  if (fetchError) {
    req.log.error({ err: fetchError }, "media/feed?mode=grid candidates query failed");
    sendError(res, "db_error", fetchError.message);
    return;
  }

  let candidates = (rawCandidates as MediaCandidate[]) ?? [];

  // ── Nearby: in-memory Haversine pass (removes bounding-box corners) ──────────
  if (filter === "nearby" && queryLat != null && queryLng != null) {
    candidates = candidates.filter((c) => {
      const lat = (c as any).location_lat as number | null | undefined;
      const lng = (c as any).location_lng as number | null | undefined;
      if (lat == null || lng == null) return false;
      return haversineKm(queryLat!, queryLng!, lat, lng) <= NEARBY_GRID_RADIUS_KM;
    });
  }

  // ── Eligibility filter ──────────────────────────────────────────────────────
  // Trip membership is needed only to admit trip_only items, which only the
  // following feed can reach — for_you admits public content exclusively, so
  // the query is skipped there entirely. Loaded ONCE per request, never per row.
  const gridViewerTripIds = filter === "following"
    ? await loadViewerTripIds(sc, user.id)
    : undefined;

  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    candidates,
    {
      viewerUserId: user.id,
      feedType: filter === "following" ? "following" : "for_you",
      followedCreatorIds,
      viewerTripIds: gridViewerTripIds,
    },
    sc,
  );

  if (blockFetchFailed) {
    req.log.warn({ userId: user.id }, "media/feed?mode=grid: block-state unknown — returning empty feed");
    res.json({ items: [], nextCursor: null, sessionId });
    return;
  }

  // ── Private-account guard ─────────────────────────────────────────────────
  // Grid candidates don't join profiles, so this requires a profiles query.
  const eligibleGrid = await excludePrivateAuthorPosts(eligible, user.id, sc);

  // ── Apply limit + compute next cursor (no ranking — chronological order) ────
  // The cursor must anchor to the last SERVED item, not the last fetched
  // candidate: eligibility/privacy filtering can drop most of the candidate
  // window, and advancing past unserved-but-eligible posts skips them forever.
  // Chronological order is stable, so resuming from the last served item is
  // exact. (Fullscreen/ranked mode intentionally keeps the fetch-window cursor
  // — a documented trade-off there because ranking reorders the page.)
  const page = eligibleGrid.slice(0, limit);
  const lastServed = page[page.length - 1];
  const lastFetched = candidates[candidates.length - 1];
  // More content may exist when eligible items overflow this page, or when the
  // candidate window was full (the DB may hold more rows past it).
  const mayHaveMore =
    eligibleGrid.length > limit || candidates.length === candidateLimit;
  // If nothing on this page survived filtering but the window was full, fall
  // back to the last fetched candidate so pagination still makes progress
  // (nothing was served, so nothing can be skipped).
  const cursorAnchor = lastServed ?? lastFetched;
  const nextCursor = cursorAnchor && mayHaveMore
    ? encodeCursor({ created_at: cursorAnchor.created_at, id: cursorAnchor.id })
    : null;

  // ── Hydrate into lightweight grid items ─────────────────────────────────────
  const items: MediaGridItem[] = page.map((c) => {
    const postMedia = Array.isArray(c.post_media) ? c.post_media : [];
    return hydrateMediaGridItem(c, postMedia, process.env.API_BASE_URL ?? "");
  });

  // ── Analytics (fire-and-forget) ─────────────────────────────────────────────
  recordMediaEvent("impression", {
    viewer_id:  user.id,
    filter,
    mode:       "grid",
    surface:    "grid_feed",
    session_id: sessionId,
  }, sc);

  res.json({ items, nextCursor, sessionId });
}

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
  // Cursor encodes JSON { ts: ISO string, id: UUID }. Both values are
  // interpolated into a PostgREST .or() expression below, so they MUST be
  // strictly validated (mirrors lib/mediaCursor.ts decodeCursor): a tampered
  // cursor containing or-grammar metacharacters could otherwise inject
  // arbitrary filters. Malformed → ignore the cursor and serve from the top.
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (parsed.data.cursor) {
    try {
      const rawC = Buffer.from(parsed.data.cursor, "base64url").toString("utf8");
      const c = JSON.parse(rawC) as { ts: string; id: string };
      const tsValid =
        typeof c.ts === "string" &&
        GEM_CURSOR_TS_RE.test(c.ts) &&
        !Number.isNaN(new Date(c.ts).getTime());
      const idValid = typeof c.id === "string" && UUID_RE.test(c.id);
      if (tsValid && idValid) {
        cursorTs = c.ts;
        cursorId = c.id;
      }
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
  const [savedSet, followedCreatorIdsGems, allowedRealNameIds] = await Promise.all([
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

  // Resolve safe, privacy-filtered coordinates per gem (exact/approximate/hidden
  // per sensitivity_level) — same choke point used by hiddenGems.ts, so Gems-feed
  // Navigate gets real coordinates without bypassing the disclosure policy.
  const coordsByGemId = new Map<string, { lat: number | null; lng: number | null }>();
  await Promise.all(page.map(async (gem: any) => {
    const coords = await resolveGemCoords(
      gem as GemCoordContext,
      sc,
      user.id,
      gem.submitted_by ?? null,
    );
    coordsByGemId.set(gem.id as string, { lat: coords.lat, lng: coords.lng });
  }));

  const items: MediaFeedItem[] = page.map((gem: any) =>
    hydrateGemFeedItem({
      gem,
      viewerUserId: user.id,
      allowedRealNameIds,
      savedGemIds: savedSet,
      followedCreatorIds: followedCreatorIdsGems,
      submitterProfile: profileMap.get(gem.submitted_by) ?? null,
      resolvedCoords: coordsByGemId.get(gem.id as string) ?? null,
    }),
  );

  res.json({ items, nextCursor, sessionId });
}));

// ── POST /api/media/:id/report ─────────────────────────────────────────────────
// Routes to the appropriate report pipeline based on media kind:
//   - hidden_gems → reportGem() (writes to hidden_gem_reports)
//   - posts       → reports table (same pipeline as reports.ts)
// The reason "media_does_not_match_place" is only meaningful for gems;
// post reports use standard reason codes (spam, nudity, harassment, etc.)

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
  if (!id || !UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const reasonSchema = z.object({
    reason: z.string().max(100).default("spam"),
    notes: z.string().max(500).optional(),
  });
  const parsed = reasonSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Detect media kind without access-control filtering (reporter may be blocked)
  const { data: gemRow } = await sc
    .from("hidden_gems")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (gemRow) {
    // ── Hidden gem: use existing reportGem pipeline ─────────────────────────
    try {
      const result = await reportGem(sc, id, user.id, parsed.data.reason, parsed.data.notes);
      res.json({ ok: result.ok, alreadyReported: result.alreadyReported });
    } catch (err: any) {
      req.log.error({ err }, "media/:id/report (gem) failed");
      sendError(res, "db_error", err.message);
    }
    return;
  }

  // ── Post: write to reports table (same pipeline as reports.ts) ────────────
  const { data: postRow } = await sc
    .from("posts")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (!postRow) { sendError(res, "not_found", "Media item not found"); return; }

  const { error } = await sc
    .from("reports")
    .insert({
      reporter_id: user.id,
      target_type: "post",
      target_id: id,
      reason_code: parsed.data.reason,
      reason_detail: parsed.data.notes ?? null,
    });

  if (error) {
    req.log.error({ err: error }, "media/:id/report (post) failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true, alreadyReported: false });
}));

// ── GET /api/media/feed ───────────────────────────────────────────────────────

router.get("/media/feed", asyncHandler(async (req, res) => {
  // Route to the grid handler when mode=grid
  if (req.query.mode === "grid") {
    return handleGridFeed(req, res);
  }

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
  // Fetch followed creator IDs (for following feed), viewer country, and viewer
  // date-of-birth in parallel. Country and age are used for SQL-level pre-filters
  // that prevent restricted posts from leaving the DB on cache misses.
  const followedCreatorIds = new Set<string>();
  let viewerCountry: string | null = null;
  let viewerAge: number | null = null;

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
    // Viewer's location country and date-of-birth — used for SQL-level
    // geo/age-restriction pre-filters. Best-effort: if unavailable the in-memory
    // gate in filterEligibleMediaCandidates handles both restrictions fail-closed.
    (async () => {
      try {
        const { data: viewerProfile } = await sc
          .from("profiles")
          .select("location_country, date_of_birth")
          .eq("id", user.id)
          .maybeSingle();
        viewerCountry = (viewerProfile as any)?.location_country ?? null;
        viewerAge = calculateUserAge((viewerProfile as any)?.date_of_birth ?? null);
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
    // Watch feed is video-only: never surface image-only posts to a video renderer.
    .eq("has_video", true)
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

  // Note: geo_restriction and age_restriction_* columns are not present in the
  // live schema yet — filterEligibleMediaCandidates skips those gates when the
  // fields are absent (fail-open for now).

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
  // See the grid path above: trip membership gates trip_only items, which only
  // the following feed can reach, so for_you skips the query. Once per request.
  const watchViewerTripIds = feedType === "following"
    ? await loadViewerTripIds(sc, user.id)
    : undefined;

  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    candidates,
    { viewerUserId: user.id, feedType, followedCreatorIds, viewerCountry, viewerAge, viewerTripIds: watchViewerTripIds },
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
  const [mediaFlags, mediaSignalsMap, creatorSignalsMap, placeAffinities] = await Promise.all([
    loadMediaRankingFlags(sc),
    loadMediaSignals(sc, eligible.map((c) => c.id)),
    loadCreatorSignals(sc, [...new Set(eligible.map((c) => c.author_id).filter(Boolean))]),
    // Build place-affinity map so scoreCandidate can fire the ×1.15 boost for
    // places the viewer has visited ≥ PLACE_ENGAGEMENT_BOOST_THRESHOLD times.
    buildPlaceAffinities(sc, user.id, nowMs),
  ]);

  // ── Load featured-by-Portava status for ranking boost ────────────────────
  // Non-fatal: if the table doesn't exist or query fails, all items get null.
  const featuredMap = new Map<string, { featuredAt: string; category: string }>();
  if (mediaFlags.featuredBoostEnabled && eligible.length > 0) {
    try {
      const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: featuredRows } = await sc
        .from("portava_featured")
        .select("post_id, category, featured_at")
        .eq("status", "live")
        .in("post_id", eligible.map((c) => c.id))
        .gte("featured_at", sevenDaysAgo);
      for (const r of (featuredRows as any[]) ?? []) {
        featuredMap.set(r.post_id as string, { featuredAt: r.featured_at as string, category: r.category as string });
      }
    } catch { /* non-fatal: ranking boost skipped */ }
  }

  // ── Pre-load bucket counts for novelty ranking (no per-post DB lookups) ─────
  const uniquePlaceIds = [...new Set(
    eligible.map((c) => (c as any).canonical_place_id as string | null).filter(Boolean) as string[],
  )];
  const bucketCountsMap = await loadBucketMap(sc, uniquePlaceIds);

  // ── Batch stamp counts for ranking likeCount signal ──────────────────────
  // posts.like_count is no longer updated by the unified stamp write path;
  // derive likeCount from content_stamps (entity_type='media') instead so
  // ranking signals stay in sync with the actual stamp table.
  const rankingStampCountMap = new Map<string, number>();
  if (eligible.length > 0) {
    try {
      const eligibleIds = eligible.map((c) => c.id);
      const { data: rankStampRows } = await sc
        .from("content_stamps")
        .select("entity_id")
        .eq("entity_type", "media")
        .in("entity_id", eligibleIds);
      for (const r of (rankStampRows as any[]) ?? []) {
        const eid = r.entity_id as string;
        rankingStampCountMap.set(eid, (rankingStampCountMap.get(eid) ?? 0) + 1);
      }
    } catch { /* non-fatal: falls back to posts.like_count */ }
  }

  // ── Build ranking candidates (merge DB signals into candidate shape) ────────
  const rankCandidates: RankingMediaFeedItem[] = eligible.map((c) => {
    const mediaSig   = mediaSignalsMap.get(c.id) ?? {};
    const creatorSig = creatorSignalsMap.get(c.author_id) ?? {};
    const featuredEntry = featuredMap.get(c.id);
    const rawBuckets = (c as any).post_buckets;
    return {
      id:       c.id,
      kind:     "post" as const,
      createdAt: c.created_at,
      authorId: c.author_id,
      city:     (c as any).location_city ?? null,
      category: (c as any).category ?? null,
      tags:     Array.isArray(c.tags) ? c.tags.map((t: string) => t.toLowerCase()) : [],
      likeCount:  rankingStampCountMap.get(c.id) ?? Number((c as any).like_count ?? 0),
      joinCount:  0,
      featuredAt: featuredEntry?.featuredAt ?? null,
      featuredByPortava: featuredEntry?.category ?? null,
      // Novelty / coverage bucket signals
      canonicalPlaceId: (c as any).canonical_place_id ?? null,
      // placeId drives the ×1.15 place-affinity boost in portavaRank.scoreCandidate;
      // use the same canonical_place_id so affinity signals route to the same key.
      placeId: (c as any).canonical_place_id ?? null,
      postBuckets: Array.isArray(rawBuckets) ? rawBuckets : null,
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
      placeAffinities,
    },
    mode:         feedType === "for_you" ? "for_you" : "following",
    sessionState: mediaSession,
    flags:        mediaFlags,
    bucketCounts: bucketCountsMap,
  });

  // Map ranked IDs back to candidate rows
  const candidateById = new Map(eligible.map((c) => [c.id, c]));
  const capped = rankedResults
    .map((r) => candidateById.get(r.item.id))
    .filter((c): c is MediaCandidate => c !== undefined);

  // ── Private-account guard ─────────────────────────────────────────────────
  // Applied after ranking so scoring is unaffected. PROFILE_COLUMNS already
  // includes is_private; read from the joined profiles data to skip an extra
  // round-trip.
  const cappedSafe = await excludePrivateAuthorPosts(capped, user.id, sc, { profilesKey: "profiles" });

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
  const page = cappedSafe.slice(0, limit);
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
        // Read stamp state from content_stamps (unified write path since Task 3047).
        const s = new Set<string>();
        if (pageIds.length === 0) return s;
        try {
          const { data } = await sc
            .from("content_stamps")
            .select("entity_id")
            .eq("user_id", user.id)
            .eq("entity_type", "media")
            .in("entity_id", pageIds);
          for (const r of (data as any[]) ?? []) s.add(r.entity_id as string);
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

  // ── Stamp-it counts (batch COUNT on media_stamp_reactions) ─────────────────
  // Counted in-memory after fetching matching rows — PostgREST does not support
  // per-row GROUP BY aggregates in the JS client.
  const stampCountMap = new Map<string, number>();
  if (pageIds.length > 0) {
    try {
      const { data: stampRows } = await sc
        .from("media_stamp_reactions")
        .select("post_id")
        .in("post_id", pageIds);
      for (const r of (stampRows as any[]) ?? []) {
        const pid = r.post_id as string;
        stampCountMap.set(pid, (stampCountMap.get(pid) ?? 0) + 1);
      }
    } catch { /* non-fatal: stamp count defaults to 0 */ }
  }

  // ── Like counts from content_stamps (entity_type='media') ─────────────────
  // posts.like_count is not updated by compat like writes; derive from stamps.
  const mediaLikeCountMap = new Map<string, number>();
  if (pageIds.length > 0) {
    try {
      const { data: likeCountRows } = await sc
        .from("content_stamps")
        .select("entity_id")
        .eq("entity_type", "media")
        .in("entity_id", pageIds);
      for (const r of (likeCountRows as any[]) ?? []) {
        const eid = r.entity_id as string;
        mediaLikeCountMap.set(eid, (mediaLikeCountMap.get(eid) ?? 0) + 1);
      }
    } catch { /* non-fatal: falls back to posts.like_count */ }
  }

  // ── Linked entity resolution ───────────────────────────────────────────────
  const linkedEntityMap = await resolveLinkedEntities(page, user.id, sc);

  // Re-fetch featured map for the final page (may differ from ranking-time map)
  // so the hydrated items carry featuredByPortava for client-side badge display.
  const pageFeaturedMap = new Map<string, string>();
  if (pageIds.length > 0) {
    try {
      const { data: pfRows } = await sc
        .from("portava_featured")
        .select("post_id, category")
        .eq("status", "live")
        .in("post_id", pageIds);
      for (const r of (pfRows as any[]) ?? []) {
        pageFeaturedMap.set(r.post_id as string, r.category as string);
      }
    } catch { /* non-fatal: badge omitted */ }
  }

  const items: MediaFeedItem[] = page.map((c) => {
    const postMedia = Array.isArray(c.post_media) ? c.post_media : [];
    const featuredCategory = pageFeaturedMap.get(c.id) ?? null;
    return hydrateMediaFeedItem({
      row: { ...c, stamp_it_count: stampCountMap.get(c.id) ?? 0, stamp_like_count: mediaLikeCountMap.get(c.id) ?? 0, featured_by_portava: featuredCategory },
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
        // Read stamp state from content_stamps (unified write path since Task 3047).
        const s = new Set<string>();
        try {
          const { data } = await sc.from("content_stamps").select("entity_id").eq("user_id", user.id).eq("entity_type", "media").eq("entity_id", id);
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
  // Same rule as the feed paths: without this a genuine trip member would get a
  // 404 on a single trip_only item, because the visibility gate fails closed
  // when viewerTripIds is absent. for_you never reaches trip_only, so skip it.
  const singleItemViewerTripIds = singleItemFeedType === "following"
    ? await loadViewerTripIds(sc, user.id)
    : undefined;

  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    [candidate],
    {
      viewerUserId: user.id,
      feedType: singleItemFeedType,
      followedCreatorIds: followedIds,
      viewerTripIds: singleItemViewerTripIds,
    },
    sc,
  );

  if (blockFetchFailed || eligible.length === 0) {
    sendError(res, "not_found", "Media item not found");
    return;
  }

  const postMedia = Array.isArray((row as any).post_media) ? (row as any).post_media : [];

  // Fetch stamp-it count and like count (content_stamps) for this single item
  let singleStampCount = 0;
  let singleLikeCount = 0;
  try {
    const [{ data: stampRows }, { data: likeRows }] = await Promise.all([
      sc.from("media_stamp_reactions").select("post_id").eq("post_id", id),
      sc.from("content_stamps").select("entity_id").eq("entity_type", "media").eq("entity_id", id),
    ]);
    singleStampCount = ((stampRows as any[]) ?? []).length;
    singleLikeCount = ((likeRows as any[]) ?? []).length;
  } catch { /* non-fatal */ }

  // Resolve linked entity (event or trip) for the single item
  const singleLinkedEntityMap = await resolveLinkedEntities([row as any], user.id, sc);

  const item = hydrateMediaFeedItem({
    row: { ...(row as any), stamp_it_count: singleStampCount, stamp_like_count: singleLikeCount },
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
    .select("id, author_id, status, visibility, post_status")
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

// ── UUID validation helper ─────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the media kind AND enforce access control:
 *   - The item must be active (status = 'active').
 *   - Neither party may have blocked the other.
 *   - Private posts are only visible to the author or approved followers.
 *
 * Returns the resolved kind, or null when the item is not found / not accessible.
 */
async function verifyMediaAccess(
  sc: any,
  id: string,
  viewerUserId: string,
): Promise<{ kind: "post"; authorId: string } | { kind: "gem"; submittedBy: string | null } | null> {
  // ── Try posts first (most common path) ────────────────────────────────────
  const { data: postRow } = await sc
    .from("posts")
    .select("id, author_id, status, visibility, trip_id")
    .eq("id", id)
    .maybeSingle();

  if (postRow && (postRow as any).status === "active") {
    const authorId: string = (postRow as any).author_id;
    const visibility: string = (postRow as any).visibility ?? "public";
    const tripId: string | null = (postRow as any).trip_id ?? null;

    // Block check (both directions) — use count to stay cardinality-safe; treat any error as blocked (fail-closed).
    const { count: blockCount, error: blockError } = await sc
      .from("blocks")
      .select("blocker_id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${viewerUserId},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${viewerUserId})`);
    if (blockError || (blockCount ?? 0) > 0) return null;

    // Visibility check — private AND friends-only posts require follow or ownership
    if ((visibility === "private" || visibility === "friends") && authorId !== viewerUserId) {
      const { data: followRow } = await sc
        .from("user_follows")
        .select("follower_id")
        .eq("follower_id", viewerUserId)
        .eq("following_id", authorId)
        .maybeSingle();
      if (!followRow) return null;
    }

    // trip_only posts require accepted trip membership (viewer or author)
    if (visibility === "trip_only" && authorId !== viewerUserId) {
      if (!tripId || !(await isAcceptedTripMember(sc, tripId, viewerUserId))) return null;
    }

    return { kind: "post", authorId };
  }

  // ── Try hidden_gems ───────────────────────────────────────────────────────
  const { data: gemRow } = await sc
    .from("hidden_gems")
    .select("id, submitted_by, status")
    .eq("id", id)
    .maybeSingle();

  if (gemRow && (gemRow as any).status === "active") {
    const submittedBy: string | null = (gemRow as any).submitted_by as string | null;

    // Block check for gems (only when submitted_by is set) — fail-closed on error.
    if (submittedBy && submittedBy !== viewerUserId) {
      const { count: blockCount, error: blockError } = await sc
        .from("blocks")
        .select("blocker_id", { count: "exact", head: true })
        .or(`and(blocker_id.eq.${viewerUserId},blocked_id.eq.${submittedBy}),and(blocker_id.eq.${submittedBy},blocked_id.eq.${viewerUserId})`);
      if (blockError || (blockCount ?? 0) > 0) return null;
    }

    return { kind: "gem", submittedBy };
  }

  return null;
}

// ── POST /api/media/:id/like ──────────────────────────────────────────────────

// Compat wrapper — proxies to content_stamps until mobile clients are migrated.
// New code should use POST /stamps { entityType: 'media', entityId }.
// Preserves verifyMediaAccess (existence + block) and Compass outcome signal parity.
router.post("/media/:id/like", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }
  // Self-like guard: preserve legacy behavior (authors cannot stamp their own media).
  if (mediaAccess.kind === "post" && (mediaAccess as any).authorId === user.id) {
    sendError(res, "forbidden", "Cannot like your own content");
    return;
  }
  const { stampCount } = await stampEntity(sc, user.id, "media", id);
  void linkOutcomeSignal(sc, user.id, id, "liked", "route:media_like");
  res.json({ ok: true, stampCount });
}));

// ── POST /api/media/:id/react ─────────────────────────────────────────────────
// Records a "stamp_it" reaction from the Watch feed long-press gesture.
// Uses a dedicated media_stamp_reactions table so it never conflicts with the
// single-reaction-per-user constraint on post_reactions (the ❤️ like row).
// Idempotent: a second stamp_it from the same viewer is silently ignored.
// Only works for posts (not gems — gems have no posts.id FK target).

router.post("/media/:id/react", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }

  if (mediaAccess.kind === "post") {
    const { error } = await sc
      .from("media_stamp_reactions")
      .upsert(
        { post_id: id, user_id: user.id },
        { onConflict: "post_id,user_id", ignoreDuplicates: true },
      );
    if (error) {
      req.log.error({ err: error }, "media_stamp_reactions upsert failed");
      sendError(res, "db_error", error.message);
      return;
    }
  }
  // Gems: no target table — acknowledge silently so the client never retries.

  res.json({ stamped: true, mediaId: id });
}));

// ── DELETE /api/media/:id/like ────────────────────────────────────────────────

// Compat wrapper — proxies to content_stamps until mobile clients are migrated.
// New code should use DELETE /stamps/media/:entityId.
// Preserves verifyMediaAccess (existence + block) parity with the original unlike path.
router.delete("/media/:id/like", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }
  const { stampCount } = await unstampEntity(sc, user.id, "media", id);
  res.json({ ok: true, stampCount });
}));

// ── POST /api/media/:id/save ──────────────────────────────────────────────────

router.post("/media/:id/save", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }

  if (mediaAccess.kind === "post") {
    const { error } = await sc
      .from("post_saves")
      .upsert(
        { user_id: user.id, post_id: id },
        { onConflict: "user_id,post_id", ignoreDuplicates: true },
      );
    if (error) { req.log.error({ err: error }, "post_saves upsert failed"); sendError(res, "db_error", error.message); return; }
  } else {
    const { error } = await sc
      .from("hidden_gem_saves")
      .upsert(
        { user_id: user.id, gem_id: id },
        { onConflict: "user_id,gem_id", ignoreDuplicates: true },
      );
    if (error) { req.log.error({ err: error }, "hidden_gem_saves upsert failed"); sendError(res, "db_error", error.message); return; }
  }

  res.json({ saved: true, mediaId: id });
}));

// ── DELETE /api/media/:id/save ────────────────────────────────────────────────

router.delete("/media/:id/save", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }

  if (mediaAccess.kind === "post") {
    const { error } = await sc
      .from("post_saves")
      .delete()
      .eq("user_id", user.id)
      .eq("post_id", id);
    if (error) { req.log.error({ err: error }, "post_saves delete failed"); sendError(res, "db_error", error.message); return; }
  } else {
    const { error } = await sc
      .from("hidden_gem_saves")
      .delete()
      .eq("user_id", user.id)
      .eq("gem_id", id);
    if (error) { req.log.error({ err: error }, "hidden_gem_saves delete failed"); sendError(res, "db_error", error.message); return; }
  }

  res.json({ saved: false, mediaId: id });
}));

// ── POST /api/media/:id/share ─────────────────────────────────────────────────

router.post("/media/:id/share", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Gate: MEDIA_SHARING_ENABLED
  if (!(await isFlagEnabled(sc, "MEDIA_SHARING_ENABLED"))) {
    sendError(res, "feature_disabled", "Media sharing is not available");
    return;
  }

  const shareSchema = z.object({
    target: z.enum(["native", "copy_link", "telegraph"]).default("native"),
  });
  const parsed = shareSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }

  // Record share event (fire-and-forget on write failure — never block the share)
  void recordMediaEvent("share", {
    media_id: id,
    post_id: id,
    viewer_id: user.id,
    mode: mediaAccess.kind === "post" ? "watch" : "gems",
    surface: mediaAccess.kind === "post" ? "watch_feed" : "gems_feed",
  }, sc);

  const shareUrl = `/share/media/${id}`;
  res.json({ ok: true, mediaId: id, shareUrl, target: parsed.data.target });
}));

// ── GET /api/media/:id/comments ───────────────────────────────────────────────
// Delegates to the posts_comments table by re-using the post ID.
// Only post-backed media items have comments; gems return an empty list.

router.get("/media/:id/comments", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Gate: MEDIA_COMMENTS_ENABLED
  if (!(await isFlagEnabled(sc, "MEDIA_COMMENTS_ENABLED"))) {
    sendError(res, "feature_disabled", "Comments are not available");
    return;
  }

  const mediaAccess = await verifyMediaAccess(sc, id, user.id);
  if (!mediaAccess) { sendError(res, "not_found", "Media item not found"); return; }

  // Gems don't have structured comments yet — return empty
  if (mediaAccess.kind === "gem") {
    res.json({ comments: [], total: 0 });
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);

  const { data, error, count } = await sc
    .from("posts_comments")
    .select(
      "id, post_id, user_id, body, created_at, updated_at",
      { count: "exact" },
    )
    .eq("post_id", id)
    .is("parent_comment_id", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "media comments query failed"); sendError(res, "db_error", error.message); return; }

  const rows = (data as any[]) ?? [];
  res.json({ comments: rows, total: count ?? 0 });
}));

// ── PATCH /api/media/:id (owner: change visibility) ──────────────────────────

router.patch("/media/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const bodySchema = z.object({
    visibility: z.enum(["public", "friends", "private"]),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const { data: postRow } = await sc
    .from("posts")
    .select("id, author_id")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();

  if (!postRow) { sendError(res, "not_found", "Media item not found"); return; }
  if ((postRow as any).author_id !== user.id) { sendError(res, "forbidden", "Only the owner can change visibility"); return; }

  const { error } = await sc
    .from("posts")
    .update({ visibility: parsed.data.visibility })
    .eq("id", id);

  if (error) { req.log.error({ err: error }, "media visibility patch failed"); sendError(res, "db_error", error.message); return; }

  res.json({ ok: true, mediaId: id, visibility: parsed.data.visibility });
}));

// ── DELETE /api/media/:id (owner: delete) ─────────────────────────────────────

router.delete("/media/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid media id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // Try posts first
  const { data: postRow } = await sc
    .from("posts")
    .select("id, author_id, status")
    .eq("id", id)
    .maybeSingle();

  if (postRow) {
    if ((postRow as any).author_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete this post"); return; }
    const { error } = await sc.from("posts").update({ status: "deleted" }).eq("id", id);
    if (error) { req.log.error({ err: error }, "post delete failed"); sendError(res, "db_error", error.message); return; }
    res.json({ ok: true, mediaId: id, deleted: true });
    return;
  }

  // Try hidden_gems
  const { data: gemRow } = await sc
    .from("hidden_gems")
    .select("id, submitted_by")
    .eq("id", id)
    .maybeSingle();

  if (!gemRow) { sendError(res, "not_found", "Media item not found"); return; }
  if ((gemRow as any).submitted_by !== user.id) { sendError(res, "forbidden", "Only the owner can delete this item"); return; }

  const { error } = await sc.from("hidden_gems").update({ status: "deleted" }).eq("id", id);
  if (error) { req.log.error({ err: error }, "hidden_gem delete failed"); sendError(res, "db_error", error.message); return; }

  res.json({ ok: true, mediaId: id, deleted: true });
}));

export default router;
