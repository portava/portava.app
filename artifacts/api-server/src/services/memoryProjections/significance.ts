/**
 * Significance and candidate ranking.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 8 "Significance and Candidate Ranking"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:295)
 *       Section 1 non-goal: "Publicly scoring users by travel volume, social value,
 *       or memory importance" - significance is INTERNAL orchestration.
 *       Section 28.13 "Always store provenance and engine/reason-code versions."
 *
 * CENSUS: H63 (scoring from the listed inputs), H64 (internal, never a public
 *         social score), H65 (media quality must not dominate), H66 (explicit
 *         user intent outranks inferred significance), H67 (AUTO_PRIVATE /
 *         SUGGESTED / NO_CANDIDATE thresholds)
 *         (docs/architecture/census-highlights-memories.md, section 8).
 *
 * THE NUMBER IS THE LESSER HALF. A significance score with no derivation is an
 * unfalsifiable verdict: nobody can tell a considered 0.42 from a constant. So
 * `scoreSignificance` returns the score together with every contribution that
 * produced it - the input that fired, its weight, the delta it added, the cap
 * that clipped it, and the hard rule that overrode it. Re-scoring the same input
 * with the same policy version must reproduce the explanation exactly.
 *
 * THIS IS NOT THE RANKER. Significance decides whether a candidate is offered to
 * its OWNER and how likely a private Memory is to resurface for that owner. It
 * is not a feed ranking signal, it is not comparable between people, and no
 * function here takes a viewer. Highlight ranking (section 12) is a separate
 * surface and is deliberately not touched from this file.
 */

import type { ConfidenceBand } from "./evidence.js";

/** Stored with every score. Bump on any weight, cap or threshold change (28.13). */
export const SIGNIFICANCE_POLICY_VERSION = "memory-significance@1";

/** Section 8 "Inputs may include ..." - the closed input registry. */
export type SignificanceInputCode =
  | "EXPLICIT_REMEMBER_INTENT"
  | "USER_CREATED"
  | "FIRST_TIME_EXPERIENCE"
  | "RARE_DESTINATION"
  | "TRIP_GOAL_MATCH"
  | "SOCIAL_CONTEXT"
  | "REPEAT_VISIT"
  | "USER_CAPTION"
  | "USER_FAVORITE"
  | "LATER_USER_PROMOTION"
  | "MEDIA_QUALITY";

export const SIGNIFICANCE_INPUT_CODES: readonly SignificanceInputCode[] = Object.freeze([
  "EXPLICIT_REMEMBER_INTENT",
  "USER_CREATED",
  "FIRST_TIME_EXPERIENCE",
  "RARE_DESTINATION",
  "TRIP_GOAL_MATCH",
  "SOCIAL_CONTEXT",
  "REPEAT_VISIT",
  "USER_CAPTION",
  "USER_FAVORITE",
  "LATER_USER_PROMOTION",
  "MEDIA_QUALITY",
] as const);

/**
 * Weights. Every user-originated input outweighs every inferred one, which is
 * section 8's hard rule expressed in the weights rather than bolted on after.
 */
export const SIGNIFICANCE_WEIGHTS: Readonly<Record<SignificanceInputCode, number>> = Object.freeze({
  EXPLICIT_REMEMBER_INTENT: 0.30,
  USER_CREATED: 0.30,
  LATER_USER_PROMOTION: 0.20,
  USER_FAVORITE: 0.15,
  FIRST_TIME_EXPERIENCE: 0.15,
  RARE_DESTINATION: 0.10,
  TRIP_GOAL_MATCH: 0.10,
  SOCIAL_CONTEXT: 0.10,
  USER_CAPTION: 0.05,
  REPEAT_VISIT: 0.05,
  // Section 8: "Media quality may influence presentation but must not dominate
  // significance." The cap is the mechanism; MEDIA_QUALITY_MAX_CONTRIBUTION is
  // asserted against the SUGGESTED threshold in the test suite, so a later
  // weight bump that made photogenic moments significant would fail there.
  MEDIA_QUALITY: 0.05,
});

export const MEDIA_QUALITY_MAX_CONTRIBUTION = SIGNIFICANCE_WEIGHTS.MEDIA_QUALITY;

/** Section 8 "Auto-creation vs suggestion thresholds". */
export const AUTO_PRIVATE_SCORE_THRESHOLD = 0.70;
export const SUGGESTED_SCORE_THRESHOLD = 0.35;

export type SignificanceTier = "AUTO_PRIVATE" | "SUGGESTED" | "NO_CANDIDATE";

export interface SignificanceInputs {
  /** The owner said "remember this". */
  explicit_remember_intent?: boolean;
  /** The owner authored the Memory themselves. */
  user_created?: boolean;
  /** The owner later promoted an automatic candidate. */
  later_user_promotion?: boolean;
  user_favorite?: boolean;
  /** A non-empty, owner-written caption. */
  user_caption?: boolean;
  first_time_experience?: boolean;
  /** 0..1 rarity of the destination for this owner. */
  destination_rarity?: number;
  trip_goal_match?: boolean;
  /** Count of people meaningfully present. Scaled and capped. */
  social_context_people?: number;
  /** Number of prior visits to the same place. */
  repeat_visit_count?: number;
  /** 0..1 presentation quality. Capped hard - see MEDIA_QUALITY_MAX_CONTRIBUTION. */
  media_quality?: number;
  /** From section 6. Gates AUTO_PRIVATE; never invents confidence of its own. */
  confidence_band?: ConfidenceBand;
  /**
   * Section 8 AUTO_PRIVATE requires "very high confidence + POLICY ELIGIBLE".
   * Supplied by the section 6 gate / section 10 policy; defaults to false so an
   * unstated policy cannot silently auto-create.
   */
  policy_eligible?: boolean;
}

export interface SignificanceContribution {
  code: SignificanceInputCode;
  /** What the input was, as scored. */
  input: number | boolean;
  weight: number;
  /** What it actually added after scaling and capping. */
  delta: number;
  note: string;
}

export interface SignificanceExplanation {
  score: number;
  tier: SignificanceTier;
  confidence_band: ConfidenceBand;
  contributions: SignificanceContribution[];
  /** Every hard rule that changed the outcome, named. */
  applied_rules: string[];
  /**
   * Section 8 hard rule: a user-created Memory may never be demoted, hidden or
   * discarded because an automated score is low. Consumers must honour this
   * flag; the score alone is not permission to drop anything.
   */
  never_discard: boolean;
  policy_version: string;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Section 8. Score a candidate and explain the score.
 *
 * Deterministic and side-effect free. Monotone in every input: adding a positive
 * signal can never lower the score, which is asserted in the test suite because
 * a scorer that is not monotone cannot be reasoned about by the people whose
 * memories it decides on.
 */
export function scoreSignificance(inputs: SignificanceInputs): SignificanceExplanation {
  const contributions: SignificanceContribution[] = [];
  const rules: string[] = [];
  const w = SIGNIFICANCE_WEIGHTS;

  const add = (code: SignificanceInputCode, input: number | boolean, delta: number, note: string) => {
    if (delta <= 0 && input === false) return;
    contributions.push({ code, input, weight: w[code], delta: Number(delta.toFixed(6)), note });
  };

  let score = 0;

  if (inputs.explicit_remember_intent) {
    score += w.EXPLICIT_REMEMBER_INTENT;
    add("EXPLICIT_REMEMBER_INTENT", true, w.EXPLICIT_REMEMBER_INTENT, "owner asked for this to be remembered");
  }
  if (inputs.user_created) {
    score += w.USER_CREATED;
    add("USER_CREATED", true, w.USER_CREATED, "owner authored the Memory");
  }
  if (inputs.later_user_promotion) {
    score += w.LATER_USER_PROMOTION;
    add("LATER_USER_PROMOTION", true, w.LATER_USER_PROMOTION, "owner promoted an automatic candidate");
  }
  if (inputs.user_favorite) {
    score += w.USER_FAVORITE;
    add("USER_FAVORITE", true, w.USER_FAVORITE, "owner marked it a favourite");
  }
  if (inputs.user_caption) {
    score += w.USER_CAPTION;
    add("USER_CAPTION", true, w.USER_CAPTION, "owner wrote a caption");
  }
  if (inputs.first_time_experience) {
    score += w.FIRST_TIME_EXPERIENCE;
    add("FIRST_TIME_EXPERIENCE", true, w.FIRST_TIME_EXPERIENCE, "first time for this owner");
  }
  if (typeof inputs.destination_rarity === "number" && inputs.destination_rarity > 0) {
    const d = clamp01(inputs.destination_rarity) * w.RARE_DESTINATION;
    score += d;
    add("RARE_DESTINATION", clamp01(inputs.destination_rarity), d, "unique destination, scaled by rarity");
  }
  if (inputs.trip_goal_match) {
    score += w.TRIP_GOAL_MATCH;
    add("TRIP_GOAL_MATCH", true, w.TRIP_GOAL_MATCH, "matches a stated trip goal");
  }
  if (typeof inputs.social_context_people === "number" && inputs.social_context_people > 0) {
    // Saturating: the fourth companion does not make an evening four times as
    // meaningful, and an unbounded head-count would let a large group dominate.
    const scaled = Math.min(1, inputs.social_context_people / 3);
    const d = scaled * w.SOCIAL_CONTEXT;
    score += d;
    add("SOCIAL_CONTEXT", inputs.social_context_people, d, "meaningful social context, saturating at 3 people");
  }
  if (typeof inputs.repeat_visit_count === "number" && inputs.repeat_visit_count > 0) {
    const scaled = Math.min(1, inputs.repeat_visit_count / 3);
    const d = scaled * w.REPEAT_VISIT;
    score += d;
    add("REPEAT_VISIT", inputs.repeat_visit_count, d, "a place the owner returns to");
  }
  if (typeof inputs.media_quality === "number" && inputs.media_quality > 0) {
    const q = clamp01(inputs.media_quality);
    const d = Math.min(q * w.MEDIA_QUALITY, MEDIA_QUALITY_MAX_CONTRIBUTION);
    score += d;
    add("MEDIA_QUALITY", q, d, `capped at ${MEDIA_QUALITY_MAX_CONTRIBUTION} so presentation cannot dominate (section 8)`);
    if (q * w.MEDIA_QUALITY > MEDIA_QUALITY_MAX_CONTRIBUTION) rules.push("MEDIA_QUALITY_CAP_APPLIED");
  }

  const raw = score;
  score = clamp01(score);
  if (raw > 1) rules.push("SCORE_CLAMPED_TO_1");

  const band: ConfidenceBand = inputs.confidence_band ?? "INSUFFICIENT";
  const userOriginated = Boolean(
    inputs.user_created || inputs.explicit_remember_intent || inputs.later_user_promotion || inputs.user_favorite,
  );

  // Section 8 thresholds. AUTO_PRIVATE demands very high confidence AND policy
  // eligibility; a high score alone is never enough to create without asking.
  let tier: SignificanceTier;
  if (score >= AUTO_PRIVATE_SCORE_THRESHOLD && band === "HIGH" && inputs.policy_eligible === true) {
    tier = "AUTO_PRIVATE";
  } else if (score >= SUGGESTED_SCORE_THRESHOLD) {
    tier = "SUGGESTED";
  } else {
    tier = "NO_CANDIDATE";
  }
  if (score >= AUTO_PRIVATE_SCORE_THRESHOLD && tier !== "AUTO_PRIVATE") {
    rules.push(
      band === "HIGH"
        ? "AUTO_PRIVATE_WITHHELD_POLICY_NOT_ELIGIBLE"
        : `AUTO_PRIVATE_WITHHELD_CONFIDENCE_${band}`,
    );
  }

  // Section 8 hard rule: explicit user intent outranks inferred significance.
  // A user-originated candidate is never NO_CANDIDATE, whatever the arithmetic.
  if (userOriginated && tier === "NO_CANDIDATE") {
    tier = "SUGGESTED";
    rules.push("USER_INTENT_FLOOR_APPLIED");
  }

  const neverDiscard = Boolean(inputs.user_created || inputs.explicit_remember_intent);
  if (neverDiscard) rules.push("USER_CREATED_NEVER_DISCARDED");

  return {
    score: Number(score.toFixed(6)),
    tier,
    confidence_band: band,
    contributions: contributions.sort((a, b) => b.delta - a.delta || a.code.localeCompare(b.code)),
    applied_rules: rules,
    never_discard: neverDiscard,
    policy_version: SIGNIFICANCE_POLICY_VERSION,
  };
}

/**
 * Section 8 / section 1 non-goal / census H64: significance is internal.
 *
 * This is the one place that decides whether a significance figure may cross a
 * boundary, so a projection cannot leak it by forgetting. Anything not owned by
 * the reader gets the tier stripped as well as the number: a tier is a coarse
 * score, and a coarse public score is still a public score.
 */
export const SIGNIFICANCE_FIELDS: readonly string[] = Object.freeze([
  "significance_score",
  "significance_tier",
  "significance_explanation",
]);

export function redactSignificanceForAudience<T extends Record<string, unknown>>(
  row: T,
  audience: "OWNER" | "NON_OWNER",
): Partial<T> {
  const copy: Record<string, unknown> = { ...row };
  if (audience === "NON_OWNER") {
    for (const field of SIGNIFICANCE_FIELDS) delete copy[field];
  }
  return copy as Partial<T>;
}
