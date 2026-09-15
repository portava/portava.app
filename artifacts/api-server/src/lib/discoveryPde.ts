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
 * `rank_events` rows, via `writeRankAnalyticAsync` at
 * `services/ranking/DiscoveryRankingService.ts:985,1110,1123,1132#writeRankAnalyticAsync`
 * — an ITEM_ELIGIBLE and an ITEM_SCORED row per candidate, plus boost and
 * fatigue rows. Those fire whenever it is handed a non-null client, and nothing
 * at this layer can ask it not to. A 20-place shadow run would have written 40+
 * rows into the exact table the ruling forbids.
 *
 * (Those four numbers read :768/:867/:879/:888 until 2026-09-05, by which time
 * every one of them was 100+ lines out, and :871/:991/:1004/:1013 until
 * 2026-09-07, when the C2 three-state creator-activity read added ~115 lines
 * above them. That is why this file is in the COVERED
 * registry of `artifacts/api-server/scripts/check-doc-citations.mjs`: the
 * anchored form above is executable, so the next time the call sites move, the
 * check goes red instead of the comment quietly becoming fiction.)
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
import { rankCandidates, normaliseGeoLabel } from "./portavaRank.js";
import type { RankCandidate, ViewerContext, ScoredCandidate } from "./portavaRank.js";
import { rankItems as drsRankItems } from "../services/ranking/DiscoveryRankingService.js";
import type { RankingInput, RankingViewerContext } from "../services/ranking/DiscoveryRankingService.js";
import { emitCreatorCapAnalytics } from "../services/ranking/CreatorCapEnforcer.js";
import {
  emitFeedSlotAnalytics, allocateExplorationBudget,
  type GovernorCandidate, type GovernorOutcome,
} from "../services/ranking/FeedSlotAllocator.js";
import { buildPlaceAffinities } from "../services/ranking/MediaFeedRankingService.js";
import {
  loadDiscoveryModifiers, inertModifiers,
  type DiscoveryModifiers, type ModifiersReason,
} from "./discoveryModifiers.js";
import { loadSequenceFeatures, type DiscoverySequenceFeatures } from "./discoverySequenceFeatures.js";
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
  /**
   * placeId → recent place_view count (last 30d). Feeds portavaRank's ×1.15
   * place-engagement boost (PLACE_ENGAGEMENT_BOOST), which was a designed signal
   * that never fired because ViewerContext never carried it and the candidate
   * map never set placeId. Empty when the viewer has no place-view history —
   * then the boost contributes nothing, which is a safe default.
   */
  placeAffinities?: Record<string, number>;
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
  /**
   * ROADMAP step 7/8 modifiers, pre-assembled. Omit and they are loaded here
   * (one cached flag read; nothing else with the flag off). Tests inject a
   * record to exercise the ON path without a flag row.
   */
  modifiers?: DiscoveryModifiers;
  /**
   * Candidate-set key (destination:category — Cache A's key) for the momentum
   * cache. Omit and one is derived from the candidate ids, which is the same
   * identity, slower to compute.
   */
  candidateKey?: string;
  /** Epoch ms; injectable so the governor's seeded allocation is testable. */
  nowMs?: number;
}

/** Which stages actually ran. Absence and failure must stay distinguishable. */
export interface PdeStages {
  portavaRank: boolean;
  /** DRS re-rank completed and reordered. False if it errored or returned nothing. */
  drs: boolean;
  analytics: boolean;
  /** Why the modifiers were on or off for this run. */
  modifiers: ModifiersReason;
  /**
   * `applied`  the governor reordered the page (modifiers on)
   * `observed` it computed an allocation and recorded it, order untouched
   * `skipped`  the modifiers are OFF (the stage does not run at all), too few
   *            candidates to govern, or the stage threw
   *
   * `observed` is reachable only with the modifiers ON — see the governor block
   * for why the OFF path may not so much as compute an allocation.
   */
  governor: "applied" | "observed" | "skipped";
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
  /** The modifiers this run ranked under (inert with the flag off). */
  modifiers: DiscoveryModifiers;
  /**
   * The governor's allocation — reason codes and slots — whether or not it was
   * applied. Null when the stage was skipped, which INCLUDES every run with the
   * modifiers flag off: the governor does not run at all there. The same
   * information is written per item into `scoredById[...].features`
   * (governorSlot, governor_<reason>, governorApplied, governorBudgetPct) so it
   * reaches rank_events through logImpression without a new writer — which is
   * exactly why the OFF path must leave the feature vector alone.
   */
  governor: GovernorOutcome | null;
}

/** FNV-1a over sorted ids — the candidate-set identity when no key is given. */
function deriveCandidateKey(city: string | null, ids: readonly string[]): string {
  let h = 2166136261;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x1f; h = Math.imul(h, 16777619);
  }
  return `${city ?? ""}:${ids.length}:${(h >>> 0).toString(16)}`;
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
  const followedIds = new Set<string>(); const degraded: PdeReadFailure[] = []; // see the degradation note at the end of this file
  if (sc) {
    try {
      const { data: followRows, error: followErr } = await sc
        .from("user_follows")
        .select("following_id")
        .eq("follower_id", userId);
      if (!readFailed(degraded, "follows", followErr)) for (const row of (followRows as any[]) ?? []) followedIds.add(row.following_id as string);
    } catch (err) { readFailed(degraded, "follows", err ?? true); }
  }

  let interestTags = new Set<string>();
  let categoryAffinities: Record<string, number> | undefined;
  if (sc) {
    try {
      // category_weights rides the SAME select as interests — the learned
      // preference signal costs no extra round trip on a path that, under
      // D5=B, runs on every request rather than on the rare cache miss.
      const { data: prefRow, error: prefErr } = await sc
        .from("compass_user_preferences")
        .select("interests, category_weights")
        .eq("user_id", userId)
        .maybeSingle();
      const interests: string[] = (readFailed(degraded, "preferences", prefErr) ? [] : (prefRow as any)?.interests) ?? [];
      interestTags = new Set(interests.map((t: string) => t.toLowerCase()));
      categoryAffinities = readFailed(degraded, "preferences", prefErr) ? undefined : normaliseCategoryAffinities((prefRow as any)?.category_weights);
    } catch (err) { readFailed(degraded, "preferences", err ?? true); }
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
      const { data: seenRows, error: seenErr } = await sc
        .from("rank_events")
        .select("item_id")
        .eq("user_id", userId)
        .eq("surface", "discovery")
        // EXCLUDE analytics rows. Without this the set is not "places the viewer
        // was SHOWN" but "places that were SCORED" — DiscoveryRankingService
        // writes one analytics row per CANDIDATE, and a request ranks up to 180
        // candidates while serving 20. Every scored candidate would be penalised
        // as already-seen for 24 h, and 500 is the cap, so a single prior
        // request could fill it with analytics rows and evict the real
        // impressions. DRS states this invariant itself: analytics rows carry
        // outcome='analytics' "so the impression-finding query never
        // accidentally matches them".
        //
        // `<> 'analytics'` rather than `= 'impression'` on purpose: POST
        // /api/rank-events/outcome UPDATES an impression row's outcome in place
        // to tap/save/join, so an impression that converted is still an
        // impression and must stay in the seen set.
        .neq("outcome", "analytics")
        .gte("served_at", since)
        .order("served_at", { ascending: false })
        .limit(SEEN_MAX_IDS);
      if (!readFailed(degraded, "seen", seenErr)) for (const row of (seenRows as any[]) ?? []) {
        if (row?.item_id) seenIds.add(row.item_id as string);
      }
    } catch (err) { readFailed(degraded, "seen", err ?? true); }
  }

  // Place-engagement affinity → portavaRank's ×1.15 PLACE_ENGAGEMENT_BOOST.
  // buildPlaceAffinities keys by rank_events.item_id (the same place id the
  // candidate map uses), so this matches rather than silently never firing. It
  // is its own read (place_view event_type, not the discovery-surface seen read
  // above), non-fatal, and returns {} for a viewer with no place-view history.
  let placeAffinities: Record<string, number> | undefined;
  if (sc) {
    try {
      placeAffinities = await buildPlaceAffinities(sc, userId);
    } catch { /* non-fatal */ }
  }

  return { userId, city, followedIds, interestTags, categoryAffinities, seenIds, placeAffinities, degraded, neighborhood: await loadViewerNeighborhood(sc, placeAffinities, degraded), sequences: await loadSequenceFeatures(sc, userId) };
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
  const nowMs = opts.nowMs ?? t0;
  const stages: PdeStages = {
    portavaRank: false, drs: false, analytics: false, suppressedWrites: 0,
    modifiers: "flag_off", governor: "skipped",
  };

  // On a run nobody receives, everything downstream gets a client that cannot
  // write. Reads are untouched, so the ranking stays representative.
  const sc = opts.served
    ? opts.sc
    : suppressWrites(opts.sc, () => { stages.suppressedWrites += 1; });

  // ── ROADMAP step 7/8 modifiers — behind discovery_ranking_modifiers_enabled ─
  // With the flag off this is one cached flag read and an inert record; the
  // ranking below is then byte-identical to the pre-modifier pipeline. Never
  // fatal: an assembly failure is the inert record, not a thrown request.
  let modifiers: DiscoveryModifiers;
  if (opts.modifiers) {
    modifiers = opts.modifiers;
  } else {
    try {
      modifiers = await loadDiscoveryModifiers(sc, {
        // The Trail modifier is the one user-dependent input, so the viewer is
        // named here rather than implied. Without it loadDiscoveryModifiers
        // performs no Trail read at all.
        viewerId: viewer.userId,
        city: viewer.city,
        placeIds: places.map((p) => p.id),
        cacheKey: opts.candidateKey ?? deriveCandidateKey(viewer.city, places.map((p) => p.id)),
        nowMs,
      });
    } catch {
      modifiers = inertModifiers("flag_off");
    }
  }
  stages.modifiers = modifiers.reason;

  const viewerContext: ViewerContext = {
    userId:       viewer.userId,
    city:         viewer.city ?? undefined, neighborhood: viewer.neighborhood ?? undefined, // DV-54: the viewer half of the geography comparison
    followedIds:  viewer.followedIds,
    interestTags: viewer.interestTags,
    // Was omitted, so f.categoryAffinity (weight 0.4) was a constant 0 for every
    // candidate on every request — the learned-preference input the ranker
    // documents but was never handed.
    categoryAffinities: viewer.categoryAffinities,
    // Was omitted, so f.seenPenalty was a constant 0 and nothing suppressed
    // repeats at the portavaRank layer.
    seenIds: viewer.seenIds,
    // Was omitted, so f.placeEngagement (the ×1.15 boost) never fired even though
    // both the signal (place_view history) and the kernel exist. Paired with
    // candidate.placeId below.
    placeAffinities: viewer.placeAffinities,
    // Capped local momentum (portavaRank LOCAL_MOMENTUM_MAX_CONTRIBUTION).
    // Undefined with the flag off ⇒ the feature is 0 for every candidate.
    localMomentum: modifiers.enabled ? modifiers.localMomentum : undefined,
    // `02` Trails as a bounded MODIFIER — the viewer's followed Trails, already
    // scaled by §11 health and DV-25 momentum, capped in portavaRank at
    // TRAIL_AFFINITY_MAX_CONTRIBUTION. Gated on `enabled` and NOT on the map
    // being empty: an inert record must leave the feature vector byte-identical
    // to the pre-Trail pipeline, which is what makes the flag a rollback.
    trailAffinity: modifiers.enabled ? modifiers.trailAffinity : undefined,
  };

  // Map place → RankCandidate.
  // DB-backed places (id prefix "db/") are treated as gems (curated by hosts);
  // OSM places are kind "place". Both carry savedCount as the likeCount proxy.
  const candidates: PlaceCandidate<T>[] = places.map((p) => ({
    id:         p.id,
    kind:       p.id.startsWith("db/") ? "gem" as const : "place" as const,
    city:       viewer.city, neighborhood: p.neighborhood ?? null, // DV-54 geography key — see the note at the end of this file
    category:   p.category ?? null,
    distanceKm: p.distanceKm ?? null,
    verified:   p.id.startsWith("db/") ? true : null,
    likeCount:  p.savedCount ?? null,
    tags:       (p.tags ?? []).map((t) => t.toLowerCase()),
    // Enables the ×1.15 place-engagement boost when the viewer's placeAffinities
    // carry this place id (same id space as the candidate). Harmless otherwise.
    placeId:    p.id,
    __place:    p,
  }));

  const prT0 = Date.now();
  // With the modifiers ON the governor owns exploration for this surface, so
  // portavaRank's fixed every-7th slot is switched off here — otherwise the
  // page would carry two exploration passes and exceed the budget. With the
  // modifiers OFF the call is exactly what it was.
  const scored = modifiers.enabled
    ? rankCandidates(candidates, viewerContext, { exploration: false })
    : rankCandidates(candidates, viewerContext);
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
      // subject HERE. A community row DOES have a `submitted_by`, and blocking
      // that person does hide their submission — but that is enforced upstream
      // as a candidate pre-filter: routes/discovery.ts drops the row inside
      // queryDbPlaces, so it never becomes a candidate and never reaches this
      // ranker. That is the shape mapSearch, mediaFeed and the Compass fallback
      // feed all use, and it is what keeps these inputs constant. `creatorId`
      // is null above because the author never travels past that query, and OSM
      // rows have no author at all. The four content-state checks and
      // `isPrivate` are already enforced upstream — both candidate queries
      // filter `.eq("status", "active")` (routes/discovery.ts:893 and :1052) —
      // so deriving them from `status` here would re-encode a filter that
      // already ran. Age and geo restriction have no columns on either place
      // table.
      //
      // So the gate cannot return ineligible on this surface. #202 already
      // dropped ITEM_ELIGIBLE everywhere on that reasoning; what remains is
      // ITEM_SCORED, one insert per CANDIDATE — and the candidate set here is
      // the full merged one (~180), not the 20 that get served.
      // `emitPerCandidateAnalytics: false` below stops us paying for it. The
      // gate CALL stays: it costs a few boolean tests and is the safety net if
      // these ever stop being constants. ITEM_INELIGIBLE is untouched and will
      // fire the moment the gate ever rejects anything here.
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

  // ── Exploration GOVERNOR (ROADMAP step 8) ──────────────────────────────────
  // Runs over the FINAL order (after DRS) so its slots are positions on the
  // page the user would receive. `apply` follows the flag: with the modifiers
  // ON but the allocation not applicable it observes — order untouched,
  // allocation recorded; applied ⇒ the picks move into their slots. Either way
  // the decision lands in every candidate's feature vector.
  //
  // WHY THE WHOLE STAGE IS BEHIND `modifiers.enabled` AND NOT JUST `apply`.
  // The feature vector is not a local diagnostic: logImpression writes it
  // verbatim into `rank_events.features`, one row per served candidate, keyed
  // by the VIEWER's user_id (lib/rankLog.ts). So an "observe only" governor is
  // not inert — with the flag off it was still stamping governorApplied,
  // governorBudgetPct, governorSlot and governor_<reason> into per-user rows in
  // production, on a feature nobody had enabled. A flag that is off must leave
  // no trace: the OFF feature vector has to be byte-identical to what the
  // pre-governor pipeline produced. Observation is a thing you turn ON.
  let governor: GovernorOutcome | null = null;
  if (modifiers.enabled) {
    try {
      const gc: GovernorCandidate[] = ranked.map((p) => ({
        id: p.id,
        category: p.category ?? null,
        socialProof: p.savedCount ?? null,
        momentum: modifiers.localMomentum[p.id] ?? null,
      }));
      governor = allocateExplorationBudget(gc, {
        userId: viewer.userId,
        budgetPct: modifiers.explorationBudgetPct,
        categoryAffinities: viewer.categoryAffinities,
        nowMs,
      }, true);

      const slotById = new Map(governor.allocations.map((a) => [a.id, a]));
      for (const [id, scoredC] of scoredById) {
        scoredC.features.governorApplied   = governor.applied ? 1 : 0;
        scoredC.features.governorBudgetPct = governor.budgetPct;
        const a = slotById.get(id);
        scoredC.features.governorSlot = a ? 1 : 0;
        if (a) for (const r of a.reasons) scoredC.features[`governor_${r}`] = 1;
      }

      if (governor.applied) {
        const pos = new Map(governor.order.map((id, i) => [id, i]));
        ranked.sort((a, b) => (pos.get(a.id) ?? ranked.length) - (pos.get(b.id) ?? ranked.length));
        stages.governor = "applied";
      } else {
        stages.governor = governor.slotCount > 0 ? "observed" : "skipped";
      }
    } catch {
      governor = null;
      stages.governor = "skipped";
    }
  }

  return {
    ranked,
    scoredById,
    stages,
    timings: { portavaRankMs, drsMs, totalMs: Date.now() - t0 },
    modifiers,
    governor,
  };
}

// ── 04 §8 behaviour chains, on the viewer (census-discovery DC-09) ────────────
//
// `04` §8 lists four behaviour chains and requires that sequence features be
// "derived downstream rather than hard-coded into clients". The derivation
// lives in lib/discoverySequenceFeatures.ts; this is where it reaches the
// engine, on the struct that already carries every other per-user input.
//
// It rides `loadPdeViewer` rather than getting a loader of its own for the
// reason the struct's own header gives: everything viewer-specific belongs in
// one place, so "may never be cached on the candidate key" stays checkable by
// reading. The read is non-fatal exactly like the four beside it — a viewer
// whose history cannot be read is ranked without the feature, and says so
// (`sequences.reason`) rather than being ranked as a viewer who did nothing.
//
// WHAT IT COSTS, SAID PLAINLY: one more round trip on a path that under D5=B
// runs on EVERY request, for a feature nothing scores on yet. It is an indexed
// read (rank_events_user_served_at, then the surface filter) on the same table
// the seen-set read already uses, and it is deliberately NOT folded into that
// read: the seen set is a 24-hour window sized to Cache A's TTL, these features
// are a 30-day one, and widening the seen window to share a query would change
// portavaRank's largest negative term for every viewer. A round trip is the
// cheaper mistake than a silent ranking change.
//
// IT IS VACUOUS TODAY, AND THAT IS NOT A DEFECT. Discovery is dark in
// production — thirteen `surface='discovery'` rows in `rank_events` ever — so
// every chain computes empty until the surface is actually reached. The module
// header says this at length so that an empty chain is never mistaken for a
// missing one.
//
// DECLARATION MERGING, DELIBERATELY. This field belongs beside `placeAffinities`
// in the interface above, and it is down here instead because every line up
// there is the target of an anchored citation in docs/architecture and
// docs/discovery: inserting one line silently repoints someone else's evidence,
// and this file is in the COVERED registry of scripts/check-doc-citations.mjs
// precisely so that kind of drift is loud. Merge, then, rather than shift.
export interface PdeViewer {
  /**
   * `04` §8's four chains for this viewer, derived from `rank_events`.
   *
   * Every chain is NAMED even when nothing could be derived, and a step the
   * live 13-column schema cannot represent reports `null` rather than 0 — see
   * lib/discoverySequenceFeatures.ts. Nothing in the ranker reads it yet: it is
   * a feature the engine now CARRIES, and a consumer that scored on a chain
   * with no production traffic would be scoring on noise.
   */
  sequences?: DiscoverySequenceFeatures;
}

// ── DV-54, the geography axis: the key is now THREADED, and what that turned on ─
//
// Appended below the last line of this file rather than edited into the
// candidate map above, for the reason the note on `PdeViewer.sequences` gives:
// this file is in the COVERED registry of scripts/check-doc-citations.mjs
// precisely so that shifting a cited line is loud. Every edit this change makes
// ABOVE this point replaces a line in place; nothing moved. The single
// EXCEPTION is deliberate and is named in the commit: the follows read at :418
// now destructures `error`, and census-discovery's DV-14 anchors on the old
// text of that line.
//
// WHAT WAS WITHHELD HERE BEFORE, AND WHAT RULED IT. An earlier pass added the
// place and geography diversity axes to `portavaRank.diversify` but refused to
// set `candidate.neighborhood`, because threading the key would ALSO switch on
// `scoreCandidate`'s `neighborhoodMatch` weight, which at the time paid 0.2 for
// a candidate merely CARRYING a label — `cityHit` is true for every candidate
// on this surface, so the only remaining term was truthiness — and paid it
// unevenly, because routes/discovery.ts mapped a DB-backed place's
// `neighborhood` column onto `address` and nothing else. The owner ruled that
// label presence must not earn relevance credit and that the spec-supported
// meaning be implemented with comparable inputs across sources. It is.
//
// THE THREE THINGS THAT RULING REQUIRED, ALL OF THEM NOW TRUE:
//
//   1. A REAL COMPARISON. `portavaRank.scoreCandidate` now computes
//      `cityHit && neighborhoodMatches(ctx.neighborhood, c.neighborhood)`.
//      Presence earns nothing: a labelled candidate with no viewer
//      neighbourhood to compare against scores exactly 0, and so does a
//      labelled candidate whose label differs from the viewer's.
//
//   2. COMPARABLE INPUTS ACROSS SOURCES. routes/discovery.ts now sets
//      `neighborhood` from the `places.neighborhood` column on BOTH DB-backed
//      mappings (`queryDbPlaces` and the canonical-places query) in addition to
//      the `address` fallback it already wrote, so a curated place reaches this
//      engine with the same field an OSM place carries from
//      `osmNeighborhood(tags)`. Before that a curated place could never earn
//      the credit whatever it was worth. `src/test/discoveryDiversityAxes.test.ts`
//      test N4 asserts the two sources earn the IDENTICAL feature value.
//
//   3. NORMALISATION. Both sides go through `normaliseGeoLabel` (case,
//      diacritics, whitespace), because the two producers are a mapper typing
//      an OSM tag and a curator typing a column, and exact equality between two
//      humans' spellings is a comparison that quietly never fires.
//
// WHAT THIS CHANGES FOR A LIVE REQUEST, SAID PLAINLY RATHER THAN IMPLIED. Two
// things move, and only for viewers who have a derived neighbourhood:
// `f.neighborhoodMatch` can now be 0.2 instead of always 0, and `diversify`'s
// geography clause has a key to compare — though `geoPenalty` is still
// UNDEFAULTED (absent ⇒ 0), so the diversity half remains inert until a
// magnitude is ruled. For every viewer whose `neighborhood` is null — which is
// every viewer with no curated place-view history, i.e. effectively all of them
// while Discovery is dark — the ordering is byte-identical to before.

/**
 * `PdePlace`, merged: the geography label the ranker compares.
 *
 * Declaration-merged for the line-stability reason above. `DiscoveryPlace`
 * already declares this field, so nothing widens in the round trip; it is
 * optional because the Compass fallback shape and every cached candidate
 * written before this change simply do not carry it, and absent must mean
 * "no key", not "no credit for anyone".
 */
export interface PdePlace {
  /** Neighbourhood label — `osmNeighborhood(tags)` for OSM rows, the
   *  `places.neighborhood` column for DB-backed ones. */
  neighborhood?: string | null;
}

/** The reads `loadPdeViewer` performs that can fail INDEPENDENTLY of the request. */
export type PdeReadFailure = "follows" | "preferences" | "seen" | "viewer_neighborhood";

/**
 * `PdeViewer`, merged: which viewer-side reads failed, and the derived
 * neighbourhood.
 *
 * WHY `degraded` EXISTS AT ALL — the defect it closes, stated so it is not
 * re-introduced. supabase-js RESOLVES on a database error; it does not throw.
 * The three reads above destructured `data` and discarded `error`, so the
 * surrounding `try/catch` never fired on the case it was written for, and a
 * failed read was BYTE-IDENTICAL to "no rows": a viewer whose follow graph 500s
 * was ranked as following nobody, a viewer whose preferences 500 was ranked as
 * having no taste, and nothing in the returned value said so. The
 * degradation was real and invisible, which is the worst of both.
 *
 * Each read now records its own failure and the caller can tell the two apart.
 * The reads stay NON-FATAL, which was always right for a feed request — a
 * viewer who follows nobody still gets a page. What changes is that "ranked
 * without the follow graph because it could not be read" is now a statement the
 * caller can make, log and alert on, instead of a silence.
 *
 * NOT the same as `buildPlaceAffinities` returning `{}`, which is a RULED
 * conflation (see the D11 ruling in services/ranking/MediaFeedRankingService.ts):
 * that map is spent as one multiplicative boost, so an empty one withholds a
 * lift and claims nothing. These three are different — a missing follow set
 * changes which authors score at all.
 */
export interface PdeViewer {
  /** Empty when every viewer-side read succeeded. Never undefined from `loadPdeViewer`. */
  degraded?: PdeReadFailure[];
  /**
   * The viewer's own neighbourhood label, or null — see `loadViewerNeighborhood`.
   * Handed to `portavaRank` as `ViewerContext.neighborhood`; null ⇒ the
   * `neighborhoodMatch` feature is 0 for every candidate, which is the
   * pre-DV-54 ordering exactly.
   */
  neighborhood?: string | null;
}

/**
 * Record a read failure once, and answer "did this read fail?".
 *
 * Idempotent on purpose: a call site that consults the same error twice (the
 * preferences read does — once for interests, once for category weights) must
 * not report the failure twice.
 */
function readFailed(into: PdeReadFailure[], which: PdeReadFailure, err: unknown): boolean {
  if (!err) return false;
  if (!into.includes(which)) into.push(which);
  return true;
}

/**
 * Cap on the ids sent to the neighbourhood lookup. `placeAffinities` is already
 * bounded by the 30-day place-view window, but that window has no row cap of
 * its own, and an `.in()` list is a URL on this client.
 */
const VIEWER_NEIGHBORHOOD_MAX_IDS = 200;

/**
 * Derive the viewer's neighbourhood: the one they have viewed most in the last
 * 30 days.
 *
 * WHICH SOURCE, AND WHY THIS ONE. There is no viewer neighbourhood anywhere in
 * the tree to read — `ViewerContext` had none, `profiles` has none, and
 * `compass_user_profiles` carries `current_city`/`current_country` and stops
 * there (migration 0051). So it is DERIVED, and the derivation is the viewer's
 * own recent behaviour rather than a profile field, for the reason this whole
 * surface is built on: `PdeViewer.city` is the DESTINATION the request names,
 * not where the user lives, so a home address would answer a question nobody
 * asked. "Which part of the place I am browsing do I keep coming back to" is
 * the question `neighborhoodMatch` is for, and `placeAffinities` — place_view
 * counts over 30 days, already loaded for the ×1.15 engagement boost — is the
 * only evidence of it the tree holds. Views are the weight, so ten visits to
 * one neighbourhood beat one visit each to ten.
 *
 * WHAT IT CANNOT SEE, STATED RATHER THAN GLOSSED. `rank_events.item_id` carries
 * the discovery id space, so a `db/<uuid>` resolves through `places` and an
 * `osm/<type>/<id>` resolves through nothing — OSM neighbourhoods live in
 * Overpass tags that are not stored per place anywhere on our side. The derived
 * neighbourhood is therefore drawn from CURATED history only. That biases which
 * viewers GET a neighbourhood; it does not bias which candidates can earn the
 * credit, because both sources carry a comparable label on the candidate side
 * (see point 2 of the note above). A viewer with no curated place-view history
 * gets null and the feature stays 0 for their whole page.
 *
 * COST. Zero round trips for a viewer with no `db/` place-view history, which
 * is every viewer today — Discovery is dark in production. One indexed
 * primary-key read otherwise.
 *
 * NON-FATAL, and audibly so: a failed read records `viewer_neighborhood` in
 * `degraded` and returns null, so "no neighbourhood" and "could not read one"
 * are distinguishable at the caller for the same reason the three reads above
 * now are.
 */
export async function loadViewerNeighborhood(
  sc: any,
  placeAffinities: Record<string, number> | undefined,
  degraded: PdeReadFailure[],
): Promise<string | null> {
  if (!sc || !placeAffinities) return null;
  const ids = Object.keys(placeAffinities)
    .filter((k) => k.startsWith("db/") && (placeAffinities[k] ?? 0) > 0)
    .map((k) => k.slice(3))
    .slice(0, VIEWER_NEIGHBORHOOD_MAX_IDS);
  if (ids.length === 0) return null;
  try {
    const { data, error } = await sc.from("places").select("id, neighborhood").in("id", ids);
    if (readFailed(degraded, "viewer_neighborhood", error)) return null;
    const byKey = new Map<string, { label: string; views: number }>();
    for (const row of (data as any[]) ?? []) {
      const label = (row?.neighborhood ?? null) as string | null;
      const key = normaliseGeoLabel(label);
      if (!key || !label) continue;
      const views = placeAffinities[`db/${row.id as string}`] ?? 0;
      if (views <= 0) continue;
      const seen = byKey.get(key);
      if (seen) seen.views += views; else byKey.set(key, { label, views });
    }
    // Deterministic: most-viewed wins, ties broken by the normalised key, so the
    // same history never yields two different answers on two requests.
    let best: { key: string; label: string; views: number } | null = null;
    for (const [key, v] of byKey) {
      if (!best || v.views > best.views || (v.views === best.views && key < best.key)) {
        best = { key, label: v.label, views: v.views };
      }
    }
    return best?.label ?? null;
  } catch (err) {
    readFailed(degraded, "viewer_neighborhood", err ?? true);
    return null;
  }
}
