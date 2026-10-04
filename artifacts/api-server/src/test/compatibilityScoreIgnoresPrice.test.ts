/**
 * compatibilityScoreIgnoresPrice.test.ts
 *
 * OWNER RULING, 2026-10-04:
 *
 *   "A buddy's list price must not influence `calculateCompatibilityScore` or
 *    the default ordering in `/rent-a-buddy/match`. Keep price visible. Any
 *    existing traveller-selected price filter or sort must stay separate from
 *    the compatibility score."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT WAS THERE
 * ══════════════════════════════════════════════════════════════════════════════
 * `budget` carried **weight 10 of 100**: a buddy inside the traveller's stated
 * range scored 100, cheaper 60, dearer fell away to 10. `prefMatch` (weight 2)
 * additionally read whether a half-day or full-day rate had been PUBLISHED. The
 * result ordered `POST /rent-a-buddy/match`, so a buddy's own price moved them
 * up or down the list a traveller sees.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS ARE SHAPED THIS WAY
 * ══════════════════════════════════════════════════════════════════════════════
 * A test that asserts "the budget term is gone" passes the moment someone
 * renames it. These assert the PROPERTY the owner ruled on instead: vary a
 * buddy's price and nothing else, and neither the score nor the rank may move.
 *
 * The price fields were removed from `BuddyScoringData` outright, so the scorer
 * is not merely ignoring a price — it is never given one. The helpers below
 * still force a price in at RUNTIME, via `Object.assign` rather than a cast, so
 * the fixture stays honest to the type while proving the stronger claim: the
 * score is unmoved even when a price IS present, which is what survives someone
 * re-adding the field later. No `any`, no `@ts-expect-error`: `typecheck:tests`
 * exists to stop fixtures describing shapes production never emits, and this
 * suite must not be the exception that blunts it.
 *
 * Every case carries a CONTROL, because "price changes nothing" is also true of
 * a scorer that has stopped working. A test suite that only ever proves absence
 * cannot tell the two apart.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCompatibilityScore,
  rankBuddies,
  type BuddyScoringData,
  type MatchPreferences,
  type ScoredBuddy,
} from "../services/rentBuddy/CompatibilityScoreService.js";

/** A plain, eligible buddy. Everything that is not under test is held equal. */
function buddy(id: string, over: Partial<BuddyScoringData> = {}): BuddyScoringData {
  return {
    buddyProfileId: id,
    buddyUserId: `u-${id}`,
    city: "Lisbon",
    categories: ["food"],
    languages: ["en"],
    vibeTagsList: ["relaxed"],
    energyType: "calm",
    buddyLevel: "pro",
    averageRating: 4.5,
    reviewCount: 20,
    completedBookings: 10,
    responseTimeH: 2,
    verified: true,
    featured: false,
    cityAmbassador: false,
    availableNow: true,
    femaleOnlyService: false,
    publicMeetupOnly: false,
    groupApproved: true,
    nightlifeApproved: true,
    arrivalApproved: true,
    categoryApprovals: { food: true },
    trustScore: 70,
    maxGroupSize: 4,
    newBuddyPublicOnly: false,
    newBuddyDaytimeOnly: false,
    riskHold: false,
    adminStatus: "active",
    status: "active",
    ...over,
  };
}

const prefs = (over: Partial<MatchPreferences> = {}): MatchPreferences => ({
  need: "food", vibe: "relaxed", language: "en", ...over,
});

/** Force a price onto the value at runtime. See the header for why not a cast. */
function withPrice(b: BuddyScoringData, price: Record<string, number | null>): BuddyScoringData {
  const copy: BuddyScoringData = { ...b };
  Object.assign(copy, price);
  return copy;
}

/** The same, for the traveller's stated budget on the preference object. */
function withBudget(p: MatchPreferences, budget: Record<string, number>): MatchPreferences {
  const copy: MatchPreferences = { ...p };
  Object.assign(copy, budget);
  return copy;
}

describe("the owner's ruling: a buddy's list price cannot move their score", () => {
  it("an hourly rate of 5 and of 500 produce the SAME score", () => {
    const cheap = calculateCompatibilityScore(withPrice(buddy("b1"), { hourlyRateUsd: 5 }), prefs());
    const dear  = calculateCompatibilityScore(withPrice(buddy("b1"), { hourlyRateUsd: 500 }), prefs());
    assert.equal(cheap.score, dear.score,
      "a hundredfold price difference changed the compatibility score");
    assert.deepEqual(cheap.scoreBreakdown, dear.scoreBreakdown,
      "no component of the breakdown may differ on price alone");
  });

  it("the traveller's stated budget cannot move it either — in or out of range", () => {
    // Under the old term this was the strongest signal available: weight 10,
    // 100 inside the range against 10 for well outside it.
    const inRange  = calculateCompatibilityScore(withPrice(buddy("b1"), { hourlyRateUsd: 30 }),
      withBudget(prefs(), { budgetMinUsd: 20, budgetMaxUsd: 40 }));
    const outRange = calculateCompatibilityScore(withPrice(buddy("b1"), { hourlyRateUsd: 400 }),
      withBudget(prefs(), { budgetMinUsd: 20, budgetMaxUsd: 40 }));
    const noBudget = calculateCompatibilityScore(buddy("b1"), prefs());
    assert.equal(inRange.score, outRange.score, "budget fit still moved the score");
    assert.equal(inRange.score, noBudget.score,
      "stating a budget at all changed the score");
  });

  it("publishing a half-day or full-day rate cannot move it", () => {
    const none = calculateCompatibilityScore(buddy("b1"), prefs({ bookingLength: "half_day" }));
    const half = calculateCompatibilityScore(
      withPrice(buddy("b1"), { halfDayRateUsd: 120, fullDayRateUsd: 200 }),
      prefs({ bookingLength: "half_day" }));
    assert.equal(none.score, half.score,
      "whether a buddy published a half-day rate still moved the score");
  });

  it("`budget` is not a scored component at all", () => {
    const r = calculateCompatibilityScore(buddy("b1"), prefs());
    assert.equal(Object.hasOwn(r.scoreBreakdown, "budget"), false,
      "the breakdown still reports a budget component");
  });

  it("CONTROL — the scorer still discriminates on everything it is allowed to", () => {
    // Without this, every assertion above is also satisfied by a scorer that
    // returns a constant.
    const onLanguage = calculateCompatibilityScore(buddy("b1", { languages: ["pt"] }), prefs());
    const matching   = calculateCompatibilityScore(buddy("b1"), prefs());
    assert.notEqual(onLanguage.score, matching.score,
      "a language mismatch no longer moves the score — the scorer is inert");
    assert.ok(matching.score > 0 && matching.score <= 100, "score out of range");
  });
});

describe("the owner's ruling: price cannot move the default rank", () => {
  const rank = (data: BuddyScoringData[], p: MatchPreferences = prefs()) => {
    const scored: ScoredBuddy[] = data.map((b) => calculateCompatibilityScore(b, p));
    const map = new Map(data.map((b) => [b.buddyProfileId, b]));
    return rankBuddies(scored, map).map((s) => s.buddyProfileId);
  };

  it("making the cheapest buddy the dearest does not reorder the list", () => {
    // Identical on every ranked dimension; only price differs between runs.
    const base = [buddy("a"), buddy("b"), buddy("c")];
    const cheapFirst = [
      withPrice(base[0], { hourlyRateUsd: 10 }),
      withPrice(base[1], { hourlyRateUsd: 50 }),
      withPrice(base[2], { hourlyRateUsd: 90 }),
    ];
    const reversed = [
      withPrice(base[0], { hourlyRateUsd: 90 }),
      withPrice(base[1], { hourlyRateUsd: 50 }),
      withPrice(base[2], { hourlyRateUsd: 10 }),
    ];
    assert.deepEqual(rank(cheapFirst), rank(reversed),
      "reversing the price order changed the order buddies are shown in");
  });

  it("a buddy priced far outside the traveller's budget is not demoted", () => {
    const p = withBudget(prefs(), { budgetMinUsd: 20, budgetMaxUsd: 40 });
    const withinAll = [
      withPrice(buddy("a"), { hourlyRateUsd: 25 }),
      withPrice(buddy("b"), { hourlyRateUsd: 30 }),
    ];
    const oneWayOut = [
      withPrice(buddy("a"), { hourlyRateUsd: 25 }),
      withPrice(buddy("b"), { hourlyRateUsd: 900 }),
    ];
    assert.deepEqual(rank(withinAll, p), rank(oneWayOut, p),
      "pricing a buddy outside the stated budget moved them in the list");
  });

  it("CONTROL — the ranker still orders on what it is allowed to", () => {
    // Featured ranks ahead of not-featured: if this stops holding, the two
    // assertions above are being satisfied by a ranker that no longer sorts.
    const ordered = rank([buddy("plain"), buddy("star", { featured: true })]);
    assert.deepEqual(ordered, ["star", "plain"],
      "featured no longer ranks first — the ranker is inert");
  });
});
