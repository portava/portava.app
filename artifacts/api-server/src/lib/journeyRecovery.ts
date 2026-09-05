/**
 * journeyRecovery — §36 Phase 6 "recovery": a planned stop has become
 * unreachable, so name the next-best alternative in the same category, say
 * WHY, and cite the evidence.
 *
 * IT CALLS THE COMPASS PLAN-B SEAM. IT DOES NOT RE-IMPLEMENT ONE.
 * ==============================================================
 * Every decision this module makes is borrowed from compass/CompassLiveConstraints:
 *
 *   isLiveConstraintEligible   the truth boundary — may this envelope act as a
 *                              hard fact at all (state 'live', band live/strong,
 *                              an observation class, unexpired)?
 *   evaluateLiveConstraints    walk-in denial / queue over tolerance / packed
 *                              vs a quiet intent, with their reasons.
 *   computePlanB               the alternative for a LIVE-constrained stop.
 *   bestSameCategoryAlternative the same-category selection rule, for the one
 *                              case Plan B structurally cannot serve.
 *
 * The only rule that is NEW here is the `closure.state` reading, and it is new
 * because nothing else reads that claim type for ranking: `constraintReasonFor`
 * in the Compass module handles access/queue/crowd and stops. It is applied
 * behind the SAME `isLiveConstraintEligible` boundary as the others, and it
 * produces a real `LiveConstraintDecision` so it flows through the SAME
 * `computePlanB`.
 *
 * §37 — WHAT IS AND IS NOT ALLOWED TO FIRE A RECOVERY
 * ===================================================
 * A LIVE recovery requires LIVE evidence. Not 'emerging', not 'typical', not a
 * historical pattern, not a Portava prediction, not an expired claim — those
 * describe what a place is usually like or what it might become, and rerouting
 * a traveller on one of those would be treating a prediction as an
 * observation. `isLiveConstraintEligible` is what enforces this, and it is
 * re-applied here rather than assumed from the read seam.
 *
 * The ONE recovery with no claim behind it is the MISSED WINDOW: the stop's
 * own planned end time is in the past. That is a fact about the traveller's
 * plan and the clock, not a fact about the venue, so it carries
 * `evidence.kind: 'schedule'` and `claimRef: null` — the type makes it
 * impossible to present a schedule fact as an observation of the world.
 *
 * NOTHING HERE FEEDS ANYTHING BACK. No score, trust value or confidence is
 * computed, written or returned; the module reads envelopes and returns
 * pointers to them.
 *
 * PURE. Envelopes and rows in, entries out. The caller does the reading.
 */
import type { CompassItem } from "../compass/types.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import {
  DEFAULT_QUEUE_TOLERANCE_MINUTES,
  bestSameCategoryAlternative,
  computePlanB,
  describeLiveIntelSource,
  evaluateLiveConstraints,
  isLiveConstraintEligible,
  sourceLabelOf,
  type LiveConstraintDecision,
  type PlanBConstrainedCandidate,
  type PlanBRankedCandidate,
  type ViewerLiveTolerances,
} from "../compass/CompassLiveConstraints.js";

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Recovery entries returned per request. Mirrors Compass's PLAN_B_MAX. */
export const RECOVERY_MAX = 5;

/**
 * Grace after a stop's planned end before the window counts as MISSED.
 *
 * Not zero: a plan is a rough intention, and telling somebody they have missed
 * a place the instant its planned end passes would fire on every stop of every
 * trip. Thirty minutes is long enough that the traveller has actually let it
 * go, short enough that the suggestion is still useful.
 */
export const MISSED_WINDOW_GRACE_MINUTES = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A planned stop, as recovery needs it. */
export interface PlannedStop {
  /** The trip_plan_items id. */
  id: string;
  title: string;
  /** The plan category ('dining', 'activity', …). Drives the same-category match. */
  category: string | null;
  /**
   * The canonical subject id live claims are filed against (a place id). Null
   * when the stop is not a canonical place — such a stop can still miss its
   * window, but no live claim can ever speak about it.
   */
  subjectId: string | null;
  /** Planned end of the visit. Null ⇒ the window can never be missed. */
  endsAt: string | null;
}

/** A candidate alternative the caller has already fetched and ranked. */
export interface RecoveryCandidate {
  id: string;
  title: string;
  /** Matched against the stop's category by the Compass rule. */
  category: string | null;
  /** The caller's rank score. Higher is better; order is what actually decides. */
  score: number;
  /** True when this candidate is ITSELF live-constrained — never offered. */
  hasHardConstraint?: boolean;
}

export type RecoveryReasonCode =
  | "walk_in_denied"
  | "queue_exceeds_tolerance"
  | "packed_vs_quiet_intent"
  | "closed_now"
  | "window_missed";

/**
 * Where a recovery's reason comes from.
 *
 * `live` carries the snapshot reference the claim came from — never a
 * contributor id, never a coordinate. `schedule` has no claim and says so by
 * having no field that could hold one.
 */
export type RecoveryEvidence =
  | {
      kind: "live";
      claimRef: string;
      claimType: string;
      /** The user-facing source label, e.g. "Traveler report". */
      sourceLabel: string;
      /** "<source label> · <cohort bucket>", cohort withheld when null. */
      sourceText: string;
      observedAt: string;
      validUntil: string;
    }
  | {
      kind: "schedule";
      /** The planned end time that has passed. */
      windowEndedAt: string;
    };

export interface RecoveryEntry {
  /** The planned stop that became unreachable. */
  stopId: string;
  stopTitle: string;
  reasonCode: RecoveryReasonCode;
  /** Human-readable, derived intelligence only — no identity, no coordinate. */
  reason: string;
  evidence: RecoveryEvidence;
  /** The next-best same-category alternative, or null when there is none. */
  alternativeId: string | null;
  alternativeTitle: string | null;
  /** The alternative's index in the supplied ranking. Null when none was found. */
  alternativeRank: number | null;
}

export interface RecoveryResult {
  entries: RecoveryEntry[];
  /** Stops examined. */
  considered: number;
  /**
   * Stops that had at least one envelope which did NOT clear the live truth
   * boundary. Reported so "no recovery" is never ambiguous between "nothing is
   * wrong" and "we only had weak evidence" — it is a count, not a description.
   */
  weakEvidenceStops: number;
}

// ── Closure: the one reading this module adds ────────────────────────────────

/** closure.state → the state string. Capture writes `{ state }` (lib/quickSignal). */
export function closureStateOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const s = (value as Record<string, unknown>).state;
    if (typeof s === "string") return s;
  }
  return null;
}

/**
 * Closure states that make a planned stop unreachable RIGHT NOW.
 *
 * 'permanently_closed' is deliberately ABSENT. lib/intelContracts marks it a
 * structural, irreversible assertion that a single capture surface may never
 * establish (STRUCTURAL_CLOSURE_STATES), and rerouting a traveller on one
 * report that a business no longer exists is exactly the harm that rule
 * prevents. A permanent-closure claim needs an official or corroborated source
 * before anything acts on it, and this module is not that source.
 */
export const RECOVERABLE_CLOSURE_STATES: readonly string[] = [
  "temporarily_closed",
  "closed_for_private_event",
];

/**
 * A closure decision for one stop, or null.
 *
 * The eligibility test is `isLiveConstraintEligible` — the SAME boundary the
 * Compass constraints use — so an emerging, typical, predicted or expired
 * closure can never fire a recovery.
 */
export function closureDecision(
  envelopes: readonly LiveClaimEnvelope[],
  nowMs: number,
): LiveConstraintDecision | null {
  for (const env of envelopes ?? []) {
    if (env.claimType !== "closure.state") continue;
    if (!isLiveConstraintEligible(env, nowMs)) continue;
    const state = closureStateOf(env.value);
    if (state === null || !RECOVERABLE_CLOSURE_STATES.includes(state)) continue;
    return {
      claimRef: env.id,
      claimType: env.claimType,
      sourceClass: env.sourceClass,
      sourceLabel: sourceLabelOf(env.sourceClass),
      band: env.band,
      sourceCountBucket: env.sourceCountBucket,
      observedAt: env.observedAt,
      validUntil: env.validUntil,
      kind: "exclude",
      reasonCode: "closed_now",
      reason:
        state === "closed_for_private_event"
          ? "Reported closed for a private event right now"
          : "Reported temporarily closed right now",
      penalty: 0,
    };
  }
  return null;
}

// ── Mapping to the Compass shapes the seam expects ───────────────────────────

/**
 * A stop as a CompassItem. `type: 'place'` + the plan category is what
 * `categoryKeysOf` folds into the fine key, so "dining stop → dining
 * alternative" falls out of the Compass rule rather than a rule invented here.
 */
function stopAsItem(stop: PlannedStop): CompassItem {
  return { id: stop.id, type: "place", category: stop.category ?? undefined } as CompassItem;
}

function candidateAsItem(c: RecoveryCandidate): CompassItem {
  return { id: c.id, type: "place", category: c.category ?? undefined } as CompassItem;
}

/** Candidates as the ranked list Plan B walks, best first. */
export function toRankedCandidates(candidates: readonly RecoveryCandidate[]): PlanBRankedCandidate[] {
  return candidates
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({
      item: candidateAsItem(c),
      finalScore: c.score,
      hasHardConstraint: c.hasHardConstraint === true,
    }));
}

// ── The recovery pass ────────────────────────────────────────────────────────

export interface RecoveryInput {
  stops: readonly PlannedStop[];
  /** Live envelopes per stop SUBJECT id, already read through the gated seam. */
  envelopesBySubject: ReadonlyMap<string, readonly LiveClaimEnvelope[]>;
  /** Same-category alternatives the caller has already fetched. */
  candidates: readonly RecoveryCandidate[];
  tolerances?: ViewerLiveTolerances;
  nowMs: number;
}

/**
 * Compute recovery entries.
 *
 * ORDER OF PROVENANCE. Live constraints are resolved first and a stop that has
 * one does NOT also produce a missed-window entry: "reported closed" is a
 * better answer than "you are late", and two entries for one stop would read
 * as two separate problems.
 */
export function computeRecovery(input: RecoveryInput): RecoveryResult {
  const tolerances: ViewerLiveTolerances = input.tolerances ?? {
    maxQueueWaitMinutes: DEFAULT_QUEUE_TOLERANCE_MINUTES,
    intent: null,
  };
  const ranked = toRankedCandidates(input.candidates);
  const byId = new Map(input.candidates.map((c) => [c.id, c]));

  const constrained: PlanBConstrainedCandidate[] = [];
  const stopById = new Map<string, PlannedStop>();
  const decisionByStop = new Map<string, LiveConstraintDecision>();
  const envelopeByRef = new Map<string, LiveClaimEnvelope>();
  let weakEvidenceStops = 0;

  for (const stop of input.stops) {
    stopById.set(stop.id, stop);
    const envelopes = stop.subjectId ? (input.envelopesBySubject.get(stop.subjectId) ?? []) : [];
    if (envelopes.length > 0 && !envelopes.some((e) => isLiveConstraintEligible(e, input.nowMs))) {
      weakEvidenceStops += 1;
    }

    // The Compass evaluator first (access / queue / crowd), then the closure
    // reading this module adds. An exclusion beats a demotion, and both beat a
    // missed window.
    const evaluation = evaluateLiveConstraints(envelopes, tolerances, input.nowMs);
    const decision =
      evaluation.exclusion ?? closureDecision(envelopes, input.nowMs) ?? evaluation.demotions[0] ?? null;
    if (!decision) continue;

    decisionByStop.set(stop.id, decision);
    for (const env of envelopes) envelopeByRef.set(env.id, env);
    constrained.push({
      item: stopAsItem(stop),
      decision,
      // An excluded stop was never scored; a demoted one is not scored here
      // either, because a planned stop is not a ranked candidate — it is the
      // plan. Passing null keeps computePlanB on its "always emit" branch,
      // which is right: a stop the traveller is going to that a live claim
      // just took out ALWAYS deserves an alternative.
      finalScore: null,
      unconstrainedScore: null,
    });
  }

  const entries: RecoveryEntry[] = [];

  for (const pb of computePlanB(constrained, ranked)) {
    if (entries.length >= RECOVERY_MAX) break;
    const stop = stopById.get(pb.forItemId);
    const decision = decisionByStop.get(pb.forItemId);
    if (!stop || !decision) continue;
    const env = envelopeByRef.get(decision.claimRef);
    const alt = byId.get(pb.alternativeItemId) ?? null;
    entries.push({
      stopId: stop.id,
      stopTitle: stop.title,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      evidence: {
        kind: "live",
        claimRef: decision.claimRef,
        claimType: decision.claimType,
        sourceLabel: decision.sourceLabel,
        sourceText: env
          ? describeLiveIntelSource(env)
          : sourceLabelOf(decision.sourceClass),
        observedAt: decision.observedAt,
        validUntil: decision.validUntil,
      },
      alternativeId: pb.alternativeItemId,
      alternativeTitle: alt?.title ?? null,
      alternativeRank: pb.alternativeRank,
    });
  }

  // Missed windows, for stops no live claim already spoke about.
  const graceMs = MISSED_WINDOW_GRACE_MINUTES * 60_000;
  for (const stop of input.stops) {
    if (entries.length >= RECOVERY_MAX) break;
    if (decisionByStop.has(stop.id)) continue;
    if (!stop.endsAt) continue;
    const endMs = Date.parse(stop.endsAt);
    if (!Number.isFinite(endMs)) continue;
    if (input.nowMs < endMs + graceMs) continue;

    const found = bestSameCategoryAlternative(stopAsItem(stop), ranked);
    const alt = found ? (byId.get(found.candidate.item.id) ?? null) : null;
    entries.push({
      stopId: stop.id,
      stopTitle: stop.title,
      reasonCode: "window_missed",
      reason: "Its planned time has passed",
      evidence: { kind: "schedule", windowEndedAt: stop.endsAt },
      alternativeId: found?.candidate.item.id ?? null,
      alternativeTitle: alt?.title ?? null,
      alternativeRank: found?.rank ?? null,
    });
  }

  return { entries, considered: input.stops.length, weakEvidenceStops };
}
