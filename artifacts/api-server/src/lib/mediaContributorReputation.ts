/**
 * mediaContributorReputation — Media v2 Phase 10 (§25 Creator Popularity vs
 * Intelligence Trust).
 *
 * Surfaces a media contributor's INTELLIGENCE-TRUST dimensions, derived ONLY
 * from the existing intel signals (intel_observations acceptance, intel_
 * confirmations corroboration). These are the three §25 dimensions that are
 * SEPARATE from social popularity:
 *
 *   • Contributor Reliability — usefulness / historical acceptance of structured
 *     observations  = accepted / total observations.
 *   • Place Expertise — evidence-backed experience in a place/category
 *     = a saturating function of accepted observations AT that place.
 *   • Live Accuracy — how often current observations are corroborated
 *     = corroborated / corroboration-opportunities.
 *
 * THE POPULARITY BOUNDARY IS STRUCTURAL, NOT A CHECK.
 * ---------------------------------------------------
 * `ContributorIntelSignals` has NO field for followers, stamps, likes, shares,
 * or any social-reach metric, and this module reads nothing else. A contributor's
 * Stamp count or follower count therefore CANNOT move any dimension here: there
 * is no parameter to route it through. The service assembler
 * (readContributorReputation) reads only intel_* tables — never passport_stamps
 * or the follow graph — so the boundary holds end-to-end. The test proves it by
 * showing two contributors with identical intel signals but wildly different
 * social popularity receive byte-identical reputation, and pins each dimension to
 * its exact intel formula so that folding any social term in turns the assertion
 * RED.
 */

/** Intel-only inputs. NO social/popularity field exists here, by design. */
export interface ContributorIntelSignals {
  /** intel_observations by this actor that reached moderation_state='allowed'. */
  acceptedObservations: number;
  /** all intel_observations by this actor (any moderation state). */
  totalObservations: number;
  /**
   * accepted intel_observations by this actor AT the place/subject in scope
   * (evidence-backed experience there). Omit / 0 when scoring globally.
   */
  placeAcceptedObservations?: number;
  /** confirmations that AGREED with this actor's claims (corroboration). */
  corroboratedObservations: number;
  /** total independent confirmation stances on this actor's claims (agree+disagree). */
  corroborationOpportunities: number;
}

export interface ContributorReputation {
  /** 0..1 — usefulness / historical acceptance of structured observations. */
  contributorReliability: number;
  /** 0..1 — evidence-backed experience at the place/category in scope. */
  placeExpertise: number;
  /** 0..1 — how often the contributor's current observations are corroborated. */
  liveAccuracy: number;
  /**
   * Explicit, machine-readable statement of what these numbers are and are NOT.
   * Consumers render "intelligence trust", never social popularity, from this.
   */
  basis: "intelligence_trust";
  /** True until any real intel signal exists (graceful pre-launch empty). */
  isEmpty: boolean;
}

const clamp01 = (x: number): number => (!Number.isFinite(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);
const nonNeg = (x: number | undefined): number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

/**
 * Reliability = accepted / total. EXACTLY that ratio — pinned by the test, so
 * any social term folded in (e.g. `(accepted + stamps)/total`) breaks it. Zero
 * observations ⇒ 0 (never null, never a popularity fallback).
 */
export function contributorReliability(accepted: number, total: number): number {
  const a = nonNeg(accepted);
  const t = nonNeg(total);
  if (t === 0) return 0;
  return clamp01(a / t);
}

/**
 * Place expertise saturates with accepted observations at the place: 1 accepted
 * observation is thin experience, EXPERTISE_SATURATION accepted is full. A
 * saturating curve so a single lucky post is not "expertise", and no amount of
 * social reach contributes — only accepted observations do.
 */
export const EXPERTISE_SATURATION = 8;
export function placeExpertise(placeAccepted: number): number {
  const n = nonNeg(placeAccepted);
  return clamp01(Math.min(n, EXPERTISE_SATURATION) / EXPERTISE_SATURATION);
}

/**
 * Live accuracy = corroborated / opportunities. No confirmations ⇒ 0 (unproven,
 * not "trusted"): a contributor with no independent corroboration has no live
 * accuracy to claim yet.
 */
export function liveAccuracy(corroborated: number, opportunities: number): number {
  const c = nonNeg(corroborated);
  const o = nonNeg(opportunities);
  if (o === 0) return 0;
  return clamp01(c / o);
}

/**
 * Compute the three intelligence-trust dimensions from intel signals ALONE.
 * There is deliberately no social input; popularity cannot reach this function.
 */
export function computeContributorReputation(s: ContributorIntelSignals): ContributorReputation {
  const total = nonNeg(s.totalObservations);
  const opportunities = nonNeg(s.corroborationOpportunities);
  const placeAccepted = nonNeg(s.placeAcceptedObservations);
  return {
    contributorReliability: contributorReliability(s.acceptedObservations, s.totalObservations),
    placeExpertise: placeExpertise(placeAccepted),
    liveAccuracy: liveAccuracy(s.corroboratedObservations, s.corroborationOpportunities),
    basis: "intelligence_trust",
    // Empty when there is no intel signal at all: no observations AND no
    // corroboration opportunities. Pre-launch (no contributors/coverage) this is
    // the normal, graceful state.
    isEmpty: total === 0 && opportunities === 0 && placeAccepted === 0,
  };
}
