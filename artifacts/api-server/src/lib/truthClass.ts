/**
 * truthClass — the shared §5.1 truth vocabulary for server-built world state.
 *
 * Sensing spec §5.1 (docs/specs/Portava_Sensing_World_Experience_Intelligence_
 * Upgrade_Architecture_v1.txt:107-108) names seven canonical truth classes —
 * OBSERVED · CORROBORATED · INFERRED · PREDICTED · CONFLICTING · STALE · UNKNOWN —
 * and requires that "every server-built state consumed by Map / Discovery /
 * Wall / Compass should carry truth class, confidence, freshness and coverage".
 *
 * ── WHY THIS MODULE EXISTS, AND WHY IT IS SMALL ──────────────────────────────
 * Before this file the concept was spread across four unrelated vocabularies
 * (SOURCE_CLASSES, CLAIM_STATUSES, CONFIDENCE_BANDS, FRESHNESS_STATES — census
 * S48) and CORROBORATED had no representation anywhere. The Wall then
 * materialised the seven values as `WallTruthClass` in lib/wallProjection.ts
 * for its own surface. A second surface re-typing the same seven strings is how
 * "one truth vocabulary" becomes three that drift, so this module is the
 * dependency-free home for the VOCABULARY and its one combinator, and nothing
 * else: no derivation from intel sources (the Wall's deriveWallTruthClass does
 * that for the Wall; each producer maps its own inputs), no I/O, no clock.
 *
 * src/test/truthClass.test.ts asserts this vocabulary and the Wall's agree
 * value-for-value, so the two cannot drift without a red test. Re-exporting
 * `WallTruthClass` from here is a one-line change in a Wall-owned file and is
 * left to the Wall's owner.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 * Composition is FAIL-WEAK. When several facts feed one state, the state's
 * truth class is the WEAKEST contributing class — never the strongest, never a
 * vote. This is the structural form of §20 "Inference confidence may only
 * decrease through conflict unless new evidence supports an increase" and of
 * §5.1 "Prediction must never be rendered indistinguishably from observation":
 * a prediction folded into an observation yields a prediction. lib/mapAggregation
 * applies the same rule to confidence bands ("silence must not be read as
 * agreement") and this module applies it to truth.
 */

import type { WallCoverage, WallTruthClass } from "./wallProjection.js";

/**
 * Compile-time pin to the Wall's vocabulary (type-only import; nothing runs).
 * If either side adds or renames a value, `tsc` fails here rather than the two
 * drifting silently. lib/mapObjects carries the same pin for the Map's copy.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** §5.1's seven classes, verbatim, lower-cased. Order here is not strength. */
export const TRUTH_CLASSES = [
  "observed",
  "corroborated",
  "inferred",
  "predicted",
  "conflicting",
  "stale",
  "unknown",
] as const;
export type TruthClass = (typeof TRUTH_CLASSES)[number];

/**
 * Strength, weakest first. `unknown` is the floor: an absent or unrecognised
 * class can never be outranked by a present one. `corroborated` is the ceiling:
 * more than one independent observation of the same fact.
 *
 * `conflicting` sits below `predicted`: observations that disagree with each
 * other are weaker evidence of a current fact than a prediction that nothing
 * contradicts, and §10 rules a material conflict may never back a Live label.
 */
export const TRUTH_CLASS_STRENGTH: Readonly<Record<TruthClass, number>> = {
  unknown: 0,
  stale: 1,
  conflicting: 2,
  predicted: 3,
  inferred: 4,
  observed: 5,
  corroborated: 6,
};

/**
 * The classes that may back a user-facing OBSERVATION / Live label. Everything
 * else is history, a guess, a disagreement, or nothing. Stricter than the
 * Wall's NON_OBSERVATION_TRUTH_CLASSES by exactly one value (`conflicting`) —
 * the test records that difference explicitly rather than hiding it.
 */
export const OBSERVATION_TRUTH_CLASSES: readonly TruthClass[] = ["observed", "corroborated"] as const;

export function isTruthClass(v: unknown): v is TruthClass {
  return typeof v === "string" && (TRUTH_CLASSES as readonly string[]).includes(v);
}

/** True when this class may be rendered as a current observation. */
export function truthClassMayRenderAsObservation(cls: TruthClass | null | undefined): boolean {
  return cls != null && OBSERVATION_TRUTH_CLASSES.includes(cls);
}

/**
 * The weakest of several classes. An empty list, a null, or an unrecognised
 * value is `unknown` — the floor — so a producer that forgot to set a class on
 * one input cannot have the composite promoted past it.
 */
export function weakestTruthClass(classes: ReadonlyArray<TruthClass | null | undefined>): TruthClass {
  let weakest: TruthClass | null = null;
  for (const c of classes) {
    const cls: TruthClass = isTruthClass(c) ? c : "unknown";
    if (weakest === null || TRUTH_CLASS_STRENGTH[cls] < TRUTH_CLASS_STRENGTH[weakest]) weakest = cls;
  }
  return weakest ?? "unknown";
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * Coverage — how much independent evidence stands behind a state — at the
 * COARSE granularity the privacy gate permits. The exact cohort count is the
 * privacy parameter itself (lib/dataRights marks distinct_actors restricted),
 * so a state carries a bucket and never a number. `unknown` is a first-class
 * value and is NOT "none": §2 "No coverage ≠ quiet" depends on the distinction
 * surviving to the surface, and there is deliberately no `none` member.
 *
 * The three non-unknown values are lib/liveClaimRead.sourceCountBucket's, so a
 * sensing state and a claim-backed state bucket identically.
 */
export const COVERAGE_BUCKETS = ["few", "several", "many", "unknown"] as const;
export type CoverageBucket = (typeof COVERAGE_BUCKETS)[number];

// The pins. A value added to one vocabulary and not the other is a type error.
const _truthClassPin: MutuallyAssignable<TruthClass, WallTruthClass> = true;
const _coveragePin: MutuallyAssignable<CoverageBucket, WallCoverage> = true;
void _truthClassPin;
void _coveragePin;

export const COVERAGE_STRENGTH: Readonly<Record<CoverageBucket, number>> = {
  unknown: 0,
  few: 1,
  several: 2,
  many: 3,
};

export function isCoverageBucket(v: unknown): v is CoverageBucket {
  return typeof v === "string" && (COVERAGE_BUCKETS as readonly string[]).includes(v);
}

/** The least coverage among several. Empty / null / unrecognised ⇒ `unknown`. */
export function weakestCoverage(buckets: ReadonlyArray<CoverageBucket | null | undefined>): CoverageBucket {
  let weakest: CoverageBucket | null = null;
  for (const b of buckets) {
    const bucket: CoverageBucket = isCoverageBucket(b) ? b : "unknown";
    if (weakest === null || COVERAGE_STRENGTH[bucket] < COVERAGE_STRENGTH[weakest]) weakest = bucket;
  }
  return weakest ?? "unknown";
}
