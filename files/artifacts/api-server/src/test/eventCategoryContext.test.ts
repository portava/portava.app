/**
 * Stamp Wave 3 follow-up — event → criteria context classifier.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eventCategoryContext, EVENT_CATEGORY_STAMP_SLUGS } from "../lib/stamps/criteria/eventContext.js";

describe("eventCategoryContext", () => {
  it("classifies by free-text category", () => {
    assert.deepEqual(eventCategoryContext({ category: "Food & Drink" }), {
      event_category_food: true, event_category_music: false, event_category_outdoor: false,
    });
    assert.equal(eventCategoryContext({ category: "Live Concert" }).event_category_music, true);
    assert.equal(eventCategoryContext({ category: "Sunset Hike" }).event_category_outdoor, true);
  });

  it("classifies by tags array", () => {
    const ctx = eventCategoryContext({ category: null, tags: ["nightlife", "dj", "rooftop"] });
    assert.equal(ctx.event_category_music, true);
    assert.equal(ctx.event_category_food, false);
  });

  it("matches multiple buckets when applicable", () => {
    const ctx = eventCategoryContext({ category: "Food & Music Festival", tags: ["beach"] });
    assert.equal(ctx.event_category_food, true);
    assert.equal(ctx.event_category_music, true);
    assert.equal(ctx.event_category_outdoor, true); // beach
  });

  it("matches nothing for an unrelated event", () => {
    assert.deepEqual(eventCategoryContext({ category: "Business Networking", tags: ["startup"] }), {
      event_category_food: false, event_category_music: false, event_category_outdoor: false,
    });
  });

  it("is null-safe", () => {
    assert.deepEqual(eventCategoryContext(null), {
      event_category_food: false, event_category_music: false, event_category_outdoor: false,
    });
    assert.deepEqual(eventCategoryContext({}), {
      event_category_food: false, event_category_music: false, event_category_outdoor: false,
    });
  });

  it("is case-insensitive", () => {
    assert.equal(eventCategoryContext({ category: "BBQ COOKOUT" }).event_category_food, true);
  });

  it("exposes the four scoped slugs", () => {
    assert.deepEqual([...EVENT_CATEGORY_STAMP_SLUGS], [
      "foodie_explorer", "music_lover", "outdoor_adventurer", "event_regular",
    ]);
  });
});
