/**
 * placeCategories — unit tests for the canonical taxonomy mapper.
 *
 * Tests cover:
 * - All canonical Discovery tab values map to themselves
 * - Known raw seed values resolve correctly (food, beaches, nightlife, etc.)
 * - place_type takes over when category is blank or non-matching
 * - Unknown values fall back to 'places'
 * - Compound/hyphenated strings are handled by substring fallback
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCanonicalCategory, CANONICAL_CATEGORIES } from "../lib/placeCategories.js";

describe("CANONICAL_CATEGORIES", () => {
  it("contains the 8 expected values", () => {
    const expected = ["food", "beaches", "nightlife", "activities", "events", "places", "transport", "other"];
    assert.deepEqual([...CANONICAL_CATEGORIES], expected);
  });
});

describe("toCanonicalCategory", () => {
  // ── canonical passthroughs ────────────────────────────────────────────────
  it("returns 'food'       for category='food'",       () => assert.equal(toCanonicalCategory("food"),       "food"));
  it("returns 'beaches'    for category='beaches'",    () => assert.equal(toCanonicalCategory("beaches"),    "beaches"));
  it("returns 'nightlife'  for category='nightlife'",  () => assert.equal(toCanonicalCategory("nightlife"),  "nightlife"));
  it("returns 'activities' for category='activities'", () => assert.equal(toCanonicalCategory("activities"), "activities"));
  it("returns 'events'     for category='events'",     () => assert.equal(toCanonicalCategory("events"),     "events"));
  it("returns 'places'     for category='places'",     () => assert.equal(toCanonicalCategory("places"),     "places"));
  it("returns 'transport'  for category='transport'",  () => assert.equal(toCanonicalCategory("transport"),  "transport"));

  // ── seed data: exact place_type values from 0075 migration ───────────────
  it("maps place_type='restaurant' → food",    () => assert.equal(toCanonicalCategory("food", "restaurant"),    "food"));
  it("maps place_type='hawker centre' → food", () => assert.equal(toCanonicalCategory(null,  "hawker centre"),  "food"));
  it("maps place_type='beach club' → beaches", () => assert.equal(toCanonicalCategory("beaches", "beach club"), "beaches"));
  it("maps place_type='bar' + cat nightlife → nightlife",
    () => assert.equal(toCanonicalCategory("nightlife", "bar"), "nightlife"));
  it("maps place_type='temple' → places",  () => assert.equal(toCanonicalCategory(null, "temple"),  "places"));
  it("maps place_type='museum' → events",  () => assert.equal(toCanonicalCategory("events", "museum"), "events"));
  it("maps place_type='park'   → activities", () => assert.equal(toCanonicalCategory("activities", "park"), "activities"));
  it("maps place_type='airport' → transport", () => assert.equal(toCanonicalCategory(null, "airport"), "transport"));

  // ── category='attraction' is a common seed value that should → places ────
  it("maps category='attraction' → places",  () => assert.equal(toCanonicalCategory("attraction"),  "places"));

  // ── place_type wins when category is empty ────────────────────────────────
  it("uses place_type when category is null",  () => assert.equal(toCanonicalCategory(null, "cafe"),       "food"));
  it("uses place_type when category is empty", () => assert.equal(toCanonicalCategory("",   "nightclub"),  "nightlife"));

  // ── category wins when both are present ──────────────────────────────────
  it("category wins over place_type", () => assert.equal(toCanonicalCategory("food", "temple"), "food"));

  // ── substring fallback for compound strings ───────────────────────────────
  it("substring-matches 'seafood-restaurant' → food",
    () => assert.equal(toCanonicalCategory("seafood-restaurant"), "food"));
  it("substring-matches 'sky-bar' → nightlife",
    () => assert.equal(toCanonicalCategory("sky-bar"), "nightlife"));
  it("substring-matches 'hiking trail' via place_type",
    () => assert.equal(toCanonicalCategory(null, "hiking trail"), "activities"));
  it("substring-matches 'music festival' → events",
    () => assert.equal(toCanonicalCategory("music festival"), "events"));

  // ── unknown values default to 'places' ───────────────────────────────────
  it("returns 'places' for completely unknown values",
    () => assert.equal(toCanonicalCategory("totally_unknown_type", "xyz"), "places"));
  it("returns 'places' for undefined inputs",
    () => assert.equal(toCanonicalCategory(undefined, undefined), "places"));
  it("returns 'places' for null/null",
    () => assert.equal(toCanonicalCategory(null, null), "places"));

  // ── case insensitive ──────────────────────────────────────────────────────
  it("case-insensitive match: 'FOOD' → food",
    () => assert.equal(toCanonicalCategory("FOOD"), "food"));
  it("case-insensitive match: 'Restaurant' → food",
    () => assert.equal(toCanonicalCategory(null, "Restaurant"), "food"));

  // ── seeded Bangkok/Singapore/Bali spot-checks ─────────────────────────────
  it("Bangkok Wat Pho: category='attraction', type='temple' → places",
    () => assert.equal(toCanonicalCategory("attraction", "temple"), "places"));
  it("Bangkok Khao San Road: category='nightlife', type='street' → nightlife",
    () => assert.equal(toCanonicalCategory("nightlife", "street"), "nightlife"));
  it("Singapore Sentosa Island: category='beaches', type='island' → beaches",
    () => assert.equal(toCanonicalCategory("beaches", "island"), "beaches"));
  it("Bangkok Muay Thai stadium: category='events', type='stadium' → events",
    () => assert.equal(toCanonicalCategory("events", "stadium"), "events"));
});
