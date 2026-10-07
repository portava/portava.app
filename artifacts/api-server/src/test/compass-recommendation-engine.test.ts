/**
 * Phase 7 — Formal Recommendation Engine tests.
 *
 * Covers:
 *   A. Community Score — viewer-independent popularity signal
 *   B. Compass Match — personal fit, grounded factors
 *   C. Independence — fit and popularity move independently
 *   D. Pipeline annotation — every passed candidate carries both scores +
 *      grounded factors; output is provably a subset of the input (the model
 *      can never inject candidates)
 *   E. Memory-derived preferences (Phase 6 bridge)
 *   F. "Why this?" text generation — grounded, privacy-safe
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeCommunityScore,
  computeCompassMatch,
  annotateCandidate,
  buildWhyThisText,
  normalizeProfileForRanking,
  presentableFactors,
  qualifyWhyThis,
  whyThisRestsOnEstimate,
  OPEN_NOW_FACTOR_LABEL,
  type RankingFactor,
} from "../compass/CompassRecommendationEngine.js";
import { nearbyNowText } from "../lib/discoveryReasonCodes.js";
import { runPipeline } from "../compass/CompassPipeline.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";

function profileFor(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return normalizeProfileForRanking({
    userId: USER_ID,
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    ...overrides,
  } as unknown as CompassProfile);
}

function contextFor(): CompassContext {
  return {
    contextState: "default",
    signals: {},
  } as unknown as CompassContext;
}

function item(overrides: Partial<CompassItem> = {}): CompassItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    type: "suggestion",
    ...overrides,
  } as CompassItem;
}

// ── A. Community Score ────────────────────────────────────────────────────────

describe("A. Community Score — viewer-independent popularity", () => {
  it("scores a highly rated, much-saved item far above an unknown one", () => {
    const popular = computeCommunityScore(item({ qualityScore: 9.6, savedCount: 90, authorTrustScore: 90 }));
    const unknown = computeCommunityScore(item({ qualityScore: 2, savedCount: 0, authorTrustScore: 30 }));
    assert.ok(popular > unknown + 30, `expected large gap, got ${popular} vs ${unknown}`);
  });

  it("is deterministic per item and never reads a profile", () => {
    const it1 = item({ id: "fixed", qualityScore: 8, savedCount: 20 });
    assert.equal(computeCommunityScore(it1), computeCommunityScore({ ...it1 }));
  });

  it("penalises reported and spam-flagged items", () => {
    const clean    = computeCommunityScore(item({ qualityScore: 8, savedCount: 20 }));
    const reported = computeCommunityScore(item({ qualityScore: 8, savedCount: 20, reportCount: 5, isSpam: true } as any));
    assert.ok(reported < clean, "community-negative signals must lower the score");
  });

  it("stays within 0–100", () => {
    assert.ok(computeCommunityScore(item({ qualityScore: 100, savedCount: 1e9, authorTrustScore: 1000 } as any)) <= 100);
    assert.ok(computeCommunityScore(item({ qualityScore: -5, reportCount: 99, isSpam: true } as any)) >= 0);
  });
});

// ── B. Compass Match ──────────────────────────────────────────────────────────

describe("B. Compass Match — personal fit with grounded factors", () => {
  it("rewards interest, city, and budget alignment with matching factors", () => {
    const profile = profileFor({
      travelStyles: ["food", "nightlife"],
      currentCity: "Cebu",
      budgetStyle: "budget",
    });
    const good = computeCompassMatch(
      item({ interestTags: ["food", "budget"], city: "Cebu" }),
      profile,
    );
    const bad = computeCompassMatch(
      item({ interestTags: ["luxury", "golf"], city: "Oslo" }),
      profile,
    );
    assert.ok(good.score > bad.score, `fit item must outrank misfit (${good.score} vs ${bad.score})`);

    const keys = good.factors.map((f) => f.key);
    assert.ok(keys.includes("interest_match"), "interest factor must be present");
    assert.ok(keys.includes("city_match"), "city factor must be present");
    const interest = good.factors.find((f) => f.key === "interest_match")!;
    assert.ok(interest.detail?.includes("food"), "factor detail must name the actual matched tag");
  });

  it("every factor is grounded — no factor fires without its signal", () => {
    const { factors } = computeCompassMatch(item({}), profileFor());
    // Bare item + bare profile: no positive personal signal → no factors
    assert.deepEqual(factors, []);
  });

  it("ignores popularity entirely", () => {
    const profile = profileFor({ travelStyles: ["food"] });
    const plain   = computeCompassMatch(item({ interestTags: ["food"] }), profile);
    const popular = computeCompassMatch(item({ interestTags: ["food"], qualityScore: 10, savedCount: 500, authorTrustScore: 99 }), profile);
    assert.equal(plain.score, popular.score, "Compass Match must not move with popularity signals");
  });

  it("applies feedback history (category weights) as prior outcomes", () => {
    const liked = computeCompassMatch(
      item({ interestTags: ["food"] }),
      profileFor({ categoryWeights: { food: 5 } }),
    );
    const neutral = computeCompassMatch(item({ interestTags: ["food"] }), profileFor());
    assert.ok(liked.score > neutral.score);
    assert.ok(liked.factors.some((f) => f.key === "history"));
  });

  it("rewards distance, open-now, availability, and time relevance", () => {
    const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
    const r = computeCompassMatch(
      item({
        type: "event",
        distanceKm: 0.5,
        isOpenNow: true,
        capacity: 20,
        currentAttendees: 5,
        eventStartsAt: soon,
      } as any),
      profileFor(),
    );
    const keys = r.factors.map((f) => f.key);
    for (const k of ["distance", "open_now", "availability", "time_relevance"]) {
      assert.ok(keys.includes(k), `expected factor ${k}, got ${keys.join(",")}`);
    }
  });
});

// ── C. Independence ───────────────────────────────────────────────────────────

describe("C. Compass Match and Community Score are independent", () => {
  it("popular-but-misfit vs fit-but-unknown produce opposite signals", () => {
    const profile = profileFor({ travelStyles: ["hiking"], currentCity: "Cebu" });

    const popularMisfit = annotateCandidate(
      item({ interestTags: ["casino"], city: "Oslo", qualityScore: 9.8, savedCount: 200, authorTrustScore: 95 }),
      profile,
    );
    const fitUnknown = annotateCandidate(
      item({ interestTags: ["hiking"], city: "Cebu", qualityScore: 1, savedCount: 0, authorTrustScore: 25 }),
      profile,
    );

    assert.ok(popularMisfit.communityScore > fitUnknown.communityScore, "popularity signal");
    assert.ok(fitUnknown.compassMatch > popularMisfit.compassMatch, "personal-fit signal");
  });
});

// ── D. Pipeline annotation — candidates provably pipeline-sourced ─────────────

describe("D. Pipeline carries both scores and cannot emit un-sourced candidates", () => {
  it("annotates every passed result and returns a strict subset of the input", async () => {
    const profile = profileFor({ travelStyles: ["food"], currentCity: "Cebu" });
    const inputs = [
      item({ id: "in-1", interestTags: ["food"], city: "Cebu", qualityScore: 8, savedCount: 10 }),
      item({ id: "in-2", interestTags: ["golf"], city: "Oslo" }),
    ];
    const summary = await runPipeline(inputs, profile, contextFor(), null);

    const inputIds = new Set(inputs.map((i) => String(i.id)));
    for (const r of summary.results) {
      assert.ok(inputIds.has(String(r.item.id)), "pipeline output must be a subset of its input — nothing can be injected");
      assert.equal(typeof r.compassMatch, "number");
      assert.equal(typeof r.communityScore, "number");
      assert.ok(Array.isArray(r.rankingFactors));
      assert.ok(r.compassMatch >= 0 && r.compassMatch <= 100);
      assert.ok(r.communityScore >= 0 && r.communityScore <= 100);
    }
    assert.ok(summary.results.length > 0, "candidates should pass");
  });

  it("factors attached by the pipeline reflect the item's actual signals", async () => {
    const profile = profileFor({ travelStyles: ["food"], currentCity: "Cebu" });
    const summary = await runPipeline(
      [item({ id: "in-1", interestTags: ["food"], city: "Cebu" })],
      profile, contextFor(), null,
    );
    const r = summary.results[0]!;
    const keys = r.rankingFactors.map((f) => f.key);
    assert.ok(keys.includes("interest_match") && keys.includes("city_match"));
  });
});

// ── E. Memory-derived preferences ─────────────────────────────────────────────

describe("E. Phase 6 memory-derived preferences influence ranking (bounded)", () => {
  it("boosts items matching remembered preferences, with a memory factor", () => {
    const profile = profileFor();
    const memoryTags = new Set(["snorkeling", "seafood"]);

    const withMemory = computeCompassMatch(item({ interestTags: ["snorkeling"] }), profile, memoryTags);
    const without    = computeCompassMatch(item({ interestTags: ["snorkeling"] }), profile);

    assert.ok(withMemory.score > without.score);
    const mem = withMemory.factors.find((f) => f.key === "memory_preference");
    assert.ok(mem, "memory factor must be present");
    assert.ok(mem!.detail?.includes("snorkeling"), "memory factor must cite the matched preference");
  });

  it("memory boost on finalScore is bounded (≤5)", () => {
    const a = annotateCandidate(item({ interestTags: ["snorkeling"] }), profileFor(), new Set(["snorkeling"]));
    assert.ok(a.memoryBoost > 0 && a.memoryBoost <= 5);
    const none = annotateCandidate(item({ interestTags: ["snorkeling"] }), profileFor());
    assert.equal(none.memoryBoost, 0);
  });
});

// ── F. "Why this?" text ───────────────────────────────────────────────────────

describe("F. Why-this text is grounded and privacy-safe", () => {
  it("builds a sentence from the strongest real factors", () => {
    const factors: RankingFactor[] = [
      { key: "interest_match", label: "Matches your interests", weight: 0.9, detail: "food" },
      { key: "city_match",     label: "In your current city",   weight: 1,   detail: "Cebu" },
      { key: "open_now",       label: "Open right now",         weight: 1 },
      { key: "distance",       label: "Close to you",           weight: 0.2 },
    ];
    const text = buildWhyThisText(factors)!;
    assert.ok(text.toLowerCase().includes("in your current city"));
    assert.ok(text.includes("Cebu"), "detail grounding must appear");
  });

  it("returns null with no presentable factors (caller falls back to template)", () => {
    assert.equal(buildWhyThisText([]), null);
    assert.equal(buildWhyThisText([{ key: "spam", label: "flagged", weight: 1 }]), null);
  });

  it("never surfaces sensitive moderation factors", () => {
    const text = buildWhyThisText([
      { key: "risk",           label: "risky content downranked", weight: 1 },
      { key: "interest_match", label: "Matches your interests",   weight: 0.5 },
    ])!;
    assert.ok(!text.toLowerCase().includes("risk"), "moderation signals must never surface");
  });
});

// ── G. Lead ruling D-67: open-now from listed hours is an estimate, never live ──

describe("G. D-67 — the open-now factor is a listed-hours estimate wherever it is shown", () => {
  const LIVE_WORDING = /\bright now\b|\baround now\b|\bverified\b|\blive\b/i;

  it("the factor says it is an estimate from listed hours, not that the place is open right now", () => {
    const r = computeCompassMatch(item({ isOpenNow: true } as any), profileFor());
    const f = r.factors.find((x) => x.key === "open_now");
    assert.ok(f, "open_now still contributes");
    assert.equal(f!.label, OPEN_NOW_FACTOR_LABEL);
    assert.match(f!.label, /listed hours/i);
    assert.match(f!.label, /estimate/i);
    assert.doesNotMatch(f!.label, LIVE_WORDING);
  });

  it("a factor stored before D-67 as \"Open right now\" is re-worded when read, in the payload and the sentence", () => {
    const stored: RankingFactor[] = [
      { key: "open_now", label: "Open right now", weight: 1 },
      { key: "interest_match", label: "Matches your interests", weight: 0.9, detail: "food" },
    ];
    assert.equal(presentableFactors(stored).find((x) => x.key === "open_now")!.label, OPEN_NOW_FACTOR_LABEL);
    const text = buildWhyThisText(stored)!;
    assert.match(text, /per its listed hours \(estimate\)/);
    assert.doesNotMatch(text, /right now/i);
  });

  it("an explanation resting on the estimate is never presented as an observation by qualifyWhyThis", () => {
    const factors: RankingFactor[] = [{ key: "open_now", label: OPEN_NOW_FACTOR_LABEL, weight: 1 }];
    const text = buildWhyThisText(factors)!;
    assert.equal(whyThisRestsOnEstimate(factors), true);
    for (const cls of ["observed", "corroborated", null] as const) {
      assert.equal(qualifyWhyThis(text, cls, { restsOnEstimate: true }), `${text} (inferred)`, `class ${cls}`);
    }
    // A class that is already not an observation keeps its own, weaker word.
    assert.equal(qualifyWhyThis(text, "stale", { restsOnEstimate: true }), `${text} (stale)`);
    // Without the estimate, an observed explanation is unchanged (CPV2-02 behaviour).
    assert.equal(qualifyWhyThis("Recommended for you: matches your interests.", "observed"), "Recommended for you: matches your interests.");
  });

  it("only a sentence that includes the estimate is qualified by it — the same top-three selection buildWhyThisText makes", () => {
    const heavy: RankingFactor[] = [
      { key: "interest_match", label: "Matches your interests", weight: 3 },
      { key: "city_match", label: "In your current city", weight: 3 },
      { key: "history", label: "Like places you saved", weight: 3 },
      { key: "open_now", label: OPEN_NOW_FACTOR_LABEL, weight: 1 },
    ];
    assert.doesNotMatch(buildWhyThisText(heavy)!, /listed hours/);
    assert.equal(whyThisRestsOnEstimate(heavy), false);
    const light = heavy.slice(1);
    assert.match(buildWhyThisText(light)!, /listed hours/);
    assert.equal(whyThisRestsOnEstimate(light), true);
  });

  it("the Discovery reason built on open_now says listed hours and estimate, and never 'around now'", () => {
    for (const fired of [["open_now"], ["distance", "open_now"], ["cityMatch", "open_now"]]) {
      const t = nearbyNowText(fired)!;
      assert.match(t, /listed hours/i, fired.join("+"));
      assert.match(t, /estimate/i, fired.join("+"));
      assert.doesNotMatch(t, LIVE_WORDING, fired.join("+"));
    }
  });
});
