/**
 * Unit tests for the image source priority resolver.
 *
 * Covers all nine canonical source types in rank order, disclaimer threshold,
 * tie-breaking by verifiedAt, and canonical-place guard.
 *
 * Pure functions — no DB, no network, no fake client needed.
 *
 * Run: node --import tsx/esm --test src/lib/visuals/priority.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sourceRank, resolveHeaderImage } from "./priority.js";
import type { HeaderCandidate } from "./priority.js";

// ── Source rank ordering ───────────────────────────────────────────────────────

describe("sourceRank — nine canonical types in strict spec order", () => {
  const ORDER = [
    "official",
    "trusted_provider",
    "tourism_authority",
    "verified_owner",
    "verified_user_photo",
    "reference_grounded_ai",
    "generic_ai_illustration",
    "category_fallback",
    "map_fallback",
  ] as const;

  it("official outranks every other source type", () => {
    const officialRank = sourceRank("official");
    const others = ORDER.filter((s) => s !== "official");
    for (const s of others) {
      assert.ok(
        officialRank > sourceRank(s),
        `official (${officialRank}) must outrank ${s} (${sourceRank(s)})`,
      );
    }
  });

  it("reference_grounded_ai outranks generic_ai_illustration and category_fallback", () => {
    assert.ok(sourceRank("reference_grounded_ai") > sourceRank("generic_ai_illustration"));
    assert.ok(sourceRank("reference_grounded_ai") > sourceRank("category_fallback"));
  });

  it("map_fallback is the lowest-ranked canonical source", () => {
    const mapRank = sourceRank("map_fallback");
    for (const s of ORDER.filter((x) => x !== "map_fallback")) {
      assert.ok(
        sourceRank(s) > mapRank,
        `${s} (${sourceRank(s)}) must outrank map_fallback (${mapRank})`,
      );
    }
  });

  it("all nine canonical types are in strict descending order", () => {
    for (let i = 0; i < ORDER.length - 1; i++) {
      assert.ok(
        sourceRank(ORDER[i]) > sourceRank(ORDER[i + 1]),
        `${ORDER[i]} must outrank ${ORDER[i + 1]}`,
      );
    }
  });
});

// ── Tie-breaking by verifiedAt ─────────────────────────────────────────────────

describe("resolveHeaderImage — tie-breaking when two candidates share the same source type", () => {
  it("most recently verified candidate wins when source types are equal", () => {
    const candidates: HeaderCandidate[] = [
      {
        url: "https://cdn.example.com/older.jpg",
        source: "official",
        verifiedAt: "2026-01-01T00:00:00Z",
      },
      {
        url: "https://cdn.example.com/newer.jpg",
        source: "official",
        verifiedAt: "2026-07-01T00:00:00Z",
      },
    ];
    const result = resolveHeaderImage(candidates);
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/newer.jpg");
  });

  it("candidate without verifiedAt loses to one with a verifiedAt when source types match", () => {
    const candidates: HeaderCandidate[] = [
      {
        url: "https://cdn.example.com/no-date.jpg",
        source: "official",
        // no verifiedAt
      },
      {
        url: "https://cdn.example.com/with-date.jpg",
        source: "official",
        verifiedAt: "2026-06-01T00:00:00Z",
      },
    ];
    const result = resolveHeaderImage(candidates);
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/with-date.jpg");
  });
});

// ── resolveHeaderImage: disclaimer threshold ───────────────────────────────────

describe("resolveHeaderImage — disclaimer threshold for specific real places", () => {
  it("sets disclaimerRequired=true for reference_grounded_ai on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/ai-cebu.webp", source: "reference_grounded_ai" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.disclaimerRequired, true);
    assert.ok(result!.disclaimerText !== null);
  });

  it("sets disclaimerRequired=true for category_fallback on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/fallback.webp", source: "category_fallback" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.disclaimerRequired, true);
  });

  it("sets disclaimerRequired=true for map_fallback on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://maps.example.com/tile.png", source: "map_fallback" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.disclaimerRequired, true);
  });

  it("sets disclaimerRequired=true for generic_ai_illustration on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/ai.webp", source: "generic_ai_illustration" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.disclaimerRequired, true);
  });

  it("does NOT set disclaimerRequired for official image on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://official.example.com/photo.jpg", source: "official" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    // official >= verified_user_photo threshold → no disclaimer
    assert.ok(
      result!.disclaimerRequired !== true,
      "official image must not carry a disclaimer",
    );
  });

  it("does NOT set disclaimerRequired for verified_user_photo on a specific-place entity", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/user-photo.jpg", source: "verified_user_photo" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.ok(
      result!.disclaimerRequired !== true,
      "verified_user_photo must not carry a disclaimer",
    );
  });

  it("does NOT set disclaimerRequired when isSpecificRealPlace is false", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/ai.webp", source: "reference_grounded_ai" }],
      { isSpecificRealPlace: false },
    );
    assert.ok(result !== null);
    assert.ok(result!.disclaimerRequired !== true);
  });
});

// ── resolveHeaderImage: canonical place guard ──────────────────────────────────

describe("resolveHeaderImage — canonical place guard", () => {
  it("rejects a candidate whose canonicalPlaceId does not match the entity's", () => {
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/wrong-place.jpg",
          source: "official",
          canonicalPlaceId: "place-other-999",
        },
      ],
      { canonicalPlaceId: "place-cebu-001" },
    );
    // Mismatch → filtered out → null
    assert.equal(result, null);
  });

  it("accepts a candidate whose canonicalPlaceId matches the entity's", () => {
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/correct-place.jpg",
          source: "official",
          canonicalPlaceId: "place-cebu-001",
        },
      ],
      { canonicalPlaceId: "place-cebu-001" },
    );
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/correct-place.jpg");
  });

  it("accepts a candidate with no canonicalPlaceId (pre-accuracy records)", () => {
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/legacy.jpg",
          source: "official",
          canonicalPlaceId: null,
        },
      ],
      { canonicalPlaceId: "place-cebu-001" },
    );
    // No canonicalPlaceId on candidate → allowed through
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/legacy.jpg");
  });

  it("prefers a matching-place candidate over a higher-priority mismatched one", () => {
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/wrong-place-official.jpg",
          source: "official",
          canonicalPlaceId: "place-other-999",
        },
        {
          url: "https://cdn.example.com/right-place-ai.jpg",
          source: "reference_grounded_ai",
          canonicalPlaceId: "place-cebu-001",
        },
      ],
      { canonicalPlaceId: "place-cebu-001" },
    );
    // Wrong-place official is filtered; right-place AI wins
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/right-place-ai.jpg");
  });
});
