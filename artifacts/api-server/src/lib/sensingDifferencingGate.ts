/**
 * sensingDifferencingGate — the anti-differencing control §3 requires and the
 * census (S24) found absent: "Anti-differencing as such is absent — no
 * query-set-size auditing, no noise, no repeated-query budget."
 *
 * ── THE ATTACK ───────────────────────────────────────────────────────────────
 * Two publications of the same cohort that differ by one contributor leak that
 * contributor: "the count went from 17 to 18 after Alice walked in" is a
 * presence fact about Alice, and a k-floor on each publication alone does not
 * stop it — both 17 and 18 clear k = 15. The same holds for a cohort read
 * before and after one revocation.
 *
 * ── THE CONTROL ──────────────────────────────────────────────────────────────
 * A cohort may be RE-published only when its distinct-contributor count has
 * moved by at least `minDelta` since the last publication, or has not moved
 * at all (a re-serve of the same value leaks nothing new). A small non-zero
 * movement is suppressed — the previously published value stands. `minDelta`
 * defaults to the privacy threshold's independent-group floor, so a change
 * smaller than a whole independent party is never published.
 *
 * This is deliberately a rule over PUBLISHED values only — it needs no token
 * set and no memory of who was in the cohort, because keeping either would be
 * the tracking store the design forbids. The caller keeps the last published
 * aggregate (a de-identified value) and hands it back in.
 *
 * PURE. No I/O, no clock. Publishes nothing; returns a decision.
 */
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import type { SensingCohortAggregate } from "./sensingCoverageAggregate.js";

export type DifferencingReason = "no_previous" | "unchanged" | "delta_at_least_minimum" | "delta_below_minimum" | "not_publishable";

export interface DifferencingDecision {
  /** Whether `current` may be served as a NEW publication. */
  publish: boolean;
  reason: DifferencingReason;
  /** The aggregate a consumer should serve: `current` when publish, else the previous. */
  serve: SensingCohortAggregate | null;
}

export interface DifferencingOptions {
  /** Minimum change in distinct contributors between publications. Default: the independent-group floor. */
  minDelta?: number;
}

export function evaluateDifferencing(
  previous: SensingCohortAggregate | null,
  current: SensingCohortAggregate,
  options: DifferencingOptions = {},
): DifferencingDecision {
  const minDelta = options.minDelta ?? PRIVACY_THRESHOLD_V1.minIndependentGroups;
  if (!Number.isInteger(minDelta) || minDelta < 1) throw new Error("evaluateDifferencing: minDelta must be a positive integer");

  // The privacy gate speaks first: an unpublishable cohort is never served,
  // and a previously published value is NOT re-served in its place — that would
  // reveal that the cohort has since fallen below k.
  if (!current || current.publishable !== true) return { publish: false, reason: "not_publishable", serve: null };

  if (!previous || previous.publishable !== true) return { publish: true, reason: "no_previous", serve: current };

  const delta = Math.abs(current.distinctActors - previous.distinctActors);
  if (delta === 0) return { publish: true, reason: "unchanged", serve: current };
  if (delta >= minDelta) return { publish: true, reason: "delta_at_least_minimum", serve: current };
  return { publish: false, reason: "delta_below_minimum", serve: previous };
}
