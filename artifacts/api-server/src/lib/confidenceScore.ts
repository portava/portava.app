/**
 * Confidence scoring — fills the seam lib/liveEnvelope.ts declared.
 *
 * liveEnvelope refuses to compute confidence, and says why: "how sources /
 * verification combine into a 0..1 score is a product decision … This module
 * never invents a formula." The specification supplies exactly that formula, so
 * this module implements it rather than cutting a new seam elsewhere.
 *
 *   raw     = 0.22*presence + 0.18*freshness + 0.16*independence
 *           + 0.14*source_reliability + 0.12*evidence_quality
 *           + 0.10*agreement + 0.08*specificity
 *   penalty = 0.20*commercial_risk + 0.25*manipulation_risk
 *           + 0.15*instability + 0.20*material_conflict
 *   confidence = clamp(raw - penalty, 0, 1)
 *
 * Confidence is "a bounded evidence score — not probability of enjoyment", and
 * the spec requires every component be stored so the result can be replayed.
 * scoreConfidence therefore returns the components alongside the score; callers
 * persist the whole record, never just the number. A score you cannot
 * reconstruct is a number nobody can audit or correct.
 *
 * FAIL-CLOSED. Every component is a 0..1 signal. A missing one is treated as
 * ZERO (absent evidence is not partial credit), while a missing PENALTY is
 * treated as zero too — the conservative direction differs per field, so each is
 * stated rather than inferred. Any non-finite or out-of-range input yields a
 * score of 0 and the 'unverified' band; it never yields a stronger result.
 */
import { confidenceBand, type ConfidenceBand } from "./intelContracts.js";

/** Positive evidence signals, each 0..1. Absent means zero. */
export interface ConfidenceComponents {
  presence: number;
  freshness: number;
  independence: number;
  sourceReliability: number;
  evidenceQuality: number;
  agreement: number;
  specificity: number;
}

/** Penalty signals, each 0..1. Absent means zero (no known risk). */
export interface ConfidencePenalties {
  commercialRisk: number;
  manipulationRisk: number;
  instability: number;
  materialConflict: number;
}

export const COMPONENT_WEIGHTS: Readonly<Record<keyof ConfidenceComponents, number>> = {
  presence: 0.22,
  freshness: 0.18,
  independence: 0.16,
  sourceReliability: 0.14,
  evidenceQuality: 0.12,
  agreement: 0.10,
  specificity: 0.08,
};

export const PENALTY_WEIGHTS: Readonly<Record<keyof ConfidencePenalties, number>> = {
  commercialRisk: 0.20,
  manipulationRisk: 0.25,
  instability: 0.15,
  materialConflict: 0.20,
};

/** The replayable record. Persist this, not just `confidence`. */
export interface ConfidenceResult {
  confidence: number;
  band: ConfidenceBand;
  raw: number;
  penalty: number;
  components: ConfidenceComponents;
  penalties: ConfidencePenalties;
  /** Set when an input was unusable and the result was forced to zero. */
  invalid: boolean;
  formulaVersion: 1;
}

const ZERO_COMPONENTS: ConfidenceComponents = {
  presence: 0, freshness: 0, independence: 0, sourceReliability: 0,
  evidenceQuality: 0, agreement: 0, specificity: 0,
};
const ZERO_PENALTIES: ConfidencePenalties = {
  commercialRisk: 0, manipulationRisk: 0, instability: 0, materialConflict: 0,
};

/** A signal is usable only if it is a finite number within 0..1. */
function usable(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

// `Record<keyof T, number>`, NOT `Record<string, number>`. A TypeScript
// INTERFACE gets no implicit index signature, so ConfidenceComponents does not
// satisfy Record<string, number> and the call fails TS2345 — while inference
// simultaneously widened the return to Record<string, number>, so assigning it
// back to the interface failed TS2740/TS2739. Constraining over `keyof T`
// requires only that T's own keys map to number, which an interface does
// satisfy, and keeps T exact through the return type.
function normalise<T extends Record<keyof T, number>>(
  input: Partial<T> | null | undefined,
  zero: T,
): { values: T; invalid: boolean } {
  const values: T = { ...zero };
  let invalid = false;
  for (const key of Object.keys(zero) as Array<keyof T>) {
    const raw = input?.[key];
    if (raw === undefined || raw === null) continue; // absent => zero
    if (!usable(raw)) { invalid = true; continue; }
    values[key] = raw as T[keyof T];
  }
  return { values, invalid };
}

/**
 * Compute the score. Returns the full replayable record.
 *
 * An unusable input does not throw — the pipeline must keep moving — but it
 * forces the score to 0 and sets `invalid`, so a bad signal can never produce a
 * confident answer and the condition is visible to whoever stores the row.
 */
export function scoreConfidence(
  components?: Partial<ConfidenceComponents> | null,
  penalties?: Partial<ConfidencePenalties> | null,
): ConfidenceResult {
  const c = normalise(components, ZERO_COMPONENTS);
  const p = normalise(penalties, ZERO_PENALTIES);
  const invalid = c.invalid || p.invalid;

  let raw = 0;
  for (const k of Object.keys(COMPONENT_WEIGHTS) as Array<keyof ConfidenceComponents>) {
    raw += COMPONENT_WEIGHTS[k] * c.values[k];
  }
  let penalty = 0;
  for (const k of Object.keys(PENALTY_WEIGHTS) as Array<keyof ConfidencePenalties>) {
    penalty += PENALTY_WEIGHTS[k] * p.values[k];
  }

  const confidence = invalid ? 0 : Math.min(1, Math.max(0, raw - penalty));
  return {
    confidence,
    band: confidenceBand(confidence),
    raw,
    penalty,
    components: c.values,
    penalties: p.values,
    invalid,
    formulaVersion: 1,
  };
}

/** Component weights sum to 1, so a perfect observation with no penalty scores 1. */
export const COMPONENT_WEIGHT_SUM = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
