/**
 * discoveryLocalMomentum — a place-level VELOCITY signal for the discovery
 * ranker. ROADMAP step 7: "taste as the spine; graph, behaviour, trails and
 * CAPPED local_momentum as modifiers only".
 *
 * WHAT IT MEASURES
 * ================
 * How much more a place is being served/saved/acted on in the last 48 hours
 * than its own recent baseline. Not popularity — a place that is always busy
 * has momentum 0. Not virality — the value saturates, and the ranker caps its
 * contribution (portavaRank.ts, LOCAL_MOMENTUM_MAX_CONTRIBUTION) so that no
 * amount of momentum can outrank a taste signal. That cap is the whole reason
 * this is admissible while the ranker is on HOLD: a modifier that cannot
 * dominate cannot turn the evidence system into a trending feed.
 *
 * SOURCE, AND WHAT THAT SOURCE CANNOT SAY
 * =======================================
 * `rank_events` rows with surface='discovery' — one row per served item
 * (`served_at`), which an outcome then UPDATES in place (`outcome`,
 * `outcome_at`; docs/fact-layer-20260810/00_VERIFIED_STATE.md §4.1). So a
 * single row can carry two moments: the impression at served_at and, if it
 * converted, the outcome at outcome_at. Both are counted, at their own time.
 * Analytics rows (outcome='analytics') are excluded — they are ranker
 * bookkeeping, one per CANDIDATE, and would count scoring as activity.
 *
 * Two honest limits, stated rather than hidden:
 *   - Anonymous serves are invisible (user_id is NOT NULL on rank_events), so
 *     momentum is a property of AUTHENTICATED activity only.
 *   - A place nobody has been served cannot have momentum. Absence of rows is
 *     momentum 0, which is "no evidence of a surge", not "evidence of decline".
 *     The signal is strictly non-negative for that reason: this module never
 *     manufactures a penalty out of an empty window.
 *
 * THE ARITHMETIC
 * ==============
 *   weight(event)   impression 1 · save 3 · any other outcome (tap/join/rsvp/
 *                   attended) 2. Saves are the strongest discovery intent the
 *                   surface records; taps are cheap.
 *   recent          Σ weights in [now − 48 h, now]
 *   prior           Σ weights in [now − 30 d, now − 48 h)
 *   baseline48h     prior / 14            (28 prior days ÷ 2-day windows)
 *   velocity        (recent − baseline48h) / (baseline48h + SMOOTHING)
 *   momentum        clamp(velocity / SATURATION, 0, 1)
 *
 * A floor: recent < MIN_RECENT_WEIGHT ⇒ momentum 0. Three impressions are not
 * a surge; this mirrors the category-affinity floor in discoveryPde.ts, for
 * the same reason — acting on one observation manufactures a signal.
 *
 * USER-INDEPENDENT, CACHED ON THE CANDIDATE KEY
 * =============================================
 * Momentum is a property of the place, not the viewer, so it is cached per
 * candidate-set key (destination:category) with a short TTL and a hard bound
 * on entries. Under D5=B the ranker runs on every request; without this cache
 * every cache-A hit would pay a 30-day rank_events scan.
 */
import { pruneAndBound } from "./boundedMapCache.js";
import { logger as rootLogger } from "./logger.js";
// `03` §9's six place-momentum stages, computed from the SAME rows this module
// already pages in. Separate module, separate function, and the scalar above is
// not touched: a number the ranker consumes must not move because a diagnostic
// was added beside it.
import { computeTrendStates, type TrendReading } from "./discoveryTrendState.js";
// census-discovery DC-17's four facts, and the version constants `06` §5's rank
// provenance already uses. Imported rather than redeclared: a momentum reading
// and a ranked page must never claim different versions of the same pipeline.
import { derivedStoreProvenance, type DerivedStoreProvenance, type DerivedStoreVersions } from "./discoveryRankProvenance.js"; import { computeLocalMomentumV2, buildPlaceTrendContext, contextKeyOfItem, type TrendContext, type ContextPlaceRow, type ContextMembershipRow } from "./discoveryTrendNormalised.js"; import { isFlagEnabled } from "./featureFlags.js"; import { isMissingSchemaError } from "./capability/schemaCapability.js";  // §84 (W10-R1)

const logger = rootLogger.child({ mod: "localMomentum" });

export const MOMENTUM_RECENT_WINDOW_MS   = 48 * 60 * 60 * 1_000;
export const MOMENTUM_BASELINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** (30 d − 48 h) / 48 h — the number of 48-hour windows in the prior period. */
export const MOMENTUM_BASELINE_WINDOWS   = 14;
export const MOMENTUM_EVENT_WEIGHTS = { impression: 1, save: 3, outcome: 2 } as const;
/** Below this much recent weighted activity the place has no momentum at all. */
export const MOMENTUM_MIN_RECENT_WEIGHT  = 3;
/** Added to the baseline so a place with zero baseline cannot divide by zero. */
export const MOMENTUM_SMOOTHING          = 2;
/** Velocity at which momentum reads 1.0 — anything faster is still 1.0. */
export const MOMENTUM_SATURATION         = 3;

/**
 * Bound on rank_events rows read per candidate set, across ALL pages.
 *
 * This used to be passed as a single `.limit(5000)`, which was three separate
 * problems wearing one number:
 *   1. PostgREST caps a response at `db-max-rows` (1000). Asking for 5000
 *      returned 1000 and reported nothing, so the "30-day window" was in fact
 *      whatever fraction of it fitted in 1000 rows.
 *   2. The query carried no ORDER BY, so which 1000 rows came back was
 *      arbitrary — Postgres's physical scan order, free to differ between two
 *      runs of the same query. The momentum of a place could change without a
 *      single new event.
 *   3. Silently. Both (1) and (2) are invisible from the return value: a
 *      truncated arbitrary sample and a complete window are the same shape.
 *
 * The loader now pages in MOMENTUM_PAGE_SIZE chunks under a stable total order
 * and stops at this ceiling, so the window is well defined: the most recent
 * MOMENTUM_ROW_LIMIT events for these places. When the ceiling is what stopped
 * the read, the loader logs it — the bound is deliberate and reported, never
 * silent.
 */
export const MOMENTUM_ROW_LIMIT = 5_000;
/**
 * Rows per page. Must not exceed PostgREST's `db-max-rows` (1000) or a full
 * page becomes indistinguishable from a capped one and paging never terminates
 * correctly.
 */
export const MOMENTUM_PAGE_SIZE = 1_000;
/** Cache: per candidate key, short-lived, bounded. */
export const MOMENTUM_CACHE_TTL_MS = 10 * 60 * 1_000;
export const MOMENTUM_CACHE_MAX    = 200;

/** Minimal shape read from `rank_events`. */
export interface MomentumRow {
  item_id: string;
  outcome: string;
  served_at: string;
  outcome_at?: string | null; /** §84: read only under v2, where independence is counted by it. */ user_id?: string | null;
}

/**
 * The momentum store's output: the numbers, and what computed them.
 *
 * census-discovery DC-17 — provenance as a SIBLING FIELD, not as a widened
 * value type. The choice is deliberate and the alternative was rejected on two
 * grounds. First, the four facts describe ONE computation over ONE window at
 * ONE moment, not one place: pushing them into every value would store N
 * identical copies of the same sentence. Second, every consumer of this map
 * does arithmetic on the bare number — `ctx.localMomentum?.[c.id]` in
 * portavaRank, `perItem[r.source_id] ?? 0` in TrailService, the scaling loop in
 * discoveryModifiers — and a `{ value, provenance }` per key would make all of
 * them unwrap a number to multiply it, which is the shape of change that
 * eventually moves one.
 *
 * The values keep their old meaning exactly: place id → momentum in [0, 1],
 * absent id ⇒ 0.
 */
export interface MomentumMap {
  /** place id → momentum in [0, 1]. Absent id ⇒ 0. */
  values: Readonly<Record<string, number>>;
  /** DC-17: the source event window, the two versions, and the computation clock. */
  provenance: DerivedStoreProvenance;
}

function weightFor(outcome: string): number {
  if (outcome === "dismiss") return 0; if (outcome === "save") return MOMENTUM_EVENT_WEIGHTS.save; // §61 (DV-25): a dismiss is EXCLUDED — zero, never a negative weight
  return MOMENTUM_EVENT_WEIGHTS.outcome;
}

/**
 * Pure: rows → momentum map. Only places with momentum > 0 appear, so empty
 * `values` mean "no surge anywhere", never "the read failed" — and the
 * provenance beside them says over which window that was established.
 */
export function computeLocalMomentum(rows: readonly MomentumRow[], nowMs: number, opts: { model?: "v1" | "v2"; context?: TrendContext } = {}): MomentumMap { if (opts.model === "v2") return computeLocalMomentumNormalised(rows, nowMs, opts.context ?? {});  // §84: absent ⇒ v1, byte for byte (golden G1, G10)
  const recentSince   = nowMs - MOMENTUM_RECENT_WINDOW_MS;
  const baselineSince = nowMs - MOMENTUM_BASELINE_WINDOW_MS;

  const recent = new Map<string, number>();
  const prior  = new Map<string, number>();
  const add = (map: Map<string, number>, id: string, w: number) => map.set(id, (map.get(id) ?? 0) + w);
  const bucket = (id: string, atIso: string | null | undefined, w: number) => {
    if (!atIso) return;
    const at = Date.parse(atIso);
    if (!Number.isFinite(at) || at > nowMs || at < baselineSince) return;
    if (at >= recentSince) add(recent, id, w);
    else add(prior, id, w);
  };

  for (const r of rows) {
    if (!r?.item_id || r.outcome === "analytics") continue;
    // Every non-analytics row was an impression at served_at …
    bucket(r.item_id, r.served_at, MOMENTUM_EVENT_WEIGHTS.impression);
    // … and, if it converted, an outcome at outcome_at.
    if (r.outcome !== "impression") bucket(r.item_id, r.outcome_at ?? null, weightFor(r.outcome));
  }

  const out: Record<string, number> = {};
  for (const [id, rec] of recent) {
    if (rec < MOMENTUM_MIN_RECENT_WEIGHT) continue;
    const baseline = (prior.get(id) ?? 0) / MOMENTUM_BASELINE_WINDOWS;
    const velocity = (rec - baseline) / (baseline + MOMENTUM_SMOOTHING);
    const m = Math.min(1, Math.max(0, velocity / MOMENTUM_SATURATION));
    if (m > 0) out[id] = Math.round(m * 1000) / 1000;
  }
  // `baselineSince` is the oldest row the bucket filter admits, so it IS the
  // window start rather than a label for it — the bounds cannot drift from the
  // arithmetic they describe because they are the same two numbers. Stamped
  // even when `out` is empty: "this window was read and nothing surged" is a
  // measurement, and the bare `{}` it used to return could not say it.
  return { values: out, provenance: derivedStoreProvenance({ kind: "bounded", startMs: baselineSince, endMs: nowMs }, nowMs, LOCAL_MOMENTUM_VERSIONS) };  // §68: this kernel's own versions, not the ranker's
}

// ── Loader, with a bounded per-key cache ──────────────────────────────────────

interface CacheEntry {
  at: number;
  /**
   * The provenanced map, cached WHOLE. A replay therefore reports the clock the
   * computation ran on, not the clock it was read back on — the same rule
   * discoveryRankProvenance states for `rankedAt`, and the reason `provenance`
   * is stored here rather than re-stamped on the way out.
   */
  map: MomentumMap;
  /** `03` §9 stages for the same places. Empty when the read failed, exactly like `map.values`. */
  trends: Record<string, TrendReading>;
}
const _cache = new Map<string, CacheEntry>();

/** Test hook: drop every cached momentum map. */
export function _resetLocalMomentumCacheForTest(): void {
  _cache.clear(); _retests.clear();
}

/**
 * Load momentum for a candidate set. Never throws; a failed read is an empty
 * map (no surge anywhere — see the module header on why that is the honest
 * degradation and not a fabricated penalty), still carrying the provenance of
 * the window it would have read.
 *
 * `cacheKey` should be the candidate-set key (destination:category) so that
 * every viewer of the same cached candidates shares one read.
 */
export async function loadLocalMomentum(
  sc: any,
  placeIds: readonly string[],
  opts: { cacheKey: string; nowMs?: number },
): Promise<MomentumMap> {
  const nowMs = opts.nowMs ?? Date.now();
  // No client and no candidates are both "nothing was read", which is still an
  // empty map over the window this call would have used — DC-17: the degraded
  // answer is provenanced too, or a caller cannot tell it from a real one.
  const empty = (): MomentumMap => computeLocalMomentum([], nowMs);
  if (!sc || placeIds.length === 0) return empty();

  const hit = _cache.get(opts.cacheKey);
  if (hit && nowMs - hit.at < MOMENTUM_CACHE_TTL_MS) return hit.map;

  let map: MomentumMap = empty(); let v2 = false; let context: TrendContext = {};  // §84: the v2 model, only with discovery_trend_normalised_enabled
  let trends: Record<string, TrendReading> = {};
  try {
    const since = new Date(nowMs - MOMENTUM_BASELINE_WINDOW_MS).toISOString(); v2 = await isFlagEnabled(sc, "discovery_trend_normalised_enabled"); if (v2) { const c = await loadTrendContext(sc, placeIds); if (c === null) throw new Error("trend context unread"); context = c; }
    const ids = [...new Set(placeIds)];
    const rows: MomentumRow[] = [];
    let failed = false;
    let truncated = false;

    for (let offset = 0; offset < MOMENTUM_ROW_LIMIT; offset += MOMENTUM_PAGE_SIZE) {
      // `served_at DESC, id DESC` is a stable total order AND the useful one:
      // when the ceiling truncates, what survives is the most RECENT window,
      // which is the half the recent/baseline split actually turns on. Ordering
      // by served_at alone would not be total (timestamps collide), and paging
      // over a non-total order can return one row twice and skip another.
      const { data, error } = await sc
        .from("rank_events")
        .select(v2 ? "item_id, outcome, served_at, outcome_at, user_id" : "item_id, outcome, served_at, outcome_at")
        .eq("surface", "discovery")
        .neq("outcome", "analytics")
        .in("item_id", ids)
        .gte("served_at", since)
        .order("served_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, Math.min(offset + MOMENTUM_PAGE_SIZE, MOMENTUM_ROW_LIMIT) - 1);

      if (error || !Array.isArray(data)) { failed = true; break; }
      rows.push(...(data as MomentumRow[]));

      // A short page is the end of the corpus, not a cap.
      if (data.length < MOMENTUM_PAGE_SIZE) break;
      // A full last page means the ceiling — not the data — ended the read.
      if (rows.length >= MOMENTUM_ROW_LIMIT) { truncated = true; break; }
    }

    if (truncated) {
      // Deliberate bound, said out loud. The window is still well defined (the
      // most recent MOMENTUM_ROW_LIMIT events), but a reader of the momentum
      // map deserves to know the baseline half may be clipped for a hot
      // candidate set rather than discovering it from a drifting score.
      logger.warn(
        { cacheKey: opts.cacheKey, placeCount: ids.length, rowLimit: MOMENTUM_ROW_LIMIT },
        "localMomentum: row ceiling reached — baseline window is bounded to the most recent rows",
      );
    }
    if (failed && v2) map = computeLocalMomentum([], nowMs, { model: "v2" });  if (!failed) {
      map = computeLocalMomentum(rows, nowMs, v2 ? { model: "v2", context } : {});
      // Same rows, second pass. Cheap relative to the read that produced them,
      // and computed here rather than at the call site so the two can never be
      // derived from different corpora and then compared.
      if (v2) trends = computeTrendStates(rows, nowMs, { model: "v2", context, ...(await postConvergenceOption(sc, rows, ids, since, nowMs)) }); else trends = computeTrendStates(rows, nowMs);  // §95 (DV-34): the post leg only under its own flag
    }
  } catch {
    // resolves-not-throws-ok: a momentum read failure degrades to "no surge",
    // which is the documented honest default; the ranker must never throw here.
    map = v2 ? computeLocalMomentum([], nowMs, { model: "v2" }) : empty();
    trends = {};
  }

  _cache.set(opts.cacheKey, { at: nowMs, map, trends }); if (v2) _retests.set(opts.cacheKey, trends); else _retests.delete(opts.cacheKey);  // §84 DV-31: the retest pool is a v2 reading only
  pruneAndBound(_cache, { max: MOMENTUM_CACHE_MAX, ttlMs: MOMENTUM_CACHE_TTL_MS, timestampOf: (e) => e.at, now: nowMs });
  return map;
}

/**
 * `03` §9 stages for a candidate set already loaded by `loadLocalMomentum`.
 *
 * A READ-ONLY companion: it never issues a query of its own, so it cannot make
 * the stages diverge from the momentum scalar by measuring a different corpus,
 * and it cannot add a round trip to a serve path. An entry that is absent or
 * expired returns `{}` — "not computed", which is what the caller must treat it
 * as, and never a set of stages inferred from nothing.
 */
export function readLocalTrendStates(
  cacheKey: string,
  nowMs: number = Date.now(),
): Record<string, TrendReading> {
  const hit = _cache.get(cacheKey);
  if (!hit || nowMs - hit.at >= MOMENTUM_CACHE_TTL_MS) return {};
  return hit.trends;
}

// ── census-discovery §68 (DC-17, lane P21): this kernel's own versions ────────
//
// Stamped on every `MomentumMap.provenance` in place of the Compass ranker's
// pair, which versioned a pipeline this arithmetic is not part of. Declared at
// the foot so no line above that a census cites moves.

/**
 * The momentum ARITHMETIC: the 48 h / 30 d split, the baseline divisor, the
 * smoothing, the saturation, the recent-weight floor and the 3-decimal rounding.
 * Bump when any of them changes. The string says "velocity", which is what this
 * module measures (see the header), and NOT the other word on purpose: this
 * record is served by routes/trails.ts as `readingProvenance`, and that route's
 * suite forbids the word anywhere in a body (`11` §4's tripwire).
 */
export const LOCAL_MOMENTUM_MODEL_VERSION = "discovery-place-velocity-v1";

/**
 * What ONE `rank_events` row contributes: analytics rows excluded, an impression
 * at `served_at` weighing 1, and an outcome at `outcome_at` weighing save 3,
 * dismiss 0 (§61, DV-25) and any other outcome 2. `v2` because §61's dismiss
 * exclusion changed it; the pre-§61 weighting (a dismiss at 2) is `v1`. Which
 * surface's rows are read is the CALLER's read, not part of this definition.
 *
 * MUST equal lib/discoveryTrendState's `TREND_FEATURE_VERSION` and the literal
 * 3435's `rebuild_place_momentum` writes to `place_momentum.feature_version`,
 * because all three weigh the same rows the same way. Pinned by
 * src/test/discoveryDerivedProvenance.test.ts rather than shared by an import,
 * for the cycle reason lib/discoveryTrendState states at its own imports.
 */
export const LOCAL_MOMENTUM_FEATURE_VERSION = "discovery-row-activity-v2";  // §84: renamed from 3435's first spelling so no version NAME contains "weight" (B2)

const LOCAL_MOMENTUM_VERSIONS: DerivedStoreVersions = {
  modelVersion:   LOCAL_MOMENTUM_MODEL_VERSION,
  featureVersion: LOCAL_MOMENTUM_FEATURE_VERSION,
};

// ── census-discovery §75 (DC-17, lane P33, H-P21-5) ───────────────────────────

/**
 * The record `computeLocalMomentum` stamps on ANY computation it runs at
 * `nowMs` — its bounds, versions and clock depend on the clock alone, never on
 * the rows. A caller whose rows reached this kernel through another function
 * (the Trail fold, lib/discoveryTrailAffinity `trailMomentumFromRankEvents`,
 * which returns `.values` only) can therefore state that computation's
 * provenance without a second read. Computed BY the kernel, not restated, so it
 * cannot drift from it; pinned equal to a real computation's record by a test.
 */
export function localMomentumProvenance(nowMs: number): DerivedStoreProvenance {
  return computeLocalMomentum([], nowMs).provenance;
}

// ── census-discovery §84 (lane W10-R1): the exposure-normalised scalar ───────

/** v2's arithmetic (lib/discoveryTrendNormalised). Bump when it changes. Says "velocity", not the other word (routes/trails.ts's tripwire). */
export const LOCAL_MOMENTUM_MODEL_VERSION_V2 = "discovery-place-velocity-v2";
/** MUST equal lib/discoveryTrendState `TREND_FEATURE_VERSION_V2` and 3477's `c_feature`. */
export const LOCAL_MOMENTUM_FEATURE_VERSION_V2 = "discovery-exposure-activity-v3";

const LOCAL_MOMENTUM_VERSIONS_V2: DerivedStoreVersions = {
  modelVersion:   LOCAL_MOMENTUM_MODEL_VERSION_V2,
  featureVersion: LOCAL_MOMENTUM_FEATURE_VERSION_V2,
};

function computeLocalMomentumNormalised(rows: readonly MomentumRow[], nowMs: number, context: TrendContext): MomentumMap {
  const baselineSince = nowMs - MOMENTUM_BASELINE_WINDOW_MS;
  return {
    values: computeLocalMomentumV2(rows, nowMs, { context }),
    provenance: derivedStoreProvenance({ kind: "bounded", startMs: baselineSince, endMs: nowMs }, nowMs, LOCAL_MOMENTUM_VERSIONS_V2),
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The v2 context for a candidate set: `discovery_places` for the community
 * ids and their non-archived Trail memberships. Null when a read FAILED (the
 * caller then degrades to "no surge", as for a failed event read). A database
 * without 2910's Trail tables has no memberships, which is a fact, not a
 * failure — the SQL twin (3476) answers the same.
 */
export async function loadTrendContext(sc: any, placeIds: readonly string[]): Promise<TrendContext | null> {
  const ids = [...new Set(placeIds.map(contextKeyOfItem).filter((id) => UUID_SHAPE.test(id)))];
  if (ids.length === 0) return {};
  try {
    const places = await sc.from("discovery_places")
      .select("id, submitted_by, city, neighborhood, lat, lng, created_at, category, place_type")
      .in("id", ids);
    if (places?.error || !Array.isArray(places?.data)) return null;
    let memberships: ContextMembershipRow[] = [];
    const ct = await sc.from("content_trails").select("trail_id, source_id").eq("source_type", "place").in("source_id", ids);
    if (ct?.error) {
      if (!isMissingSchemaError(ct.error)) return null;
    } else if (Array.isArray(ct?.data) && ct.data.length > 0) {
      const trailIds = [...new Set((ct.data as ContextMembershipRow[]).map((m) => m.trail_id))];
      const live = await sc.from("trails").select("id").in("id", trailIds).neq("lifecycle_status", "archived");
      if (live?.error || !Array.isArray(live?.data)) return null;
      const ok = new Set((live.data as Array<{ id: string }>).map((t) => t.id));
      memberships = (ct.data as ContextMembershipRow[]).filter((m) => ok.has(m.trail_id));
    }
    return buildPlaceTrendContext(places.data as ContextPlaceRow[], memberships);
  } catch {
    // resolves-not-throws-ok: a throw is a failed read, reported as null.
    return null;
  }
}

// ── §84 DV-31: the rediscovery retest pool ───────────────────────────────────

/** The v2 readings of the last load per candidate key; empty under v1 (the retest is a v2 mechanism). */
const _retests = new Map<string, Record<string, TrendReading>>();

/**
 * The v2 trend readings `loadLocalMomentum` computed for this key, for
 * lib/discoveryTrendRediscovery to choose retests from. `{}` when the last
 * load ran v1, failed, or has expired — never readings inferred from nothing.
 */
export function readRetestReadings(cacheKey: string, nowMs: number = Date.now()): Record<string, TrendReading> {
  const hit = _cache.get(cacheKey);
  if (!hit || nowMs - hit.at >= MOMENTUM_CACHE_TTL_MS) return {};
  return _retests.get(cacheKey) ?? {};
}

// ── census-discovery §95 (lane W11-X3): "visitors post afterward" (DV-34) ────
//
// Read only while discovery_trend_normalised_enabled is on (the v2 branch above)
// AND discovery_trend_post_convergence_enabled (3496, seeded FALSE) is on. Off,
// absent or unreadable: `{}` — no Memory is read and the reading is §84's, byte
// for byte (src/test/discoveryTrendPostConvergence.test.ts P0). A failed or
// truncated Memory read is `unread`: it adds nothing, and the evidence says so.
import { loadPublicMemoriesAtPlaces, postAfterVisitAuthors, type PostAfterVisitInput } from "./discoveryTrendPostConvergence.js";
import { TREND_V2_RECENT_MS, TREND_V2_MID_MS, TREND_V2_PRIOR_MS, type TrendRowV2 } from "./discoveryTrendNormalised.js";

async function postConvergenceOption(
  sc: any, rows: readonly MomentumRow[], placeIds: readonly string[], sinceIso: string, nowMs: number,
): Promise<{ postAfterVisit?: PostAfterVisitInput }> {
  if (!(await isFlagEnabled(sc, "discovery_trend_post_convergence_enabled"))) return {};
  const memories = await loadPublicMemoriesAtPlaces(sc, placeIds, sinceIso);
  if (memories === null) return { postAfterVisit: { status: "unread" } };
  return {
    postAfterVisit: postAfterVisitAuthors(rows as readonly TrendRowV2[], memories, nowMs,
      { recentMs: TREND_V2_RECENT_MS, midMs: TREND_V2_MID_MS, priorMs: TREND_V2_PRIOR_MS }),
  };
}
