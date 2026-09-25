/**
 * sensingWindowAggregate — the producer census-sensing S42 and S52 have been
 * waiting for: the server side that turns a run of k-gated cohorts into the
 * §5.2 feature vector `lib/vibeInference` consumes.
 *
 * ── WHAT WAS ACTUALLY MISSING ────────────────────────────────────────────────
 * S42 read *"the engine and its guards are pinned; not one input has a
 * producer"* and S52 *"all ten fields present; RED WHEN something can populate
 * it"*. Measured on 2026-09-25, `inferVibe` had no production caller at all —
 * only its own tests, the census freshness script and the revocation lineage
 * bookkeeping. `lib/sensingCoverageAggregate` scores ONE cohort (one zone, one
 * time bucket) and says whether it may be published; nothing joined consecutive
 * cohorts, so there was no arrival rate, no departure rate and no dwell.
 *
 * This module is that join, and nothing else: it does not publish, does not
 * write, does not decide a surface and owns no threshold.
 *
 * ── WHY THE TOKENS NEVER LEAVE ───────────────────────────────────────────────
 * Arrival and departure are SET DIFFERENCES over contributor tokens between
 * adjacent buckets, so this module must hold tokens to compute them.
 * `SensingCohortAggregate` deliberately exposes none, and that is correct — so
 * rather than widening it, the window reads the rows itself, derives the rates,
 * and returns NUMBERS. No token, no set, and no per-contributor anything appears
 * on `SensingWindowFeatures`. A caller cannot recover who was where from what
 * this returns, because what it returns does not contain it.
 *
 * ── A RATE OVER A SUB-k COHORT IS A LEAK, SO PAIRS MUST BOTH PASS ────────────
 * The whole privacy argument for publishing crowd movement is that no single
 * contributor is distinguishable inside the aggregate. A rate computed between
 * a k-passing bucket and a bucket of three people is a statement about those
 * three. So a bucket that `aggregateSensingCohort` refused contributes NOTHING:
 * not to a rate, not to coverage, not to dwell. A pair is used only when BOTH
 * of its buckets are publishable, and the denominator is the UNION of the two
 * contributor sets — at least k either way — so a single arrival moves the rate
 * by at most 1/k.
 *
 * Refusing to count an unpublishable bucket is not the same as treating it as
 * empty, and the difference matters: a gap in the middle of a window breaks the
 * ADJACENCY, and a rate computed across the gap would compare two buckets that
 * are not neighbours in time. Those pairs are skipped, and if no pair survives,
 * the rates are NULL — never 0. §2's rule is the one being honoured: no
 * coverage ≠ quiet, and "we could not look" is not "nobody arrived".
 *
 * ── THE FOUR FEATURES THIS PRODUCER REFUSES TO INVENT ────────────────────────
 * `VibeFeatureInput` has ten fields. This producer fills the ones the anonymous
 * store can actually support and leaves four NULL, deliberately, because a null
 * means "unknown" to the engine and a fabricated number would not:
 *
 *   motionEnergy   The store carries `signal_bucket`, an ordinal 0..4 whose
 *                  MEANING is pinned by `reduction_version` in code and is an
 *                  owner decision that has not been taken — census-sensing says
 *                  so in as many words: the field "carries the ordinal and no
 *                  label". Reading it as normalised motion would be assigning
 *                  that meaning here, in a producer, by arithmetic. So the
 *                  median bucket is carried out as `medianSignalBucket` for an
 *                  owner to interpret, and `motionEnergy` stays null.
 *   periodicity    Rhythm needs the accelerometer stream S28 describes. The
 *                  device does not produce it yet.
 *   acousticEnergy S29: there is no acoustic capture, and the engine refuses a
 *                  value without the separate permission in any case.
 *   density        §5.2's density is about the WORLD — how occupied the place
 *                  is — and coverage is about the EVIDENCE. In THIS store the
 *                  only population signal IS the contributor count, so bucketing
 *                  it twice would publish one number under two names and let
 *                  "we have a lot of data" render as "a lot of people are here",
 *                  which is the exact failure `vibeInference`'s own header names.
 *                  Density needs a source this store does not have.
 *
 * What survives is real: coverage, arrival rate, departure rate, dwell, and the
 * venue context where it was legitimately sourced. Through `inferVibe` that
 * yields sociality, momentum and volatility, with energy and dance likelihood
 * NULL — which is the spec behaving correctly, not a shortfall.
 *
 * ── VENUE CONTEXT IS SUPPLIED, NOT GUESSED ───────────────────────────────────
 * `geo_zones.zone_type` is `city | neighborhood | venue | custom`, which is a
 * shape of area and not a kind of venue; mapping "venue" onto "nightlife" would
 * be invention, and `danceLikelihood` takes a nudge from "nightlife". So the
 * context arrives as an argument, is validated against `vibeInference`'s own
 * vocabulary, and anything else becomes NULL rather than a default.
 *
 * ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
 * It is not a publisher. Anti-differencing (S24) is `lib/sensingDifferencingGate`
 * and belongs to whatever surface publishes, because the gate needs the PREVIOUS
 * publication and only a publisher has one. Putting it here would mean every
 * caller that merely computed a window consumed the differencing budget.
 */
import {
  aggregateSensingCohort,
  type SensingAggregateOptions,
  type SensingCohortAggregate,
} from "./sensingCoverageAggregate.js";
import {
  isSensingContributionExpired,
  sensingCohortKey,
  sensingTimeBucket,
  type SensingContributionRow,
  type SensingReadResult,
} from "./sensingAnonStore.js";
import { sourceCountBucket } from "./liveClaimRead.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import type { CoverageBucket } from "./truthClass.js";
import {
  inferVibe,
  type SensingVibeState,
  type VenueContext,
  type VibeFeatureInput,
} from "./vibeInference.js";

/** `vibeInference`'s vocabulary, repeated here ONLY to validate an argument. */
const VENUE_CONTEXTS: readonly VenueContext[] = ["nightlife", "dining", "transit", "outdoor", "none"];

/**
 * Narrow an untrusted venue context to the engine's vocabulary. Anything else —
 * a typo, a zone_type, a null — is UNKNOWN, never a default, because "none" is
 * a statement that there is no venue context and `null` is a statement that we
 * do not know of one.
 */
export function asVenueContext(x: unknown): VenueContext | null {
  return typeof x === "string" && (VENUE_CONTEXTS as readonly string[]).includes(x)
    ? (x as VenueContext)
    : null;
}

/** One time bucket of a window, as the caller read it. */
export interface SensingWindowInput {
  /** The bucket's floor, exactly as `sensingTimeBucket` produced it. */
  timeBucket: string;
  /** That bucket's cohort read. A failed read is a first-class input. */
  read: SensingReadResult;
}

/** Why a window produced no features. */
export type SensingWindowReason =
  | "no_buckets"
  | "no_publishable_bucket"
  | "buckets_not_contiguous";

export interface SensingWindowFeatures {
  /** Buckets supplied, in the order given. */
  bucketsSupplied: number;
  /** Buckets `aggregateSensingCohort` allowed to be published. */
  bucketsPublishable: number;
  /** Adjacent publishable pairs the rates were averaged over. */
  pairsCounted: number;
  /**
   * Coverage behind the window: the bucket of DISTINCT CONTRIBUTORS across the
   * publishable buckets, via the same `sourceCountBucket` a claim-backed state
   * uses, so a sensing state and a claim state bucket identically. `unknown`
   * when nothing was publishable.
   */
  coverage: CoverageBucket;
  /** Mean arrival rate over the counted pairs, 0..1; null when no pair survived. */
  arrivalVelocity: number | null;
  /** Mean departure rate over the counted pairs, 0..1; null when no pair survived. */
  departureVelocity: number | null;
  /** Lower-median consecutive-bucket presence per contributor, 0..4; null when unknown. */
  dwellBucket: number | null;
  /**
   * True when the median contributor was seen in at least two of the window's
   * buckets. NEVER false: one sighting does not prove transit, and `false` is
   * load-bearing in the engine — it caps `danceLikelihood` as contradicting
   * evidence — so it is claimed only where there is evidence for it.
   */
  boundedMovement: boolean | null;
  /**
   * The cohorts' median signal bucket, 0..4, carried OUT rather than
   * interpreted. Null unless at least one bucket was publishable. See the
   * header: `reduction_version` pins what an ordinal means and the owner has
   * not pinned it, so this producer does not turn it into `motionEnergy`.
   */
  medianSignalBucket: number | null;
  /** Freshest counted arrival across publishable buckets; null when none. */
  observedAt: string | null;
  /** Per-bucket decisions, for observability. Carries no contributor anything. */
  buckets: readonly SensingCohortAggregate[];
  /** Null when features were produced. */
  reason: SensingWindowReason | null;
}

export interface SensingWindowOptions extends SensingAggregateOptions {
  /** Bucket width, which must be the width the rows were written with. */
  timeBucketMinutes?: number;
}

const EMPTY = (reason: SensingWindowReason, supplied: number): SensingWindowFeatures => ({
  bucketsSupplied: supplied,
  bucketsPublishable: 0,
  pairsCounted: 0,
  coverage: "unknown",
  arrivalVelocity: null,
  departureVelocity: null,
  dwellBucket: null,
  boundedMovement: null,
  medianSignalBucket: null,
  observedAt: null,
  buckets: [],
  reason,
});

/** Lower median of a non-empty list; null for an empty one. */
function lowerMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/**
 * Build one window's features from consecutive cohort reads.
 *
 * The buckets are taken IN THE ORDER GIVEN and must be strictly increasing and
 * exactly one bucket-width apart; anything else is refused outright rather than
 * silently treated as adjacent, because a rate between two buckets an hour
 * apart is not a rate.
 */
export function aggregateSensingWindow(
  inputs: readonly SensingWindowInput[],
  options: SensingWindowOptions = {},
): SensingWindowFeatures {
  const supplied = inputs?.length ?? 0;
  if (!Array.isArray(inputs) || supplied === 0) return EMPTY("no_buckets", 0);

  const nowMs = options.nowMs ?? Date.now();
  const widthMs = (options.timeBucketMinutes ?? 0) > 0
    ? (options.timeBucketMinutes as number) * 60_000
    : null;

  // ── Contiguity, before anything is counted ─────────────────────────────────
  const stamps: number[] = [];
  for (const i of inputs) {
    const t = i && typeof i.timeBucket === "string" ? new Date(i.timeBucket).getTime() : NaN;
    if (!Number.isFinite(t)) return EMPTY("buckets_not_contiguous", supplied);
    stamps.push(t);
  }
  for (let k = 1; k < stamps.length; k++) {
    const gap = (stamps[k] as number) - (stamps[k - 1] as number);
    if (gap <= 0) return EMPTY("buckets_not_contiguous", supplied);
    if (widthMs !== null && gap !== widthMs) return EMPTY("buckets_not_contiguous", supplied);
  }
  // Without a declared width, take the FIRST gap as the width and require the
  // rest to match it. A caller that supplies uneven buckets and no width gets a
  // refusal, not an average over gaps of different sizes.
  if (widthMs === null && stamps.length > 2) {
    const first = (stamps[1] as number) - (stamps[0] as number);
    for (let k = 2; k < stamps.length; k++) {
      if ((stamps[k] as number) - (stamps[k - 1] as number) !== first) {
        return EMPTY("buckets_not_contiguous", supplied);
      }
    }
  }

  // ── Per bucket: the gate's decision, and (privately) who was in it ─────────
  const decisions: SensingCohortAggregate[] = [];
  const tokenSets: Array<Set<string> | null> = [];
  const medians: number[] = [];
  let latestMs = Number.NEGATIVE_INFINITY;
  let publishable = 0;

  for (const input of inputs) {
    const decision = aggregateSensingCohort(input.read, { ...options, nowMs });
    decisions.push(decision);
    if (!decision.publishable) {
      tokenSets.push(null);
      continue;
    }
    publishable += 1;
    if (decision.medianSignalBucket !== null) medians.push(decision.medianSignalBucket);
    if (decision.observedAt) {
      const ms = new Date(decision.observedAt).getTime();
      if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
    }
    const rows: readonly SensingContributionRow[] =
      input.read && input.read.ok === true ? (input.read.rows ?? []) : [];
    const tokens = new Set<string>();
    for (const row of rows) {
      if (!row || !row.contributor_token) continue;
      if (isSensingContributionExpired(row, nowMs)) continue;
      tokens.add(row.contributor_token);
    }
    tokenSets.push(tokens);
  }

  if (publishable === 0) {
    const empty = EMPTY("no_publishable_bucket", supplied);
    return { ...empty, buckets: decisions };
  }

  // ── Rates, over ADJACENT pairs where BOTH buckets passed the gate ──────────
  let arrivalSum = 0;
  let departureSum = 0;
  let pairs = 0;
  for (let k = 1; k < tokenSets.length; k++) {
    const prev = tokenSets[k - 1];
    const cur = tokenSets[k];
    if (!prev || !cur) continue;                       // a refused bucket breaks adjacency
    const union = new Set<string>([...prev, ...cur]);
    if (union.size === 0) continue;
    let arrived = 0;
    for (const t of cur) if (!prev.has(t)) arrived += 1;
    let departed = 0;
    for (const t of prev) if (!cur.has(t)) departed += 1;
    arrivalSum += arrived / union.size;
    departureSum += departed / union.size;
    pairs += 1;
  }

  // ── Coverage and dwell, over the publishable buckets only ─────────────────
  const seenIn = new Map<string, number>();
  for (const set of tokenSets) {
    if (!set) continue;
    for (const t of set) seenIn.set(t, (seenIn.get(t) ?? 0) + 1);
  }
  const distinctContributors = seenIn.size;
  const coverage: CoverageBucket = distinctContributors === 0 ? "unknown" : sourceCountBucket(distinctContributors);
  const dwellBucket = lowerMedian([...seenIn.values()].map((n) => Math.min(4, Math.max(0, n - 1))));

  return {
    bucketsSupplied: supplied,
    bucketsPublishable: publishable,
    pairsCounted: pairs,
    coverage,
    arrivalVelocity: pairs === 0 ? null : arrivalSum / pairs,
    departureVelocity: pairs === 0 ? null : departureSum / pairs,
    dwellBucket,
    boundedMovement: dwellBucket === null ? null : dwellBucket >= 1 ? true : null,
    medianSignalBucket: lowerMedian(medians),
    observedAt: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    buckets: decisions,
    reason: null,
  };
}

/**
 * The window's features in the engine's own shape.
 *
 * Kept separate from `aggregateSensingWindow` so the four deliberately-null
 * fields are visible at the seam where they are set, rather than buried inside
 * the arithmetic above.
 */
export function windowToVibeFeatures(
  window: SensingWindowFeatures,
  venueContext: VenueContext | null,
): VibeFeatureInput {
  return {
    // Supported by the anonymous store:
    arrivalVelocity: window.arrivalVelocity,
    departureVelocity: window.departureVelocity,
    dwellBucket: window.dwellBucket,
    boundedMovement: window.boundedMovement,
    coverage: window.coverage,
    observedAt: window.observedAt,
    venueContext: asVenueContext(venueContext),
    // NOT supported by it. See the header for each.
    motionEnergy: null,
    periodicity: null,
    density: null,
    acousticEnergy: null,
    acousticPermissionGranted: false,
  };
}

export type SensingWindowVibe =
  | { ok: true; state: SensingVibeState; window: SensingWindowFeatures }
  | { ok: false; reason: SensingWindowReason | string; window: SensingWindowFeatures };

/**
 * The whole path in one call: consecutive cohort reads → k-gated window →
 * `inferVibe`. This is the call census-sensing S42 and S52 were waiting for.
 */
export function inferVibeForWindow(
  inputs: readonly SensingWindowInput[],
  venueContext: VenueContext | null,
  options: SensingWindowOptions = {},
): SensingWindowVibe {
  const nowMs = options.nowMs ?? Date.now();
  const window = aggregateSensingWindow(inputs, { ...options, nowMs });
  if (window.reason !== null) return { ok: false, reason: window.reason, window };
  const result = inferVibe(windowToVibeFeatures(window, venueContext), nowMs);
  if (!result.ok) return { ok: false, reason: result.reason, window };
  return { ok: true, state: result.state, window };
}

/**
 * The cohort keys one window needs, oldest first.
 *
 * Exported so a caller cannot build them by hand and disagree with the writer
 * about which rows form a cohort: both sides go through `sensingCohortKey`.
 */
export function sensingWindowCohortKeys(
  zoneId: string,
  endMs: number,
  buckets: number,
  timeBucketMinutes?: number,
  reductionVersion?: number,
): Array<{ timeBucket: string; cohortKey: string }> {
  if (!zoneId) throw new Error("sensingWindowCohortKeys: zoneId is required");
  if (!Number.isInteger(buckets) || buckets < 1) {
    throw new Error("sensingWindowCohortKeys: buckets must be a positive integer");
  }
  const minutes = timeBucketMinutes ?? PRIVACY_THRESHOLD_V1.timeBucketMinutes;
  const width = minutes * 60_000;
  const endFloor = new Date(sensingTimeBucket(endMs, minutes)).getTime();
  const out: Array<{ timeBucket: string; cohortKey: string }> = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const at = new Date(endFloor - i * width).toISOString();
    out.push({
      timeBucket: at,
      cohortKey: reductionVersion === undefined
        ? sensingCohortKey(zoneId, at)
        : sensingCohortKey(zoneId, at, reductionVersion),
    });
  }
  return out;
}
