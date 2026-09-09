/**
 * highlightRanking — §12 "Ranking", including the two rules that are not about
 * arithmetic at all.
 *
 * Highlights/Memories Development Architecture Spec v1 §12:
 *
 *     Ranking
 *       manual_pin
 *       + recency
 *       + significance
 *       + current_relevance
 *       + audience_relevance
 *       + presentation_quality
 *       + diversity_constraints
 *
 *     "Pinned/manual order always outranks automatic ordering. Diversity should
 *      prevent repetitive auto-selection across the same trip, person, venue, or
 *      activity type unless the user explicitly curates that way."
 *
 * Census ids: H99 (the factor set), H100 (pin precedence), H101 (diversity) —
 * all three recorded NOT-BUILT, the surface ordering by `created_at ASC` with
 * no score anywhere (routes/highlights.ts).
 *
 * ── THREE DESIGN DECISIONS, EACH BECAUSE OF A SPECIFIC WAY THIS GOES WRONG ──
 *
 * 1. `manual_pin` IS NOT A TERM IN THE SUM. The spec lists it in the sum and
 *    then, one line later, says pinned order ALWAYS outranks automatic order.
 *    A weight — even a huge one — cannot express "always": some combination of
 *    the other six eventually beats it, and the bug is invisible until the day
 *    a user's pin silently loses. So pins are a PARTITION. Pinned items are
 *    ordered among themselves by the owner's explicit `pinOrder` and placed
 *    ahead of every unpinned item, whatever the scores say. `rankHighlights`
 *    computes the automatic score for pinned items too — for observability —
 *    and never lets it change their position.
 *
 * 2. A FACTOR THAT CANNOT BE MEASURED IS `null`, NOT `0`. Of the six automatic
 *    factors, this repository can measure exactly one honestly today —
 *    `recency`, from `created_at`. There is no significance model for a
 *    Highlight, no current-world relevance engine wired to this surface
 *    (§14 executable memories is NOT-BUILT in full), no audience-relevance
 *    signal, and no presentation-quality score. Passing 0 for those would rank
 *    every Highlight as maximally insignificant and maximally ugly, and the
 *    resulting order would LOOK considered. So each factor is `number | null`,
 *    nulls are excluded from the mean rather than counted as zero, and the
 *    result carries `factorsUsed` / `factorsMissing` so a caller can see that a
 *    "score" was computed from one signal out of six. A caller that wants to
 *    refuse to rank at all can read `factorsUsed.length`.
 *
 * 3. DIVERSITY IS A CONSTRAINT, NOT A SEVENTH ADDEND. "Prevent repetitive
 *    auto-selection across the same trip, person, venue, or activity type" is a
 *    property of the SEQUENCE, which no per-item score can express. It is
 *    applied as a re-ordering pass over the already-scored list, and — per the
 *    spec's own "unless the user explicitly curates that way" — it is never
 *    applied to the pinned partition.
 *
 * PURE. No I/O, no clock except the one you pass. Deterministic: equal scores
 * break ties on `id` so two calls on the same input give the same order.
 */

/** The six automatic factors §12 names, plus the diversity keys. */
export const HIGHLIGHT_RANKING_FACTORS = [
  "recency",
  "significance",
  "current_relevance",
  "audience_relevance",
  "presentation_quality",
] as const;
export type HighlightRankingFactor = (typeof HIGHLIGHT_RANKING_FACTORS)[number];

/**
 * The dimensions §12 names for diversity: "the same trip, person, venue, or
 * activity type".
 */
export const DIVERSITY_DIMENSIONS = ["trip", "person", "venue", "activity"] as const;
export type DiversityDimension = (typeof DIVERSITY_DIMENSIONS)[number];

export interface RankableHighlight {
  readonly id: string;
  readonly createdAt: string;
  /**
   * §12 manual_pin. `null` = not pinned. A number = the owner's explicit order,
   * ascending (0 first). Ties inside the pinned partition fall back to
   * createdAt then id, so a partially-ordered pin set is still deterministic.
   */
  readonly pinOrder?: number | null;
  /**
   * Each factor in [0, 1], or `null` when this deployment cannot measure it.
   * `recency` is normally left out here and computed by `rankHighlights` from
   * `createdAt`; pass it explicitly only to override.
   */
  readonly factors?: Partial<Record<HighlightRankingFactor, number | null>>;
  /**
   * Diversity keys. A dimension that is absent or null does not constrain —
   * two Highlights with no known venue are not "the same venue".
   */
  readonly diversityKeys?: Partial<Record<DiversityDimension, string | null>>;
}

export interface RankedHighlight<T extends RankableHighlight = RankableHighlight> {
  readonly item: T;
  readonly pinned: boolean;
  /**
   * The mean of the factors that were measurable, in [0, 1] — or `null` when
   * NONE were. `null` is not "worst"; it is "unscored", and unscored items sort
   * after scored ones rather than being treated as zeros.
   */
  readonly score: number | null;
  readonly factorsUsed: readonly HighlightRankingFactor[];
  readonly factorsMissing: readonly HighlightRankingFactor[];
  /** Set when the diversity pass moved this item; empty when it did not. */
  readonly deferredFor: readonly DiversityDimension[];
}

export interface RankingOptions {
  readonly now?: Date;
  /**
   * §12 LIVE: "high freshness". The half-life, in hours, over which `recency`
   * decays from 1 toward 0. 24h is the Highlights surface's own default expiry
   * (routes/highlights.ts EXPIRY_HOURS default), so a Highlight is at 0.5 when
   * it is halfway through the standard lifetime. It is a knob, not a truth
   * claim, and it is the only tunable in this file.
   */
  readonly recencyHalfLifeHours?: number;
  /**
   * §12 diversity. How many items sharing a diversity key may appear in a row
   * before the next one is deferred. 1 = never two adjacent from the same trip
   * / person / venue / activity.
   */
  readonly maxConsecutivePerKey?: number;
  /** Which dimensions to constrain. Defaults to all four §12 names. */
  readonly diversityDimensions?: readonly DiversityDimension[];
}

const DEFAULT_HALF_LIFE_HOURS = 24;
const DEFAULT_MAX_CONSECUTIVE = 1;

/**
 * §12 recency, as an exponential decay with the given half-life. In [0, 1];
 * a Highlight created in the future (clock skew) clamps to 1 rather than
 * exceeding it, and an unparseable createdAt yields `null` — unmeasurable, not
 * zero.
 */
export function recencyScore(createdAt: string, now: Date, halfLifeHours: number): number | null {
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return null;
  if (!(halfLifeHours > 0)) return null;
  const ageHours = (now.getTime() - t.getTime()) / 3_600_000;
  if (ageHours <= 0) return 1;
  return Math.pow(0.5, ageHours / halfLifeHours);
}

function scoreOf(
  item: RankableHighlight,
  now: Date,
  halfLifeHours: number,
): { score: number | null; used: HighlightRankingFactor[]; missing: HighlightRankingFactor[] } {
  const supplied = item.factors ?? {};
  const used: HighlightRankingFactor[] = [];
  const missing: HighlightRankingFactor[] = [];
  let sum = 0;

  for (const f of HIGHLIGHT_RANKING_FACTORS) {
    let v: number | null | undefined = supplied[f];
    if (f === "recency" && (v === undefined || v === null)) {
      v = recencyScore(item.createdAt, now, halfLifeHours);
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      // Clamp rather than reject: a caller's 1.4 is a caller bug, and silently
      // letting it dominate the mean is worse than pinning it to the range.
      const clamped = Math.min(1, Math.max(0, v));
      sum += clamped;
      used.push(f);
    } else {
      missing.push(f);
    }
  }
  return { score: used.length === 0 ? null : sum / used.length, used, missing };
}

/**
 * Sort key for the AUTOMATIC partition. Higher score first; unscored items
 * (score === null) after every scored one; ties on newer-first then id, so the
 * order is total and stable across calls.
 */
function compareAutomatic(a: RankedHighlight, b: RankedHighlight): number {
  const as = a.score;
  const bs = b.score;
  if (as === null && bs !== null) return 1;
  if (bs === null && as !== null) return -1;
  if (as !== null && bs !== null && as !== bs) return bs - as;
  const at = Date.parse(a.item.createdAt);
  const bt = Date.parse(b.item.createdAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

/** Pinned partition order: explicit pinOrder ascending, then newest, then id. */
function comparePinned(a: RankedHighlight, b: RankedHighlight): number {
  const ap = a.item.pinOrder ?? Number.MAX_SAFE_INTEGER;
  const bp = b.item.pinOrder ?? Number.MAX_SAFE_INTEGER;
  if (ap !== bp) return ap - bp;
  return compareAutomatic(a, b);
}

/**
 * §12 diversity. A greedy re-ordering of an already-sorted list: walk it, and
 * whenever the next item would make `maxConsecutivePerKey + 1` in a row share a
 * diversity key with what has just been emitted, defer it and take the
 * best-ranked item that would not. If EVERY remaining candidate would violate
 * the constraint, emit the best one anyway — a diversity rule that can empty a
 * feed is worse than a repetitive feed, and the item records `deferredFor` so
 * the compromise is visible rather than silent.
 */
function applyDiversity(
  sorted: RankedHighlight[],
  dims: readonly DiversityDimension[],
  maxConsecutive: number,
): RankedHighlight[] {
  if (sorted.length <= 1 || dims.length === 0 || maxConsecutive < 1) return sorted;

  const out: RankedHighlight[] = [];
  const pending = [...sorted];
  // For each dimension: the key of the tail run, and how long that run is.
  const runKey: Partial<Record<DiversityDimension, string | null>> = {};
  const runLen: Partial<Record<DiversityDimension, number>> = {};

  const violates = (r: RankedHighlight): DiversityDimension[] => {
    const bad: DiversityDimension[] = [];
    for (const d of dims) {
      const k = r.item.diversityKeys?.[d];
      if (k == null) continue; // unknown key constrains nothing
      if (runKey[d] === k && (runLen[d] ?? 0) >= maxConsecutive) bad.push(d);
    }
    return bad;
  };

  while (pending.length > 0) {
    let pickIndex = 0;
    let deferred: DiversityDimension[] = [];
    let found = false;
    for (let i = 0; i < pending.length; i++) {
      if (violates(pending[i]).length === 0) {
        pickIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      // Every candidate repeats. Take the best and say which constraint gave.
      pickIndex = 0;
      deferred = violates(pending[0]);
    }
    const [chosen] = pending.splice(pickIndex, 1);
    out.push(deferred.length > 0 ? { ...chosen, deferredFor: deferred } : chosen);
    for (const d of dims) {
      const k = chosen.item.diversityKeys?.[d] ?? null;
      if (k != null && runKey[d] === k) runLen[d] = (runLen[d] ?? 0) + 1;
      else {
        runKey[d] = k;
        runLen[d] = k == null ? 0 : 1;
      }
    }
  }
  return out;
}

/**
 * The §12 ranking, end to end.
 *
 * Order of operations, and it matters:
 *   1. score every item (pinned ones too, for observability)
 *   2. PARTITION on pin — this is what makes "always outranks" true
 *   3. sort each partition
 *   4. apply diversity to the AUTOMATIC partition ONLY ("unless the user
 *      explicitly curates that way" — a pin IS explicit curation)
 *   5. concatenate pinned ++ automatic
 */
export function rankHighlights<T extends RankableHighlight>(
  items: readonly T[],
  opts: RankingOptions = {},
): RankedHighlight<T>[] {
  const now = opts.now ?? new Date();
  const halfLife = opts.recencyHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  const maxConsecutive = opts.maxConsecutivePerKey ?? DEFAULT_MAX_CONSECUTIVE;
  const dims = opts.diversityDimensions ?? DIVERSITY_DIMENSIONS;

  const scored: RankedHighlight<T>[] = items.map((item) => {
    const { score, used, missing } = scoreOf(item, now, halfLife);
    return {
      item,
      pinned: item.pinOrder != null,
      score,
      factorsUsed: used,
      factorsMissing: missing,
      deferredFor: [] as readonly DiversityDimension[],
    };
  });

  const pinned = scored.filter((r) => r.pinned).sort(comparePinned);
  const automatic = scored.filter((r) => !r.pinned).sort(compareAutomatic);

  return [...pinned, ...(applyDiversity(automatic, dims, maxConsecutive) as RankedHighlight<T>[])];
}
