/**
 * wall — the Portava Wall API (spec §26/§27).
 *
 *   GET    /wall?mode=for_you|following&cursor=&session_intent=   — the feed
 *   GET    /wall/live?limit=4                                     — live strip
 *   POST   /wall/session-intent   { text }                       — set intent
 *   DELETE /wall/session-intent                                  — clear intent
 *   POST   /wall/impression       { objectId, objectType, ... }  — impression
 *   POST   /wall/action           { objectId, objectType, action }— action
 *
 * This route is THIN. It authenticates, gates on the Wall feature flags, gathers
 * canonical candidates, and delegates every decision to a Wall service:
 *
 *   WallProjectionService  — eligibility/block/visibility gate + projection (§23/§24)
 *   WallRankingService     — For You ordering + stable cursor (§14/§28)
 *   FollowingFeedService   — strict reverse-chronology (§5/TABLE 1)
 *   LiveForYouService      — bounded personalized live strip (§4)
 *   WallSessionIntentService — temporary typed intent via Global Input Intel (§17)
 *
 * GRACEFUL DEGRADATION IS LOAD-BEARING (spec §34 / TABLE 5 / non-negotiable test
 * §40): every intelligence subsystem call is wrapped so that if ranking, live,
 * compass, place resolution or RAB is unavailable, a SAFE social feed still
 * returns. The one thing that never degrades to "make something up" is a live
 * label — a failed live read yields an empty strip, never a fabricated state.
 *
 * The whole surface is dark until `wall_enabled` is pressed (migration 2270);
 * with the flag off every route short-circuits before any canonical read.
 */
import { Router } from "express";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, sendError } from "../lib/http.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { isPostPublished } from "../lib/postVisibility.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { logger as rootLogger } from "../lib/logger.js";
import { RankingEvent } from "../services/ranking/rankingAnalytics.js";
import {
  projectObjects,
  attachContextThreads,
  type WallCandidate,
  type ProjectViewerContext,
} from "../services/wall/WallProjectionService.js";
import {
  loadPostcardCandidates,
  loadVideoMediaCandidates,
  loadSharedMomentCandidates,
  loadContextualOpportunityCandidates,
  mergeLoadedCandidates,
} from "../services/wall/WallCandidateLoaders.js";
import {
  applyFeedDiversity,
  DEFAULT_FEED_DIVERSITY_POLICY,
} from "../services/wall/WallDiversityService.js";
import {
  explainDiscovery,
  type DiscoveryViewerSignals,
} from "../services/wall/WallDiscoveryInsertionService.js";
import {
  rankForYou,
  decodeForYouCursor,
  encodeForYouCursor,
  type WallRankSignals,
  type WallRankViewer,
} from "../services/wall/WallRankingService.js";
import {
  buildFollowing,
  decodeFollowingCursor,
  encodeFollowingCursor,
} from "../services/wall/FollowingFeedService.js";
import {
  buildLiveForYou,
  MAX_LIVE_FOR_YOU,
  type LiveForYouCandidate,
} from "../services/wall/LiveForYouService.js";
import {
  parseIntent,
  getStoredIntent,
  setStoredIntent,
  clearStoredIntent,
} from "../services/wall/WallSessionIntentService.js";
import type {
  LiveForYouItem,
  PublicActorRef,
  PublicPlaceRef,
  StructuredIntent,
  WallObjectType,
  WallProjection,
  WallResponse,
} from "../lib/wallProjection.js";

const router = Router();
const logger = rootLogger.child({ route: "wall" });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;
/** How many candidates we fetch before gating/ranking. Bounded to keep the
 *  first server page fast (spec TABLE 4: < 500 ms backend). */
const CANDIDATE_FETCH = 150;

// `post_status` is the delayed-publish state machine (lib/postVisibility
// isPostPublished). It was never selected here, so the spine's only gate was
// `status = 'active'` — and POST /posts inserts a delayed-geotag post as
// status='active' + post_status='pending_*'. The Wall served those pending
// posts to every follower while the author was still at the place (§23/§37).
const POST_COLUMNS =
  "id, author_id, trip_id, content, visibility, status, post_status, created_at, published_at, " +
  "canonical_place_id, has_video, media_count, category, location_city, location_country, " +
  "like_count, comment_count, save_count";

// ── Local analytics (reuses the existing rank_events store; no Wall table) ────

/**
 * Record a Wall analytics row into the existing rank_events store, fire-and-
 * forget. Uses surface='wall' (a free-text provenance value, distinct from the
 * ranker's SurfaceName enum) and outcome='analytics' so it never collides with
 * the impression-finding query. Never throws; never blocks the response
 * (spec §37: rate-limited mutation endpoints; §32: no raw private content).
 */
function recordWallEvent(
  sc: SupabaseClient | null,
  eventType: string,
  itemId: string,
  contentType: string,
  viewerId: string,
  sessionId: string | null,
): void {
  if (!sc) return;
  try {
    void sc
      .from("rank_events")
      .insert({
        event_type: eventType,
        item_id: itemId,
        content_type: contentType,
        surface: "wall",
        user_id: viewerId,
        session_id: sessionId,
        served_at: new Date().toISOString(),
        outcome: "analytics",
      })
      .then(
        (res: { error?: unknown } | null) => {
          if (res?.error) logger.warn({ err: res.error, eventType }, "wall: rank_events insert rejected");
        },
        (err: unknown) => logger.warn({ err }, "wall: rank_events insert threw"),
      );
  } catch (err) {
    logger.warn({ err }, "wall: recordWallEvent failed");
  }
}

// ── Viewer context ────────────────────────────────────────────────────────────

interface WallViewerContext {
  followedCreatorIds: Set<string>;
  viewerTripIds: Set<string>;
  currentCity: string | null;
  currentCountry: string | null;
  // ── Discovery-explanation signals (spec §13). All lowercased where they are
  //    matched case-insensitively against candidate place cities / categories.
  /** Authors that people the viewer follows also follow (second-degree proof). */
  mutualFollowedAuthorIds: Set<string>;
  /** Lowercased destination cities of the viewer's upcoming/active trips. */
  upcomingTripCities: Set<string>;
  /** Lowercased preferred / home cities. */
  preferredCities: Set<string>;
  /** Lowercased interest tokens (categories the viewer cares about). */
  interests: Set<string>;
}

// Exported as a TEST SEAM only (see src/test/wallViewerLocationRead.test.ts).
// The Wall's viewer signals are read here and consumed only inside this module;
// without a seam the `profiles` select list can only be asserted through a full
// HTTP round-trip, which is how a nonexistent column in it went unnoticed.
export async function loadViewerContext(sc: any, viewerId: string): Promise<WallViewerContext> {
  const ctx: WallViewerContext = {
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
    currentCity: null,
    currentCountry: null,
    mutualFollowedAuthorIds: new Set<string>(),
    upcomingTripCities: new Set<string>(),
    preferredCities: new Set<string>(),
    interests: new Set<string>(),
  };
  // Each read is independent and fail-soft — a missing signal degrades ranking
  // quality, never the feed itself (spec §34).
  try {
    const { data } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId);
    for (const r of (data as any[]) ?? []) ctx.followedCreatorIds.add(String(r.following_id));
  } catch (err) {
    logger.warn({ err }, "wall: follow graph read failed");
  }
  try {
    const { data } = await sc
      .from("trip_members")
      .select("trip_id, status, role")
      .eq("user_id", viewerId);
    for (const r of (data as any[]) ?? []) {
      const status = (r as any).status;
      if (status == null || status === "accepted") ctx.viewerTripIds.add(String((r as any).trip_id));
    }
  } catch (err) {
    logger.warn({ err }, "wall: trip membership read failed");
  }
  try {
    // `current_country` DOES NOT EXIST on profiles — it is a column of
    // compass_user_profiles (migration 0051). Selecting it here failed the
    // WHOLE read with PGRST100, and the catch below swallowed that, so
    // BOTH fields were null on every request since this shipped: the Wall has
    // never known the viewer's city either.
    //
    // profiles carries current_city, country, location_country, home_country —
    // but no "current country". Rather than substitute one of those and assert
    // a fact the schema does not record, the country stays null and says so.
    // If the Wall needs it, the honest source is compass_user_profiles, which
    // is a different read with its own privacy posture.
    const { data, error } = await sc
      .from("profiles")
      .select("current_city, home_city, interests")
      .eq("id", viewerId)
      .maybeSingle();
    // A missing row is normal and silent. A rejected query is not — that is how
    // this was invisible for the life of the feature.
    if (error) {
      logger.warn(
        { err: error, code: (error as any)?.code, viewerId },
        "wall: viewer location read failed; the Wall will not know the viewer's city",
      );
    }
    ctx.currentCity = (data as any)?.current_city ?? null;
    // Both sides of this merge wanted more from this read. main added home_city
    // and interests; this branch had removed current_country because it DOES
    // NOT EXIST on profiles (it belongs to compass_user_profiles, migration
    // 0051). Verified again against the live schema during this merge:
    // current_city, home_city and interests are all real; current_country is
    // not.
    //
    // Keeping main's version verbatim would have kept the whole read failing
    // with PGRST100 — and made it worse, because four fields would then be
    // null instead of two. So main's INTENT is kept in full and only the
    // column that breaks the query is dropped.
    ctx.currentCountry = null;
    for (const c of [(data as any)?.current_city, (data as any)?.home_city]) {
      if (c) ctx.preferredCities.add(String(c).trim().toLowerCase());
    }
    for (const i of ((data as any)?.interests as unknown[] | undefined) ?? []) {
      if (typeof i === "string" && i.trim()) ctx.interests.add(i.trim().toLowerCase());
    }
  } catch (err) {
    logger.warn({ err }, "wall: viewer location read threw");
  }
  // Upcoming/active trip destination cities — a real-world discovery signal
  // (spec §13). Reads only the viewer's OWN trips, so nothing else leaks.
  try {
    const { data } = await sc
      .from("trips")
      .select("destination_city, status")
      .eq("owner_id", viewerId)
      .in("status", ["planning", "upcoming", "active"])
      .limit(50);
    for (const r of (data as any[]) ?? []) {
      const c = (r as any).destination_city;
      if (c) ctx.upcomingTripCities.add(String(c).trim().toLowerCase());
    }
  } catch (err) {
    logger.warn({ err }, "wall: upcoming trips read failed");
  }
  // Second-degree follows: authors that people the viewer follows also follow.
  // Powers the "followed by people you follow" discovery explanation (spec §13).
  try {
    const seeds = [...ctx.followedCreatorIds].slice(0, 200);
    if (seeds.length > 0) {
      const { data } = await sc
        .from("user_follows")
        .select("following_id")
        .in("follower_id", seeds)
        .limit(1000);
      for (const r of (data as any[]) ?? []) {
        const id = String((r as any).following_id);
        // Not the viewer, and not someone they already follow (that is not
        // "discovery" — it would already be in the primary set).
        if (id === viewerId || ctx.followedCreatorIds.has(id)) continue;
        ctx.mutualFollowedAuthorIds.add(id);
      }
    }
  } catch (err) {
    logger.warn({ err }, "wall: second-degree follow read failed");
  }
  return ctx;
}

// ── Candidate loading ──────────────────────────────────────────────────────────

interface LoadedCandidates {
  candidates: WallCandidate[];
  signals: Map<string, WallRankSignals>;
  /** canonicalObjectId → place ref (for live-strip candidate derivation). */
  placeByObject: Map<string, PublicPlaceRef>;
  /**
   * Following mode only: true when the followed-post fetch reached the TRUE end
   * of eligible content (returned fewer than CANDIDATE_FETCH rows). Undefined for
   * For You. buildFollowing requires this before reporting `caughtUp`, so a full
   * (capped) fetch never masquerades as "you're all caught up" (§27).
   */
  followingReachedEnd?: boolean;
}

function classifyObjectType(row: any, isOutsideGraph: boolean, discoveryEnabled: boolean): WallObjectType {
  if (isOutsideGraph && discoveryEnabled) return "discovery";
  if (row.has_video === true) return "video";
  if ((row.media_count ?? 0) > 0) return "social_post";
  return "social_update";
}

async function loadCandidates(
  sc: any,
  mode: "for_you" | "following",
  viewer: WallViewerContext,
  opts: { snapshotAtIso?: string; discoveryEnabled: boolean; followingCursorPublishedAt?: string },
): Promise<LoadedCandidates> {
  const empty: LoadedCandidates = { candidates: [], signals: new Map(), placeByObject: new Map() };
  const followed = [...viewer.followedCreatorIds];

  // Following: only followed authors. With no follows there is nothing to show —
  // and that IS the true end (caught up immediately).
  if (mode === "following" && followed.length === 0) return { ...empty, followingReachedEnd: true };

  let rows: any[] = [];
  let followingReachedEnd: boolean | undefined;
  try {
    // Primary set: followed authors (+ self is implicitly followable but the
    // author's own posts belong on their profile; the Wall's Following is other
    // people). For You starts from the same followed set.
    if (followed.length > 0) {
      let q = sc
        .from("posts")
        .select(POST_COLUMNS)
        .eq("status", "active")
        // Delayed-publish gate — the same DB predicate the Following / global
        // feeds apply (routes/posts.ts). Re-checked in memory below.
        .eq("post_status", "published")
        .in("author_id", followed.slice(0, 500))
        .order("created_at", { ascending: false })
        .limit(CANDIDATE_FETCH);
      if (opts.snapshotAtIso) q = q.lte("created_at", opts.snapshotAtIso);
      // Following pagination: slide the fetch window down to the cursor so older
      // followed posts past the first CANDIDATE_FETCH are actually reachable (the
      // window is inclusive; buildFollowing re-applies the precise after-cursor
      // filter). Without this the fetch was frozen at the newest 150 and the tail
      // was unreachable — and falsely reported as "caught up".
      if (mode === "following" && opts.followingCursorPublishedAt) {
        q = q.lte("created_at", opts.followingCursorPublishedAt);
      }
      const { data } = await q;
      const primary = (data as any[]) ?? [];
      // True end of the followed spine iff the fetch came back short of its cap.
      if (mode === "following") followingReachedEnd = primary.length < CANDIDATE_FETCH;
      rows = primary.map((r) => ({ ...r, __outside: false }));
    }

    // For You may reach outside the follow graph (discovery), but only when the
    // discovery-insertions phase flag is on (spec §13 / Phase 4).
    if (mode === "for_you" && opts.discoveryEnabled) {
      let q = sc
        .from("posts")
        .select(POST_COLUMNS)
        .eq("status", "active")
        .eq("post_status", "published")
        .eq("visibility", "public")
        .order("created_at", { ascending: false })
        .limit(CANDIDATE_FETCH);
      if (opts.snapshotAtIso) q = q.lte("created_at", opts.snapshotAtIso);
      const { data } = await q;
      const followedSet = viewer.followedCreatorIds;
      for (const r of (data as any[]) ?? []) {
        if (followedSet.has(String(r.author_id))) continue; // already in primary set
        rows.push({ ...r, __outside: true });
      }
    }
  } catch (err) {
    logger.warn({ err }, "wall: candidate posts read failed — returning empty candidate set");
    return empty;
  }

  if (rows.length === 0) return { ...empty, followingReachedEnd };

  // In-memory re-check of the delayed-publish gate (same predicate as the query
  // filter above): a row fed past the DB filter must still never be served.
  rows = rows.filter((r) => isPostPublished(r));

  // Dedupe by post id (a post could appear in both queries).
  const byId = new Map<string, any>();
  for (const r of rows) if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  const uniqueRows = [...byId.values()];

  // Batch-load author profiles (actor + eligibility) and places (refs).
  const authorIds = [...new Set(uniqueRows.map((r) => String(r.author_id)))];
  const placeIds = [
    ...new Set(uniqueRows.map((r) => r.canonical_place_id).filter((x): x is string => !!x)),
  ];

  const profileById = new Map<string, any>();
  const placeById = new Map<string, PublicPlaceRef>();
  try {
    if (authorIds.length > 0) {
      const { data } = await sc
        .from("profiles")
        .select("id, display_name, username, avatar_url, account_status")
        .in("id", authorIds.slice(0, 500));
      for (const p of (data as any[]) ?? []) profileById.set(String(p.id), p);
    }
  } catch (err) {
    logger.warn({ err }, "wall: author profile batch read failed");
  }
  try {
    if (placeIds.length > 0) {
      const { data } = await sc
        .from("places")
        .select("id, name, city, country_code")
        .in("id", placeIds.slice(0, 500));
      for (const pl of (data as any[]) ?? []) {
        placeById.set(String(pl.id), {
          placeId: String(pl.id),
          name: String(pl.name ?? "Place"),
          city: pl.city ?? null,
          country: pl.country_code ?? null,
          // Coordinates deliberately omitted from the Wall place ref (spec §23):
          // the feed never needs a venue coordinate, and omitting it removes any
          // risk of a coarse/protected place leaking one.
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "wall: place batch read failed");
  }

  // Permitted-gem lookup for discovery explanations (spec §13/§20): a place is a
  // "permitted Hidden Gem" only when its disclosure policy is public/approximate.
  // Protected / reveal-after-* gems are NEVER surfaced as a discovery reason.
  const permittedGemPlaceIds = new Set<string>();
  if (opts.discoveryEnabled && placeIds.length > 0) {
    try {
      const { data } = await sc
        .from("hidden_gems")
        .select("canonical_place_id, sensitivity_level, status")
        .in("canonical_place_id", placeIds.slice(0, 500))
        .eq("status", "active");
      for (const g of (data as any[]) ?? []) {
        const pid = g.canonical_place_id ? String(g.canonical_place_id) : null;
        const sens = String(g.sensitivity_level ?? "public");
        if (pid && (sens === "public" || sens === "approximate")) permittedGemPlaceIds.add(pid);
      }
    } catch (err) {
      logger.warn({ err }, "wall: hidden gem batch read failed");
    }
  }

  const discoveryViewer: DiscoveryViewerSignals = {
    mutualFollowedAuthorIds: viewer.mutualFollowedAuthorIds,
    tripCities: viewer.upcomingTripCities,
    currentCity: viewer.currentCity,
    preferredCities: viewer.preferredCities,
    interests: viewer.interests,
  };

  const candidates: WallCandidate[] = [];
  const signals = new Map<string, WallRankSignals>();
  const placeByObject = new Map<string, PublicPlaceRef>();

  for (const r of uniqueRows) {
    const id = String(r.id);
    const authorId = String(r.author_id);
    const prof = profileById.get(authorId);
    const isOutside = r.__outside === true;
    const objectType = classifyObjectType(r, isOutside, opts.discoveryEnabled);
    const placeRef = r.canonical_place_id ? placeById.get(String(r.canonical_place_id)) ?? null : null;

    // Discovery insertions MUST be socially explained (spec §13) — an outside-
    // graph object with no social explanation is NOT a naked directory listing;
    // it is simply dropped. Followed-graph objects are never subject to this.
    let discoveryReason: string | null = null;
    if (objectType === "discovery") {
      const explanation = explainDiscovery(
        {
          authorId,
          placeCity: placeRef?.city ?? r.location_city ?? null,
          placeCountry: placeRef?.country ?? r.location_country ?? null,
          category: r.category ?? null,
          likeCount: Number(r.like_count ?? 0),
          saveCount: Number(r.save_count ?? 0),
          commentCount: Number(r.comment_count ?? 0),
          createdAt: String(r.created_at ?? r.published_at ?? ""),
          isPermittedHiddenGem: placeRef ? permittedGemPlaceIds.has(placeRef.placeId) : false,
        },
        discoveryViewer,
      );
      if (!explanation) continue; // drop unexplained outside-graph object
      discoveryReason = explanation.reason;
    }

    const actor: PublicActorRef | undefined = prof
      ? {
          userId: authorId,
          displayName: String(prof.display_name ?? prof.username ?? "Traveler"),
          handle: prof.username ?? null,
          avatarUrl: prof.avatar_url ?? null,
        }
      : undefined;

    candidates.push({
      objectType,
      canonicalObjectId: id,
      authorId,
      visibility: r.visibility ?? null,
      tripId: r.trip_id ?? null,
      publishedAt: String(r.published_at ?? r.created_at),
      text: r.content ?? null,
      place: placeRef,
      actor,
      authorAccountStatus: prof?.account_status ?? "active",
      isDeleted: false,
      discoveryReason,
    });

    signals.set(id, {
      category: r.category ?? null,
      city: r.location_city ?? null,
      country: r.location_country ?? null,
      saveCount: Number(r.save_count ?? 0),
      isFirstImpression: true,
    });
    if (placeRef) placeByObject.set(id, placeRef);
  }

  return { candidates, signals, placeByObject, followingReachedEnd };
}

// ── Intent steering (temporary; never changes saved preferences, spec §17) ───

/**
 * Softly bias the candidate set toward the session intent. A `city` filter keeps
 * matching-city candidates; keywords keep candidates whose text matches. If a
 * filter would empty the feed it is NOT applied — steering must never turn the
 * Wall into a zero-result page (spec §1: enjoyable as pure social media).
 */
function applyIntentSteer(candidates: WallCandidate[], intent: StructuredIntent | undefined): WallCandidate[] {
  if (!intent) return candidates;
  let out = candidates;
  const cityFilter = intent.filters.find((f) => f.kind === "city");
  if (cityFilter?.label) {
    const want = cityFilter.label.toLowerCase();
    const matched = out.filter((c) => (c.place?.city ?? "").toLowerCase().includes(want));
    if (matched.length > 0) out = matched;
  }
  if (intent.keywords.length > 0) {
    const kws = intent.keywords.map((k) => k.toLowerCase());
    const matched = out.filter((c) => {
      const t = (c.text ?? "").toLowerCase();
      return kws.some((k) => t.includes(k));
    });
    if (matched.length > 0) out = matched;
  }
  return out;
}

// ── Live strip assembly (shared by GET /wall and GET /wall/live) ─────────────

async function buildLiveStrip(
  sc: any,
  liveEnabled: boolean,
  candidates: LiveForYouCandidate[],
  opts: { limit: number; dedupeSubjectIds?: Set<string> },
): Promise<LiveForYouItem[]> {
  if (!liveEnabled) return [];
  try {
    return await buildLiveForYou(sc, candidates, {
      limit: opts.limit,
      dedupeSubjectIds: opts.dedupeSubjectIds,
    });
  } catch (err) {
    logger.warn({ err }, "wall: live strip build failed — degrading to empty");
    return [];
  }
}

// ── Schemas ────────────────────────────────────────────────────────────────

const wallQuerySchema = z.object({
  mode: z.enum(["for_you", "following"]).optional().default("for_you"),
  cursor: z.string().max(4096).optional(),
  session_intent: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const sessionIntentSchema = z.object({ text: z.string().min(1).max(120) });

const impressionSchema = z.object({
  objectId: z.string().min(1).max(200),
  objectType: z.string().min(1).max(40),
  session: z.string().max(200).optional(),
});

const actionSchema = z.object({
  objectId: z.string().min(1).max(200),
  objectType: z.string().min(1).max(40),
  action: z.enum(["open", "tap", "save", "hide", "report", "follow", "share"]),
  session: z.string().max(200).optional(),
});

// ── GET /wall ────────────────────────────────────────────────────────────────

router.get(
  "/wall",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }

    const parsed = wallQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "Invalid Wall query");
      return;
    }
    const { mode, cursor, session_intent } = parsed.data;
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;

    const [inputIntelEnabled, discoveryEnabled, liveEnabled, compassHandoffEnabled, rabEnabled] =
      await Promise.all([
        isFlagEnabled(sc, "wall_input_intelligence_enabled"),
        isFlagEnabled(sc, "wall_discovery_insertions_enabled"),
        isFlagEnabled(sc, "wall_live_for_you_enabled"),
        isFlagEnabled(sc, "wall_compass_handoff_enabled"),
        isFlagEnabled(sc, "wall_rab_integration_enabled"),
      ]);

    const viewer = await loadViewerContext(sc, user.id);

    // ── Session intent (spec §17). A per-request `session_intent` query param is
    //    a TEMPORARY steer (parsed fresh, not persisted); otherwise the stored
    //    intent applies. Both are ignored unless the phase flag is on.
    let sessionIntent: StructuredIntent | undefined;
    if (inputIntelEnabled) {
      try {
        if (session_intent && session_intent.trim()) {
          sessionIntent = await parseIntent(sc, user.id, session_intent, {
            city: viewer.currentCity,
          });
        } else {
          sessionIntent = (await getStoredIntent(sc, user.id)) ?? undefined;
        }
      } catch (err) {
        logger.warn({ err }, "wall: session intent resolution failed");
        sessionIntent = undefined;
      }
    }

    // ── For You cursor carries the rank session snapshot so pages don't drift.
    const forYouCursor = mode === "for_you" && cursor ? decodeForYouCursor(cursor) : null;
    const followingCursor = mode === "following" && cursor ? decodeFollowingCursor(cursor) : null;

    const loaded = await loadCandidates(sc, mode, viewer, {
      snapshotAtIso: forYouCursor?.snapshotAt,
      discoveryEnabled,
      // Following pagination slides its fetch window down to the cursor so the
      // tail past CANDIDATE_FETCH is reachable (and `caughtUp` stays honest).
      followingCursorPublishedAt: followingCursor?.publishedAt,
    });

    // ── Supplementary object types (spec §6): Postcards (§10), video/media (§11)
    //    and Shared Moments (§12). Each loader is independent and fail-soft
    //    (spec §34): it degrades to an empty set on any failure, so it costs the
    //    feed one object TYPE, never the feed. They fetch OTHER canonical rows
    //    (or the same posts with real media) and are merged + deduped into the
    //    Post spine, which is left untouched. Every merged candidate still runs
    //    through the SAME eligibility → block → visibility gate below.
    const loaderViewer = { viewerId: user.id, followedCreatorIds: viewer.followedCreatorIds };
    // Freeze the supplementary loaders to the SAME For You created-at horizon as
    // the Post spine (loadCandidates, above) so a postcard/video/moment published
    // mid-session cannot enter the candidate set and drift ranks across pages
    // (§28). Following mode has no horizon (forYouCursor is null) and is unaffected.
    const loaderOpts = { snapshotAtIso: forYouCursor?.snapshotAt };
    // RAB contextual opportunities (§19) are For You only: Following is the
    // strict-chronology trust anchor of followed PEOPLE's content (TABLE 1) and
    // an availability signal is not a post. The loader re-reads BOTH flags
    // itself (fail-closed); the route's `rabEnabled` short-circuits the call.
    const opportunityViewer = {
      ...loaderViewer,
      currentCity: viewer.currentCity,
      upcomingTripCities: viewer.upcomingTripCities,
      interests: viewer.interests,
    };
    const emptyLoad = () => ({ candidates: [], signals: new Map(), placeByObject: new Map() });
    const [postcardsLoaded, mediaLoaded, momentsLoaded, opportunitiesLoaded] = await Promise.all([
      loadPostcardCandidates(sc, mode, loaderViewer, loaderOpts).catch((err) => {
        logger.warn({ err }, "wall: postcard loader threw — no postcards");
        return emptyLoad();
      }),
      loadVideoMediaCandidates(sc, user.id, loaderOpts).catch((err) => {
        logger.warn({ err }, "wall: video/media loader threw — no media objects");
        return emptyLoad();
      }),
      loadSharedMomentCandidates(sc, user.id, loaderOpts).catch((err) => {
        logger.warn({ err }, "wall: shared moment loader threw — no moments");
        return emptyLoad();
      }),
      mode === "for_you" && rabEnabled
        ? loadContextualOpportunityCandidates(sc, opportunityViewer, loaderOpts).catch((err) => {
            logger.warn({ err }, "wall: RAB opportunity loader threw — no buddy opportunities");
            return emptyLoad();
          })
        : Promise.resolve(emptyLoad()),
    ]);
    const merged = mergeLoadedCandidates(loaded, postcardsLoaded, mediaLoaded, momentsLoaded, opportunitiesLoaded);

    const steered = applyIntentSteer(merged.candidates, sessionIntent);

    // ── Gate + project (eligibility/block/visibility BEFORE ordering, §23/§24).
    const projectViewer: ProjectViewerContext = {
      viewerId: user.id,
      viewerTripIds: viewer.viewerTripIds,
      followedCreatorIds: viewer.followedCreatorIds,
      compassHandoffEnabled,
    };
    let projections: WallProjection[] = [];
    try {
      projections = await projectObjects(sc, steered, projectViewer);
    } catch (err) {
      logger.warn({ err }, "wall: projection failed — empty social feed (safe)");
      projections = [];
    }

    // ── Order per mode.
    let items: WallProjection[] = [];
    let nextCursor: string | undefined;
    let caughtUp: boolean | undefined;

    if (mode === "following") {
      const built = buildFollowing(projections, {
        limit,
        cursor: followingCursor,
        // Only claim "caught up" when the followed-post fetch actually reached the
        // end — never merely because a capped 150-row window was exhausted (§27).
        reachedEnd: loaded.followingReachedEnd,
      });
      items = built.items;
      caughtUp = built.caughtUp;
      nextCursor = built.nextCursor ? encodeFollowingCursor(built.nextCursor) : undefined;
    } else {
      const rankViewer: WallRankViewer = {
        viewerId: user.id,
        currentCity: viewer.currentCity,
        currentCountry: viewer.currentCountry,
        followedCreatorIds: viewer.followedCreatorIds,
      };
      const built = await rankForYou(sc, projections, rankViewer, {
        limit,
        cursor: forYouCursor,
        signals: merged.signals,
      });
      items = built.items;
      nextCursor = built.nextCursor ? encodeForYouCursor(built.nextCursor) : undefined;

      // ── Feed Diversity Controller (For You only, spec §15). Reorders to
      //    prevent one-creator floods / five-videos-in-a-row / a wall of
      //    annotations, and prunes over-budget discovery insertions so For You
      //    never becomes a disguised Discovery page. Following is a strict-
      //    chronology trust anchor and is deliberately NOT reordered.
      const diversified = applyFeedDiversity(items, DEFAULT_FEED_DIVERSITY_POLICY);
      items = diversified.items;
    }

    // ── Live For You strip: bounded, deduped against the feed's places (§4).
    const feedSubjectIds = new Set<string>();
    const liveCandidates: LiveForYouCandidate[] = [];
    for (const it of items) {
      const placeRef = it.place ?? merged.placeByObject.get(it.canonicalObjectId);
      if (placeRef) {
        feedSubjectIds.add(placeRef.placeId);
        liveCandidates.push({ subjectId: placeRef.placeId, liveObjectType: "place_state", subject: placeRef });
      }
    }
    // Dedup the live strip against subjects ALREADY shown as feed objects (§4:
    // do not repeat a live signal that already appears in the feed).
    const liveForYou = await buildLiveStrip(sc, liveEnabled, liveCandidates, {
      limit: MAX_LIVE_FOR_YOU,
      dedupeSubjectIds: feedSubjectIds,
    });

    // ── Context Threads (spec §8/§9): attach an OPTIONAL compact bridge beneath
    //    an object ONLY where the §9 gate says it earns its place. Behind
    //    wall_context_threads_enabled (checked once in attachContextThreads).
    //    Dedups against the Live For You strip (§4/§15) and caps annotations per
    //    window (§15 maxContextThreadsInWindow). Runs in both modes.
    const liveStripSubjectIds = new Set<string>(liveForYou.map((i) => i.subjectId));
    try {
      items = await attachContextThreads(sc, items, projectViewer, {
        maxContextThreadsInWindow: DEFAULT_FEED_DIVERSITY_POLICY.maxContextThreadsInWindow,
        liveStripSubjectIds,
        rabEnabled,
      });
    } catch (err) {
      logger.warn({ err }, "wall: context thread attach failed — items unannotated");
    }

    const body: WallResponse = {
      mode,
      sessionIntent,
      liveForYou,
      items,
      nextCursor,
      caughtUp,
      generatedAt: new Date().toISOString(),
    };
    res.status(200).json(body);
  }),
);

// ── GET /wall/live ───────────────────────────────────────────────────────────

router.get(
  "/wall/live",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }
    const liveEnabled = await isFlagEnabled(sc, "wall_live_for_you_enabled");

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(Math.trunc(limitRaw), MAX_LIVE_FOR_YOU))
      : MAX_LIVE_FOR_YOU;

    // Live-strip candidates are the places from the viewer's recent followed
    // content — a viewer-relevant, bounded set, NOT a city-wide scan (spec §4).
    const viewer = await loadViewerContext(sc, user.id);
    const loaded = await loadCandidates(sc, "following", viewer, { discoveryEnabled: false });
    const seen = new Set<string>();
    const candidates: LiveForYouCandidate[] = [];
    for (const [, placeRef] of loaded.placeByObject) {
      if (seen.has(placeRef.placeId)) continue;
      seen.add(placeRef.placeId);
      candidates.push({ subjectId: placeRef.placeId, liveObjectType: "place_state", subject: placeRef });
    }

    const liveForYou = await buildLiveStrip(sc, liveEnabled, candidates, { limit });
    res.status(200).json({ liveForYou, generatedAt: new Date().toISOString() });
  }),
);

// ── POST /wall/session-intent ────────────────────────────────────────────────

router.post(
  "/wall/session-intent",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }
    if (!(await isFlagEnabled(sc, "wall_input_intelligence_enabled"))) {
      sendError(res, "feature_disabled", "Wall input intelligence is not enabled");
      return;
    }

    const parsed = sessionIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "Session intent text is required");
      return;
    }

    const rl = checkRateLimit("wall_session_intent", user.id, 30, 60_000);
    if (!rl.allowed) {
      sendError(res, "rate_limited", "Too many intent updates. Please wait.");
      return;
    }

    const viewer = await loadViewerContext(sc, user.id);
    const intent = await parseIntent(sc, user.id, parsed.data.text, { city: viewer.currentCity });
    await setStoredIntent(sc, user.id, intent, parsed.data.text);
    res.status(200).json({ sessionIntent: intent });
  }),
);

// ── DELETE /wall/session-intent ──────────────────────────────────────────────

router.delete(
  "/wall/session-intent",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }
    await clearStoredIntent(sc, user.id);
    res.status(200).json({ cleared: true });
  }),
);

// ── POST /wall/impression ────────────────────────────────────────────────────

router.post(
  "/wall/impression",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }

    const parsed = impressionSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "objectId and objectType are required");
      return;
    }
    // Rate-limit mutation endpoints (spec §37): a generous window that stops
    // impression flooding / self-engagement manipulation without hurting real use.
    const rl = checkRateLimit("wall_impression", user.id, 600, 60_000);
    if (!rl.allowed) {
      sendError(res, "rate_limited", "Too many impressions. Please slow down.");
      return;
    }

    recordWallEvent(
      sc,
      RankingEvent.ITEM_IMPRESSION,
      parsed.data.objectId,
      parsed.data.objectType,
      user.id,
      parsed.data.session ?? null,
    );
    res.status(202).json({ ok: true });
  }),
);

// ── POST /wall/action ────────────────────────────────────────────────────────

const ACTION_EVENT: Record<string, string> = {
  open: RankingEvent.ITEM_OPENED,
  tap: RankingEvent.ITEM_OPENED,
  save: RankingEvent.ITEM_SAVED,
  hide: RankingEvent.ITEM_HIDDEN,
  report: RankingEvent.ITEM_REPORTED,
  follow: RankingEvent.ITEM_OPENED,
  share: RankingEvent.ITEM_OPENED,
};

router.post(
  "/wall/action",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client: sc, user } = auth;

    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }

    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "objectId, objectType and a valid action are required");
      return;
    }
    const rl = checkRateLimit("wall_action", user.id, 300, 60_000);
    if (!rl.allowed) {
      sendError(res, "rate_limited", "Too many actions. Please slow down.");
      return;
    }

    const eventType = ACTION_EVENT[parsed.data.action] ?? RankingEvent.ITEM_OPENED;
    recordWallEvent(sc, eventType, parsed.data.objectId, parsed.data.objectType, user.id, parsed.data.session ?? null);
    res.status(202).json({ ok: true });
  }),
);

export default router;
