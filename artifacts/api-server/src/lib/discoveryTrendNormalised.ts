/**
 * discoveryTrendNormalised — the `03` §7 exposure-normalised trend model
 * (census-discovery §84, lane W10-R1: DV-28, DV-29, DV-30, DV-32, DV-33,
 * DV-34, DC-06). Model `discovery-trend-state-v2`, feature
 * `discovery-exposure-activity-v3`.
 *
 * WHAT IT IS, AND WHAT GATES IT
 * =============================
 * A second arithmetic for the trend state and the momentum scalar, used ONLY
 * when `discovery_trend_normalised_enabled` (migration 3475, seeded FALSE) is
 * on. lib/discoveryTrendState.computeTrendStates and
 * lib/discoveryLocalMomentum.computeLocalMomentum delegate here when their
 * caller passes `{ model: "v2" }`; with no option they run their v1 bodies,
 * byte for byte (src/test/discoveryDerivedProvenanceGolden.test.ts G1, G2, G10).
 * The SQL twin is `rebuild_place_momentum_v2` (migration 3477), and the
 * harness suite src/test/db/discoveryTrendNormalisedParity.db.test.ts holds
 * every stored row equal to what this module computes over the same rows.
 *
 * THE DECISIONS THIS FILE IMPLEMENTS (docs/architecture/discovery-decision-register.md, § W10-R1)
 * ====================================================================================
 *   D-W10-R1-1  a served impression is EXPOSURE, the denominator, not activity
 *              (census §66.9 Q66-1, the recommended reading of `03` §5 and §7).
 *   D-W10-R1-2  a window's rate is a reading only at ≥ TREND_V2_MIN_EXPOSURES.
 *   D-W10-R1-3  diversity of evidence: activity is counted per INDEPENDENCE
 *              CLUSTER, each capped at one save's weight, and a claim needs
 *              ≥ TREND_V2_MIN_GROUPS clusters (DV-32, DV-28's "broad
 *              independent confirmation").
 *   D-W10-R1-4  independence = Sensing's clustering (lib/intelIndependence),
 *              reused, over the positive outcomes (DV-34).
 *   D-W10-R1-5  the six `03` §7 normalisers, each defined below.
 *   D-W10-R1-6  the Local Pulse cell.
 *   D-W10-R1-7  `03` §4's content-type lifecycle.
 *   D-W10-R1-9  signal-led reasons: the driver of a claim.
 *
 * THE ARITHMETIC, PER KEY (a place, a Local Pulse cell, or a folded Trail)
 * =======================================================================
 * Windows: recent [now−48 h, now], mid [now−7 d, now−48 h), prior [now−30 d,
 * now−7 d) — lib/discoveryTrendState's, unchanged — and, for the scalar only,
 * base = mid ∪ prior (lib/discoveryLocalMomentum's 30 d − 48 h baseline).
 *
 *   exposure E_w   rows SERVED in w (one row = one served impression)
 *   activity       outcomes at outcome_at in w with a positive weight:
 *                  save 3, any other positive outcome 2 (dismiss and analytics
 *                  are not activity, exactly as in v1)
 *   clusters       clusterByIndependence over w's activity, one observation
 *                  per event: actor = user_id, no group token, value =
 *                  `item|outcome`, observed at outcome_at
 *   A_w            Σ over clusters of min(cluster activity, TREND_V2_GROUP_CAP)
 *   G_w            the number of clusters
 *   r_w            A_w / E_w when E_w ≥ TREND_V2_MIN_EXPOSURES, else no reading
 *   had_w          r_w is a reading AND G_w ≥ TREND_V2_MIN_GROUPS
 *
 * The six normalisers (`03` §7), in the order the spec lists them:
 *   exposure       r_w is activity PER EXPOSURE (above).
 *   creator, Trail, location
 *                  a peer baseline: v is divided by M, the LARGEST of three
 *                  medians of the same v over other places sharing the key
 *                  (same submitter; any shared Trail; same Local Pulse cell),
 *                  each median taken only over ≥ TREND_V2_MIN_PEERS peers.
 *                  The largest, not the product: the three peer groups overlap
 *                  (a creator's places tend to share a cell), and a product
 *                  would divide one shared surge out two or three times.
 *   time of day    direct standardisation over four six-hour UTC bands: the
 *                  baseline's per-band conversion re-weighted to the recent
 *                  window's exposure mix, over its pooled conversion. For one
 *                  place a UTC band is a fixed shift of a local band (its time
 *                  zone does not move), so like is compared with like.
 *   content age    a baseline window never counts the LAUNCH window: rows
 *                  within TREND_V2_LAUNCH_MS of the place's creation are left
 *                  out of mid, prior and base (a launch burst is not history),
 *                  and the lifecycle's decay horizon is the content type's.
 *
 *   v   = r_recent / (r_mid × tod_mid)          (classifier; needs had_mid)
 *   v_s = r_recent / (r_base × tod_base)        (scalar; needs had_base)
 *   ṽ   = v / M                                 (M = 1 when no peer group qualifies)
 *
 * Classification, in v1's evaluation order:
 *   1. no recent reading, or G_recent < TREND_V2_MIN_GROUPS  → unknown
 *   2. neither had_mid nor had_prior                         → emerging
 *   3. had_prior and not had_mid                             → rediscovered
 *   4. ṽ > TREND_GROWTH_FACTOR                               → trending
 *   5. ṽ < TREND_DECLINE_FACTOR                              → cooling
 *   6. otherwise                                             → established
 *
 * Scalar: momentum = clamp((ṽ_s − 1) / MOMENTUM_SATURATION, 0, 1), rounded to
 * three decimals, and 0 without a recent AND a base reading: no velocity
 * without a baseline to move from.
 *
 * PURITY
 * ======
 * No I/O, no clock other than `nowMs`, no randomness. Imports the Sensing
 * clustering (pure) and nothing from the two modules that delegate here, so
 * it cannot close an import cycle with them.
 */
import { clusterByIndependence, SYNC_WINDOW_SECONDS, type IndependenceObservation } from "./intelIndependence.js"; import { POST_CONVERGENCE_MIN_AUTHORS, type PostAfterVisitInput, type PostWindow } from "./discoveryTrendPostConvergence.js";  // §95 (DV-34): "visitors post afterward", only when the caller passes it

// ─────────────────────────────────────────────────────────────────────────────
// Constants. Each is mirrored in migration 3477 under the name in brackets and
// pinned equal by src/test/discoveryTrendNormalised.test.ts (N-SQL).
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/** v1's windows, restated because this module may not import the v1 modules (cycle). Pinned equal. */
export const TREND_V2_RECENT_MS = 48 * HOUR;
export const TREND_V2_MID_MS    = 7 * 24 * HOUR;
export const TREND_V2_PRIOR_MS  = 30 * 24 * HOUR;

/** [c_w_save], [c_w_outcome]. v1's weights for the outcome arm; the impression arm is gone (D-W10-R1-1). */
export const TREND_V2_WEIGHTS = { save: 3, outcome: 2 } as const;

/**
 * [c_min_exposures] D-W10-R1-2. Below this many served impressions a window's
 * conversion is not a reading. At n = 30 the worst-case 95 % half-width of a
 * sample proportion is 1.96 × 0.5 / √30 ≈ ±0.18, the conventional floor for
 * the normal approximation; below it one extra exposure moves the rate by
 * more than 1/30.
 */
export const TREND_V2_MIN_EXPOSURES = 30;

/**
 * [c_group_cap] D-W10-R1-3. One independence cluster contributes at most one
 * save's weight per key per window — Sensing's "one cluster contributes at
 * most one full source weight" in Discovery's units.
 */
export const TREND_V2_GROUP_CAP = TREND_V2_WEIGHTS.save;

/**
 * [c_min_groups] D-W10-R1-3. The smallest number of independent clusters at
 * which no single cluster can supply a MAJORITY of the capped activity: with
 * the cap 3 and the smallest positive weight 2, one cluster's share is at
 * most 3 / (3 + 2(n − 1)) — 60 % at n = 2, 43 % at n = 3.
 */
export const TREND_V2_MIN_GROUPS = 3;

/** [c_min_peers] A peer median is a baseline only over this many other places (the same majority argument). */
export const TREND_V2_MIN_PEERS = 3;

/** [c_launch_ms] Content age: the launch window left out of every baseline — one recent window. */
export const TREND_V2_LAUNCH_MS = TREND_V2_RECENT_MS;

/** [c_sync_ms] Sensing's synchronised-behaviour window, reused. */
export const TREND_V2_SYNC_MS = SYNC_WINDOW_SECONDS * 1_000;

/** Time-of-day bands: four six-hour UTC bands ([floor(hour / 6)]). */
export const TREND_V2_BAND_HOURS = 6;
export const TREND_V2_BANDS = 24 / TREND_V2_BAND_HOURS;

/** [c_growth], [c_decline] — v1's factors, pinned equal to TREND_GROWTH_FACTOR / TREND_DECLINE_FACTOR. */
export const TREND_V2_GROWTH_FACTOR = 1.5;
export const TREND_V2_DECLINE_FACTOR = 0.6;

/** The scalar's saturation — v1's MOMENTUM_SATURATION, pinned equal. */
export const TREND_V2_SATURATION = 3;

/**
 * `03` §4 content types (D-W10-R1-7). A nightclub EVENT "decays in hours"; a
 * temple guide "may remain valuable for years". Matched on the place's own
 * `category`, then `place_type`, lower-cased and trimmed, exactly.
 */
export const CONTENT_CLASSES = ["ephemeral", "standard", "enduring"] as const;
export type ContentClass = (typeof CONTENT_CLASSES)[number];
export const EPHEMERAL_TYPES = ["event", "events", "festival", "concert", "performance", "party"] as const;
export const ENDURING_TYPES = [
  "temple", "church", "cathedral", "mosque", "shrine", "monument", "palace", "castle", "fort", "ruins",
  "landmark", "museum", "heritage site", "historic district", "attraction", "beach", "park", "garden", "viewpoint",
] as const;
/** [c_h_ephemeral_ms] [c_h_standard_ms] [c_h_enduring_ms] — the decay horizon after the last positive activity. */
export const CONTENT_HORIZON_MS: Readonly<Record<ContentClass, number>> = {
  ephemeral: 12 * HOUR,
  standard:  TREND_V2_PRIOR_MS,
  enduring:  365 * 24 * HOUR,
};

/** Local Pulse's grid, when a place has no named neighbourhood: lib/mapTravelers AREA_GRID_DEG (≈2.2 km), the finest the map shows. */
export const TREND_V2_CELL_DEG = 0.02;

/** `03` §4's seven lifecycle states, plus `unknown` (no claim). */
export const TREND_LIFECYCLE_STATES = [
  "unknown", "emerging", "growing", "peak", "cooling", "evergreen", "rediscovered", "inactive",
] as const;
export type TrendLifecycle = (typeof TREND_LIFECYCLE_STATES)[number];

/** What drove a claim (D-W10-R1-9): a majority of its independent clusters did it. */
export const TREND_DRIVERS = ["trip_adds", "saves", "independent_groups"] as const;
export type TrendDriver = (typeof TREND_DRIVERS)[number];

/** The v2 states are v1's six (`03` §9); the stored CHECK is unchanged. */
export type TrendStateV2 = "unknown" | "emerging" | "trending" | "established" | "cooling" | "rediscovered";

// ─────────────────────────────────────────────────────────────────────────────
// Context: what the rows cannot say about a place
// ─────────────────────────────────────────────────────────────────────────────

/** The row shape read from `rank_events`. `user_id` is what makes independence countable. */
export interface TrendRowV2 {
  item_id: string;
  outcome: string;
  served_at: string;
  outcome_at?: string | null;
  user_id?: string | null;
}

export interface PlaceTrendContext {
  /** `discovery_places.submitted_by` — the creator peer group. */
  creatorId: string | null;
  /** The Local Pulse cell (D-W10-R1-6) — the location peer group. */
  cellKey: string | null;
  /** A named neighbourhood's display text; null for a grid cell. Never used to compute. */
  cellLabel: string | null;
  city: string | null;
  createdAtMs: number | null;
  contentClass: ContentClass;
  /** Non-archived Trails the place is a member of — the Trail peer group. */
  trailIds: readonly string[];
}

/** Keyed by `discovery_places.id` as text (lower-case uuid). */
export type TrendContext = Readonly<Record<string, PlaceTrendContext>>;

/** The `discovery_places` columns the context reads. */
export interface ContextPlaceRow {
  id: string;
  submitted_by?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  lat?: number | null;
  lng?: number | null;
  created_at?: string | null;
  category?: string | null;
  place_type?: string | null;
}

/** `content_trails` rows of source_type 'place' whose Trail is not archived. */
export interface ContextMembershipRow { trail_id: string; source_id: string }

/** PostgreSQL btrim(): spaces only, not every whitespace. */
const btrim = (s: string): string => s.replace(/^ +| +$/g, "");

/** `03` §4 content class — mirrored by 3476's discovery_trend_place_context(). */
export function contentClassOf(category: string | null | undefined, placeType: string | null | undefined): ContentClass {
  const cat = btrim(String(category ?? "")).toLowerCase();
  const typ = btrim(String(placeType ?? "")).toLowerCase();
  if ((EPHEMERAL_TYPES as readonly string[]).includes(cat)) return "ephemeral";
  if ((ENDURING_TYPES as readonly string[]).includes(cat)) return "enduring";
  if ((EPHEMERAL_TYPES as readonly string[]).includes(typ)) return "ephemeral";
  if ((ENDURING_TYPES as readonly string[]).includes(typ)) return "enduring";
  return "standard";
}

/** The Local Pulse cell: a named neighbourhood within its city, else the grid square. */
export function cellKeyOf(city: string | null, neighbourhood: string | null, lat: unknown, lng: unknown): string | null {
  if (neighbourhood && city) return `n:${city}:${neighbourhood.toLowerCase()}`;
  if (typeof lat === "number" && Number.isFinite(lat) && typeof lng === "number" && Number.isFinite(lng)) {
    return `g:${String(Math.floor(lat / TREND_V2_CELL_DEG) + 0)}:${String(Math.floor(lng / TREND_V2_CELL_DEG) + 0)}`;
  }
  return null;
}

/** The byte order PostgreSQL's COLLATE "C" gives, for a label chosen as the minimum. */
const cMin = (a: string, b: string): string => (Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) <= 0 ? a : b);

/**
 * Rows → context. Mirrors 3476's `discovery_trend_place_context()` exactly: the
 * suite N-CTX compares the two over the same rows on the harness.
 */
export function buildPlaceTrendContext(
  places: readonly ContextPlaceRow[],
  memberships: readonly ContextMembershipRow[] = [],
): Record<string, PlaceTrendContext> {
  const trails = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!m || typeof m.trail_id !== "string" || typeof m.source_id !== "string") continue;
    const k = m.source_id.toLowerCase();
    let s = trails.get(k);
    if (!s) { s = new Set(); trails.set(k, s); }
    s.add(m.trail_id.toLowerCase());
  }
  const staged: Array<{ key: string; ctx: PlaceTrendContext; hood: string | null }> = [];
  const labels = new Map<string, string>();
  for (const p of places) {
    if (!p || typeof p.id !== "string" || p.id === "") continue;
    const cityRaw = btrim(String(p.city ?? "")).toLowerCase();
    const city = cityRaw === "" ? null : cityRaw;
    const hoodRaw = btrim(String(p.neighborhood ?? ""));
    const hood = hoodRaw === "" ? null : hoodRaw;
    const cellKey = cellKeyOf(city, hood, p.lat, p.lng);
    const created = typeof p.created_at === "string" ? Date.parse(p.created_at) : NaN;
    const key = p.id.toLowerCase();
    staged.push({
      key, hood: cellKey !== null && cellKey.startsWith("n:") ? hood : null,
      ctx: {
        creatorId: typeof p.submitted_by === "string" && p.submitted_by !== "" ? p.submitted_by.toLowerCase() : null,
        cellKey, cellLabel: null, city,
        createdAtMs: Number.isFinite(created) ? created : null,
        contentClass: contentClassOf(p.category, p.place_type),
        trailIds: [...(trails.get(key) ?? [])].sort(),
      },
    });
    if (cellKey !== null && cellKey.startsWith("n:") && hood !== null) {
      const cur = labels.get(cellKey);
      labels.set(cellKey, cur === undefined ? hood : cMin(cur, hood));
    }
  }
  const out: Record<string, PlaceTrendContext> = {};
  for (const s of staged) out[s.key] = { ...s.ctx, cellLabel: s.ctx.cellKey !== null ? labels.get(s.ctx.cellKey) ?? null : null };
  return out;
}

/** A served item id → its context key: `db/<uuid>` and the bare uuid name one community place. */
export function contextKeyOfItem(itemId: string): string {
  return itemId.replace(/^db\//, "").toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

type Win = "recent" | "mid" | "prior";

interface Activity { actor: string; value: string; atMs: number; w: number; outcome: string }

interface WindowAcc {
  exposures: number;
  bandExposures: number[];
  bandActivity: number[];
  activity: Activity[];
}

const newWin = (): WindowAcc => ({
  exposures: 0,
  bandExposures: new Array<number>(TREND_V2_BANDS).fill(0),
  bandActivity: new Array<number>(TREND_V2_BANDS).fill(0),
  activity: [],
});

interface KeyAcc {
  w: Record<Win, WindowAcc>;
  /** base = mid ∪ prior, for the scalar. */
  base: WindowAcc;
  recentTravelers: Set<string>;
  windowTravelers: Set<string>;
  lastActivityMs: number | null;
}

/** Evidence of one window after clustering. */
export interface WindowEvidence {
  exposures: number;
  /** Σ over clusters of min(cluster activity, cap). */
  activity: number;
  groups: number;
  /** Clusters in which a save / a trip add occurred. */
  saveGroups: number;
  tripAddGroups: number;
  /** activity / exposures when exposures ≥ the floor, else null. */
  rate: number | null;
}

const bandOf = (ms: number): number => Math.floor(new Date(ms).getUTCHours() / TREND_V2_BAND_HOURS);

/** Milliseconds, truncated as PostgreSQL's floor(extract(epoch) × 1000) truncates. */
const msOf = (iso: string | null | undefined): number => (typeof iso === "string" ? Date.parse(iso) : NaN);

function positiveWeight(outcome: string): number {
  if (outcome === "impression" || outcome === "analytics" || outcome === "dismiss") return 0;
  return outcome === "save" ? TREND_V2_WEIGHTS.save : TREND_V2_WEIGHTS.outcome;
}

function clusterWindow(acc: WindowAcc): WindowEvidence {
  const obs: IndependenceObservation[] = acc.activity.map((a) => ({
    actorId: a.actor, groupKey: null, valueKey: a.value, observedAtMs: a.atMs, mediaRefs: [], sourceRefs: [],
  }));
  const clustering = clusterByIndependence(obs);
  const byCluster = new Map<string, { a: number; save: boolean; trip: boolean }>();
  for (const a of acc.activity) {
    const c = clustering.clusterForUnit(null, a.actor);
    const cur = byCluster.get(c) ?? { a: 0, save: false, trip: false };
    cur.a += a.w;
    if (a.outcome === "save") cur.save = true;
    if (a.outcome === "trip_add") cur.trip = true;
    byCluster.set(c, cur);
  }
  let activity = 0, saveGroups = 0, tripAddGroups = 0;
  for (const c of byCluster.values()) {
    activity += Math.min(c.a, TREND_V2_GROUP_CAP);
    if (c.save) saveGroups += 1;
    if (c.trip) tripAddGroups += 1;
  }
  const rate = acc.exposures >= TREND_V2_MIN_EXPOSURES ? activity / acc.exposures : null;
  return { exposures: acc.exposures, activity, groups: byCluster.size, saveGroups, tripAddGroups, rate };
}

/** Did this window carry history? A reading over enough independent clusters. */
const had = (e: WindowEvidence): boolean => e.rate !== null && e.groups >= TREND_V2_MIN_GROUPS;

/**
 * Time of day (D-W10-R1-5): the baseline's conversion re-weighted to the
 * recent window's band mix, over the baseline's pooled conversion. Uncapped
 * weights, so the factor is a property of when people were exposed, not of
 * who they were. 1 when either side carries no information.
 */
function timeOfDayFactor(recent: WindowAcc, baseline: WindowAcc): number {
  const baseActivity = baseline.bandActivity.reduce((s, x) => s + x, 0);
  if (recent.exposures <= 0 || baseline.exposures <= 0) return 1;
  const pooled = baseActivity / baseline.exposures;
  if (!(pooled > 0)) return 1;
  let expected = 0;
  for (let d = 0; d < TREND_V2_BANDS; d++) {
    const share = recent.bandExposures[d]! / recent.exposures;
    const bandRate = baseline.bandExposures[d]! > 0 ? baseline.bandActivity[d]! / baseline.bandExposures[d]! : pooled;
    expected += share * bandRate;
  }
  return expected > 0 ? expected / pooled : 1;
}

export interface AggregateOptions {
  /** The key a row belongs to (a place, a cell, a Trail); null drops the row. */
  keyOf: (row: TrendRowV2) => string | null;
  /** The row's place context, for the launch window; null when unknown. */
  contextOf: (row: TrendRowV2) => PlaceTrendContext | null;
}

function aggregate(rows: readonly TrendRowV2[], nowMs: number, opts: AggregateOptions): Map<string, KeyAcc> {
  const recentSince = nowMs - TREND_V2_RECENT_MS;
  const midSince = nowMs - TREND_V2_MID_MS;
  const priorSince = nowMs - TREND_V2_PRIOR_MS;
  const winOf = (at: number): Win => (at >= recentSince ? "recent" : at >= midSince ? "mid" : "prior");
  const acc = new Map<string, KeyAcc>();
  const get = (k: string): KeyAcc => {
    let a = acc.get(k);
    if (!a) {
      a = { w: { recent: newWin(), mid: newWin(), prior: newWin() }, base: newWin(), recentTravelers: new Set(), windowTravelers: new Set(), lastActivityMs: null };
      acc.set(k, a);
    }
    return a;
  };
  /** Content age: a baseline window never counts the launch window. */
  const launch = (ctx: PlaceTrendContext | null, at: number, win: Win): boolean =>
    win !== "recent" && ctx !== null && ctx.createdAtMs !== null && at >= ctx.createdAtMs && at < ctx.createdAtMs + TREND_V2_LAUNCH_MS;
  const inRange = (at: number): boolean => Number.isFinite(at) && at <= nowMs && at >= priorSince;

  for (const r of rows) {
    if (!r?.item_id || r.outcome === "analytics") continue;
    // The loader's read, and 3477's `base`: a row is admitted only when it was
    // SERVED inside the window (census §58.6 #3 — an outcome on an impression
    // served earlier is not read, by the product or the store).
    if (!(msOf(r.served_at) >= priorSince)) continue;
    const key = opts.keyOf(r);
    if (key === null) continue;
    const ctx = opts.contextOf(r);
    const actor = typeof r.user_id === "string" && r.user_id !== "" ? r.user_id.toLowerCase() : null;
    const a = get(key);

    // The exposure arm: every served row, at served_at.
    const served = msOf(r.served_at);
    if (inRange(served)) {
      if (actor) { a.windowTravelers.add(actor); if (served >= recentSince) a.recentTravelers.add(actor); }
      const win = winOf(served);
      if (!launch(ctx, served, win)) {
        const band = bandOf(served);
        for (const t of win === "recent" ? [a.w.recent] : [a.w[win], a.base]) {
          t.exposures += 1;
          t.bandExposures[band]! += 1;
        }
      }
    }

    // The outcome arm: a converted row, at outcome_at.
    if (r.outcome === "impression") continue;
    const at = msOf(r.outcome_at ?? null);
    if (!inRange(at)) continue;
    if (actor) { a.windowTravelers.add(actor); if (at >= recentSince) a.recentTravelers.add(actor); }
    const w = positiveWeight(r.outcome);
    if (w <= 0 || actor === null) continue;
    a.lastActivityMs = a.lastActivityMs === null ? at : Math.max(a.lastActivityMs, at);
    const win = winOf(at);
    if (launch(ctx, at, win)) continue;
    const ev: Activity = { actor, value: `${r.item_id}|${r.outcome}`, atMs: at, w, outcome: r.outcome };
    const band = bandOf(at);
    for (const t of win === "recent" ? [a.w.recent] : [a.w[win], a.base]) {
      t.activity.push(ev);
      t.bandActivity[band]! += w;
    }
  }
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence, peers, classification
// ─────────────────────────────────────────────────────────────────────────────

export interface TrendEvidenceV2 {
  // v1's four names, with v2's meaning: activity PER EXPOSURE (0 when a window
  // has no exposure) and the capped total. `model_version` says which.
  recentRate: number;
  midRate: number;
  priorRate: number;
  totalWeight: number;
  recentExposures: number;
  midExposures: number;
  priorExposures: number;
  recentGroups: number;
  midGroups: number;
  priorGroups: number;
  /** The recent window's time-of-day factor against mid. */
  timeOfDayFactor: number;
  /** M: the largest qualifying peer median, 1 when none qualifies. */
  peerFactor: number;
  /** ṽ, or null when there is no mid reading to accelerate from. */
  velocity: number | null;
  recentTravelers: number;
  windowTravelers: number;
  lastActivityAt: string | null; /** §95 (DV-34): present only when the post-after-visit leg was passed. */ postConvergence?: { status: "ok"; recentGroups: number; midGroups: number; priorGroups: number } | { status: "unread" };
}

export interface TrendReadingV2 {
  state: TrendStateV2;
  lifecycle: TrendLifecycle;
  driver: TrendDriver | null;
  evidence: TrendEvidenceV2;
}

/** The median `percentile_cont(0.5)` computes. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * M for each key: the largest median of peers' own v, over the three peer
 * groups, each only when it has ≥ TREND_V2_MIN_PEERS other members with a v.
 * 1 when none qualifies. Mirrored by 3477's `m_creator`, `m_trail`, `m_cell`.
 */
export function peerFactors(
  own: ReadonlyMap<string, number>,
  contextOfKey: (key: string) => PlaceTrendContext | null,
): Map<string, number> {
  const keys = [...own.keys()];
  const out = new Map<string, number>();
  for (const k of [...own.keys()]) {
    const c = contextOfKey(k);
    if (!c) { out.set(k, 1); continue; }
    const medianWhere = (pred: (q: PlaceTrendContext) => boolean): number | null => {
      const vs: number[] = [];
      for (const q of keys) {
        if (q === k) continue;
        const qc = contextOfKey(q);
        if (qc && pred(qc)) vs.push(own.get(q)!);
      }
      return vs.length >= TREND_V2_MIN_PEERS ? median(vs) : null;
    };
    const ms = [
      c.creatorId !== null ? medianWhere((q) => q.creatorId === c.creatorId) : null,
      c.trailIds.length > 0 ? medianWhere((q) => q.trailIds.some((t) => c.trailIds.includes(t))) : null,
      c.cellKey !== null ? medianWhere((q) => q.cellKey === c.cellKey) : null,
    ].filter((m): m is number => m !== null);
    out.set(k, ms.length > 0 ? Math.max(...ms) : 1);
  }
  return out;
}

/** The v2 classifier. Mirrored by 3477's `place_momentum_classify_v2`. */
export function classifyTrendStateV2(i: {
  recentReading: boolean; hadMid: boolean; hadPrior: boolean; velocity: number | null;
}): TrendStateV2 {
  if (!i.recentReading) return "unknown";
  if (!i.hadMid && !i.hadPrior) return "emerging";
  if (i.hadPrior && !i.hadMid) return "rediscovered";
  if (i.velocity === null) return "unknown";
  if (i.velocity > TREND_V2_GROWTH_FACTOR) return "trending";
  if (i.velocity < TREND_V2_DECLINE_FACTOR) return "cooling";
  return "established";
}

/** `03` §4 lifecycle (D-W10-R1-7). Mirrored by 3477's `place_momentum_lifecycle_v2`. */
export function lifecycleOf(
  state: TrendStateV2, cls: ContentClass, hadPrior: boolean, lastActivityMs: number | null, nowMs: number,
): TrendLifecycle {
  const lapsed = lastActivityMs !== null && nowMs - lastActivityMs > CONTENT_HORIZON_MS[cls];
  switch (state) {
    case "emerging": return "emerging";
    case "trending": return "growing";
    case "established": return cls !== "ephemeral" && hadPrior ? "evergreen" : "peak";
    case "rediscovered": return "rediscovered";
    case "cooling": return lapsed ? "inactive" : "cooling";
    default: return lapsed ? "inactive" : "unknown";
  }
}

/**
 * The driver (D-W10-R1-9): trip adds when a strict majority of the recent
 * window's clusters added the place to a trip, else saves on the same rule,
 * else the breadth itself. Null for `unknown` and `cooling` — a decline has
 * no driver to name.
 */
export function driverOf(state: TrendStateV2, recent: WindowEvidence): TrendDriver | null {
  if (state === "unknown" || state === "cooling") return null;
  if (recent.tripAddGroups * 2 > recent.groups) return "trip_adds";
  if (recent.saveGroups * 2 > recent.groups) return "saves";
  return "independent_groups";
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export interface ComputeV2Options {
  /** Place context keyed by `contextKeyOfItem`; absent ⇒ no peers, no launch window, standard class. */
  context?: TrendContext;
  /** Group rows by something other than the item (Local Pulse cells, Trails). */
  keyOf?: (row: TrendRowV2) => string | null;
  /** Peer groups on or off (off for cells and Trails, which have no peers of their own). */
  peers?: boolean;
  /** The content class of a non-place key. */
  classOfKey?: (key: string) => ContentClass; /** §95 (DV-34, D-W11X3-2): the post-after-visit leg; absent ⇒ §84 byte for byte. */ postAfterVisit?: PostAfterVisitInput;
}

/** Rows → key → v2 reading. The in-process twin of 3477's rebuild. */
export function computeTrendStatesV2(
  rows: readonly TrendRowV2[], nowMs: number, opts: ComputeV2Options = {},
): Record<string, TrendReadingV2> {
  const ctxOfItem = (itemId: string): PlaceTrendContext | null => opts.context?.[contextKeyOfItem(itemId)] ?? null;
  const acc = aggregate(rows, nowMs, {
    keyOf: opts.keyOf ?? ((r) => r.item_id),
    contextOf: (r) => ctxOfItem(r.item_id),
  });
  const ev = new Map<string, { recent: WindowEvidence; mid: WindowEvidence; prior: WindowEvidence; tod: number; k: KeyAcc }>();
  const own = new Map<string, number>();
  for (const [key, k] of acc) {
    const recent = withPostConvergence(clusterWindow(k.w.recent), k.w.recent, key, "recent", opts.postAfterVisit), mid = withPostConvergence(clusterWindow(k.w.mid), k.w.mid, key, "mid", opts.postAfterVisit), prior = withPostConvergence(clusterWindow(k.w.prior), k.w.prior, key, "prior", opts.postAfterVisit);
    const tod = timeOfDayFactor(k.w.recent, k.w.mid);
    ev.set(key, { recent, mid, prior, tod, k });
    if (had(recent) && had(mid)) own.set(key, recent.rate! / (mid.rate! * tod));
  }
  const peers = opts.peers === false ? new Map<string, number>() : peerFactors(own, (key) => ctxOfItem(key));
  const out: Record<string, TrendReadingV2> = {};
  for (const [key, e] of ev) {
    const m = peers.get(key) ?? 1;
    const v = own.has(key) ? own.get(key)! / m : null;
    const state = classifyTrendStateV2({ recentReading: had(e.recent), hadMid: had(e.mid), hadPrior: had(e.prior), velocity: v });
    const cls = opts.classOfKey ? opts.classOfKey(key) : ctxOfItem(key)?.contentClass ?? "standard";
    out[key] = {
      state,
      lifecycle: lifecycleOf(state, cls, had(e.prior), e.k.lastActivityMs, nowMs),
      driver: driverOf(state, e.recent),
      evidence: {
        recentRate: e.recent.exposures > 0 ? e.recent.activity / e.recent.exposures : 0,
        midRate:    e.mid.exposures > 0 ? e.mid.activity / e.mid.exposures : 0,
        priorRate:  e.prior.exposures > 0 ? e.prior.activity / e.prior.exposures : 0,
        totalWeight: e.recent.activity + e.mid.activity + e.prior.activity,
        recentExposures: e.recent.exposures, midExposures: e.mid.exposures, priorExposures: e.prior.exposures,
        recentGroups: e.recent.groups, midGroups: e.mid.groups, priorGroups: e.prior.groups,
        timeOfDayFactor: e.tod, peerFactor: m, velocity: v,
        recentTravelers: e.k.recentTravelers.size, windowTravelers: e.k.windowTravelers.size,
        lastActivityAt: iso(e.k.lastActivityMs), ...postConvergenceEvidence(opts.postAfterVisit, e.recent, e.mid, e.prior),
      },
    };
  }
  return out;
}

/** The momentum scalar, v2. Only places with momentum > 0 appear, as in v1. */
export function computeLocalMomentumV2(
  rows: readonly TrendRowV2[], nowMs: number, opts: { context?: TrendContext } = {},
): Record<string, number> {
  const ctxOfItem = (itemId: string): PlaceTrendContext | null => opts.context?.[contextKeyOfItem(itemId)] ?? null;
  const acc = aggregate(rows, nowMs, { keyOf: (r) => r.item_id, contextOf: (r) => ctxOfItem(r.item_id) });
  const own = new Map<string, number>();
  for (const [key, k] of acc) {
    const recent = clusterWindow(k.w.recent), base = clusterWindow(k.base);
    if (had(recent) && had(base)) own.set(key, recent.rate! / (base.rate! * timeOfDayFactor(k.w.recent, k.base)));
  }
  const peers = peerFactors(own, (key) => ctxOfItem(key));
  const out: Record<string, number> = {};
  for (const [key, v] of own) {
    const vNorm = v / (peers.get(key) ?? 1);
    const m = Math.min(1, Math.max(0, (vNorm - 1) / TREND_V2_SATURATION));
    if (m > 0) out[key] = Math.round(m * 1000) / 1000;
  }
  return out;
}

/**
 * DV-29 Local Pulse: the same model over a CELL — every row of every place in
 * it — classified by the same rule, with no peer baseline (a cell is its own
 * location baseline). Stored in `area_momentum` by 3477.
 */
export function computeAreaTrendStates(
  rows: readonly TrendRowV2[], nowMs: number, context: TrendContext,
): Record<string, TrendReadingV2> {
  return computeTrendStatesV2(rows, nowMs, {
    context,
    keyOf: (r) => context[contextKeyOfItem(r.item_id)]?.cellKey ?? null,
    peers: false,
    classOfKey: () => "standard",
  });
}

/** The label of a cell, when it is a named neighbourhood. */
export function cellLabelOf(context: TrendContext, cellKey: string): string | null {
  for (const c of Object.values(context)) if (c.cellKey === cellKey && c.cellLabel !== null) return c.cellLabel;
  return null;
}

// ── census-discovery §95 (lane W11-X3): `03` §6 "visitors post afterward" ────
//
// DV-34, register D-W11X3-2, work item W11A-B9. Appended so no cited line above
// moves. lib/discoveryTrendPostConvergence builds the input (published, public
// Memories only; k-floored); this is where it meets the classifier's
// convergence input, the window's independent-group count.

/** Post-after-visit groups added to this window's G. Only the classifier's input; never activity. */
const POST_GROUPS = new WeakMap<WindowEvidence, number>();

/**
 * G + the independence clusters of the window's NEW post authors — travellers
 * who posted publicly after their own positive outcome and are not already one
 * of the window's activity actors (the same traveller is not independent
 * evidence twice). Below the k-floor of new authors it adds 0. Never negative:
 * the leg only adds convergence. Absent or `unread` input: the evidence as is.
 */
function withPostConvergence(e: WindowEvidence, acc: WindowAcc, key: string, win: PostWindow, input: PostAfterVisitInput | undefined): WindowEvidence {
  if (!input || input.status !== "ok") return e;
  const authors = input.byKey.get(key)?.[win] ?? [];
  const actors = new Set(acc.activity.map((a) => a.actor));
  const fresh = authors.filter((a) => !actors.has(a));
  let added = 0;
  if (fresh.length >= POST_CONVERGENCE_MIN_AUTHORS) {
    const times = input.posts.get(key);
    const obs: IndependenceObservation[] = fresh.map((a) => ({
      actorId: a, groupKey: null, valueKey: `${key}|post`, observedAtMs: times?.get(`${win}|${a}`) ?? 0, mediaRefs: [], sourceRefs: [],
    }));
    const clustering = clusterByIndependence(obs);
    added = new Set(fresh.map((a) => clustering.clusterForUnit(null, a))).size;
  }
  const out: WindowEvidence = { ...e, groups: e.groups + added };
  POST_GROUPS.set(out, added);
  return out;
}

/** The evidence's post breakdown — present only when the caller passed the leg. */
function postConvergenceEvidence(
  input: PostAfterVisitInput | undefined, recent: WindowEvidence, mid: WindowEvidence, prior: WindowEvidence,
): { postConvergence?: { status: "ok"; recentGroups: number; midGroups: number; priorGroups: number } | { status: "unread" } } {
  if (!input) return {};
  if (input.status !== "ok") return { postConvergence: { status: "unread" } };
  return { postConvergence: { status: "ok", recentGroups: POST_GROUPS.get(recent) ?? 0, midGroups: POST_GROUPS.get(mid) ?? 0, priorGroups: POST_GROUPS.get(prior) ?? 0 } };
}
