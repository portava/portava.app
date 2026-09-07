/**
 * sensingCoverageAggregate — the ONLY way a cohort of anonymous sensing
 * contributions is allowed to become a published number.
 *
 * The owner ruling permits this store to own "cohort/coverage aggregation". This
 * module is that aggregation, and its entire job is to hand
 * lib/privacyGate.evaluatePrivacy a set of TRUTHFUL counts.
 *
 * ── WHY THE COUNTING IS THE WHOLE JOB ────────────────────────────────────────
 * privacyGate says it plainly: "It does not COUNT anything. Supplying a truthful
 * distinct-actor count is the caller's job, and that is the hard part... A gate
 * handed a wrong count returns a confident wrong answer." So there is no
 * threshold arithmetic in this file, no k, no 15, no 0.2 and no second copy of
 * k-anonymity — evaluatePrivacy is imported and called, and its verdict is
 * returned unchanged. Reimplementing it here would be the exact mistake
 * privacyGate's header was written to prevent: two thresholds over overlapping
 * aggregates, drifting apart.
 *
 * ── COUNTING RULES: lib/intelProjectionAggregator IS THE REFERENCE ───────────
 * The same three rules crowdFlowProducer follows verbatim, applied to tokens
 * instead of account ids:
 *
 *   distinctActors  size of the contributor-token Set. CONTRIBUTORS, never rows.
 *                   Counting rows would let one device that submitted forty
 *                   readings read as forty people.
 *   distinctGroups  count of DISTINCT NON-NULL group tokens. A null group token
 *                   earns ZERO group credit — we never infer a party from a bare
 *                   contributor — though the contributor is still counted.
 *   maxGroupShare   (largest group's distinct contributors) / (DISTINCT GROUPED
 *                   contributors, the union). The union denominator, not the sum
 *                   of group sizes, so a contributor in several parties cannot
 *                   dilute the dominant group's share.
 *
 * WHY lib/intelIndependence's CLUSTERING IS NOT APPLIED HERE. Its media and
 * common-source detectors are inert against this store by construction — a
 * contribution carries no media and no feed reference, so there is nothing to
 * cluster on. Its third detector, "different actors asserting the IDENTICAL value
 * within 30 seconds is coordination", is calibrated for HUMAN REPORTS of a claim
 * value, where simultaneity is suspicious. Here the payload is a five-valued
 * ordinal from passive reduction, so near-simultaneous identical buckets are the
 * NORMAL case; running that detector would merge an entire honest cohort into one
 * cluster and make the store permanently unpublishable. Suppressing everything is
 * the safe direction but it is not a privacy control, it is a broken one, so this
 * module reuses the counting RULE (which crowdFlowProducer also reuses without
 * the clustering) and says why the heuristic does not transfer.
 *
 * ── A FAILED READ MUST NEVER INFLATE A COHORT ────────────────────────────────
 * The realistic inflation path is not a thrown error; it is a read that half
 * worked. Supabase returns rows AND an `exact` count, so a truncated page arrives
 * next to a count claiming the full cohort size. Taking that count would be
 * inflation in its purest form: a number describing rows nobody looked at, and
 * one that counts ROWS rather than CONTRIBUTORS besides.
 *
 * So this module derives every number from the rows it is actually holding, and:
 *
 *   * a failed read is refused outright (`read_failed`) with every count at 0 —
 *     `reportedCount` lives on the failure branch of SensingReadResult and is
 *     never read here;
 *   * an INCOMPLETE read is refused too (`read_incomplete`), because a full page
 *     is indistinguishable from a truncated one and a truncated cohort silently
 *     understates a dominant group's share — the direction that publishes when it
 *     should not;
 *   * expired rows are dropped before anything is counted, so a stale row cannot
 *     pad a cohort past the threshold.
 *
 * ── INERT ────────────────────────────────────────────────────────────────────
 * Nothing outside its tests imports this module. No route, scheduler or flag
 * calls it, and it publishes nothing itself — it returns a decision, and there is
 * as yet no consumer to act on one.
 */
import {
  evaluatePrivacy,
  type PrivacyThreshold,
  type SuppressionReason,
} from "./privacyGate.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import {
  isSensingContributionExpired,
  type SensingContributionRow,
  type SensingReadResult,
} from "./sensingAnonStore.js";

/**
 * Why an aggregate was refused. The privacy gate's own reasons, plus the two
 * this module owns — a read that failed and a read that was incomplete. They are
 * kept DISTINCT from the gate's reasons on purpose: "we could not look" is a
 * different fact from "we looked and there were too few people", and collapsing
 * them would hide an outage behind a privacy suppression.
 */
export type SensingAggregateReason = SuppressionReason | "read_failed" | "read_incomplete";

export interface SensingCohortAggregate {
  publishable: boolean;
  reason: SensingAggregateReason | null;
  /** Distinct contributors, derived from rows actually held. */
  distinctActors: number;
  distinctGroups: number;
  maxGroupShare: number;
  /** Rows counted. Never used as a cohort size — exposed for observability only. */
  contributions: number;
  /** Freshest arrival in the cohort, or null when nothing was counted. */
  observedAt: string | null;
}

const REFUSED_WITHOUT_LOOKING = (reason: SensingAggregateReason): SensingCohortAggregate => ({
  publishable: false,
  reason,
  distinctActors: 0,
  distinctGroups: 0,
  maxGroupShare: 0,
  contributions: 0,
  observedAt: null,
});

export interface SensingAggregateOptions {
  /** Evaluation instant. Also decides which rows have expired. */
  nowMs?: number;
  threshold?: PrivacyThreshold;
  /**
   * True when the subject is a category the spec excludes outright. Passed
   * straight to the gate, which refuses it before any arithmetic.
   */
  sensitiveSubject?: boolean;
}

/**
 * Turn one cohort read into a publish decision.
 *
 * Takes the READ RESULT, not an array of rows, so that a caller physically cannot
 * hand this function the rows from a failed read: the failure is part of the
 * value being passed in.
 */
export function aggregateSensingCohort(
  read: SensingReadResult,
  options: SensingAggregateOptions = {},
): SensingCohortAggregate {
  const nowMs = options.nowMs ?? Date.now();
  const threshold = options.threshold ?? PRIVACY_THRESHOLD_V1;

  if (!read || read.ok !== true) return REFUSED_WITHOUT_LOOKING("read_failed");
  if (read.complete !== true) return REFUSED_WITHOUT_LOOKING("read_incomplete");

  const rows: readonly SensingContributionRow[] = read.rows ?? [];
  const fresh = rows.filter((r) => r && !isSensingContributionExpired(r, nowMs));

  // distinctActors — contributors, never rows.
  const actors = new Set<string>();
  // Per-group distinct contributors, and the union across all grouped rows.
  const groupActors = new Map<string, Set<string>>();
  const groupedActorUnion = new Set<string>();
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const r of fresh) {
    const token = r.contributor_token;
    if (!token) continue; // a tokenless row is not a countable contributor
    actors.add(token);

    const created = Date.parse(r.created_at);
    if (Number.isFinite(created) && created > latestMs) latestMs = created;

    const group = r.group_token;
    if (group === null || group === undefined || group === "") continue; // zero group credit
    let set = groupActors.get(group);
    if (!set) {
      set = new Set<string>();
      groupActors.set(group, set);
    }
    set.add(token);
    groupedActorUnion.add(token);
  }

  let maxGroupActors = 0;
  for (const set of groupActors.values()) {
    if (set.size > maxGroupActors) maxGroupActors = set.size;
  }
  // Union denominator, and always finite (0 when nothing is grouped) so the gate
  // returns an accurate below_group_threshold rather than invalid_input.
  const maxGroupShare = groupedActorUnion.size > 0 ? maxGroupActors / groupedActorUnion.size : 0;

  const observedAt = Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null;

  const distinctActors = actors.size;
  const distinctGroups = groupActors.size;

  // An empty cohort has no observation instant, so the gate's publication-delay
  // clause would see `observedAt: undefined` and answer invalid_input — a
  // misleading reason for "nobody contributed". Let the actor threshold speak.
  if (distinctActors === 0) {
    const decision = evaluatePrivacy(
      { distinctActors: 0, distinctGroups: 0, maxGroupShare: 0, observedAt: new Date(nowMs).toISOString(), now: nowMs, sensitiveSubject: options.sensitiveSubject },
      threshold,
    );
    return {
      publishable: decision.publishable,
      reason: decision.reason,
      distinctActors: 0,
      distinctGroups: 0,
      maxGroupShare: 0,
      // The rows we actually held, even though none of them named a countable
      // contributor. Reporting 0 here would understate what was read, and this
      // module's whole argument is that its numbers are literal.
      contributions: fresh.length,
      observedAt: null,
    };
  }

  const decision = evaluatePrivacy(
    {
      distinctActors,
      distinctGroups,
      maxGroupShare,
      // The FRESHEST arrival, so a cohort still receiving contributions cannot
      // publish — the publication delay is a guard against a live tracker, and
      // measuring it from the oldest row would defeat it entirely.
      observedAt: observedAt ?? undefined,
      now: nowMs,
      sensitiveSubject: options.sensitiveSubject,
    },
    threshold,
  );

  return {
    publishable: decision.publishable,
    reason: decision.reason,
    distinctActors,
    distinctGroups,
    maxGroupShare,
    contributions: fresh.length,
    observedAt,
  };
}
