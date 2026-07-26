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
 * enforceCreatorCapsGeneric. Pagination via opaque stable cursors
 * (mediaCursor.ts).
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import {
  filterEligibleMediaCandidates,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import {
  hydrateMediaFeedItem,
  type MediaFeedItem,
} from "../lib/mediaFeedItem.js";
import {
  encodeCursor,
  decodeCursor,
  applyCursorFilter,
} from "../lib/mediaCursor.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { rankCandidates } from "../lib/portavaRank.js";
import {
  enforceCreatorCapsGeneric,
} from "../services/ranking/CreatorCapEnforcer.js";

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
  "id, author_id, trip_id, content, visibility, status, post_status, publish_at, " +
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

// ── Query schemas ─────────────────────────────────────────────────────────────

const feedQuerySchema = z.object({
  mode: z.literal("fullscreen"),
  feedType: z.enum(["for_you", "following"]).optional().default("for_you"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
  sessionId: z.string().optional(),
});

const viewBodySchema = z.object({
  type: z.enum(["impression", "qualified_view", "completion", "rewatch"]),
  watchedMs: z.number().int().min(0).optional(),
  sessionId: z.string().optional(),
});

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
  // For following feed, load followed creator IDs upfront
  const followedCreatorIds = new Set<string>();
  if (feedType === "following") {
    try {
      const { data: followRows } = await sc
        .from("user_follows")
        .select("following_id")
        .eq("follower_id", user.id);
      for (const r of (followRows as any[]) ?? []) followedCreatorIds.add(r.following_id as string);
    } catch { /* non-fatal */ }

    if (followedCreatorIds.size === 0) {
      res.json({ items: [], nextCursor: null, sessionId });
      return;
    }
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
    { viewerUserId: user.id, feedType, followedCreatorIds },
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

  // ── Rank candidates ────────────────────────────────────────────────────────
  const rankInput = eligible.map((c) => ({
    id: c.id,
    kind: "post" as const,
    createdAt: c.created_at,
    authorId: c.author_id,
    tags: Array.isArray(c.tags) ? c.tags.map((t: string) => t.toLowerCase()) : [],
    category: (c as any).category ?? null,
  }));

  const ranked = rankCandidates(rankInput, {
    userId: user.id,
    followedIds: followedCreatorIds,
    interestTags,
    seenIds,
  });

  // Map ranked IDs back to candidate rows
  const candidateById = new Map(eligible.map((c) => [c.id, c]));
  const rankedCandidates = ranked
    .map((r) => candidateById.get(r.candidate.id))
    .filter((c): c is MediaCandidate => c !== undefined);

  // ── Creator caps ───────────────────────────────────────────────────────────
  const capped = enforceCreatorCapsGeneric(
    rankedCandidates,
    (c) => c.author_id,
  );

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
    });
  });

  // ── Log impressions (fire-and-forget) ──────────────────────────────────────
  void (async () => {
    try {
      if (items.length === 0) return;
      const servedAt = new Date(nowMs).toISOString();
      const impressionRows = items.map((item, idx) => {
        const rankedItem = ranked.find((r) => r.candidate.id === item.id);
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
    } catch { /* non-fatal */ }
  })();

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

  res.json({ counted });
}));

export default router;
