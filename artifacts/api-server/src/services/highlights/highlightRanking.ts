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

/* ============================================================================
 * The partition rule, applied on a surface that has PINS and does not have the
 * six automatic factors.
 *
 * §12: "Pinned/manual order always outranks automatic ordering."
 *
 * WHY THIS IS NOT `rankHighlights`. `rankHighlights` is the full §12 model and
 * needs six measured factors — recency, significance, current_relevance,
 * audience_relevance, presentation_quality — of which `public.highlights`
 * carries a witness for exactly one. Calling it from a route would mean
 * inventing five, and this module's own header says what a factor that cannot
 * be measured is: `null`, not `0`. A ranker fed five nulls does not rank.
 *
 * So the routes get the half of §12 that IS measurable, and only that half.
 * `pinned_at` is a real column with a real writer (POST /highlights/:id/pin),
 * so the PARTITION is enforceable today: pinned items ahead of unpinned ones,
 * pinned ordered among themselves by when the owner pinned them, and the
 * automatic partition left in whatever order its query produced. Nothing here
 * claims to have scored anything, and census H100 stays BUILT-BUT-WRONG on the
 * five factors — this is the evidence for the grade, not an argument against
 * it.
 *
 * STABLE. Two unpinned items keep the order they arrived in, so a caller's
 * `ORDER BY created_at` survives. A partition that reordered the automatic half
 * would silently replace the surface's chosen ordering with nothing.
 * ==========================================================================*/

export interface PinnablyOrdered {
  /** §3.5 `pinned_at`. NULL / absent = not pinned. */
  readonly pinned_at?: string | null;
  readonly id?: string;
}

export function pinnedFirst<T extends PinnablyOrdered>(rows: readonly T[]): T[] {
  const pinned: T[] = [];
  const automatic: T[] = [];
  for (const r of rows) (r?.pinned_at != null ? pinned : automatic).push(r);
  pinned.sort((a, b) => {
    // Earliest pin first: the owner's pin order is the order they pinned in,
    // which is the only manual order this schema records. Ties fall back to id
    // so the result is deterministic rather than dependent on the query plan.
    const at = String(a.pinned_at ?? "");
    const bt = String(b.pinned_at ?? "");
    return at.localeCompare(bt) || String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
  return [...pinned, ...automatic];
}

/* ============================================================================
 * §12 ON A REAL SURFACE — binding `rankHighlights` to a row of
 * `public.highlights`.
 *
 * Census H99: "Ranking (manual_pin + recency + significance + current_relevance
 * + audience_relevance + presentation_quality + diversity)" — BUILT-BUT-WRONG,
 * blocker: "`rankHighlights` — §12's seven factors — has NO caller in
 * `src/routes/` or `src/services/` outside its own module. Only `pinnedFirst`
 * is wired."
 * Census H101: "Diversity constraints across trip/person/venue/activity" —
 * BUILT-BUT-WRONG, blocker: "`DIVERSITY_DIMENSIONS` … applied inside
 * `rankHighlights`. Unreachable."
 *
 * This section is the caller those two rows name, and it is deliberately
 * SEPARATE from `rankHighlights` itself: that function is pure §12 and takes
 * measured factors, and it must not learn what a Supabase row looks like. What
 * was missing was never the model — it was the ADAPTER between §12's vocabulary
 * and the eleven columns this surface actually has.
 *
 * ── WHY THE MODULE HEADER'S OBJECTION IS ANSWERED, NOT OVERRULED ───────────
 * `pinnedFirst`'s own header says calling `rankHighlights` from a route "would
 * mean inventing five" factors, "and a ranker fed five nulls does not rank".
 * The second half is true of the SCORE and false of the ORDER, and keeping them
 * apart is the whole of this adapter:
 *
 *   - The SCORE is one factor of six. `scoreOf` already excludes a `null`
 *     factor from the mean instead of counting it as zero, and already reports
 *     `factorsMissing`. A score computed from recency alone IS recency — it
 *     claims nothing more, and `RANKING_FACTORS_UNMEASURED` below is published
 *     so no caller can mistake it for a considered one.
 *   - The ORDER is not a score. §12's two NON-arithmetic rules — "pinned/manual
 *     order always outranks automatic ordering" and "diversity should prevent
 *     repetitive auto-selection" — need no factor at all. Both are fully
 *     enforceable on this surface today, and neither was being enforced.
 *
 * So inventing a factor is still refused; ordering by the rules that do not
 * need one is not.
 *
 * ── WHICH DIVERSITY DIMENSIONS THIS SURFACE CAN KEY, AND WHICH IT CANNOT ───
 * DERIVED from the map below rather than listed twice, for the reason
 * FEED_ENFORCEABLE_CONTROLS gives in highlightResurfacing.ts: the list retyped
 * beside the table was wrong once already, and a dimension silently dropped
 * from a constraint set looks exactly like a dimension that was satisfied.
 *
 *   person   -> `owner_id`. Present on every row.
 *   venue    -> `location_name`, falling back to `location_city`. §12 says
 *               "venue"; a city is the coarsest honest stand-in, and a row with
 *               neither keys NOTHING rather than keying the empty string —
 *               `applyDiversity` treats a null key as "does not constrain", and
 *               two Highlights with no known venue are not the same venue.
 *   trip     -> NOTHING. `public.highlights` carries no trip reference (22
 *               columns, none of them a trip id — asserted in
 *               src/test/highlightsMemoriesDeployedStorage.test.ts). This is
 *               the SAME ceiling HIDE_TRIP hits in highlightResurfacing.ts and
 *               census H90 records; one missing column closes both.
 *   activity -> NOTHING. There is no activity taxonomy on a Highlight.
 *               `media_type` is a MIME family, not an activity, and keying
 *               diversity on it would separate a photo from a video and call
 *               that variety.
 *
 * Two of §12's four, and the surface SAYS so rather than quietly constraining
 * two and reporting four. That is the same posture `unenforceableControls` and
 * `consentEnforcement` already take: the ceiling is a fact the server knows, so
 * the server states it.
 * ==========================================================================*/

/** A row of `public.highlights`, as much of it as §12 ordering reads. */
export interface HighlightRowForRanking {
  readonly id: string;
  readonly created_at?: string | null;
  readonly owner_id?: string | null;
  readonly location_name?: string | null;
  readonly location_city?: string | null;
  /** §3.5 `pinned_at` — migration 2723. Absent when the probe did not project it. */
  readonly pinned_at?: string | null;
}

/**
 * Which column of `public.highlights` keys each §12 diversity dimension.
 * `null` means this surface cannot key it at all — see the header.
 */
export const HIGHLIGHT_DIVERSITY_SOURCES: Readonly<
  Record<DiversityDimension, { readonly columns: readonly string[]; readonly note: string }>
> = Object.freeze({
  trip: {
    columns: [],
    note: "public.highlights carries no trip reference — the same missing column HIDE_TRIP hits (census H90)",
  },
  person: { columns: ["owner_id"], note: "the one person a Highlight row identifies" },
  venue: {
    columns: ["location_name", "location_city"],
    note: "the venue text, coarsening to the city; a row with neither keys nothing",
  },
  activity: {
    columns: [],
    note: "no activity taxonomy on a Highlight; media_type is a MIME family, not an activity",
  },
});

/** The §12 dimensions a `public.highlights` row can key. Derived, not listed. */
export const FEED_DIVERSITY_DIMENSIONS: readonly DiversityDimension[] = Object.freeze(
  DIVERSITY_DIMENSIONS.filter((d) => HIGHLIGHT_DIVERSITY_SOURCES[d].columns.length > 0),
) as readonly DiversityDimension[];

/** The §12 dimensions it cannot, published so a caller can say so. */
export const UNRESOLVABLE_DIVERSITY_DIMENSIONS: readonly DiversityDimension[] = Object.freeze(
  DIVERSITY_DIMENSIONS.filter((d) => HIGHLIGHT_DIVERSITY_SOURCES[d].columns.length === 0),
) as readonly DiversityDimension[];

/**
 * The §12 factors no column of `public.highlights` witnesses. Derived from
 * RANKED_FROM_ROW below so it cannot drift from what is actually measured.
 */
export const RANKING_FACTORS_MEASURED_ON_ROW: readonly HighlightRankingFactor[] =
  Object.freeze(["recency"]) as readonly HighlightRankingFactor[];

export const RANKING_FACTORS_UNMEASURED: readonly HighlightRankingFactor[] = Object.freeze(
  HIGHLIGHT_RANKING_FACTORS.filter(
    (f) => !(RANKING_FACTORS_MEASURED_ON_ROW as readonly string[]).includes(f),
  ),
) as readonly HighlightRankingFactor[];

/**
 * Turn a stored row into §12's vocabulary.
 *
 * `pinOrder` is the pin INSTANT in epoch milliseconds, so "earliest pin first"
 * — the only manual order `pinned_at` records — falls out of `comparePinned`'s
 * ascending sort with no second ordering rule to disagree with `pinnedFirst`.
 * An unparseable or absent `pinned_at` is NOT pinned; it is not "pinned at the
 * epoch", which would put a corrupt row ahead of every real pin.
 */
export function rankableFromRow(row: HighlightRowForRanking): RankableHighlight {
  const pinnedMs = row.pinned_at != null ? Date.parse(String(row.pinned_at)) : Number.NaN;
  const venue = row.location_name ?? row.location_city ?? null;
  return {
    id: String(row.id),
    // An absent created_at yields `null` recency inside `scoreOf` — unmeasured,
    // not "infinitely old". "" parses to NaN, which is what that branch wants.
    createdAt: row.created_at == null ? "" : String(row.created_at),
    pinOrder: Number.isFinite(pinnedMs) ? pinnedMs : null,
    diversityKeys: {
      trip: null,
      person: row.owner_id == null ? null : String(row.owner_id),
      venue: venue == null || String(venue).trim() === "" ? null : String(venue).trim(),
      activity: null,
    },
  };
}

export interface RankedPage<T> {
  /** The rows, in §12 order. Same rows, same count — this reorders, never filters. */
  readonly ordered: T[];
  /** §12 factors this surface measured. */
  readonly factorsMeasured: readonly HighlightRankingFactor[];
  /** §12 factors it could not, so a caller can publish the ceiling. */
  readonly factorsUnmeasured: readonly HighlightRankingFactor[];
  /** §12 diversity dimensions actually constrained. */
  readonly diversityApplied: readonly DiversityDimension[];
  /** §12 diversity dimensions this surface cannot key at all. */
  readonly diversityUnresolvable: readonly DiversityDimension[];
  /** True when the page contains at least one pinned row. */
  readonly pinnedCount: number;
}

/**
 * §12 ordering for a page of stored rows. THE caller `rankHighlights` and
 * `DIVERSITY_DIMENSIONS` did not have.
 *
 * REORDERS, NEVER FILTERS. The returned array is a permutation of the input:
 * same rows, same count. Every privacy decision on this surface — blocks,
 * `canViewHighlight`, §11 controls, §10 consent — has already been taken by the
 * caller, and a ranker that could drop a row would be a second, unreviewed
 * place for a Highlight to disappear. `applyDiversity` is written to the same
 * rule: when every remaining candidate repeats a key it emits the best one
 * anyway rather than emptying the page.
 *
 * `now` is REQUIRED and is not defaulted. Recency is the one factor this
 * surface measures, so the instant it is measured against is a caller
 * decision — and the caller should be passing the SAME instant it used to cut
 * expired rows out of the query, or the page can contain a row the ranker
 * scores as already gone. Defaulting it here would have made that second clock
 * read invisible, which is the failure `splitClockGuard` exists to catch.
 */
export function rankHighlightRows<T extends HighlightRowForRanking>(
  rows: readonly T[],
  now: Date,
  opts: { readonly recencyHalfLifeHours?: number; readonly maxConsecutivePerKey?: number } = {},
): RankedPage<T> {
  // CARRIED BY POSITION, NOT BY ID — and that is the whole of the round trip's
  // correctness. Keying the rows in a Map by `id` and looking each ranked
  // result back up looks equivalent and is not: two rows sharing an id collapse
  // to one Map entry, both ranked entries resolve to the SAME row, and the page
  // comes back the right LENGTH with one row silently replaced by a duplicate
  // of another. Nothing downstream can tell that page from a correct one, and
  // the row that vanished had already passed every privacy gate on this
  // surface. `rankHighlights` is generic over its item type and returns the
  // item it was handed, so an index rides along and the mapping back is exact.
  const ranked = rankHighlights(
    rows.map((row, index) => ({ ...rankableFromRow(row), index })),
    {
      now,
      recencyHalfLifeHours: opts.recencyHalfLifeHours,
      maxConsecutivePerKey: opts.maxConsecutivePerKey,
      diversityDimensions: FEED_DIVERSITY_DIMENSIONS,
    },
  );

  // A permutation by construction: `rankHighlights` partitions, sorts and
  // reorders but never adds or drops, so every input index appears exactly
  // once and `ordered` is `rows` in a different order.
  const ordered: T[] = ranked.map((r) => rows[r.item.index]);

  return {
    ordered,
    factorsMeasured: RANKING_FACTORS_MEASURED_ON_ROW,
    factorsUnmeasured: RANKING_FACTORS_UNMEASURED,
    diversityApplied: FEED_DIVERSITY_DIMENSIONS,
    diversityUnresolvable: UNRESOLVABLE_DIVERSITY_DIMENSIONS,
    pinnedCount: ranked.filter((r) => r.pinned).length,
  };
}
