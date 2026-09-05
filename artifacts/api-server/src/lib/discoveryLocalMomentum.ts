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
  outcome_at?: string | null;
}

/** place id → momentum in [0, 1]. Absent id ⇒ 0. */
export type MomentumMap = Readonly<Record<string, number>>;

function weightFor(outcome: string): number {
  if (outcome === "save") return MOMENTUM_EVENT_WEIGHTS.save;
  return MOMENTUM_EVENT_WEIGHTS.outcome;
}

/**
 * Pure: rows → momentum map. Only places with momentum > 0 appear, so an
 * empty map means "no surge anywhere", never "the read failed".
 */
export function computeLocalMomentum(rows: readonly MomentumRow[], nowMs: number): Record<string, number> {
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
  return out;
}

// ── Loader, with a bounded per-key cache ──────────────────────────────────────

interface CacheEntry { at: number; map: Record<string, number> }
const _cache = new Map<string, CacheEntry>();

/** Test hook: drop every cached momentum map. */
export function _resetLocalMomentumCacheForTest(): void {
  _cache.clear();
}

/**
 * Load momentum for a candidate set. Never throws; a failed read is an empty
 * map (no surge anywhere — see the module header on why that is the honest
 * degradation and not a fabricated penalty).
 *
 * `cacheKey` should be the candidate-set key (destination:category) so that
 * every viewer of the same cached candidates shares one read.
 */
export async function loadLocalMomentum(
  sc: any,
  placeIds: readonly string[],
  opts: { cacheKey: string; nowMs?: number },
): Promise<Record<string, number>> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!sc || placeIds.length === 0) return {};

  const hit = _cache.get(opts.cacheKey);
  if (hit && nowMs - hit.at < MOMENTUM_CACHE_TTL_MS) return hit.map;

  let map: Record<string, number> = {};
  try {
    const since = new Date(nowMs - MOMENTUM_BASELINE_WINDOW_MS).toISOString();
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
        .select("item_id, outcome, served_at, outcome_at")
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
    if (!failed) map = computeLocalMomentum(rows, nowMs);
  } catch {
    // resolves-not-throws-ok: a momentum read failure degrades to "no surge",
    // which is the documented honest default; the ranker must never throw here.
    map = {};
  }

  _cache.set(opts.cacheKey, { at: nowMs, map });
  pruneAndBound(_cache, { max: MOMENTUM_CACHE_MAX, ttlMs: MOMENTUM_CACHE_TTL_MS, timestampOf: (e) => e.at, now: nowMs });
  return map;
}
