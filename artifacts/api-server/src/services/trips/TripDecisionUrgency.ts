/**
 * Trips spec §8.2 — decision urgency, PURE (census-trips TR140, TR141).
 *
 *   "Unresolved decisions are first-class work items. Their urgency depends
 *    on deadline, availability decay, dependency impact, and consequence —
 *    not merely chronological due date.
 *      decisionUrgency = f(timeRemaining, availabilityDecay, downstreamImpact, consequence)"
 *
 * Four terms, each 0..1, each stated on the result so a consumer can see
 * WHY a task ranks where it does; the score is their weighted sum, and the
 * band is the score read against fixed thresholds. Nothing here reads a
 * database: routes/tripDecisions.ts supplies the inputs from
 * trip_decision_tasks (2762) and what depends on each task.
 *
 *   timeRemaining     1 when the deadline is now or passed, 0 at a week or
 *                     more out; a task with no deadline scores 0 here and
 *                     says so — "no deadline" is not "due now" (TR141's
 *                     row: chronological due date is one input of four)
 *   availabilityDecay how fast the option is disappearing: a venue with
 *                     three tables left decays faster than a museum; 0..1
 *                     supplied, or derived from a half-life in hours
 *   downstreamImpact  the share of the trip that depends on this decision:
 *                     dependent commitments and plans over the trip's total
 *   consequence       what happens if it is left: none / minor / major /
 *                     severe, from the task's `consequence` text or an
 *                     explicit level
 */

export const URGENCY_BANDS = ["low", "medium", "high", "critical"] as const;
export type UrgencyBand = (typeof URGENCY_BANDS)[number];

export const CONSEQUENCE_LEVELS = ["none", "minor", "major", "severe"] as const;
export type ConsequenceLevel = (typeof CONSEQUENCE_LEVELS)[number];

export interface UrgencyInputs {
  /** ISO, or null for no deadline. */
  deadlineAt: string | null;
  /** 0..1 directly, or a half-life in hours after which half the option is gone. */
  availabilityDecay?: number | { halfLifeHours: number; sinceIso?: string | null } | null;
  /** What depends on this decision. */
  downstream: { dependentCommitments: number; dependentPlans: number; totalCommitments: number; totalPlans: number };
  /** The task's consequence, as a level or as free text (classified by keyword). */
  consequence: ConsequenceLevel | string | null;
}

export interface UrgencyTerms {
  timeRemaining: number;
  availabilityDecay: number;
  downstreamImpact: number;
  consequence: number;
}

export interface DecisionUrgency {
  score: number;
  band: UrgencyBand;
  terms: UrgencyTerms;
  /** Hours to the deadline; null with no deadline; negative when passed. */
  hoursRemaining: number | null;
  consequenceLevel: ConsequenceLevel;
  explanation: string[];
}

/** The weights, exported so the formula is inspectable and a test can pin it. */
export const URGENCY_WEIGHTS: Readonly<UrgencyTerms> = { timeRemaining: 0.35, availabilityDecay: 0.2, downstreamImpact: 0.25, consequence: 0.2 };
export const URGENCY_THRESHOLDS: Readonly<Record<Exclude<UrgencyBand, "low">, number>> = { medium: 0.3, high: 0.55, critical: 0.8 };
/** A deadline this far out contributes nothing to timeRemaining. */
export const TIME_HORIZON_HOURS = 7 * 24;

const CONSEQUENCE_SCORE: Readonly<Record<ConsequenceLevel, number>> = { none: 0, minor: 0.33, major: 0.66, severe: 1 };
const SEVERE_WORDS = /\b(stranded|no accommodation|nowhere to sleep|miss(ed|ing)? (the )?flight|deport|visa|passport|emergency|unsafe|hospital)\b/i;
const MAJOR_WORDS = /\b(non-?refundable|lose (the )?(booking|deposit|reservation)|cancel(l)?ation fee|forfeit|miss(ed|ing)? (the )?(train|ferry|tour|check-?in)|crew (splits|can't|cannot)|overnight)\b/i;
const MINOR_WORDS = /\b(fee|charge|wait|queue|late|later|less time|smaller|worse|cost)\b/i;

export function classifyConsequence(c: ConsequenceLevel | string | null | undefined): ConsequenceLevel {
  if (!c) return "none";
  if ((CONSEQUENCE_LEVELS as readonly string[]).includes(c)) return c as ConsequenceLevel;
  if (SEVERE_WORDS.test(c)) return "severe";
  if (MAJOR_WORDS.test(c)) return "major";
  if (MINOR_WORDS.test(c)) return "minor";
  return "minor";
}

function clamp01(n: number): number { return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

export function decisionUrgency(inputs: UrgencyInputs, now: number): DecisionUrgency {
  const explanation: string[] = [];
  // timeRemaining
  let hoursRemaining: number | null = null;
  let timeRemaining = 0;
  if (inputs.deadlineAt) {
    const dl = Date.parse(inputs.deadlineAt);
    if (Number.isFinite(dl)) {
      hoursRemaining = (dl - now) / 3_600_000;
      timeRemaining = hoursRemaining <= 0 ? 1 : clamp01(1 - hoursRemaining / TIME_HORIZON_HOURS);
      explanation.push(hoursRemaining <= 0 ? "the deadline has passed" : `${Math.round(hoursRemaining)} h to the deadline`);
    } else explanation.push("the deadline could not be parsed; no time term");
  } else explanation.push("no deadline — time contributes nothing, which is not the same as due now");
  // availabilityDecay
  let availabilityDecay = 0;
  const ad = inputs.availabilityDecay;
  if (typeof ad === "number") availabilityDecay = clamp01(ad);
  else if (ad && typeof ad === "object" && ad.halfLifeHours > 0) {
    const since = ad.sinceIso ? Date.parse(ad.sinceIso) : now;
    const elapsedH = Math.max(0, (now - (Number.isFinite(since) ? since : now)) / 3_600_000);
    availabilityDecay = clamp01(1 - Math.pow(0.5, elapsedH / ad.halfLifeHours));
  }
  if (availabilityDecay > 0) explanation.push(`the option is decaying (${Math.round(availabilityDecay * 100)} % gone)`);
  // downstreamImpact
  const d = inputs.downstream;
  const denom = Math.max(1, d.totalCommitments + d.totalPlans);
  const downstreamImpact = clamp01((d.dependentCommitments * 2 + d.dependentPlans) / denom);
  if (d.dependentCommitments + d.dependentPlans > 0) explanation.push(`${d.dependentCommitments} commitment(s) and ${d.dependentPlans} plan(s) depend on it`);
  // consequence
  const consequenceLevel = classifyConsequence(inputs.consequence);
  const consequence = CONSEQUENCE_SCORE[consequenceLevel];
  if (consequenceLevel !== "none") explanation.push(`consequence ${consequenceLevel}`);

  const terms: UrgencyTerms = { timeRemaining, availabilityDecay, downstreamImpact, consequence };
  const score = Math.round(clamp01(
    URGENCY_WEIGHTS.timeRemaining * timeRemaining + URGENCY_WEIGHTS.availabilityDecay * availabilityDecay
    + URGENCY_WEIGHTS.downstreamImpact * downstreamImpact + URGENCY_WEIGHTS.consequence * consequence,
  ) * 1000) / 1000;
  const band: UrgencyBand = score >= URGENCY_THRESHOLDS.critical ? "critical" : score >= URGENCY_THRESHOLDS.high ? "high" : score >= URGENCY_THRESHOLDS.medium ? "medium" : "low";
  return { score, band, terms, hoursRemaining, consequenceLevel, explanation };
}

/** Sort key: urgency desc, then the sooner deadline, then id — deterministic. */
export function byUrgency<T extends { id: string; urgency: DecisionUrgency }>(a: T, b: T): number {
  return b.urgency.score - a.urgency.score
    || ((a.urgency.hoursRemaining ?? Infinity) - (b.urgency.hoursRemaining ?? Infinity))
    || a.id.localeCompare(b.id);
}
