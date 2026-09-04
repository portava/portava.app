/**
 * eventFamilies (Phase 0 item 10) — pins the verb -> family map that the SQL
 * read model canonical_event_families (2123) mirrors. If a verb is re-filed
 * here without the view's CASE changing (or vice versa), the drift is a review
 * catch; this test at least keeps the map itself total, valid, and fail-closed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_EVENT_VERBS } from "../lib/canonicalEvents.js";
import {
  EVENT_FAMILIES,
  VERB_FAMILY,
  familyForVerb,
} from "../lib/eventFamilies.js";

describe("eventFamilies — the map is total and valid", () => {
  it("every canonical verb has a family", () => {
    for (const verb of CANONICAL_EVENT_VERBS) {
      assert.ok(verb in VERB_FAMILY, `verb '${verb}' is unmapped`);
    }
  });
  it("no extra keys beyond the canonical verbs", () => {
    for (const verb of Object.keys(VERB_FAMILY)) {
      assert.ok(
        (CANONICAL_EVENT_VERBS as readonly string[]).includes(verb),
        `'${verb}' is not a canonical verb`,
      );
    }
  });
  it("every family value is one of the five", () => {
    for (const fam of Object.values(VERB_FAMILY)) {
      assert.ok(EVENT_FAMILIES.includes(fam), `'${fam}' is not a valid family`);
    }
  });
});

describe("eventFamilies — the documented categorization", () => {
  it("pins the funnel mapping (change here => change the 2123 view too)", () => {
    assert.deepEqual(VERB_FAMILY, {
      impression: "exposure",
      open: "action",
      save: "action",
      join: "action",
      direction: "action",
      arrival: "outcome",
      completion: "outcome",
      rejection: "outcome",
      satisfaction: "satisfaction",
      // I4a (2277): pipeline transitions, not traveler interactions.
      "intel.observation.recorded": "domain",
      "intel.claim.promoted": "domain",
      "intel.state.changed": "domain",
    });
  });
});

describe("eventFamilies — familyForVerb", () => {
  it("returns the family for a known verb", () => {
    assert.equal(familyForVerb("impression"), "exposure");
    assert.equal(familyForVerb("save"), "action");
    assert.equal(familyForVerb("completion"), "outcome");
    assert.equal(familyForVerb("satisfaction"), "satisfaction");
  });
  it("returns null for a non-canonical verb (fail-closed)", () => {
    assert.equal(familyForVerb("teleport"), null);
    assert.equal(familyForVerb(""), null);
  });
});
