/**
 * discoveryTrendState — `03` §9's place-momentum stages, from the rows
 * lib/discoveryLocalMomentum already reads.
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/03_Trending.md` §9 (`:122`):
 *
 *   "Conceptual stages: unknown, emerging, trending, established, cooling,
 *    rediscovered."
 *
 * and §14's acceptance criteria — *"it can distinguish emerging vs
 * established"* and *"it can explain major trend reasons"*. §11 gives the shape
 * of an explanation: *"Rising quickly in Sukhumvit tonight."*
 *
 * census-discovery DV-28 (*"a scalar is not a lifecycle"*) and DV-33.
 *
 * WHY A SCALAR CANNOT ANSWER THIS, AND WHAT FIXES IT
 * ==================================================
 * `computeLocalMomentum` returns one number: recent activity against a single
 * 30-day baseline. Two places can produce the SAME number and mean opposite
 * things — one with no history and a little activity (emerging), one with a long
 * history and less activity than before (cooling). §9 exists precisely because
 * those deserve different sentences.
 *
 * What separates them is a THIRD window, and the rows already contain it. This
 * module reads the same `rank_events` rows, splits them into
 *
 *     recent  [now − 48 h, now]
 *     mid     [now − 7 d,  now − 48 h)
 *     prior   [now − 30 d, now − 7 d)
 *
 * and normalises each to a per-48-hour rate so the three are comparable. Nothing
 * new is read, nothing is persisted, and `computeLocalMomentum` is not touched:
 * a number the ranker already consumes must not move because a diagnostic was
 * added beside it.
 *
 * SIX STAGES, NOT `03` §4's SEVEN — AND THE DIFFERENCE IS NOT COSMETIC
 * ====================================================================
 * `03` §4 specifies a seven-state CONTENT lifecycle (emerging, growing, peak,
 * cooling, evergreen, rediscovered, inactive) and adds the rule that makes it a
 * different object: *"Trend lifecycle must depend on content type. A nightclub
 * event decays in hours. A temple guide may remain valuable for years."* A
 * place-scoped activity signal has no content-type dimension to decay
 * differently by, so implementing §4's list here would be seven labels over a
 * model that cannot distinguish them. §9's six are what this evidence supports,
 * and census-discovery DV-28 records the §4 lifecycle as still absent.
 *
 * ORDER OF EVALUATION IS PART OF THE CONTRACT
 * ===========================================
 * The states are not mutually exclusive by construction — a place can satisfy
 * "rediscovered" and "trending" at once — so the order below IS the ruling and is
 * pinned by tests:
 *
 *   1. below the evidence floor          → unknown  (never a claim)
 *   2. no history at all                 → emerging
 *   3. history, quiet middle, active now → rediscovered
 *   4. accelerating against the middle   → trending
 *   5. decelerating against the middle   → cooling
 *   6. otherwise sustained               → established
 *
 * `rediscovered` is checked before `trending` because a return after silence is
 * the more specific and more useful thing to say; `unknown` is checked first
 * because absence of evidence must never become evidence.
 */
// TYPE-ONLY, and that is load-bearing: lib/discoveryLocalMomentum imports this
// module to compute the stages beside its scalar, so a VALUE import back the
// other way would be a runtime cycle — and an ES-module cycle through a `const`
// fails at import time with "cannot access before initialization", which is a
// startup crash rather than a test failure. The two numeric constants this
// module needs are therefore declared here and pinned equal to the momentum
// module's by a test, not shared by an import.
import type { MomentumRow } from "./discoveryLocalMomentum.js";
// NOT type-only, and safe: lib/discoveryRankProvenance imports nothing, so it
// cannot close a cycle back through either of the two modules that use it.
import { derivedStoreProvenance, type DerivedStoreProvenance } from "./discoveryRankProvenance.js";

/** `03` §9's stages, in the specification's own order. */
export const TREND_STATES = [
  "unknown",
  "emerging",
  "trending",
  "established",
  "cooling",
  "rediscovered",
] as const;

export type DiscoveryTrendState = (typeof TREND_STATES)[number];

const HOUR = 60 * 60 * 1_000;
export const TREND_RECENT_MS = 48 * HOUR;
export const TREND_MID_MS    = 7 * 24 * HOUR;
export const TREND_PRIOR_MS  = 30 * 24 * HOUR;

/**
 * Event weights. MUST equal `MOMENTUM_EVENT_WEIGHTS` in
 * lib/discoveryLocalMomentum — two modules weighing the same rows differently
 * would produce a stage and a scalar that disagree about the same place. Pinned
 * equal by a test rather than shared by an import; see the import note above.
 */
export const TREND_EVENT_WEIGHTS = { impression: 1, save: 3, outcome: 2 } as const;

/**
 * The per-48-hour activity rate below which a window counts as SILENT.
 *
 * MUST equal `MOMENTUM_MIN_RECENT_WEIGHT`, so the two modules cannot disagree
 * about whether a place is active — one calling it a surge while the other calls
 * it noise would be worse than either being wrong alone. Pinned by the same test.
 */
export const TREND_MIN_RATE = 3;

/** Recent must exceed the middle by this factor to be called acceleration. */
export const TREND_GROWTH_FACTOR = 1.5;
/** Recent must fall below the middle by this factor to be called cooling. */
export const TREND_DECLINE_FACTOR = 0.6;

export interface TrendEvidence {
  /** Weighted activity in the last 48 h. */
  recentRate: number;
  /** Weighted activity between 7 d and 48 h ago, normalised to a 48 h rate. */
  midRate: number;
  /** Weighted activity between 30 d and 7 d ago, normalised to a 48 h rate. */
  priorRate: number;
  /** Total weight seen across all three windows. 0 ⇒ nothing is known. */
  totalWeight: number;
}

export interface TrendReading {
  state: DiscoveryTrendState;
  evidence: TrendEvidence;
  /**
   * census-discovery DC-17 — what computed this reading, over which rows, when.
   *
   * On the READING rather than beside the map, because a reading is already a
   * record with room for a field and because a single reading is the unit that
   * travels: `readLocalTrendStates` hands one map out and a caller may keep one
   * entry of it, so a stage that has been separated from its map must still be
   * able to say which window produced it. Every reading from one call shares
   * one object by reference — one computation, one window, one clock.
   */
  provenance: DerivedStoreProvenance;
}

/**
 * Classify one place from its three window rates. Pure and total.
 *
 * Every branch is a claim about what the evidence supports, and the one that
 * matters most is the first: below the floor the answer is `unknown`, never
 * `cooling`. A place nobody has been served recently has not cooled — nothing
 * has been observed about it, and saying "cooling" would turn an absence of
 * evidence into a negative claim.
 */
export function classifyTrendState(e: TrendEvidence): DiscoveryTrendState {
  if (!e || e.totalWeight <= 0) return "unknown";
  if (e.recentRate < TREND_MIN_RATE) return "unknown";

  const hadMid   = e.midRate   >= TREND_MIN_RATE;
  const hadPrior = e.priorRate >= TREND_MIN_RATE;

  // `03` §3 Emerging — "Small absolute numbers, strong acceleration": active
  // now, and no history at all to accelerate away from.
  if (!hadMid && !hadPrior) return "emerging";

  // `03` §9 rediscovered — the QUIET MIDDLE is the whole state. Without it this
  // is just continued activity.
  if (hadPrior && !hadMid) return "rediscovered";

  if (e.recentRate > e.midRate * TREND_GROWTH_FACTOR) return "trending";
  if (e.recentRate < e.midRate * TREND_DECLINE_FACTOR) return "cooling";
  return "established";
}

function weightFor(outcome: string): number {
  if (outcome === "save") return TREND_EVENT_WEIGHTS.save;
  return TREND_EVENT_WEIGHTS.outcome;
}

/**
 * Rows → `place id → reading`, over the same `rank_events` projection
 * `computeLocalMomentum` reads and with the same exclusions: analytics rows are
 * ranker bookkeeping and are not activity, and an outcome is counted at its own
 * time as well as the impression at `served_at`.
 *
 * Every place that appears in the rows gets a reading, `unknown` included —
 * unlike the momentum map, which omits anything scoring zero. A caller asking
 * "what is the state of this place" needs "unknown" back, not a missing key that
 * it has to interpret.
 */
export function computeTrendStates(
  rows: readonly MomentumRow[],
  nowMs: number,
): Record<string, TrendReading> {
  const recentSince = nowMs - TREND_RECENT_MS;
  const midSince    = nowMs - TREND_MID_MS;
  const priorSince  = nowMs - TREND_PRIOR_MS;

  // Normalisers: each window's length expressed in 48-hour units, so the three
  // rates are comparable. Without this a 23-day window always looks bigger than
  // a 2-day one and every place reads as "cooling".
  const midWindows   = (TREND_MID_MS - TREND_RECENT_MS) / TREND_RECENT_MS;
  const priorWindows = (TREND_PRIOR_MS - TREND_MID_MS) / TREND_RECENT_MS;

  const acc = new Map<string, { recent: number; mid: number; prior: number }>();
  const bucket = (id: string, atIso: string | null | undefined, w: number) => {
    if (!atIso) return;
    const at = Date.parse(atIso);
    if (!Number.isFinite(at) || at > nowMs || at < priorSince) return;
    const cur = acc.get(id) ?? { recent: 0, mid: 0, prior: 0 };
    if (at >= recentSince) cur.recent += w;
    else if (at >= midSince) cur.mid += w;
    else cur.prior += w;
    acc.set(id, cur);
  };

  for (const r of rows) {
    if (!r?.item_id || r.outcome === "analytics") continue;
    bucket(r.item_id, r.served_at, TREND_EVENT_WEIGHTS.impression);
    if (r.outcome !== "impression") bucket(r.item_id, r.outcome_at ?? null, weightFor(r.outcome));
  }

  // Stamped ONCE, outside the loop, and shared by every reading: the three
  // windows above are the same three windows for every place in this call, and
  // reading the clock per place would let one corpus carry several computation
  // times. `priorSince` is the oldest row that can survive the bucket filter,
  // so it IS the window start rather than a restatement of it.
  const provenance = derivedStoreProvenance({ kind: "bounded", startMs: priorSince, endMs: nowMs }, nowMs);

  const out: Record<string, TrendReading> = {};
  for (const [id, w] of acc) {
    const evidence: TrendEvidence = {
      recentRate: w.recent,
      midRate:    midWindows   > 0 ? w.mid   / midWindows   : 0,
      priorRate:  priorWindows > 0 ? w.prior / priorWindows : 0,
      totalWeight: w.recent + w.mid + w.prior,
    };
    out[id] = { state: classifyTrendState(evidence), evidence, provenance };
  }
  return out;
}

/**
 * `03` §11 — a plain-language trend reason.
 *
 * Fixed text, naming no place, no neighbourhood and no person. §11's own
 * examples interpolate ("Rising quickly in Sukhumvit tonight") and that shape is
 * deliberately not adopted: the neighbourhood of a place is exactly what the
 * sensitive-location policy governs, and there is no ruling here on which
 * locations are safe to name in a public explanation. Fixed text is the honest
 * amount of specificity until there is one — the same decision, for the same
 * reason, as lib/discoveryReasonCodes.
 *
 * `unknown` returns null. A state that is not a claim must not produce a
 * sentence that reads like one.
 */
const TREND_EXPLANATION: Readonly<Partial<Record<DiscoveryTrendState, string>>> = {
  emerging:     "New around here, and starting to get attention.",
  trending:     "Picking up locally in the last couple of days.",
  established:  "Consistently busy here, not just this week.",
  cooling:      "Quieter than it has been recently.",
  rediscovered: "Getting attention again after a quiet spell.",
};

export function explainTrendState(state: DiscoveryTrendState): string | null {
  return TREND_EXPLANATION[state] ?? null;
}
