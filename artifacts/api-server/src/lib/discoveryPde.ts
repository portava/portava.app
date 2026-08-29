/**
 * PDE — the Portava Discovery Engine. Ruling D5=B, ranking half.
 *
 * WHAT D5=B ACTUALLY SAYS, AND WHAT IT DOES NOT
 * =============================================
 * D5=B is not a new scoring formula. It is a change of SHAPE:
 *
 *     cache the user-independent CANDIDATES; rank per user on EVERY request.
 *
 * The ranker itself is deliberately the one this codebase already runs on the
 * authenticated cold-fetch path — portavaRank followed by the
 * DiscoveryRankingService re-rank. What changes under D5=B is not how a request
 * is ranked but HOW MANY requests are ranked at all.
 *
 * THE STRUCTURAL DEFECT THIS SPLITS, VERIFIABLE AT HEAD
 * ====================================================
 * Cache A in `routes/discovery.ts` is keyed by (destination, category, radius)
 * — user-independent, which is exactly right for a candidate set. But it is
 * consulted as a RESPONSE cache, not a candidate cache: `serveCachedPlaces`
 * merges, filters, slices and `res.json()`s, then returns. The request ends.
 * Every per-user ranking stage below it — portavaRank, DRS, the diversity and
 * exploration passes — is not skipped by a decision, it is simply never
 * reached.
 *
 * So one user's cold fetch populates the key, and for the next two hours every
 * other user of that key receives the raw Overpass order. User-independent
 * retrieval and inherently per-user ranking are fused into one cache entry, and
 * the entry is shared on the retrieval half's key.
 *
 * That claim is a statement about control flow. It is true at any traffic
 * volume, INCLUDING ZERO, which is why the D5 revisit clause could be resolved
 * on it (docs/discovery/discovery-engine-mode-packet.html#d5-resolution) while
 * the empirical magnitude question stays open and explicitly unanswered.
 *
 * WHAT THIS MODULE IS, PRECISELY
 * ==============================
 * The ranking half of that split, as a function of (candidates, viewer):
 *
 *     candidates  user-independent, supplied by the caller, cacheable on the
 *                 SAME key Cache A already uses
 *     viewer      per-user, never cacheable across users
 *
 * It does NOT retrieve. Not fetching is the point rather than an omission: the
 * whole reason D5=B is affordable is that it does not change external call
 * volume. Overpass is rate-limited, the candidate cache in front of it keeps its
 * 2-hour TTL, and PDE runs downstream of it on candidates the caller already
 * has in hand. An engine that retrieved for itself would multiply Overpass
 * traffic by exactly the factor D5=B was chosen to avoid.
 *
 * WHY IT IS AN EXTRACTION AND NOT A REIMPLEMENTATION (mechanic M2)
 * ===============================================================
 * The bodies below were MOVED out of the authenticated cold-fetch path in
 * routes/discovery.ts, which now calls this module. There is one ranking
 * pipeline in the tree, not two. A copy would drift from the original, and a
 * drifted copy would silently invalidate every shadow comparison the engine
 * exists to produce: divergence would no longer distinguish "PDE reaches more
 * traffic" from "the two implementations grew apart".
 *
 * `served` IS REQUIRED, AND IT IS ENFORCED BY THE CLIENT, NOT BY DISCIPLINE
 * ========================================================================
 * A run whose result no user receives must write nothing. Getting that wrong
 * would be wrong twice over: it would fabricate production impression rows for
 * a result NOBODY SAW, and it would put them in `rank_events` — the mutable,
 * client-input-adjacent table D7=A exists to keep shadow data OUT of — for the
 * full 90-day retention.
 *
 * Gating this module's own analytics calls is NOT sufficient, and the tests
 * caught that. `rankItems` in DiscoveryRankingService writes its own
 * `rank_events` rows, via `writeRankAnalyticAsync` at :768/:867/:879/:888 — an
 * ITEM_ELIGIBLE and an ITEM_SCORED row per candidate, plus boost and fatigue
 * rows. Those fire whenever it is handed a non-null client, and nothing at this
 * layer can ask it not to. A 20-place shadow run would have written 40+ rows
 * into the exact table the ruling forbids.
 *
 * So `served: false` does not merely skip our own emitters: it replaces the
 * client with one that CANNOT WRITE — every insert/upsert/update/delete and
 * every rpc is intercepted and counted instead of executed, for this module and
 * for everything it calls, however deep. Reads pass through untouched, so the
 * shadow run still sees the same flags, weights, activity scores and
 * underexposure data the serve path sees, and therefore still ranks
 * representatively.
 *
 * That is the difference between "we remembered to gate the writes" and "the
 * writes have nowhere to go". Only the second survives someone adding a new
 * write downstream.
 *
 * AUTHENTICATED VIEWERS ONLY
 * ==========================
 * PDE ranks for a known viewer. Anonymous discovery traffic has no viewer to
 * rank for, no follow graph and no interests, and `rank_events.user_id` is NOT
 * NULL (0153_add_rank_events.sql) so it cannot be observed either. Anonymous
 * requests keep the legacy unranked order; this module is not consulted.
 */
import { rankCandidates } from "./portavaRank.js";
import type { RankCandidate, ViewerContext, ScoredCandidate } from "./portavaRank.js";
import { rankItems as drsRankItems } from "../services/ranking/DiscoveryRankingService.js";
import type { RankingInput, RankingViewerContext } from "../services/ranking/DiscoveryRankingService.js";
import { emitCreatorCapAnalytics } from "../services/ranking/CreatorCapEnforcer.js";
import { emitFeedSlotAnalytics } from "../services/ranking/FeedSlotAllocator.js";

/**
 * The structural subset of a discovery place that ranking reads.
 *
 * Declared here rather than imported from `routes/discovery.ts` on purpose: a
 * lib that imports a route inverts the dependency and drags the whole Express
 * surface into every test of this engine. `DiscoveryPlace` satisfies this shape
 * structurally, and the generic below returns the caller's own type back, so
 * nothing is widened or lost in the round trip.
 */
export interface PdePlace {
  id: string;
  category?: string | null;
  distanceKm?: number | null;
  savedCount?: number | null;
  tags?: string[] | null;
  rating?: number | null;
  lat?: number | null;
  lng?: number | null;
  headerImageUrl?: string | null;
  description?: string | null;
}

/**
 * The per-user half of the split, loaded once per request.
 *
 * Everything here is viewer-specific and therefore may never be cached on the
 * candidate key. Keeping it in one struct is what makes that rule checkable by
 * reading rather than by remembering.
 */
export interface PdeViewer {
  userId: string;
  /** Lowercased city label, or null. Derived from the destination, not the user. */
  city: string | null;
  followedIds: Set<string>;
  interestTags: Set<string>;
  /**
   * Category → affinity in [0,1], NORMALISED (see normaliseCategoryAffinities).
   * Undefined when the viewer has too little signal to have a preference yet;
   * portavaRank then contributes 0 for this feature rather than guessing.
   */
  categoryAffinities?: Record<string, number>;
  /**
   * Place ids this viewer was recently shown on the DISCOVERY surface.
   * Empty when there is no impression history — portavaRank then applies no
   * penalty, which is the current behaviour.
   */
  seenIds?: Set<string>;
}

/**
 * How far back a discovery impression still counts as "seen".
 *
 * 24 hours: long enough that browsing a city and coming back an hour later does
 * not replay the same page, short enough that yesterday's session does not
 * permanently bury a place. Cache A's own TTL is 2 h, so this comfortably spans
 * the window in which the identical cached candidate set would be re-served.
 */
const SEEN_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Cap on the seen set. Ordered most-recent-first, so a heavy browser keeps the
 * impressions that matter and the query can never return an unbounded list.
 */
const SEEN_MAX_IDS = 500;

/**
 * Minimum total observations before ANY category affinity is applied.
 *
 * A single tap is not a preference. Below this floor the whole map is dropped
 * rather than scaled, because normalising one observation would hand it 1.0 —
 * the maximum possible affinity — on the strength of one action. This mirrors
 * the memory system's inferred-preference floor (migration 2195), which exists
 * for the same reason: acting on a single tap manufactures a trait the user
 * never expressed.
 */
const MIN_TOTAL_CATEGORY_OBSERVATIONS = 3;

/**
 * Turn `compass_user_preferences.category_weights` into the 0–1 affinities
 * portavaRank expects.
 *
 * WHY NORMALISATION IS THE WHOLE POINT
 * ------------------------------------
 * The stored value is a RAW OBSERVATION COUNT — production holds
 * `{"food": 4, "post": 1, "places": 10}`. portavaRank clamps with
 * `Math.min(1, Math.max(0, affinity))` (portavaRank.ts:277), so feeding raw
 * counts in would send every category with a count ≥ 1 to exactly 1.0. Every
 * candidate would then receive the identical `categoryAffinity` term, which
 * adds a constant to every score and therefore changes NO ordering at all —
 * reproducing the exact defect this change exists to fix, while looking like
 * the feature had been switched on.
 *
 * Dividing by the viewer's own maximum preserves the ordering that the counts
 * actually express (places 10 → 1.0, food 4 → 0.4, post 1 → 0.1) and lands in
 * the documented range. It is relative to the viewer, not global, so a heavy
 * user and a light user are treated alike.
 *
 * Keys are stored under BOTH their original and lowercased spelling: the
 * lookup at portavaRank.ts:276 uses `c.category` verbatim, and the candidate
 * category comes from place data whose casing this module does not control.
 */
export function normaliseCategoryAffinities(
  raw: unknown,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const counts: Array<[string, number]> = [];
  let total = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;   // absent/'0'/junk contribute nothing
    if (!key.trim()) continue;
    counts.push([key, n]);
    total += n;
  }

  if (counts.length === 0 || total < MIN_TOTAL_CATEGORY_OBSERVATIONS) return undefined;

  const max = Math.max(...counts.map(([, n]) => n));
  if (!(max > 0)) return undefined;

  const out: Record<string, number> = {};
  for (const [key, n] of counts) {
    const affinity = n / max;
    out[key] = affinity;
    out[key.toLowerCase()] = affinity;
  }
  return out;
}

export interface PdeRankOptions {
  /** Service client. Null is tolerated: ranking still runs, DRS degrades. */
  sc: any;
  /**
   * Whether this run's result is what the user receives. No default — the
   * caller must say which it is.
   *
   * `true`  the serve path. Production behaviour exactly: analytics emitted,
   *         client passed through untouched.
   * `false` the result reaches no user. Our analytics are skipped AND the
   *         client is wrapped so that no write can reach the database from
   *         here or from anything downstream. See the module header.
   */
  served: boolean;
}

/** Which stages actually ran. Absence and failure must stay distinguishable. */
export interface PdeStages {
  portavaRank: boolean;
  /** DRS re-rank completed and reordered. False if it errored or returned nothing. */
  drs: boolean;
  analytics: boolean;
  /**
   * Writes intercepted because `served` was false. A non-zero count is the
   * proof the suppressor is load-bearing rather than decorative: it is how many
   * production rows this run would have written had it been trusted to behave.
   */
  suppressedWrites: number;
}

// ── Write suppression ─────────────────────────────────────────────────────────

const WRITE_OPS = new Set(["insert", "upsert", "update", "delete"]);

/** A chainable, awaitable stand-in that performs nothing and resolves empty. */
function inertBuilder(): any {
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (onOk: any, onErr: any) =>
          Promise.resolve({ data: null, error: null, count: null, status: 200, statusText: "OK" })
            .then(onOk, onErr);
      }
      if (prop === "catch")   return () => b;
      if (prop === "finally") return (f: any) => { try { f?.(); } catch { /* ignore */ } return b; };
      return () => b;
    },
  });
  return b;
}

/**
 * Wrap a Supabase client so that every write is intercepted and counted rather
 * than executed, while reads pass through unchanged.
 *
 * `insert`/`upsert`/`update`/`delete` are methods on the builder returned by
 * `.from(table)`, so intercepting at that level catches every write, including
 * ones made by code this module merely calls. `rpc` is suppressed too — a
 * stored procedure is a write surface this layer cannot inspect, so a run that
 * must not write must not invoke one.
 *
 * Exported for direct testing: a safety device whose failure is silent has to
 * be tested on its own, not only through its callers.
 */
export function suppressWrites(sc: any, onSuppressed: () => void): any {
  if (!sc) return sc;
  return new Proxy(sc, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get(b, p) {
              if (typeof p === "string" && WRITE_OPS.has(p)) {
                return (..._args: unknown[]) => { onSuppressed(); return inertBuilder(); };
              }
              const v = (b as any)[p];
              return typeof v === "function" ? v.bind(b) : v;
            },
          });
        };
      }
      if (prop === "rpc") {
        return (..._args: unknown[]) => { onSuppressed(); return inertBuilder(); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export interface PdeRankOutcome<T extends PdePlace> {
  ranked: T[];
  /** place id → scored candidate, for impression logging on the served slice. */
  scoredById: Map<string, ScoredCandidate<RankCandidate>>;
  stages: PdeStages;
  timings: { portavaRankMs: number; drsMs: number; totalMs: number };
}

/**
 * Load the per-user inputs: follow graph and interest tags.
 *
 * Both reads are individually non-fatal and were so before this extraction. A
 * viewer whose follows fail to load is ranked as following nobody — degraded,
 * not broken — which is the correct trade for a feed request.
 */
export async function loadPdeViewer(
  sc: any,
  userId: string,
  city: string | null,
): Promise<PdeViewer> {
  const followedIds = new Set<string>();
  if (sc) {
    try {
      const { data: followRows } = await sc
        .from("user_follows")
        .select("following_id")
        .eq("follower_id", userId);
      for (const row of (followRows as any[]) ?? []) followedIds.add(row.following_id as string);
    } catch { /* non-fatal */ }
  }

  let interestTags = new Set<string>();
  let categoryAffinities: Record<string, number> | undefined;
  if (sc) {
    try {
      // category_weights rides the SAME select as interests — the learned
      // preference signal costs no extra round trip on a path that, under
      // D5=B, runs on every request rather than on the rare cache miss.
      const { data: prefRow } = await sc
        .from("compass_user_preferences")
        .select("interests, category_weights")
        .eq("user_id", userId)
        .maybeSingle();
      const interests: string[] = (prefRow as any)?.interests ?? [];
      interestTags = new Set(interests.map((t: string) => t.toLowerCase()));
      categoryAffinities = normaliseCategoryAffinities((prefRow as any)?.category_weights);
    } catch { /* non-fatal */ }
  }

  // Recent discovery impressions → portavaRank's seenPenalty (weight -0.6, the
  // largest-magnitude negative term in the model, and inert until now because
  // ViewerContext never carried seenIds).
  //
  // A PENALTY, not a filter: a viewer who has seen everything in a small city
  // still gets a full page, reordered. That is why an over-broad seen set
  // degrades ranking rather than emptying the feed.
  //
  // `item_id` here is the place id the serve log wrote (discoveryServeLog:209
  // `item_id: item.id`), which is the same id the candidate map uses, so this
  // matches rather than silently never firing. Indexed by
  // rank_events_user_served_at (user_id, served_at DESC); the surface filter is
  // applied on top. Non-fatal like the two reads above: a viewer whose history
  // fails to load is ranked with no penalty, which is exactly today's behaviour.
  let seenIds = new Set<string>();
  if (sc) {
    try {
      const since = new Date(Date.now() - SEEN_WINDOW_MS).toISOString();
      const { data: seenRows } = await sc
        .from("rank_events")
        .select("item_id")
        .eq("user_id", userId)
        .eq("surface", "discovery")
        .gte("served_at", since)
        .order("served_at", { ascending: false })
        .limit(SEEN_MAX_IDS);
      for (const row of (seenRows as any[]) ?? []) {
        if (row?.item_id) seenIds.add(row.item_id as string);
      }
    } catch { /* non-fatal */ }
  }

  return { userId, city, followedIds, interestTags, categoryAffinities, seenIds };
}

type PlaceCandidate<T extends PdePlace> = RankCandidate & { __place: T };

/**
 * Rank a user-independent candidate set for one viewer.
 *
 * Never throws. The DRS pass and the analytics emission are each individually
 * non-fatal, exactly as they were inline: on any error the portavaRank order is
 * preserved and returned. That property is load-bearing — under D5=B this runs
 * on every request rather than on the rare cache miss, so a throw here would be
 * a throw on the whole discovery surface.
 */
export async function rankForViewer<T extends PdePlace>(
  places: T[],
  viewer: PdeViewer,
  opts: PdeRankOptions,
): Promise<PdeRankOutcome<T>> {
  const t0 = Date.now();
  const stages: PdeStages = { portavaRank: false, drs: false, analytics: false, suppressedWrites: 0 };

  // On a run nobody receives, everything downstream gets a client that cannot
  // write. Reads are untouched, so the ranking stays representative.
  const sc = opts.served
    ? opts.sc
    : suppressWrites(opts.sc, () => { stages.suppressedWrites += 1; });

  const viewerContext: ViewerContext = {
    userId:       viewer.userId,
    city:         viewer.city ?? undefined,
    followedIds:  viewer.followedIds,
    interestTags: viewer.interestTags,
    // Was omitted, so f.categoryAffinity (weight 0.4) was a constant 0 for every
    // candidate on every request — the learned-preference input the ranker
    // documents but was never handed.
    categoryAffinities: viewer.categoryAffinities,
    // Was omitted, so f.seenPenalty was a constant 0 and nothing suppressed
    // repeats at the portavaRank layer.
    seenIds: viewer.seenIds,
  };

  // Map place → RankCandidate.
  // DB-backed places (id prefix "db/") are treated as gems (curated by hosts);
  // OSM places are kind "place". Both carry savedCount as the likeCount proxy.
  const candidates: PlaceCandidate<T>[] = places.map((p) => ({
    id:         p.id,
    kind:       p.id.startsWith("db/") ? "gem" as const : "place" as const,
    city:       viewer.city,
    category:   p.category ?? null,
    distanceKm: p.distanceKm ?? null,
    verified:   p.id.startsWith("db/") ? true : null,
    likeCount:  p.savedCount ?? null,
    tags:       (p.tags ?? []).map((t) => t.toLowerCase()),
    __place:    p,
  }));

  const prT0 = Date.now();
  const scored = rankCandidates(candidates, viewerContext);
  const portavaRankMs = Date.now() - prT0;
  stages.portavaRank = true;

  const scoredById = new Map<string, ScoredCandidate<RankCandidate>>(
    scored.map((s) => [(s.candidate as PlaceCandidate<T>).__place.id, s]),
  );
  const ranked: T[] = scored.map((s) => (s.candidate as PlaceCandidate<T>).__place);

  // ── DiscoveryRankingService re-ranking pass ────────────────────────────────
  // Applies activity boost, underexposure boost, and fatigue penalties on top of
  // the existing portavaRank score. Non-fatal; DRS returns items in input order
  // when it has nothing to say, so the portavaRank order survives by default.
  let drsMs = 0;
  const drsT0 = Date.now();
  try {
    const drsInputs: RankingInput[] = ranked.map((p) => ({
      itemId:             p.id,
      itemType:           p.id.startsWith("db/") ? "place" : "place",
      creatorId:          null,
      createdAt:          null,
      city:               p.id.startsWith("db/") ? viewer.city : null,
      country:            null,
      tags:               (p.tags ?? []).map((t) => t.toLowerCase()),
      category:           p.category ?? null,
      languageCode:       null,
      hasMedia:           !!(p.headerImageUrl),
      completeness:       p.headerImageUrl && p.description ? 0.9 : 0.5,
      positiveReviewRate: p.rating != null ? Math.min(1, (p.rating - 1) / 4) : null,
      flagCount:          0,
      saveCount:          p.savedCount ?? 0,
      shareCount:         0,
      commentCount:       0,
      impressionCount:    Math.max(1, p.savedCount ?? 1),
      uniqueViewerCount:  p.savedCount ?? 0,
      lat:                p.lat ?? null, lng: p.lng ?? null,
      distanceKm:         p.distanceKm ?? null,
      // EVERY eligibility input below is a constant, and that is deliberate.
      //
      // A discovery candidate is a PLACE, not authored content. The six
      // author-side checks (blocks, mute, hidden-creator, reported) have no
      // subject: `creatorId` is null above because the ranked projection does
      // not select `discovery_places.submitted_by`, and OSM rows have no author
      // at all. The four content-state checks and `isPrivate` are already
      // enforced upstream — both candidate queries filter `.eq("status",
      // "active")` (routes/discovery.ts:840 and :994) — so deriving them from
      // `status` here would re-encode a filter that already ran. Age and geo
      // restriction have no columns on either place table.
      //
      // So the gate cannot return ineligible on this surface, and the pair of
      // per-candidate rank_events rows it would emit records a decision with
      // one possible outcome. `emitPerCandidateAnalytics: false` below is what
      // stops us paying for them; the gate CALL stays, because it costs a few
      // boolean tests and is the safety net if these ever stop being constants.
      //
      // If you wire a real value into any field below, turn the analytics back
      // on in the same change — the guard test in test/discoveryPde.test.ts
      // fails until you do, on purpose.
      isDeleted: false, isExpired: false, isSuspended: false,
      isModerated: false, isPrivate: false,
      isAgeRestricted: false, minAgeRequired: null,
      isGeoRestricted: false, geoRestrictionCountries: null,
      authorIsBlockedByViewer: false, authorBlocksViewer: false,
      authorIsMutedByViewer: false,
      viewerHasReportedItem: false, viewerHasHiddenItem: false,
      viewerHasHiddenCreator: false,
      repeatCount: null, expiresAt: null, accountAgeDays: null,
      isUnfamiliarCategory: false, isFirstImpression: false,
    }));
    const drsViewer: RankingViewerContext = {
      viewerId:           viewer.userId,
      travelStyles:       [...viewer.interestTags],
      preferredLanguages: [],
      preferredCities:    [viewer.city ?? ""],
      currentCity:        viewer.city,
      currentCountry:     null,
      lat: null, lng: null, viewerAge: null,
      followedCreatorIds: viewer.followedIds,
      mutedCreatorIds:    new Set(),
      blockedCreatorIds:  new Set(),
      seenItemIds:        new Set(),
      sessionId:          null,
      lastActiveAt:       null,
    };
    const drsResults = await drsRankItems(
      drsInputs, "discovery", drsViewer, sc, {},
      { emitPerCandidateAnalytics: false },
    );
    if (drsResults.length > 0) {
      const drsOrder = new Map(drsResults.map((r, idx) => [r.itemId, idx]));
      ranked.sort((a, b) => {
        const aIdx = drsOrder.get(a.id) ?? ranked.length;
        const bIdx = drsOrder.get(b.id) ?? ranked.length;
        return aIdx - bIdx;
      });
      stages.drs = true;
    }

    // Assembly-phase analytics: creator-cap diversity pass + slot allocation.
    // Both calls are fire-and-forget side effects that emit rank_events rows;
    // they never affect feed order, response shape, or latency on error.
    //
    // GATED. A run whose result no user receives must not write an impression.
    if (opts.served) {
      try {
        const eligibleDrs  = drsResults.filter((r) => r.eligibilityPassed);
        const itemTypeMap  = new Map(drsInputs.map((i) => [i.itemId, i.itemType]));
        const creatorIdMap = new Map(drsInputs.map((i) => [i.itemId, i.creatorId]));
        const capEnforced  = emitCreatorCapAnalytics(
          eligibleDrs, itemTypeMap, creatorIdMap, "discovery", viewer.userId, null, sc,
        );
        emitFeedSlotAnalytics(capEnforced, drsInputs, "discovery", viewer.userId, null, sc);
        stages.analytics = true;
      } catch { /* non-fatal — assembly analytics must never affect the feed response */ }
    }
  } catch { /* non-fatal — portavaRank order preserved on DRS error */ }
  drsMs = Date.now() - drsT0;

  return {
    ranked,
    scoredById,
    stages,
    timings: { portavaRankMs, drsMs, totalMs: Date.now() - t0 },
  };
}
