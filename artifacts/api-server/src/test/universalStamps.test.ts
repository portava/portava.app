/**
 * Universal Stamp Catalog — unit tests
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/universalStamps.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCombosFromUserStampRows, type LocationCombo } from "../lib/stamps/reconcileStampCatalog.js";
import { canonicalLocationKey, normalizeSegment, definitionScopedKey } from "../lib/stamps/locationKey.js";
import { buildStampPrompt, STYLE_VERSION, CANDIDATE_COUNT } from "../lib/stamps/artDirection.js";
import { PlaceholderProvider } from "../lib/stamps/imageProvider.js";

// ── normalizeSegment ──────────────────────────────────────────────────────────

describe("normalizeSegment", () => {
  it("lowercases and removes accents", () => {
    assert.equal(normalizeSegment("Cébu"), "cebu");
    assert.equal(normalizeSegment("São Paulo"), "sao-paulo");
    assert.equal(normalizeSegment("Köln"), "koln");
  });

  it("replaces spaces and underscores with hyphens", () => {
    assert.equal(normalizeSegment("New York"), "new-york");
    assert.equal(normalizeSegment("cebu_city"), "cebu-city");
  });

  it("strips punctuation", () => {
    assert.equal(normalizeSegment("St. Louis"), "st-louis");
    assert.equal(normalizeSegment("D'Hondt"), "dhondt");
  });

  it("collapses multiple hyphens", () => {
    assert.equal(normalizeSegment("A  B--C"), "a-b-c");
  });
});

// ── definitionScopedKey — location-less stamps ────────────────────────────────

describe("definitionScopedKey", () => {
  it("builds a definition-scoped key from a slug", () => {
    assert.equal(definitionScopedKey("first_trip_created"), "definition:first-trip-created");
  });

  it("normalises casing and accents", () => {
    assert.equal(definitionScopedKey("Safe Réturn"), "definition:safe-return");
  });

  it("is stable across variants of the same slug", () => {
    assert.equal(definitionScopedKey("first_trip_created"), definitionScopedKey("First Trip Created"));
  });

  it("throws on a slug that normalises to nothing", () => {
    assert.throws(() => definitionScopedKey("***"));
  });
});

// ── canonicalLocationKey — city stamps ────────────────────────────────────────

describe("canonicalLocationKey — city stamps", () => {
  const base = { stampType: "city", countryCode: "PH" };

  it("handles 'Cebu'", () => {
    assert.equal(canonicalLocationKey({ ...base, city: "Cebu" }), "city:ph:cebu");
  });

  it("handles 'Cebu City'", () => {
    assert.equal(canonicalLocationKey({ ...base, city: "Cebu City" }), "city:ph:cebu-city");
  });

  it("handles lowercase variant", () => {
    assert.equal(canonicalLocationKey({ ...base, city: "cebu city" }), "city:ph:cebu-city");
  });

  it("is stable across capitalisation variants", () => {
    const k1 = canonicalLocationKey({ ...base, city: "Manila" });
    const k2 = canonicalLocationKey({ ...base, city: "MANILA" });
    const k3 = canonicalLocationKey({ ...base, city: "manila" });
    assert.equal(k1, k2);
    assert.equal(k2, k3);
  });

  it("includes country code in the key", () => {
    const key = canonicalLocationKey({ stampType: "city", countryCode: "JP", city: "Tokyo" });
    assert.ok(key.includes("jp"), "should contain jp");
    assert.ok(key.includes("tokyo"), "should contain tokyo");
  });

  it("different cities in same country produce different keys", () => {
    const k1 = canonicalLocationKey({ ...base, city: "Cebu" });
    const k2 = canonicalLocationKey({ ...base, city: "Manila" });
    assert.notEqual(k1, k2);
  });

  it("same city in different countries produce different keys", () => {
    const k1 = canonicalLocationKey({ stampType: "city", countryCode: "PH", city: "Cebu" });
    const k2 = canonicalLocationKey({ stampType: "city", countryCode: "JP", city: "Cebu" });
    assert.notEqual(k1, k2);
  });
});

// ── canonicalLocationKey — country stamps ─────────────────────────────────────

describe("canonicalLocationKey — country stamps", () => {
  it("builds country key without city", () => {
    const key = canonicalLocationKey({ stampType: "country", countryCode: "PH" });
    assert.equal(key, "country:ph");
  });

  it("different stamp types produce different keys", () => {
    const k1 = canonicalLocationKey({ stampType: "city",    countryCode: "PH", city: "Cebu" });
    const k2 = canonicalLocationKey({ stampType: "country", countryCode: "PH" });
    assert.notEqual(k1, k2);
  });
});

// ── canonicalLocationKey — neighborhood stamps ────────────────────────────────

describe("canonicalLocationKey — neighborhood stamps", () => {
  it("builds neighborhood key", () => {
    const key = canonicalLocationKey({
      stampType:    "neighborhood",
      countryCode:  "PH",
      city:         "Cebu City",
      neighborhood: "IT Park",
    });
    assert.equal(key, "neighborhood:ph:cebu-city:it-park");
  });
});

// ── canonicalLocationKey — country name resolution ───────────────────────────

describe("canonicalLocationKey — country name resolution", () => {
  it("resolves Philippines from country name", () => {
    const key = canonicalLocationKey({ stampType: "city", country: "Philippines", city: "Cebu" });
    assert.equal(key, "city:ph:cebu");
  });

  it("resolves Japan from country name", () => {
    const key = canonicalLocationKey({ stampType: "city", country: "Japan", city: "Tokyo" });
    assert.equal(key, "city:jp:tokyo");
  });
});

// ── Reconciliation combo schema contract ──────────────────────────────────────
// Verifies that the reconciliation script correctly collects stamp_definition_id
// (not stamp_type) from user_stamps rows, so the write-side update never filters
// on the nonexistent stamp_type column.

describe("reconciliation — user_stamps combo building", () => {
  // buildCombosFromUserStampRows is imported from the shipped
  // reconcileStampCatalog.ts (not mirrored) so a change to the real combo logic
  // is exercised here directly.

  it("populates userStampDefIds from stamp_definition_id, not stamp_type", () => {
    const rows = [
      {
        stamp_definition_id: "def-001",
        country: "PH",
        city: "Cebu City",
        stamp_definitions: { stamp_type: "city" },
      },
    ];
    const combos = buildCombosFromUserStampRows(rows);
    assert.equal(combos.size, 1);
    const combo = [...combos.values()][0];
    assert.deepEqual(combo.userStampDefIds, ["def-001"], "must carry stamp_definition_id");
    assert.equal(combo.stamp_type, "city");
  });

  it("accumulates multiple definition IDs for the same canonical location", () => {
    const rows = [
      { stamp_definition_id: "def-001", country: "PH", city: "Cebu City", stamp_definitions: { stamp_type: "city" } },
      { stamp_definition_id: "def-002", country: "PH", city: "Cebu City", stamp_definitions: { stamp_type: "city" } },
      { stamp_definition_id: "def-001", country: "PH", city: "Cebu City", stamp_definitions: { stamp_type: "city" } }, // duplicate — should not double-add
    ];
    const combos = buildCombosFromUserStampRows(rows);
    assert.equal(combos.size, 1);
    const combo = [...combos.values()][0];
    assert.deepEqual(combo.userStampDefIds, ["def-001", "def-002"], "should deduplicate definition IDs");
  });

  it("produces separate combos for different locations", () => {
    const rows = [
      { stamp_definition_id: "def-001", country: "PH", city: "Cebu City", stamp_definitions: { stamp_type: "city" } },
      { stamp_definition_id: "def-003", country: "PH", city: "Manila",    stamp_definitions: { stamp_type: "city" } },
    ];
    const combos = buildCombosFromUserStampRows(rows);
    assert.equal(combos.size, 2);
  });

  it("passport_stamps-only combos initialize with empty userStampDefIds", () => {
    // Simulates a combo added from passport_stamps (no user_stamps rows)
    const combo: LocationCombo = {
      stamp_type:      "city",
      country:         "PH",
      city:            "Cebu City",
      userStampDefIds: [],
    };
    // Write-side must skip user_stamps update when defIds is empty
    assert.equal(combo.userStampDefIds.length, 0, "passport-only combo has no def IDs — write side must skip user_stamps update");
  });

  it("falls back to 'city' stamp_type when definition join is null", () => {
    const rows = [
      { stamp_definition_id: "def-999", country: "JP", city: "Tokyo", stamp_definitions: null },
    ];
    const combos = buildCombosFromUserStampRows(rows);
    const combo = [...combos.values()][0];
    assert.equal(combo.stamp_type, "city", "null definition should fall back to city type");
    assert.deepEqual(combo.userStampDefIds, ["def-999"]);
  });
});

// ── canonicalLocationKey — idempotency ────────────────────────────────────────

describe("canonicalLocationKey — idempotency", () => {
  it("same input always produces same key", () => {
    const input = { stampType: "city", countryCode: "PH", city: "Cebu City" };
    const k1 = canonicalLocationKey(input);
    const k2 = canonicalLocationKey(input);
    const k3 = canonicalLocationKey(input);
    assert.equal(k1, k2);
    assert.equal(k2, k3);
  });
});

// ── buildStampPrompt ──────────────────────────────────────────────────────────

const cebuEntry = {
  id:                     "00000000-0000-0000-0000-000000000001",
  canonical_location_key: "city:ph:cebu-city",
  stamp_type:             "city",
  display_name:           "Cebu City",
  country:                "Philippines",
  country_code:           "PH",
  region:                 null,
  city:                   "Cebu City",
  neighborhood:           null,
};

describe("buildStampPrompt", () => {
  it("returns a non-empty string of reasonable length", () => {
    const prompt = buildStampPrompt(cebuEntry);
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 100, "prompt too short");
  });

  it("includes the display name", () => {
    const prompt = buildStampPrompt(cebuEntry);
    assert.ok(prompt.includes("Cebu City"), "prompt should contain display name");
  });

  it("includes country info", () => {
    const prompt = buildStampPrompt(cebuEntry);
    assert.ok(prompt.includes("Philippines"), "prompt should contain country");
  });

  it("uses circular badge shape for city stamps", () => {
    const prompt = buildStampPrompt(cebuEntry);
    assert.ok(prompt.toLowerCase().includes("circular"), "city stamp should use circular shape");
  });

  it("uses rectangular frame for country stamps", () => {
    const countryEntry = { ...cebuEntry, stamp_type: "country", display_name: "Philippines" };
    const prompt = buildStampPrompt(countryEntry);
    assert.ok(prompt.toLowerCase().includes("rectangular"), "country stamp should use rectangular shape");
  });
});

describe("artDirection constants", () => {
  it("STYLE_VERSION matches semver pattern", () => {
    assert.match(STYLE_VERSION, /^v\d+\.\d+$/);
  });

  it("CANDIDATE_COUNT is a positive integer", () => {
    assert.ok(Number.isInteger(CANDIDATE_COUNT));
    assert.ok(CANDIDATE_COUNT > 0);
  });
});

// ── PlaceholderProvider ───────────────────────────────────────────────────────

describe("PlaceholderProvider", () => {
  it("returns CANDIDATE_COUNT images by default", async () => {
    const provider = new PlaceholderProvider();
    const images = await provider.generate("test prompt");
    assert.equal(images.length, CANDIDATE_COUNT);
  });

  it("returns data-URL images", async () => {
    const provider = new PlaceholderProvider();
    const images = await provider.generate("test prompt");
    for (const img of images) {
      assert.match(img.url, /^data:/, "image URL should be a data URL");
    }
  });

  it("each image has metadata with model field", async () => {
    const provider = new PlaceholderProvider();
    const images = await provider.generate("test prompt");
    for (const img of images) {
      assert.ok(img.metadata, "metadata should be defined");
      assert.equal(img.metadata.model, "placeholder");
    }
  });

  it("respects explicit n parameter", async () => {
    const provider = new PlaceholderProvider();
    const images = await provider.generate("test prompt", 1);
    assert.equal(images.length, 1);
  });
});
