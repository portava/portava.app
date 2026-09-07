/**
 * sensingPresenceState — §19's PresenceObservation for the anonymous path:
 * "aggregate place/zone activity + coverage", with §5.1 truth metadata.
 *
 * ── WHY THE NAME IS NOT PresenceObservation ──────────────────────────────────
 * This tree already exports a `PresenceObservation` (src/presence/domain/
 * types.ts:88) and it is the OPPOSITE object: one device's raw, identifiable
 * observation — sessionId, subjectEphemeralId, a point, an expiry. The Sensing
 * spec's PresenceObservation (§5 engine table, §19) is an AGGREGATE over a
 * zone with a coverage figure and no person in it. Reusing the name would be
 * the semantic substitution §1 forbids ("Never semantically substitute one
 * domain ID for another"), so this is `SensingPresenceState` and says so.
 *
 * ── WHAT IT OWNS ─────────────────────────────────────────────────────────────
 * The Presence engine "owns confidence that activity exists in a place/zone"
 * and "must not claim public person identity" (§5). This module turns ONE
 * cohort's aggregate decision (lib/sensingCoverageAggregate, which routes
 * through the real privacy gate) into a server-built state carrying the four
 * §5.1 fields — truth class, confidence, freshness, coverage — and nothing a
 * person could be found in. It does not read the store; it takes the aggregate.
 * It computes no threshold; the gate already did. It publishes nothing: a
 * consumer that folds this onto a map or a wall object is S5/S6's job, behind
 * that surface's own flag.
 *
 * ── THE INVARIANTS, MADE STRUCTURAL ──────────────────────────────────────────
 *   No coverage ≠ quiet   `presence` has exactly two values, `observed` and
 *                         `unknown`. There is no `absent`, no `quiet`, no zero.
 *                         An unpublishable cohort is UNKNOWN, with coverage
 *                         `unknown` and no ordinal — not a low number.
 *   One device ≠ a crowd  Only a cohort the gate cleared (≥ k distinct
 *                         contributors, ≥ the independent-group floor) is ever
 *                         `observed`; below it every field is the unknown value.
 *   No person identity    The output type has no field for a token, a group
 *                         token or a count; the test walks the serialised state
 *                         for sentinel tokens.
 *   Busy ≠ good           `activityOrdinal` is the cohort's median bucket, an
 *                         UNLABELLED ordinal. What bucket 3 means is pinned by
 *                         reduction_version and is an owner decision (2315,
 *                         "why there is no sensor / channel vocabulary"); this
 *                         state carries no word for it.
 *   Inference ≠ observation
 *                         A published cohort is `observed` or `corroborated`
 *                         (several/many independent contributors), never
 *                         `inferred`; nothing here infers.
 *   Stale ≠ current       Freshness is derived from the observation window, not
 *                         from when the state was built, and a stale window
 *                         downgrades the truth class to `stale`.
 */
import { MIN_BAND_FOR_LIVE_STATE, PRIVACY_THRESHOLD_V1, type ConfidenceBand } from "./intelContracts.js";
import { sourceCountBucket } from "./liveClaimRead.js";
import { deriveFreshness, type FreshnessState } from "./mapObjects.js";
import type { SensingAggregateReason, SensingCohortAggregate } from "./sensingCoverageAggregate.js";
import type { CoverageBucket, TruthClass } from "./truthClass.js";

export interface SensingPresenceState {
  kind: "sensing_presence";
  /** The coarse zone label the cohort was grouped on. Never a coordinate. */
  zoneId: string;
  /** ISO start of the privacy time bucket. */
  timeBucket: string;
  /** ISO end of that bucket. */
  windowEnd: string;
  /**
   * Whether activity was OBSERVED in this zone during this window. The only
   * other value is `unknown` — there is deliberately no way to say "nobody was
   * there", because this path cannot know that.
   */
  presence: "observed" | "unknown";
  /** The cohort's median signal bucket (0..4), unlabelled; null unless observed. */
  activityOrdinal: number | null;
  reductionVersion: number;
  truthClass: TruthClass;
  confidence: ConfidenceBand;
  freshness: FreshnessState;
  coverage: CoverageBucket;
  provenance: {
    source: "sensing_anon";
    /** Why the cohort was withheld, when it was. Null when observed. */
    withheld: SensingAggregateReason | null;
  };
}

export interface SensingPresenceInput {
  zoneId: string;
  /** ISO start of the bucket, as lib/sensingAnonStore.sensingTimeBucket produced it. */
  timeBucket: string;
  aggregate: SensingCohortAggregate;
  nowMs: number;
  reductionVersion?: number;
  bucketMinutes?: number;
}

const UNKNOWN_PRESENCE = (
  input: SensingPresenceInput,
  windowEnd: string,
  reductionVersion: number,
  withheld: SensingAggregateReason | null,
): SensingPresenceState => ({
  kind: "sensing_presence",
  zoneId: input.zoneId,
  timeBucket: input.timeBucket,
  windowEnd,
  presence: "unknown",
  activityOrdinal: null,
  reductionVersion,
  truthClass: "unknown",
  confidence: "unverified",
  freshness: "unknown",
  coverage: "unknown",
  provenance: { source: "sensing_anon", withheld },
});

/**
 * Build the state for one cohort. PURE — takes its instant, reads nothing.
 * Throws only on a malformed bucket instant, which is a programming error, not
 * a data condition.
 */
export function buildSensingPresenceState(input: SensingPresenceInput): SensingPresenceState {
  if (!input || !input.zoneId || !input.timeBucket || !Number.isFinite(input.nowMs)) {
    throw new Error("buildSensingPresenceState: zoneId, timeBucket and nowMs are required");
  }
  const startMs = Date.parse(input.timeBucket);
  if (!Number.isFinite(startMs)) throw new Error("buildSensingPresenceState: timeBucket must be an ISO instant");
  const minutes = input.bucketMinutes ?? PRIVACY_THRESHOLD_V1.timeBucketMinutes;
  const windowEndMs = startMs + minutes * 60_000;
  const windowEnd = new Date(windowEndMs).toISOString();
  const reductionVersion = input.reductionVersion ?? 1;

  const agg = input.aggregate;
  // Every refusal — a failed read, an incomplete one, a sub-k cohort, a
  // dominant group, a publication delay, a sensitive subject — is the SAME
  // unknown state. The reason travels in provenance for an operator; the
  // surface gets no number to misread as "quiet".
  if (!agg || agg.publishable !== true) {
    return UNKNOWN_PRESENCE(input, windowEnd, reductionVersion, agg?.reason ?? "read_failed");
  }

  // Observed for: the freshest arrival, capped at the window's end. A bucket
  // still receiving contributions is "as of now"; a closed one is as of its
  // close. Freshness measures the OBSERVATION, never the moment this ran.
  const latestMs = agg.observedAt ? Date.parse(agg.observedAt) : NaN;
  const observedForMs = Number.isFinite(latestMs) ? Math.min(latestMs, windowEndMs) : windowEndMs;
  const freshness = deriveFreshness(observedForMs, null, input.nowMs);

  const coverage: CoverageBucket = sourceCountBucket(agg.distinctActors);

  // Truth class, fail-weak: a stale window is stale whatever its coverage;
  // otherwise several/many independent contributors corroborate, few observe —
  // the same mapping lib/wallProjection.deriveWallTruthClass applies.
  let truthClass: TruthClass;
  if (freshness === "stale" || freshness === "historical" || freshness === "unknown") truthClass = "stale";
  else if (coverage === "several" || coverage === "many") truthClass = "corroborated";
  else truthClass = "observed";

  // Confidence: a k-gated aggregate meets the platform's floor for current
  // state (MIN_BAND_FOR_LIVE_STATE) and, without a calibrated score, nothing
  // more. A stale one drops to provisional. No gradation is invented here.
  const confidence: ConfidenceBand = truthClass === "stale" ? "provisional" : MIN_BAND_FOR_LIVE_STATE;

  return {
    kind: "sensing_presence",
    zoneId: input.zoneId,
    timeBucket: input.timeBucket,
    windowEnd,
    presence: "observed",
    activityOrdinal: Number.isInteger(agg.medianSignalBucket) ? agg.medianSignalBucket : null,
    reductionVersion,
    truthClass,
    confidence,
    freshness,
    coverage,
    provenance: { source: "sensing_anon", withheld: null },
  };
}
