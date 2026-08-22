/**
 * Privacy gate — the single decision point for publishing an aggregate.
 *
 * WHY ONE GATE AND NOT AN INTEL-ONLY MODULE. The A0 reconnaissance found a live
 * path already publishing community aggregates at k = 1 distinct actor:
 * CompassGraphEngine injects per-city × day-part activity lines into the
 * /compass/ask prompt gated only by MIN_SLICE_SAMPLE = 3, which counts EVENTS,
 * not people — and its edge key contains no user id, so three stamps from one
 * traveller read as "3 observations". Building the spec's threshold as a new
 * intel-only module would leave that path publishing at k=1 forever, with two
 * thresholds covering overlapping aggregates and a 15x gap between them.
 *
 * So this is deliberately generic: it takes counts, not intel rows, and any
 * publisher can route through it.
 *
 * WHAT IT DOES NOT DO. It does not COUNT anything. Supplying a truthful
 * distinct-actor count is the caller's job, and that is the hard part — see the
 * note on compass_graph_edges at the bottom. A gate handed a wrong count
 * returns a confident wrong answer, so `distinctActors` is required and a
 * missing one is a refusal, not a default.
 *
 * Fail-closed throughout: any missing, non-finite or negative input suppresses.
 */
import { meetsKAnonymity } from "./kAnonymity.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";

export interface PrivacyThreshold {
  minUniqueActors: number;
  minIndependentGroups: number;
  maxSingleGroupShare: number;
  timeBucketMinutes: number;
  publicationDelayMinutes: number;
}

export interface AggregateShape {
  /** Distinct PEOPLE, not events. The caller must count truthfully. */
  distinctActors: number;
  /** Distinct independent groups/parties, guarding against one crowd. */
  distinctGroups?: number;
  /** Largest single group's share of contributions, 0..1. */
  maxGroupShare?: number;
  /** When the underlying observations were made. */
  observedAt?: string | number | Date;
  /** Evaluation time; defaults to now. */
  now?: string | number | Date;
  /** True when the subject is a sensitive category the spec excludes outright. */
  sensitiveSubject?: boolean;
}

export type SuppressionReason =
  | "below_actor_threshold"
  | "below_group_threshold"
  | "single_group_dominates"
  | "publication_delay_not_elapsed"
  | "sensitive_subject"
  | "invalid_input";

export interface PrivacyDecision {
  publishable: boolean;
  /** Populated only when publishable is false. */
  reason: SuppressionReason | null;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/**
 * May this aggregate be published?
 *
 * Order matters: the cheapest and most absolute checks run first, so a sensitive
 * subject is refused before any arithmetic and can never be rescued by a large
 * cohort.
 */
export function evaluatePrivacy(
  shape: AggregateShape,
  threshold: PrivacyThreshold = PRIVACY_THRESHOLD_V1,
): PrivacyDecision {
  if (shape?.sensitiveSubject === true) {
    return { publishable: false, reason: "sensitive_subject" };
  }
  if (!shape || !finite(shape.distinctActors) || shape.distinctActors < 0) {
    return { publishable: false, reason: "invalid_input" };
  }
  if (!finite(threshold?.minUniqueActors) || threshold.minUniqueActors < 1) {
    return { publishable: false, reason: "invalid_input" };
  }

  if (!meetsKAnonymity(shape.distinctActors, threshold.minUniqueActors)) {
    return { publishable: false, reason: "below_actor_threshold" };
  }

  // Group clauses are enforced when a threshold demands them. A caller that
  // cannot supply group counts cannot satisfy a group threshold — that is a
  // refusal, not an exemption, or the clause would be optional in practice.
  if (finite(threshold.minIndependentGroups) && threshold.minIndependentGroups > 0) {
    if (!finite(shape.distinctGroups)) return { publishable: false, reason: "invalid_input" };
    if (shape.distinctGroups < threshold.minIndependentGroups) {
      return { publishable: false, reason: "below_group_threshold" };
    }
  }
  if (finite(threshold.maxSingleGroupShare)) {
    if (!finite(shape.maxGroupShare)) return { publishable: false, reason: "invalid_input" };
    if (shape.maxGroupShare > threshold.maxSingleGroupShare) {
      return { publishable: false, reason: "single_group_dominates" };
    }
  }

  // Publication delay: an aggregate published the instant it forms is a live
  // tracker of whoever is present right now, however many people it counts.
  if (finite(threshold.publicationDelayMinutes) && threshold.publicationDelayMinutes > 0) {
    if (shape.observedAt === undefined) return { publishable: false, reason: "invalid_input" };
    const observed = toMs(shape.observedAt);
    const now = shape.now === undefined ? Date.now() : toMs(shape.now);
    if (!Number.isFinite(observed) || !Number.isFinite(now)) {
      return { publishable: false, reason: "invalid_input" };
    }
    if (now - observed < threshold.publicationDelayMinutes * 60_000) {
      return { publishable: false, reason: "publication_delay_not_elapsed" };
    }
  }

  return { publishable: true, reason: null };
}

/** Convenience wrapper for call sites that only need the boolean. */
export function mayPublishAggregate(
  shape: AggregateShape,
  threshold: PrivacyThreshold = PRIVACY_THRESHOLD_V1,
): boolean {
  return evaluatePrivacy(shape, threshold).publishable;
}

/**
 * KNOWN UNROUTED PUBLISHER — recorded here so it is not rediscovered.
 *
 * compass/CompassGraphEngine.ts buildDestinationContextLines still publishes
 * per-city × day-part aggregates using MIN_SLICE_SAMPLE = 3 on an EVENT count.
 * It cannot be routed through this gate as-is: compass_graph_edges dedups on
 * `${src_type}|${src_key}|${dst_type}|${dst_key}|${edge_type}` with no user id,
 * so a distinct-ACTOR count is not derivable from the stored data. Closing it
 * needs either a user id in the edge key or a parallel distinct-actor rollup
 * computed at build time — a schema change on a live serving path, which is why
 * it is not bundled with this module.
 */
export const UNROUTED_PUBLISHERS: readonly string[] = [
  "compass/CompassGraphEngine.ts buildDestinationContextLines (needs a distinct-actor count that compass_graph_edges cannot currently produce)",
];
