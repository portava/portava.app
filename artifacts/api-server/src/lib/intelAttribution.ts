/**
 * Intelligence Gathering — ATTRIBUTION v1 (unit I4a, spec §14 Table 22).
 *
 *   Touch                                                     Weight
 *   Direct paid answer accepted then action                   1.00
 *   User taps Go/Reroute from contribution                    0.70
 *   Contribution included in Compass explanation and action   0.30
 *   Generic impression without action                         0.00
 *   Action already committed before exposure                  0.00–0.10
 *
 * "Normalize multi-touch weights so total attributable contribution does not
 *  exceed 1.0 per outcome. Store counterfactual feedback: 'Would you have made
 *  the same choice without this?'"
 *
 * PURE. Every function here is a deterministic map from an outcome event and the
 * served claim's input observations to attribution rows; the DB-touching driver
 * is lib/intelAttributionScheduler.ts. Nothing here mutates a claim: a
 * contradiction is RECORDED (row + structured log) for the correction path.
 */
import type { AttributionTouch, IntelOutcome, IntelOutcomePayload } from "./intelOutcomes.js";

export const ATTRIBUTION_ALGORITHM_VERSION = "attribution.v1";

/** Table 22. `pre_committed` sits in the band's midpoint; the cap below bounds it. */
export const TOUCH_WEIGHT: Record<AttributionTouch, number> = {
  direct_paid_answer: 1.0,
  go_tap: 0.7,
  compass_explanation: 0.3,
  impression: 0.0,
  pre_committed: 0.05,
};

/** Table 22 "Action already committed before exposure: 0.00–0.10" — the ceiling. */
export const PRE_COMMITTED_WEIGHT_MAX = 0.10;

/**
 * The counterfactual answer "I would have made the same choice without this"
 * IS the pre-committed case: the contribution did not change the action. The
 * touch weight is discounted to the pre-committed ceiling, never to zero (the
 * contribution was still consulted), and never raised.
 */
export function touchWeight(touch: AttributionTouch, counterfactualSameChoice?: boolean | null): number {
  const w = TOUCH_WEIGHT[touch] ?? 0;
  if (counterfactualSameChoice === true) return Math.min(w, PRE_COMMITTED_WEIGHT_MAX);
  return w;
}

/**
 * Accuracy grade of an outcome against the served state, 0..1. `same` is the
 * accurate case; a positive surprise is graded above a negative one because it
 * did not harm the traveler; `did_not_go` carries no information (null).
 */
export const OUTCOME_SCORE: Record<IntelOutcome, number | null> = {
  same: 1.0,
  slightly_better: 0.85,
  better: 0.65,
  worse: 0.1,
  could_not_enter: 0.0,
  did_not_go: null,
};

/** Outcomes that CONTRADICT the served state — recorded for the correction path. */
export const CONTRADICTING_OUTCOMES: readonly IntelOutcome[] = ["worse", "could_not_enter"];
const CONTRADICTION_SET = new Set<string>(CONTRADICTING_OUTCOMES);

export function isContradiction(outcome: IntelOutcome): boolean {
  return CONTRADICTION_SET.has(outcome);
}

/** 0..1 or null. The served confidence recorded on the outcome event's envelope. */
export function expectedAccuracyOf(confidence: unknown): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.min(1, Math.max(0, confidence));
}

export interface Contribution {
  observationId: string;
  actorId: string;
  /** Optional relative share (any positive scale); equal split when absent. */
  share?: number;
}

/**
 * Split `totalWeight` across the contributing observations so that Σ ≤ 1.0 per
 * outcome (Table 22). Equal split by default; explicit shares are normalized.
 * Deterministic and order-preserving; weights are truncated (never rounded up)
 * to 4 dp so the stored numerics are stable across runs AND the sum can never
 * creep above the touch weight (seven equal shares rounded to nearest would
 * sum to 1.0003 — a violation of the Table-22 cap by rounding alone).
 */
export function normalizeAttribution(totalWeight: number, contributions: readonly Contribution[]): Map<string, number> {
  const out = new Map<string, number>();
  if (contributions.length === 0) return out;
  const total = Number.isFinite(totalWeight) ? Math.min(1, Math.max(0, totalWeight)) : 0;
  const shares = contributions.map((c) => (typeof c.share === "number" && Number.isFinite(c.share) && c.share > 0 ? c.share : 1));
  const sum = shares.reduce((a, b) => a + b, 0);
  for (let i = 0; i < contributions.length; i++) {
    const w = sum > 0 ? (total * shares[i]) / sum : 0;
    // +1e-9 absorbs binary float error (0.35 * 10_000 = 3499.9999…) before the floor.
    out.set(contributions[i].observationId, Math.floor(w * 10_000 + 1e-9) / 10_000);
  }
  return out;
}

/** One intel_attributions row (column names). */
export interface AttributionRow {
  outcome_event_id: string;
  claim_id: string;
  observation_id: string;
  actor_id: string;
  touch: AttributionTouch;
  weight: number;
  outcome: IntelOutcome;
  outcome_score: number | null;
  expected_accuracy: number | null;
  counterfactual: boolean;
  contradiction: boolean;
  scope_key: string;
  algorithm_version: string;
  computed_at: string;
}

export interface DeriveArgs {
  outcomeEventId: string;
  outcome: IntelOutcomePayload;
  touch: AttributionTouch;
  counterfactualSameChoice?: boolean | null;
  /** The served confidence from the event envelope. */
  servedConfidence: unknown;
  contributions: readonly Contribution[];
  scopeKey: string;
  computedAt: Date;
}

/**
 * Derive the attribution rows for one outcome. Pure. Returns [] when there is
 * nothing to attribute (no contributing observations) — never a placeholder row.
 */
export function deriveAttributions(a: DeriveArgs): AttributionRow[] {
  const weights = normalizeAttribution(touchWeight(a.touch, a.counterfactualSameChoice), a.contributions);
  const contradiction = isContradiction(a.outcome.outcome);
  const expected = expectedAccuracyOf(a.servedConfidence);
  const score = OUTCOME_SCORE[a.outcome.outcome] ?? null;
  const computedAt = a.computedAt.toISOString();
  return a.contributions.map((c) => ({
    outcome_event_id: a.outcomeEventId,
    claim_id: a.outcome.claim_id,
    observation_id: c.observationId,
    actor_id: c.actorId,
    touch: a.touch,
    weight: weights.get(c.observationId) ?? 0,
    outcome: a.outcome.outcome,
    outcome_score: score,
    expected_accuracy: expected,
    counterfactual: a.counterfactualSameChoice === true,
    contradiction,
    scope_key: a.scopeKey,
    algorithm_version: ATTRIBUTION_ALGORITHM_VERSION,
    computed_at: computedAt,
  }));
}
