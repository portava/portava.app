/**
 * Section 8 - significance, and the derivation of the number.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 8 (:295), section 1 non-goals (public scoring), 28.13.
 * CENSUS: H63, H64, H65, H66 NOT-BUILT; H67 BUILT-BUT-WRONG.
 *
 * A SCORER THAT RETURNS A CONSTANT PASSES AN EXAMPLE TEST. So this suite does
 * not check that a plausible number comes out. It checks:
 *
 *   * that the score MOVES with its inputs (distinctness), and moves the RIGHT
 *     WAY (monotonicity across every registered input);
 *   * that the explanation ADDS UP - the contributions sum to the score, so a
 *     number cannot be produced by one path and explained by another;
 *   * both sides of both thresholds, and each of the three AUTO_PRIVATE
 *     conditions failed independently;
 *   * that maxed media quality cannot buy significance (section 8's explicit
 *     prohibition), tested as an inequality against the threshold rather than
 *     against today's weight;
 *   * that a user-created Memory is never scored into oblivion.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memorySignificance.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_PRIVATE_SCORE_THRESHOLD,
  MEDIA_QUALITY_MAX_CONTRIBUTION,
  SIGNIFICANCE_INPUT_CODES,
  SUGGESTED_SCORE_THRESHOLD,
  redactSignificanceForAudience,
  scoreSignificance,
  type SignificanceInputs,
} from "../services/memoryProjections/significance.js";

/** One flag per registered input, so a new input cannot be forgotten here. */
const ONE_OF_EACH: Array<[string, SignificanceInputs]> = [
  ["EXPLICIT_REMEMBER_INTENT", { explicit_remember_intent: true }],
  ["USER_CREATED", { user_created: true }],
  ["LATER_USER_PROMOTION", { later_user_promotion: true }],
  ["USER_FAVORITE", { user_favorite: true }],
  ["USER_CAPTION", { user_caption: true }],
  ["FIRST_TIME_EXPERIENCE", { first_time_experience: true }],
  ["RARE_DESTINATION", { destination_rarity: 1 }],
  ["TRIP_GOAL_MATCH", { trip_goal_match: true }],
  ["SOCIAL_CONTEXT", { social_context_people: 3 }],
  ["REPEAT_VISIT", { repeat_visit_count: 3 }],
  ["MEDIA_QUALITY", { media_quality: 1 }],
];

describe("section 8: the score is not a constant", () => {
  it("nothing at all scores 0 and is NO_CANDIDATE", () => {
    const r = scoreSignificance({});
    assert.equal(r.score, 0);
    assert.equal(r.tier, "NO_CANDIDATE");
    assert.deepEqual(r.contributions, []);
  });

  it("each registered input moves the score off zero, by its own amount", () => {
    const seen = new Map<string, number>();
    for (const [name, inputs] of ONE_OF_EACH) {
      const r = scoreSignificance(inputs);
      assert.ok(r.score > 0, `${name} contributed nothing`);
      assert.equal(r.contributions.length, 1, `${name} produced ${r.contributions.length} contributions`);
      seen.set(name, r.score);
    }
    assert.equal(seen.size, SIGNIFICANCE_INPUT_CODES.length, "every registered input is exercised here");
    assert.ok(new Set(seen.values()).size > 1, "a scorer whose inputs all score the same is a constant in disguise");
  });

  it("is monotone: adding any single input never lowers the score", () => {
    const bases: SignificanceInputs[] = [
      {},
      { first_time_experience: true },
      { user_created: true, user_caption: true, social_context_people: 2 },
    ];
    for (const base of bases) {
      const before = scoreSignificance(base).score;
      for (const [name, extra] of ONE_OF_EACH) {
        const after = scoreSignificance({ ...base, ...extra }).score;
        assert.ok(after >= before, `${name} lowered the score from ${before} to ${after}`);
      }
    }
  });

  it("saturating inputs saturate rather than run away", () => {
    const three = scoreSignificance({ social_context_people: 3 }).score;
    const thirty = scoreSignificance({ social_context_people: 30 }).score;
    assert.equal(thirty, three, "a crowd is not ten times a dinner");
    const oneVsTwo = scoreSignificance({ social_context_people: 1 }).score;
    assert.ok(oneVsTwo < three, "but it does still scale below saturation");
  });

  it("the explanation adds up to the score, so the number cannot be produced elsewhere", () => {
    const inputs: SignificanceInputs = {
      explicit_remember_intent: true, first_time_experience: true, destination_rarity: 0.6,
      social_context_people: 2, user_caption: true, media_quality: 0.9, repeat_visit_count: 1,
    };
    const r = scoreSignificance(inputs);
    const sum = r.contributions.reduce((acc, c) => acc + c.delta, 0);
    // Each delta is reported to 6 decimal places, so seven contributions can
    // differ from the running total by up to 3.5e-6 of pure display rounding.
    // Anything larger means the score came from somewhere the explanation does
    // not mention, which is the defect this assertion exists to catch.
    assert.ok(Math.abs(sum - r.score) < 4e-6, `contributions sum to ${sum} but the score is ${r.score}`);
    for (const c of r.contributions) {
      assert.ok(c.note.length > 0, `${c.code} has no note`);
      assert.ok(c.weight > 0, `${c.code} has no weight`);
    }
    assert.equal(r.policy_version, "memory-significance@1");
  });

  it("a clamped score says it was clamped rather than quietly returning 1", () => {
    const r = scoreSignificance({
      explicit_remember_intent: true, user_created: true, later_user_promotion: true, user_favorite: true,
      user_caption: true, first_time_experience: true, destination_rarity: 1, trip_goal_match: true,
      social_context_people: 5, repeat_visit_count: 5, media_quality: 1,
    });
    assert.equal(r.score, 1);
    assert.ok(r.applied_rules.includes("SCORE_CLAMPED_TO_1"));
  });
});

describe("section 8: media quality must not dominate", () => {
  it("perfect media alone cannot reach even the suggestion threshold", () => {
    const r = scoreSignificance({ media_quality: 1 });
    assert.ok(r.score < SUGGESTED_SCORE_THRESHOLD, `beautiful photo scored ${r.score}`);
    assert.equal(r.tier, "NO_CANDIDATE");
  });

  it("the cap is smaller than the threshold as a matter of policy, not of arithmetic luck", () => {
    assert.ok(
      MEDIA_QUALITY_MAX_CONTRIBUTION < SUGGESTED_SCORE_THRESHOLD,
      "media quality could buy a suggestion on its own",
    );
    assert.ok(
      MEDIA_QUALITY_MAX_CONTRIBUTION * 5 < AUTO_PRIVATE_SCORE_THRESHOLD,
      "media quality is not within reach of automatic creation even with a bug elsewhere",
    );
  });

  it("media quality never outweighs one user signal", () => {
    const photogenic = scoreSignificance({ media_quality: 1 }).score;
    const cared = scoreSignificance({ user_caption: true }).score;
    assert.ok(cared >= photogenic, "a caption the owner wrote must weigh at least as much as a sharp photo");
  });
});

describe("section 8: thresholds, on both sides and condition by condition", () => {
  const qualifying: SignificanceInputs = {
    explicit_remember_intent: true, user_created: true, first_time_experience: true,
    destination_rarity: 1, confidence_band: "HIGH", policy_eligible: true,
  };

  it("the qualifying fixture really is AUTO_PRIVATE", () => {
    const r = scoreSignificance(qualifying);
    assert.ok(r.score >= AUTO_PRIVATE_SCORE_THRESHOLD, `score ${r.score}`);
    assert.equal(r.tier, "AUTO_PRIVATE");
  });

  it("drop the confidence band alone and it becomes a SUGGESTION, with the reason recorded", () => {
    const r = scoreSignificance({ ...qualifying, confidence_band: "MEDIUM" });
    assert.equal(r.tier, "SUGGESTED");
    assert.ok(r.applied_rules.includes("AUTO_PRIVATE_WITHHELD_CONFIDENCE_MEDIUM"));
  });

  it("drop policy eligibility alone and it becomes a SUGGESTION, with the reason recorded", () => {
    const r = scoreSignificance({ ...qualifying, policy_eligible: false });
    assert.equal(r.tier, "SUGGESTED");
    assert.ok(r.applied_rules.includes("AUTO_PRIVATE_WITHHELD_POLICY_NOT_ELIGIBLE"));
  });

  it("an unstated policy does not silently auto-create", () => {
    const { policy_eligible, ...withoutPolicy } = qualifying;
    void policy_eligible;
    assert.equal(scoreSignificance(withoutPolicy).tier, "SUGGESTED");
  });

  it("exactly at the suggestion threshold is SUGGESTED; a hair below is NO_CANDIDATE", () => {
    const at = scoreSignificance({ first_time_experience: true, destination_rarity: 1, trip_goal_match: true });
    assert.equal(at.score, SUGGESTED_SCORE_THRESHOLD);
    assert.equal(at.tier, "SUGGESTED");

    const below = scoreSignificance({ first_time_experience: true, destination_rarity: 0.99, trip_goal_match: true });
    assert.ok(below.score < SUGGESTED_SCORE_THRESHOLD, `${below.score}`);
    assert.equal(below.tier, "NO_CANDIDATE");
  });
});

describe("section 8: explicit user intent outranks inferred significance", () => {
  it("a low-scoring user favourite is floored to SUGGESTED, not discarded", () => {
    const r = scoreSignificance({ user_favorite: true });
    assert.ok(r.score < SUGGESTED_SCORE_THRESHOLD, "the arithmetic alone would drop this");
    assert.equal(r.tier, "SUGGESTED");
    assert.ok(r.applied_rules.includes("USER_INTENT_FLOOR_APPLIED"));
  });

  it("PAIRED - an inferred candidate with the same score IS dropped", () => {
    const r = scoreSignificance({ media_quality: 1, repeat_visit_count: 3, user_caption: false });
    assert.equal(r.tier, "NO_CANDIDATE", `the floor must not apply to inference: ${JSON.stringify(r)}`);
  });

  it("a user-created Memory is flagged never-discard even at the bottom of the range", () => {
    const r = scoreSignificance({ user_created: true });
    assert.equal(r.never_discard, true);
    assert.ok(r.applied_rules.includes("USER_CREATED_NEVER_DISCARDED"));
    assert.notEqual(r.tier, "NO_CANDIDATE");
  });

  it("an automatic candidate is not flagged never-discard", () => {
    assert.equal(scoreSignificance({ first_time_experience: true, media_quality: 1 }).never_discard, false);
  });
});

describe("section 8 / H64: significance is internal, never a public social score", () => {
  const row = {
    memory_id: "m1", title: "Dinner", significance_score: 0.82,
    significance_tier: "AUTO_PRIVATE", significance_explanation: { contributions: [] },
  };

  it("a non-owner audience gets no score, no tier and no explanation", () => {
    const out = redactSignificanceForAudience(row, "NON_OWNER") as Record<string, unknown>;
    assert.equal("significance_score" in out, false);
    assert.equal("significance_tier" in out, false, "a tier is a coarse score, and a coarse public score is still public");
    assert.equal("significance_explanation" in out, false);
    assert.equal(out.title, "Dinner", "the rest of the row survives");
  });

  it("the owner keeps their own score and its derivation", () => {
    const out = redactSignificanceForAudience(row, "OWNER") as Record<string, unknown>;
    assert.equal(out.significance_score, 0.82);
    assert.ok(out.significance_explanation);
  });

  it("redaction copies rather than mutating the caller's row", () => {
    redactSignificanceForAudience(row, "NON_OWNER");
    assert.equal(row.significance_score, 0.82);
  });
});
