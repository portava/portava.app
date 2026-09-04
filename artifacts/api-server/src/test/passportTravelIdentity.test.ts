/**
 * Passport Travel Identity / Travel DNA (§19, TABLE 20).
 *
 * Verifies:
 *   • dimensions are inferred from the canonical profile + behavioural signals,
 *     each carrying explaining EVIDENCE;
 *   • named traits (Night Explorer, Hidden Gem Hunter, Food Driven) derive from
 *     concrete signals;
 *   • Show / Hide / Not-Me state controls a non-owner view (hidden/not_me items
 *     removed for viewers, retained for the owner);
 *   • with the flag OFF (default) no stored prefs are read and everything shows.
 *
 * Run: node --import tsx/esm --test src/test/passportTravelIdentity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferTravelIdentity,
  buildTravelIdentity,
  filterTravelIdentityForViewer,
} from "../services/passport/PassportTravelIdentityService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const USER = "user-dna";

const PROFILE = {
  id: USER,
  travel_pace: "packed",
  planning_style: "planner",
  budget_style: "budget",
  travel_group_style: ["social", "small groups"],
  open_to_meet: true,
  interests: ["Nightlife", "Food"],
  spoken_languages: ["English", "Vietnamese"],
};

const SIGNALS = { hiddenGemCount: 3, nightlifeCount: 4, foodCount: 3, countriesCount: 9, interestTags: ["night", "food"] };

describe("inferTravelIdentity (pure)", () => {
  it("reads spectrum dimensions from the profile with evidence", () => {
    const { dimensions } = inferTravelIdentity(USER, PROFILE, SIGNALS);
    const byKey = new Map(dimensions.map((d) => [d.key, d]));

    const pace = byKey.get("travel_pace")!;
    assert.equal(pace.value, "Packed");
    assert.ok(pace.evidence.length > 0, "pace must be explainable");
    assert.equal(pace.inferred, false);

    const planning = byKey.get("planning")!;
    assert.equal(planning.value, "Planner");

    const spend = byKey.get("spend_style")!;
    assert.equal(spend.value, "Budget");

    const langs = byKey.get("languages")!;
    assert.ok(langs.value.includes("English"));
  });

  it("emits named Travel DNA traits from concrete signals", () => {
    const { traits } = inferTravelIdentity(USER, PROFILE, SIGNALS);
    const keys = traits.map((t) => t.key);
    assert.ok(keys.includes("night_explorer"));
    assert.ok(keys.includes("hidden_gem_hunter"));
    assert.ok(keys.includes("food_driven"));
    assert.ok(keys.includes("globe_trotter"));
    // Each trait explains itself.
    for (const t of traits) assert.ok(t.evidence.length > 0, `${t.key} must carry evidence`);
  });

  it("marks empty dimensions as inferred defaults, never fabricated", () => {
    const { dimensions } = inferTravelIdentity(USER, { id: USER }, {});
    const pace = dimensions.find((d) => d.key === "travel_pace")!;
    assert.equal(pace.value, "Balanced");
    assert.equal(pace.inferred, true);
    assert.deepEqual(pace.evidence, []);
  });
});

describe("buildTravelIdentity + viewer filtering", () => {
  it("with the flag OFF, reads no prefs and everything shows", async () => {
    // feature_flags empty ⇒ passport_travel_dna_enabled is OFF (fail-closed).
    const db = makePassportDb({ passport_travel_dna_prefs: [{ user_id: USER, dimension_key: "spend_style", state: "hidden" }] });
    const ti = await buildTravelIdentity(db, USER, PROFILE, SIGNALS, { isSelf: true });
    assert.equal(ti.preferencesApplied, false, "prefs must not apply when flag is off");
    const spend = ti.dimensions.find((d) => d.key === "spend_style")!;
    assert.equal(spend.state, "shown", "default state with flag off");
    assert.equal(ti.editable, true);
  });

  it("with the flag ON, applies stored Show/Hide/Not-Me and filters for viewers", async () => {
    const db = makePassportDb({
      feature_flags: [{ flag: "passport_travel_dna_enabled", enabled: true }],
      passport_travel_dna_prefs: [
        { user_id: USER, dimension_key: "spend_style", state: "hidden" },
        { user_id: USER, dimension_key: "night_explorer", state: "not_me" },
      ],
    });
    const owned = await buildTravelIdentity(db, USER, PROFILE, SIGNALS, { isSelf: true });
    assert.equal(owned.preferencesApplied, true);
    // Owner keeps hidden/not_me items so they can toggle them back.
    assert.equal(owned.dimensions.find((d) => d.key === "spend_style")!.state, "hidden");
    assert.equal(owned.traits.find((t) => t.key === "night_explorer")!.state, "not_me");

    // A viewer sees the hidden/not_me items REMOVED.
    const viewerView = filterTravelIdentityForViewer(owned, false);
    assert.ok(!viewerView.dimensions.some((d) => d.key === "spend_style"), "hidden dimension removed for viewer");
    assert.ok(!viewerView.traits.some((t) => t.key === "night_explorer"), "not_me trait removed for viewer");
    assert.equal(viewerView.editable, false);
    // Non-hidden content survives.
    assert.ok(viewerView.dimensions.some((d) => d.key === "travel_pace"));
  });
});
