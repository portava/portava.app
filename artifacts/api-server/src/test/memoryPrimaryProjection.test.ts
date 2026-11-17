import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readPrimaryMemoryFacts, projectPrimaryMemory } from "../services/memoryProjections/primaryMemoryProjection.js";
import { withCanonicalPayload } from "../services/memory/memoryCanonicalFields.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function source() {
  return {
    id: "memory", owner_id: OWNER, title: "Recorded title", caption: "Owner's account",
    visibility: "public", state: "published", trip_id: null, event_id: null,
    place_id: "recorded-place", canonical_location_id: null, location_city: "Kyoto", location_country: "JP",
    location_lat: 35, location_lng: 135, starts_at: "2026-01-01T12:00:00Z", ends_at: null,
    created_at: "2026-01-02T12:00:00Z", updated_at: "2026-01-02T12:00:00Z",
    allowed_user_ids: [VIEWER], hidden_user_ids: ["someone-else"],
  };
}

describe("H1 primary Memory fact and viewer projection boundary", () => {
  it("reads historical facts without layout, AI narrative or raw new database columns", () => {
    const row = { ...source(), narrative: { title: "Invented", placeId: "invented" },
      presentation_json: { title: "Layout title" }, internal_notes: "private", future_column: "private" };
    const model = readPrimaryMemoryFacts(row);
    assert.equal(model.facts.title, "Recorded title");
    assert.equal(model.facts.placeId, "recorded-place");
    assert.equal(model.facts.truthClass, "historical");
    assert.equal(model.facts.establishesCurrentStatus, false);
    for (const key of ["narrative", "presentation_json", "internal_notes", "future_column", "allowedUserIds", "hiddenUserIds", "visibility"])
      assert.equal(Object.hasOwn(model.facts, key), false, key);
  });

  it("a viewer response cannot mutate canonical facts or the next viewer's response", () => {
    const row = source(); const model = readPrimaryMemoryFacts(row);
    const first = projectPrimaryMemory(model, OWNER);
    first.title = "A layout's replacement label";
    first.allowedUserIds!.push("injected"); first.hiddenUserIds!.length = 0;
    const again = projectPrimaryMemory(model, OWNER);
    assert.equal(again.title, "Recorded title");
    assert.deepEqual(again.allowedUserIds, [VIEWER]);
    assert.deepEqual(again.hiddenUserIds, ["someone-else"]);
    assert.deepEqual(row, source());
  });

  it("later mutations of a query result do not rewrite an already captured fact view", () => {
    const row = source(); const model = readPrimaryMemoryFacts(row);
    row.title = "Changed later"; row.allowed_user_ids.push("later"); row.hidden_user_ids.length = 0;
    assert.equal(projectPrimaryMemory(model, OWNER).title, "Recorded title");
    assert.deepEqual(projectPrimaryMemory(model, OWNER).allowedUserIds, [VIEWER]);
    assert.deepEqual(projectPrimaryMemory(model, OWNER).hiddenUserIds, ["someone-else"]);
    assert.equal(Object.isFrozen(model), true);
    assert.equal(Object.isFrozen(model.facts), true);
    assert.equal(Object.isFrozen(model.audience.allowedUserIds), true);
  });

  for (const viewer of [undefined, VIEWER]) {
    it(`withholds audience controls for ${viewer ?? "an unspecified viewer"}`, () => {
      const model = readPrimaryMemoryFacts({ ...source(), location_precision: "city" });
      const result = projectPrimaryMemory(model, viewer);
      for (const key of ["allowedUserIds", "hiddenUserIds", "locationPrecision", "audience"])
        assert.equal(Object.hasOwn(result, key), false, key);
      const own = projectPrimaryMemory(model, OWNER);
      assert.equal(own.locationPrecision, "city");
      assert.deepEqual(own.allowedUserIds, [VIEWER]);
    });
  }

  it("never invents a precision when that schema field was not read", () => {
    assert.equal(Object.hasOwn(projectPrimaryMemory(readPrimaryMemoryFacts(source()), OWNER), "locationPrecision"), false);
  });

  it("serves only canonical fields authorized by their existing gate", () => {
    const row = { ...source(), memory_type: "TRIP", place_display_name_at_occurrence: "hidden name" };
    const without = projectPrimaryMemory(readPrimaryMemoryFacts(row), VIEWER);
    assert.equal(Object.hasOwn(without, "memoryType"), false);
    assert.equal(Object.hasOwn(without, "placeDisplayNameAtOccurrence"), false);
    const allowed = withCanonicalPayload(row, { memoryType: "PLACE", placeDisplayNameAtOccurrence: "Allowed occurrence name" });
    const withFields = projectPrimaryMemory(readPrimaryMemoryFacts(allowed), VIEWER);
    assert.equal(withFields.memoryType, "PLACE");
    assert.equal(withFields.placeDisplayNameAtOccurrence, "Allowed occurrence name");
  });

  it("keeps missing occurrence times unknown instead of replacing them with creation time", () => {
    const model = readPrimaryMemoryFacts({ ...source(), starts_at: null });
    assert.equal(projectPrimaryMemory(model, VIEWER).startsAt, null);
    assert.equal(projectPrimaryMemory(model, VIEWER).createdAt, "2026-01-02T12:00:00Z");
  });
});
