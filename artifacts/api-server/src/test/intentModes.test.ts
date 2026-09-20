/**
 * census-compass CX-02 — Sensing §8 `:137`: "Support intent modes using the
 * same shared intelligence: Right Now, Tonight, Explore, Quiet, Social, High
 * Energy, Nearby, Trip."
 *
 * Before this suite three intent vocabularies existed and none was pinned as
 * the eight: lib/compassDecision's four decision intents, Map §13's nine
 * request-scoped kinds, and Compass's nine derived context modes — while the
 * eight themselves sat one directory away on Discovery's live ranker,
 * unshared. lib/intentModes is now the one home; this pins the eight in the
 * spec's order, the totality of the three maps, that Discovery reads the same
 * table, and that every cross-vocabulary value is a member of the vocabulary
 * it points into.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 a mode dropped from INTENT_MODES                           → red
 *   M2 INTENT_MODE_TO_DECISION_INTENT.quiet → "social"            → GREEN here (Discovery reads the same
 *      table, so a wrong value is consistently wrong) and RED in
 *      compassPlatformChain.test.ts's ask cases (2 red), where the mode meets
 *      the shared engine over a busy place. Stated rather than hidden.
 *   M3 a feed-section target misspelled                            → red
 *   M4 parseIntentMode stops lower-casing                          → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intentModes.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTENT_MODES,
  INTENT_MODE_LABELS,
  INTENT_MODE_TO_DECISION_INTENT,
  INTENT_MODE_TO_FEED_SECTION,
  LAYOVER_CHIP_TO_MODE,
  MAP_INTENT_TO_MODE,
  isIntentMode,
  parseIntentMode,
} from "../lib/intentModes.js";
import { DECISION_INTENTS } from "../lib/compassDecision.js";
import { DISCOVERY_INTENT_MODES, INTENT_MODE_PROFILES, intentForMode } from "../lib/discoveryLiveRank.js";
import { parseIntentMode as discoveryParse } from "../lib/discoveryLiveRankRead.js";
import { LAYOVER_INTENT_BY_CHIP, intentFromVibeChips } from "../lib/layoverLiveIntersection.js";
import { MAP_INTENT_KINDS } from "../compass/CompassTemporaryIntent.js";
import { SECTION_NAMES } from "../compass/CompassFeedBuilder.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("A. the eight, once", () => {
  it("are exactly the spec's eight, in the spec's order", () => {
    assert.deepEqual([...INTENT_MODES], ["right_now", "tonight", "explore", "quiet", "social", "high_energy", "nearby", "trip"]);
    assert.deepEqual(Object.values(INTENT_MODE_LABELS), ["Right Now", "Tonight", "Explore", "Quiet", "Social", "High Energy", "Nearby", "Trip"]);
  });

  it("the four decision intents are pinned too (they were unpinned), and each is one of the eight", () => {
    assert.deepEqual([...DECISION_INTENTS], ["quiet", "social", "high_energy", "explore"]);
    for (const d of DECISION_INTENTS) assert.ok(isIntentMode(d), d);
  });

  it("Discovery's DISCOVERY_INTENT_MODES IS the shared list, not a copy", () => {
    assert.strictEqual(DISCOVERY_INTENT_MODES, INTENT_MODES);
    const src = readFileSync(join(SRC, "lib", "discoveryLiveRank.ts"), "utf8");
    assert.doesNotMatch(src, /"right_now",\s*"tonight",\s*"explore"/, "a second spelling of the eight survives in discoveryLiveRank");
  });
});

describe("B. totality — a null is an entry, an absent key is a bug", () => {
  it("every mode has a decision-intent entry and it is a decision intent or null", () => {
    for (const m of INTENT_MODES) {
      assert.ok(m in INTENT_MODE_TO_DECISION_INTENT, m);
      const d = INTENT_MODE_TO_DECISION_INTENT[m];
      assert.ok(d === null || (DECISION_INTENTS as readonly string[]).includes(d), `${m} → ${d}`);
    }
    assert.equal(Object.keys(INTENT_MODE_TO_DECISION_INTENT).length, 8);
    // The four that have no crowd preference say so rather than guessing one.
    assert.deepEqual(INTENT_MODES.filter((m) => INTENT_MODE_TO_DECISION_INTENT[m] === null), ["right_now", "tonight", "nearby", "trip"]);
  });

  it("every Map §13 kind maps onto one of the eight or to nothing — and the keys are the nine kinds verbatim", () => {
    assert.deepEqual(Object.keys(MAP_INTENT_TO_MODE).sort(), [...MAP_INTENT_KINDS].sort());
    for (const [k, v] of Object.entries(MAP_INTENT_TO_MODE)) assert.ok(v === null || isIntentMode(v), `${k} → ${v}`);
    assert.equal(MAP_INTENT_TO_MODE.party, "high_energy");
    assert.equal(MAP_INTENT_TO_MODE.chill, "quiet");
    assert.equal(MAP_INTENT_TO_MODE.local, "nearby");
    assert.equal(MAP_INTENT_TO_MODE.eat, null);
  });

  it("every feed-section target is a real section name, and the two that were coincidences are now stated", () => {
    assert.equal(Object.keys(INTENT_MODE_TO_FEED_SECTION).length, 8);
    for (const [m, sec] of Object.entries(INTENT_MODE_TO_FEED_SECTION)) {
      assert.ok(sec === null || (SECTION_NAMES as readonly string[]).includes(sec), `${m} → ${sec}`);
    }
    assert.equal(INTENT_MODE_TO_FEED_SECTION.tonight, "tonight");
    assert.equal(INTENT_MODE_TO_FEED_SECTION.nearby, "near_your_area");
  });
});

describe("C. one table, read by every consumer", () => {
  it("Discovery's per-mode profile intent and intentForMode agree with the shared map for all eight", () => {
    for (const m of INTENT_MODES) {
      assert.equal(INTENT_MODE_PROFILES[m].intent, INTENT_MODE_TO_DECISION_INTENT[m], m);
      assert.equal(intentForMode(m), INTENT_MODE_TO_DECISION_INTENT[m], m);
    }
  });

  it("Discovery's parser is the shared parser", () => {
    assert.strictEqual(discoveryParse, parseIntentMode);
  });

  it("the layover chips reach a decision intent THROUGH a mode, and a chip whose mode has no crowd preference maps to nothing", () => {
    for (const [chip, mode] of Object.entries(LAYOVER_CHIP_TO_MODE)) {
      assert.equal(LAYOVER_INTENT_BY_CHIP[chip], INTENT_MODE_TO_DECISION_INTENT[mode], chip);
    }
    assert.equal(intentFromVibeChips(["food", "nightlife"]), "high_energy");
    assert.equal(intentFromVibeChips(["food", "shopping"]), null);
  });
});

describe("D. parsing", () => {
  it("trims and lower-cases; anything else is no mode, never an error", () => {
    assert.equal(parseIntentMode("Tonight "), "tonight");
    assert.equal(parseIntentMode("HIGH_ENERGY"), "high_energy");
    assert.equal(parseIntentMode("dinner"), null);
    assert.equal(parseIntentMode(42), null);
    assert.equal(parseIntentMode(undefined), null);
  });
});
