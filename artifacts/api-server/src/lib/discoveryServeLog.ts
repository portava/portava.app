/**
 * discoveryServeLog — Stage 0 serve-point instrumentation for Discovery.
 *
 * WHY THIS EXISTS
 * ===============
 * `GET /discovery` has six paths that return places to a user. Exactly ONE of
 * them writes a `rank_events` row today (the cold-fetch legacy-rank path, via
 * logImpression at routes/discovery.ts:1433). The other five — both Cache A
 * layers, the stale-while-revalidate serve, the Compass candidate-cache hit and
 * the fresh Compass rank — respond and `return` before it.
 *
 * So there is no baseline. Any comparison of a new discovery engine against the
 * old one would be computed on the one serve point that scarcely ever executes.
 * Migration 0202_rank_events_live_page_watch_feed_surfaces.sql:17-21 records the
 * live confirmation: a production `SELECT surface, count(*) FROM rank_events`
 * returned only pulse / compass / events, with 'discovery' named among the
 * surfaces "written by the code but ZERO rows present" — and unlike living_page
 * and live_pulse, 'discovery' was already PERMITTED by the CHECK constraint
 * (0199:60, 0202:77). Its absence is not rejection. It is that path not running.
 *
 * This module gives every serve point a row, so the baseline describes what
 * users actually receive rather than one unrepresentative slice of it.
 *
 * INERT UNTIL SEEDED
 * ==================
 * Every write is gated on the `discovery_serve_log_enabled` flag, read through
 * `isFlagEnabled` — which is fail-closed, and returns false for a MISSING row.
 * The flag is deliberately not seeded by this change, so introducing this module
 * performs no production write of any kind and is behaviour-preserving. Turning
 * it on is a separate, deliberate step.
 *
 * ERRORS ARE LOGGED, NOT SWALLOWED
 * ================================
 * `logImpression` swallows insert failures silently. That is exactly how
 * living_page and watch_feed impressions were rejected by the surface CHECK for
 * an unknown period with the loss visible nowhere — the defect 0202 was written
 * to fix. This module logs a warning on failure so a rejected row is observable
 * instead of being lost on the floor. It still never throws: instrumentation
 * must not break a feed response.
 */
import { randomUUID } from "node:crypto";
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";
import { recordImpressionDistributionStats } from "../services/ranking/DiscoveryRankingService.js";

/** Feature flag gating every write in this module. Absent row ⇒ disabled. */
export const DISCOVERY_SERVE_LOG_FLAG = "discovery_serve_log_enabled";

/**
 * The six serve points of `GET /discovery`, numbered as in the Phase −1
 * repository proof (docs/discovery/phase-minus-1-repository-proof.md §1a).
 *
 * The number is recorded on every row. Without it the data reproduces exactly
 * the blindness it is meant to remove: a row saying only "discovery served
 * this" cannot distinguish a ranked cold fetch from an unranked cache hit,
 * which is the entire distinction under study.
 */
export const DiscoveryServePoint = {
  CACHE_A_L1:             1,
  CACHE_A_L2_FRESH:       2,
  CACHE_A_L2_STALE:       3,
  CACHE_B_HIT:            4,
  COMPASS_FRESH_RANK:     5,
  COLD_FETCH_LEGACY_RANK: 6,
  // Stage 0b — the rest of the discovery surface (ruling D4=C). None of these
  // ranks or caches; they are instrumented because the baseline must describe
  // everything users receive, not only what the flag will govern (D4=A).
  FEED:                   7,
  SEARCH:                 8,
  SUGGEST:                9,
  // GET /discovery/community — curated community places for a city. It returns
  // items to a caller and was the last uninstrumented serve point on the
  // surface, which made the D4=C baseline incomplete by exactly one route: the
  // comparison would have been computed on traffic that is not everything users
  // receive, which is the specific error D4=C exists to prevent.
  // Like 7-9 it runs no ranker, so it is NOT part of the D5 denominator.
  COMMUNITY:              10,
  // Stage 0c — the two discovery surfaces that live OUTSIDE routes/discovery*.
  // Both return ranked results to a user and neither wrote a rank_events row of
  // any kind, so a Discovery analytics query could not see them at all: not
  // their impressions, and therefore not their outcomes either (the outcome
  // route resolves an outcome by finding the impression it belongs to, so a
  // surface with no impression row can never record one).
  //
  // HIDDEN_GEMS — routes/hiddenGems.ts. GET /hidden-gems runs
  // HiddenGemDiscoveryService.discoverGems (verification weight + saves +
  // visits + vibe-tag match) and GET /hidden-gems/nearby runs findNearbyGems.
  // Both rank. Both are in RANKED_IN_REQUEST below.
  HIDDEN_GEMS:            11,
  // MAP_SEARCH — routes/mapSearch.ts GET /map/search. Merges travelers, gems
  // and events, then rankResults() orders them and paginate() cuts the served
  // page. Ranked in-request.
  MAP_SEARCH:             12,
} as const;

export type DiscoveryServePointId =
  (typeof DiscoveryServePoint)[keyof typeof DiscoveryServePoint];

/**
 * Serve points that ran a ranker during THIS request.
 *
 * Serve points 7-9 are absent deliberately, and not by oversight: feed, search
 * and suggest contain no ranker call at all. A grep of routes/discoverySearch.ts
 * for rankCandidates / rankItemsForDiscovery / drsRankItems / logImpression
 * returns nothing, and /discovery/feed merges Overpass and DB output with no
 * scoring step (routes/discovery.ts:1667-1683).
 */
const RANKED_IN_REQUEST = new Set<number>([
  DiscoveryServePoint.COMPASS_FRESH_RANK,
  DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
  // 11 and 12 DO rank during the request — discoverGems / findNearbyGems for
  // hidden gems, rankResults for map search — so they belong here, unlike 7-10.
  DiscoveryServePoint.HIDDEN_GEMS,
  DiscoveryServePoint.MAP_SEARCH,
]);

/**
 * The item_kind values the CHECK constraint accepts
 * (0153_add_rank_events.sql:18). NULL is also accepted — 0197 dropped the NOT
 * NULL — and is the correct value for a served entity that is none of these,
 * such as a city, country, language or hashtag result from search.
 */
export type RankItemKind = "post" | "event" | "plan" | "buddy" | "place" | "gem";

/** Minimal shape this module needs from a served item. */
export interface ServedItem {
  id: string;
  /**
   * Explicit kind. When omitted the id is used to infer place-vs-gem, which is
   * right for GET /discovery (every item there is a DiscoveryPlace) and wrong
   * for search, whose results are heterogeneous — so search passes this.
   */
  kind?: RankItemKind | null;
}

/**
 * Map a discovery search/suggest result `type` to an item_kind.
 *
 * Returns null for the taxonomic result types — hashtags, circles, stamps,
 * activities, cities, countries, languages, interests, vibes. These are real
 * served results and belong in the baseline, but none of them is one of the six
 * kinds the constraint allows, and inventing a kind for them would corrupt
 * every metric that groups by item_kind. NULL says "served, kind not
 * applicable", which is exactly true.
 */
export function searchTypeToItemKind(type: string): RankItemKind | null {
  switch (type) {
    // Plural forms: the /discovery/search and /discovery/suggest group types.
    case "travelers":
    case "buddies":     return "buddy";
    case "events":      return "event";
    case "trips":
    case "plans":       return "plan";
    case "places":      return "place";
    case "hidden_gems": return "gem";
    case "posts":       return "post";
    // Singular forms: MapSearchResult.resultType (lib/mapSearch.ts) uses
    // 'traveler' | 'gem' | 'event'. Mapped here rather than in a second
    // near-identical function so both surfaces classify one entity identically —
    // a map-search gem and a search-results gem must land on the same item_kind
    // or every per-kind rollup double-counts under two names.
    case "traveler":    return "buddy";
    case "gem":         return "gem";
    case "event":       return "event";
    case "place":       return "place";
    case "plan":
    case "trip":        return "plan";
    case "post":        return "post";
    default:            return null;
  }
}

export interface DiscoveryServeLogParams {
  userId:      string;
  servePoint:  DiscoveryServePointId;
  /** Items actually delivered to the client — after filtering AND pagination. */
  items:       readonly ServedItem[];
  /** Route path, for when Stage 0b widens this beyond GET /discovery. */
  route?:      string;
  sessionId?:  string;
  /** Free-form context, e.g. { destination, category }. Never coordinates. */
  context?:    Record<string, string | number | boolean | null>;
}

// ── Flag read, with a short TTL cache ─────────────────────────────────────────
// isFlagEnabled issues a DB round-trip per call. These writes happen after the
// response is flushed so latency is not the concern; query volume is. A 30s TTL
// mirrors compass/flags.ts:9 and keeps this to at most two reads a minute.

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Invalidate the flag cache. Exported for tests. */
export function invalidateServeLogFlagCache(): void {
  _flagCache = null;
}

async function serveLogEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) {
    return _flagCache.value;
  }
  const value = await isFlagEnabled(sc, DISCOVERY_SERVE_LOG_FLAG);
  _flagCache = { value, at: Date.now() };
  return value;
}

/**
 * Map a DiscoveryPlace id to an `item_kind` the CHECK constraint accepts.
 *
 * rank_events.item_kind is CHECK (item_kind IN ('post','event','plan','buddy',
 * 'place','gem')) — 0153_add_rank_events.sql:18. Discovery ids are either
 * "db/<uuid>" for curated DB places or an OSM element string such as
 * "node/12345678". This mirrors the mapping the cold path already uses at
 * routes/discovery.ts:1329 so both paths classify a given place identically.
 */
function itemKindFor(id: string): "gem" | "place" {
  return id.startsWith("db/") ? "gem" : "place";
}

/**
 * Write one `impression` row per served item.
 *
 * Fire-and-forget: call WITHOUT `await`, and only AFTER the response has been
 * sent. Never throws.
 */
export async function logDiscoveryServe(
  sc:     any,
  params: DiscoveryServeLogParams,
): Promise<void> {
  try {
    if (!sc) return;
    const { userId, servePoint, items, route, sessionId, context } = params;
    if (!userId || items.length === 0) return;

    if (!(await serveLogEnabled(sc))) return;

    const servedAt = new Date().toISOString();
    // One session id for the whole batch — mirrors the "single open" semantics
    // callers rely on for funnel reconstruction (lib/rankLog.ts:97-100).
    const effectiveSessionId = sessionId ?? randomUUID();

    const rows = items.map((item, idx) => ({
      user_id:    userId,
      item_id:    item.id,
      item_kind:  item.kind !== undefined ? item.kind : itemKindFor(item.id),
      position:   idx,
      features: {
        servePoint,
        route:  route ?? "GET /discovery",
        // Whether a ranker ran during THIS request. Serve point 4 replays a
        // stored Compass order and is deliberately `false`: the order came from
        // a ranker, but not from this request.
        rankedInRequest: RANKED_IN_REQUEST.has(servePoint),
        ...(context ?? {}),
      },
      outcome:    "impression",
      served_at:  servedAt,
      surface:    "discovery",
      session_id: effectiveSessionId,
    }));

    const { error } = await sc.from("rank_events").insert(rows);
    if (error) {
      // Deliberately NOT silent — see the module header.
      logger.warn(
        { err: error, servePoint, route, count: rows.length },
        "discoveryServeLog: impression insert rejected",
      );
    } else {
      // Exposure denominator — content_distribution_stats.eligible_impressions
      // mirrors the impression rows that landed (lib/rankLog.ts does the same
      // for the ranked writers). Still behind the flag above: with it off there
      // is no insert, so there is no increment either.
      await recordImpressionDistributionStats(sc, rows.map((r) => r.item_id), userId);
    }
  } catch (err) {
    logger.warn({ err }, "discoveryServeLog: impression insert threw");
  }
}
