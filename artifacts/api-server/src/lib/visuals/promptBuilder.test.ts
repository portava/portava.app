/**
 * Unit tests for the visual prompt builder — focusing on the real-place policy gate.
 *
 * Pure functions — no DB, no network, no fake client needed.
 *
 * Run: node --import tsx/esm --test src/lib/visuals/promptBuilder.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlacePrompt } from "./promptBuilder.js";
import type { VisualInputSnapshot } from "./types.js";

function placeSnap(over: Partial<VisualInputSnapshot> = {}): VisualInputSnapshot {
  return {
    entityType: "place",
    purpose: "place_header",
    title: "Kawasan Falls",
    category: "attraction",
    city: "Cebu",
    country: "Philippines",
    style: "portava_editorial",
    renderMode: "realistic",
    people: "auto",
    promptVersion: "place-header-v1",
    ...over,
  };
}

// ── Scenario 1: specific real place with no reference images → null ─────────────

describe("buildPlacePrompt — specific real place with no reference images", () => {
  it("returns null — text-only generation is blocked for specific named places", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: null,
      }),
    );
    assert.equal(result, null, "must return null to block generation without references");
  });

  it("also returns null when referenceImageUrls is an empty array", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: [],
      }),
    );
    assert.equal(result, null);
  });
});

// ── Scenario 2: specific real place with reference images → reference-grounded prompt ─────

describe("buildPlacePrompt — specific real place with reference images", () => {
  it("returns a non-null prompt when reference images are present", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: [
          "https://official.example.com/kawasan-ref1.jpg",
          "https://official.example.com/kawasan-ref2.jpg",
        ],
      }),
    );
    assert.ok(result !== null, "must return a prompt when reference images are present");
    assert.ok(result!.length > 0);
  });

  it("reference-grounded prompt contains the STRICT TRUTHFULNESS RULES section", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: ["https://official.example.com/ref.jpg"],
      }),
    )!;
    assert.ok(
      result.includes("STRICT TRUTHFULNESS RULES"),
      "reference-grounded prompt must include the spec STRICT TRUTHFULNESS RULES label",
    );
  });

  it("reference-grounded prompt mentions that it is grounded in reference images", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: ["https://ref.example.com/photo.jpg"],
      }),
    )!;
    assert.ok(
      result.toLowerCase().includes("reference") || result.toLowerCase().includes("grounded"),
      "prompt must mention the reference images used",
    );
  });

  it("reference-grounded prompt instructs NOT to invent structures or features", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: ["https://ref.example.com/photo.jpg"],
      }),
    )!;
    assert.ok(
      result.includes("Do NOT invent structures") ||
      result.includes("not present in the references"),
      "prompt must explicitly forbid inventing structures",
    );
  });

  it("reference-grounded prompt does NOT instruct to change season or environment", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: ["https://ref.example.com/photo.jpg"],
      }),
    )!;
    // The prompt must not tell the model to change the season or setting
    const lower = result.toLowerCase();
    assert.ok(
      !lower.includes("change season") && !lower.includes("alter season"),
      "reference-grounded prompt must not instruct to change season",
    );
  });

  it("reference-grounded prompt does NOT instruct to add signage not in references", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: ["https://ref.example.com/photo.jpg"],
      }),
    )!;
    // Must include a prohibition on adding signage
    assert.ok(
      result.toLowerCase().includes("no add signage") ||
      result.toLowerCase().includes("do not add signage") ||
      result.includes("not in the reference"),
      "reference-grounded prompt must prohibit adding signage not in references",
    );
  });

  it("reference-grounded prompt mentions the reference count", () => {
    const refs = [
      "https://ref.example.com/photo1.jpg",
      "https://ref.example.com/photo2.jpg",
      "https://ref.example.com/photo3.jpg",
    ];
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: true,
        referenceImageUrls: refs,
      }),
    )!;
    // The spec requires the prompt signals the reference count to the provider
    assert.ok(
      result.includes("3") || result.includes("three"),
      "prompt should mention the number of reference images",
    );
  });
});

// ── Scenario 3: non-specific-place snapshot → normal creative prompt ─────────────

describe("buildPlacePrompt — non-specific-place snapshot (generic content card)", () => {
  it("returns a non-null creative prompt for a generic entity", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: false,
        referenceImageUrls: null,
        title: "Tropical Café",
        category: "food",
      }),
    );
    assert.ok(result !== null, "must return a prompt for non-specific entities");
  });

  it("generic prompt does NOT include STRICT TRUTHFULNESS RULES", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: false,
      }),
    )!;
    assert.ok(
      !result.includes("STRICT TRUTHFULNESS RULES"),
      "generic prompts must not include the real-place truthfulness rules section",
    );
  });

  it("generic prompt includes a note that this is a category-based representation", () => {
    const result = buildPlacePrompt(
      placeSnap({
        isSpecificRealPlace: false,
      }),
    )!;
    assert.ok(
      result.toLowerCase().includes("category") ||
      result.toLowerCase().includes("representation"),
      "generic prompt must clarify it is a category-based representation",
    );
  });

  it("returns non-null even when isSpecificRealPlace is not set (undefined)", () => {
    const snap = placeSnap();
    // isSpecificRealPlace not set → treated as falsy → not specific
    const result = buildPlacePrompt(snap);
    assert.ok(result !== null);
  });
});
