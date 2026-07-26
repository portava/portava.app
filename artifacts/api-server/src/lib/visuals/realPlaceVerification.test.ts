/**
 * Unit tests for realPlaceVerification — the eight-question accuracy gate.
 *
 * Pure function — no DB, no network, no fake client needed.
 *
 * Run: node --import tsx/esm --test src/lib/visuals/realPlaceVerification.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyPlaceImage } from "./realPlaceVerification.js";

// ── Scenario 1: verified official image for a specific named place ─────────────

describe("verifyPlaceImage — specific place with official image", () => {
  it("passes with accuracyStatus=verified_real and no disclaimer", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://official.example.com/hotel-photo.jpg",
      imageSource: "official",
      generatedWithAi: false,
      canonicalPlaceId: "place-001",
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, true, "official image for a specific place must be permitted");
    assert.equal(result.accuracyStatus, "verified_real");
    assert.equal(result.disclaimerRequired, false, "official images need no disclaimer");
    assert.equal(result.disclaimerText, null);
    assert.equal(result.rejectionReason, null);
  });

  it("has all eight answers set correctly", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://official.example.com/hotel-photo.jpg",
      imageSource: "official",
      generatedWithAi: false,
      canonicalPlaceId: "place-001",
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.isSpecificRealPlace, true);
    assert.equal(result.hasVerifiedRealImage, true);
    assert.equal(result.sourcePermitted, true);
    assert.equal(result.matchesCanonicalPlace, true);
    assert.equal(result.generatedWithAi, false);
    assert.equal(result.usedVerifiedReferences, false);
    assert.equal(result.characteristicsPreserved, true);
    assert.equal(result.disclaimerRequired, false);
  });

  it("trusted_provider also yields verified_real for a specific place", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.getty.com/photo.jpg",
      imageSource: "trusted_provider",
      generatedWithAi: false,
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.accuracyStatus, "verified_real");
    assert.equal(result.permitted, true);
    assert.equal(result.disclaimerRequired, false);
  });
});

// ── Scenario 2: reference_grounded_ai image for a specific named place ─────────

describe("verifyPlaceImage — specific place with reference_grounded_ai image", () => {
  it("passes with accuracyStatus=reference_grounded and disclaimerRequired=true", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/ai-cebu.webp",
      imageSource: "reference_grounded_ai",
      generatedWithAi: true,
      referenceImageUrls: [
        "https://official.example.com/ref1.jpg",
        "https://official.example.com/ref2.jpg",
      ],
      canonicalPlaceId: "place-cebu-001",
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, true);
    assert.equal(result.accuracyStatus, "reference_grounded");
    assert.equal(result.disclaimerRequired, true);
    assert.ok(result.disclaimerText !== null, "a disclaimer text must be provided");
    assert.ok(
      result.disclaimerText!.toLowerCase().includes("ai") ||
      result.disclaimerText!.toLowerCase().includes("representation"),
      "disclaimer text should mention AI or representation",
    );
  });

  it("sets usedVerifiedReferences=true when references are provided", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/ai.webp",
      imageSource: "reference_grounded_ai",
      generatedWithAi: true,
      referenceImageUrls: ["https://ref.example.com/photo.jpg"],
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.usedVerifiedReferences, true);
    assert.equal(result.characteristicsPreserved, true);
  });
});

// ── Scenario 3: text-only AI generation for a specific named place ─────────────

describe("verifyPlaceImage — text-only AI for a specific named place", () => {
  it("is rejected (permitted=false) — no reference images means it cannot be verified", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/generic-ai.webp",
      imageSource: "generic_ai_illustration",
      generatedWithAi: true,
      referenceImageUrls: null,
      canonicalPlaceId: "place-001",
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, false, "text-only AI for a named place must be rejected");
    assert.ok(result.rejectionReason !== null, "rejection reason must be set");
    assert.ok(
      result.rejectionReason!.toLowerCase().includes("text-only") ||
      result.rejectionReason!.toLowerCase().includes("reference"),
      "rejection reason should explain the reference requirement",
    );
  });

  it("disclaimerRequired is true even when rejected (specific place)", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/generic-ai.webp",
      imageSource: "generic_ai_illustration",
      generatedWithAi: true,
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.disclaimerRequired, true);
  });

  it("empty referenceImageUrls array is treated the same as null", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/generic-ai.webp",
      imageSource: "generic_ai_illustration",
      generatedWithAi: true,
      referenceImageUrls: [], // empty = no references
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, false);
    assert.equal(result.usedVerifiedReferences, false);
  });
});

// ── Scenario 4: specific named place with no reference imagery ─────────────────

describe("verifyPlaceImage — specific place with no reference imagery available", () => {
  it("category_fallback is permitted but carries disclaimerRequired=true", () => {
    // When no real image exists, the caller falls back to category_fallback.
    // The verification service permits the fallback but requires a disclaimer.
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/fallback/attraction.webp",
      imageSource: "category_fallback",
      generatedWithAi: false,
      canonicalPlaceId: "place-no-ref-001",
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, true, "category_fallback is a permitted source");
    assert.equal(result.disclaimerRequired, true, "fallback for specific place must carry disclaimer");
    assert.ok(result.disclaimerText !== null);
    assert.equal(result.accuracyStatus, "illustrative_only");
  });

  it("map_fallback is also permitted with disclaimerRequired=true", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://maps.example.com/static/tile.png",
      imageSource: "map_fallback",
      generatedWithAi: false,
      isSpecificRealPlace: true,
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, true);
    assert.equal(result.disclaimerRequired, true);
    assert.equal(result.accuracyStatus, "illustrative_only");
  });
});

// ── Scenario 5: generic category entity (not a specific real place) ─────────────

describe("verifyPlaceImage — generic category entity (not a specific real place)", () => {
  it("text-only AI generation is permitted without a disclaimer", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/category-ai.webp",
      imageSource: "generic_ai_illustration",
      generatedWithAi: true,
      referenceImageUrls: null,
      isSpecificRealPlace: false, // not a named real place
      currentAccuracyStatus: null,
    });
    assert.equal(result.permitted, true, "generic AI is permitted for non-specific entities");
    assert.equal(result.disclaimerRequired, false, "no disclaimer needed for generic content cards");
    assert.equal(result.disclaimerText, null);
  });

  it("rejectionReason is null when permitted", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/category-ai.webp",
      imageSource: "generic_ai_illustration",
      generatedWithAi: true,
      isSpecificRealPlace: false,
      currentAccuracyStatus: null,
    });
    assert.equal(result.rejectionReason, null);
  });

  it("isSpecificRealPlace=false drives the no-disclaimer decision, not the source type", () => {
    // reference_grounded_ai on a generic entity → no disclaimer
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/ai.webp",
      imageSource: "reference_grounded_ai",
      generatedWithAi: true,
      referenceImageUrls: ["https://ref.example.com/img.jpg"],
      isSpecificRealPlace: false,
      currentAccuracyStatus: null,
    });
    assert.equal(result.disclaimerRequired, false);
  });
});

// ── Previously rejected image ───────────────────────────────────────────────────

describe("verifyPlaceImage — previously rejected image", () => {
  it("a previously rejected image is not permitted regardless of source", () => {
    const result = verifyPlaceImage({
      imageUrl: "https://cdn.example.com/bad-image.jpg",
      imageSource: "official",
      generatedWithAi: false,
      isSpecificRealPlace: true,
      currentAccuracyStatus: "rejected",
    });
    assert.equal(result.permitted, false);
    assert.equal(result.accuracyStatus, "rejected");
    assert.equal(result.matchesCanonicalPlace, false);
  });
});
