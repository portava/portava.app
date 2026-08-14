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
    case "travelers":
    case "buddies":     return "buddy";
    case "events":      return "event";
    case "trips":
    case "plans":       return "plan";
    case "places":      return "place";
    case "hidden_gems": return "gem";
    case "posts":       return "post";
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
    }
  } catch (err) {
    logger.warn({ err }, "discoveryServeLog: impression insert threw");
  }
}
