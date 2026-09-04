/**
 * §13 TemporaryIntent — the addend, and its arrival in the ranker.
 *
 * Three things this file holds:
 *   1. The parse/expiry contract: a stale or malformed intent NEVER reaches
 *      ranking (fail-closed), whatever the sending client's clock claimed.
 *   2. The match is defensible: "Matches current Party intent" is only claimed
 *      on a genuine tag overlap, not a weak type-only affinity.
 *   3. The addend actually reaches CompassScoringEngine and CHANGES ORDER — the
 *      whole point of Table 9's `+`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_BOOST_MAX,
  MAP_INTENT_KINDS,
  MAP_INTENT_LABELS,
  intentBoost,
  intentMatchFraction,
  isMapIntentKind,
  itemMatchesIntent,
  parseTemporaryIntent,
  type TemporaryIntentContext,
} from "../compass/CompassTemporaryIntent.js";
import { scoreItem } from "../compass/CompassScoringEngine.js";
import type { CompassItem, CompassContext, CompassProfile } from "../compass/types.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function profile(): CompassProfile {
  return {
    userId: "u1",
    travelStyles: [],
    currentCity: "Da Nang",
    preferredCities: [],
    preferredLanguages: [],
    socialStyle: null,
    safetyPreference: "standard",
  } as unknown as CompassProfile;
}

function context(intent?: TemporaryIntentContext | null): CompassContext {
  return {
    contextState: "normal",
    signals: {},
    computedAt: new Date(NOW).toISOString(),
    ...(intent ? { temporaryIntent: intent } : {}),
  } as unknown as CompassContext;
}

function item(over: Partial<CompassItem> & Record<string, unknown> = {}): CompassItem {
  return { id: "i1", type: "place", city: "Da Nang", ...over } as CompassItem;
}

// ── A. Vocabulary parity with the client (§13) ────────────────────────────────

describe("§13 intent vocabulary", () => {
  it("is exactly the nine primary intents, in the spec's order", () => {
    assert.deepEqual([...MAP_INTENT_KINDS], [
      "bored", "eat", "party", "explore",
      "meet_people", "date_night", "chill", "local", "surprise_me",
    ]);
  });

  it("labels every kind", () => {
    for (const k of MAP_INTENT_KINDS) {
      assert.equal(typeof MAP_INTENT_LABELS[k], "string");
      assert.ok(MAP_INTENT_LABELS[k].length > 0, `${k} needs a label`);
    }
  });

  it("recognises only the nine kinds", () => {
    assert.equal(isMapIntentKind("eat"), true);
    assert.equal(isMapIntentKind("dinner"), false);
    assert.equal(isMapIntentKind(42), false);
  });
});

// ── B. Parse + fail-closed expiry re-check ────────────────────────────────────

describe("parseTemporaryIntent — fail-closed on a client clock", () => {
  it("returns null for an absent or off-vocabulary intent", () => {
    assert.equal(parseTemporaryIntent(undefined, NOW), null);
    assert.equal(parseTemporaryIntent({}, NOW), null);
    assert.equal(parseTemporaryIntent({ intent: "dinner" }, NOW), null);
  });

  it("parses a valid intent and clamps the two sliders", () => {
    const ctx = parseTemporaryIntent({ intent: "party", intentEnergy: 1.7, intentNovelty: -3 }, NOW);
    assert.equal(ctx?.kind, "party");
    assert.equal(ctx?.energy, 1, "energy clamps to [0,1]");
    assert.equal(ctx?.novelty, 0, "novelty clamps to [0,1]");
  });

  it("defaults missing sliders to the neutral midpoint", () => {
    const ctx = parseTemporaryIntent({ intent: "eat" }, NOW)!;
    assert.equal(ctx.energy, 0.5);
    assert.equal(ctx.novelty, 0.5);
  });

  it("fails closed on an EXPIRED horizon — a stale mood never reaches ranking", () => {
    const past = new Date(NOW - 60_000).toISOString();
    assert.equal(parseTemporaryIntent({ intent: "eat", intentExpiresAt: past }, NOW), null);
  });

  it("fails closed on an unparseable horizon", () => {
    assert.equal(parseTemporaryIntent({ intent: "eat", intentExpiresAt: "not-a-date" }, NOW), null);
  });

  it("accepts a live, unexpired horizon", () => {
    const future = new Date(NOW + 60 * 60_000).toISOString();
    const ctx = parseTemporaryIntent({ intent: "eat", intentExpiresAt: future }, NOW);
    assert.equal(ctx?.kind, "eat");
    assert.equal(ctx?.expiresAt, future);
  });

  it("accepts a well-formed intent with no horizon at all", () => {
    const ctx = parseTemporaryIntent({ intent: "chill" }, NOW);
    assert.equal(ctx?.kind, "chill");
    assert.equal(ctx?.expiresAt, null);
  });
});

// ── C. Match: strong (tag) vs weak (type-only) ────────────────────────────────

describe("intent match — the 'Matches current intent' claim is defensible", () => {
  const eat = parseTemporaryIntent({ intent: "eat" }, NOW)!;
  const party = parseTemporaryIntent({ intent: "party" }, NOW)!;
  const surprise = parseTemporaryIntent({ intent: "surprise_me" }, NOW)!;

  it("claims a match on a genuine tag overlap", () => {
    assert.equal(itemMatchesIntent(item({ category: "restaurant" }), eat), true);
    assert.equal(itemMatchesIntent(item({ type: "event", category: "nightlife dance party" }), party), true);
  });

  it("does NOT claim a match on a weak type-only affinity", () => {
    // A generic place is type-affine to `eat` (eat favours places) but has no
    // food tag — it earns a small boost, but never the "matches" claim.
    const generic = item({ category: "museum" });
    assert.equal(itemMatchesIntent(generic, eat), false);
    assert.ok(intentMatchFraction(generic, eat) > 0, "a type affinity still earns some boost");
    assert.ok(intentMatchFraction(generic, eat) < intentMatchFraction(item({ category: "restaurant" }), eat));
  });

  it("serves surprise_me from hidden gems", () => {
    assert.equal(itemMatchesIntent(item({ type: "hidden_gem" }), surprise), true);
    assert.equal(itemMatchesIntent(item({ type: "place", category: "restaurant" }), surprise), false);
  });

  it("keeps the boost within [0, INTENT_BOOST_MAX] and 0 without an intent", () => {
    assert.equal(intentBoost(item({ category: "restaurant" }), null), 0);
    const b = intentBoost(item({ category: "restaurant" }), eat);
    assert.ok(b > 0 && b <= INTENT_BOOST_MAX, `boost ${b} out of band`);
  });
});

// ── D. The addend reaches the ranker and CHANGES ORDER ────────────────────────

describe("the intent addend reaches CompassScoringEngine and reorders", () => {
  // Two places, identical in every scored dimension EXCEPT their category, so
  // their base scores are equal and only the intent can separate them.
  const restaurant = item({ id: "resto", category: "restaurant" });
  const museum = item({ id: "museum", category: "museum" });

  it("scores them equal with no intent in context", () => {
    const a = scoreItem(restaurant, profile(), context()).finalScore;
    const b = scoreItem(museum, profile(), context()).finalScore;
    assert.equal(a, b, "with no intent, category must not affect the score");
  });

  it("lifts the intent-matched item above the other under an eat intent", () => {
    const eat = parseTemporaryIntent({ intent: "eat" }, NOW)!;
    const a = scoreItem(restaurant, profile(), context(eat)).finalScore;
    const b = scoreItem(museum, profile(), context(eat)).finalScore;
    assert.ok(a > b, `expected the restaurant (${a}) to outrank the museum (${b}) under an eat intent`);
  });

  it("adds a visible, bounded boost to the matched item vs no intent", () => {
    const eat = parseTemporaryIntent({ intent: "eat" }, NOW)!;
    const without = scoreItem(restaurant, profile(), context()).finalScore;
    const withIntent = scoreItem(restaurant, profile(), context(eat)).finalScore;
    assert.ok(withIntent > without, "a matched item scores higher with the intent than without");
    assert.ok(withIntent <= 100, "the 0–100 contract still holds after the addend");
  });

  it("surfaces the boost as a named score component", () => {
    const eat = parseTemporaryIntent({ intent: "eat" }, NOW)!;
    const res = scoreItem(restaurant, profile(), context(eat));
    assert.ok(res.components.temporaryIntentBoost > 0);
    const none = scoreItem(restaurant, profile(), context());
    assert.equal(none.components.temporaryIntentBoost, 0);
  });
});
