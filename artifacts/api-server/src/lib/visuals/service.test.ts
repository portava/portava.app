/**
 * Unit tests for VisualGenerationService — focusing on:
 *   - no_reference_fallback behaviour for specific real places
 *   - provenance fields surviving through buildSnapshot
 *   - category_fallback output carrying disclaimerRequired when isSpecificRealPlace
 *
 * Route-level integration tests for the /visuals/generate endpoint that returns
 * no_reference_fallback are in visuals.test.ts (no duplication here).
 *
 * Run: node --import tsx/esm --test src/lib/visuals/service.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, requestGeneration } from "./service.js";
import { resolveHeaderImage } from "./priority.js";
import { _setTestClient } from "../http.js";

// ── buildSnapshot — provenance field survival ─────────────────────────────────

describe("buildSnapshot — provenance fields", () => {
  it("sets canonicalPlaceId from the entity row", () => {
    const snap = buildSnapshot(
      "place",
      "place_header",
      {
        id: "p1",
        name: "Kawasan Falls",
        category: "attraction",
        city: "Cebu",
        country: "Philippines",
        canonical_place_id: "canonical-kawasan-001",
        provider_place_id: null,
        header_image_url: null,
        header_image_source: null,
        header_image_updated_at: null,
      },
      "portava_editorial",
    );
    assert.equal(snap.canonicalPlaceId, "canonical-kawasan-001");
  });

  it("sets providerPlaceId from the entity row", () => {
    const snap = buildSnapshot(
      "place",
      "place_header",
      {
        id: "p1",
        name: "SM Mall",
        category: "shopping",
        city: "Cebu",
        canonical_place_id: null,
        provider_place_id: "fsq-abc-123",
        header_image_url: null,
        header_image_source: null,
        header_image_updated_at: null,
      },
      "portava_editorial",
    );
    assert.equal(snap.providerPlaceId, "fsq-abc-123");
  });

  it("preserves referenceImageUrls in the snapshot when provided", () => {
    const refs = [
      "https://official.example.com/ref1.jpg",
      "https://official.example.com/ref2.jpg",
    ];
    const snap = buildSnapshot(
      "place",
      "place_header",
      {
        id: "p1",
        name: "Kawasan Falls",
        category: "attraction",
        city: "Cebu",
        canonical_place_id: "canonical-kawasan-001",
        provider_place_id: null,
        header_image_url: null,
        header_image_source: null,
        header_image_updated_at: null,
      },
      "portava_editorial",
      undefined,
      refs,
    );
    assert.deepEqual(snap.referenceImageUrls, refs);
  });

  it("sets referenceImageUrls to null when none are provided", () => {
    const snap = buildSnapshot(
      "place",
      "place_header",
      { id: "p1", name: "Generic", category: "other", city: null, canonical_place_id: null, provider_place_id: null },
      "portava_editorial",
    );
    assert.equal(snap.referenceImageUrls, null);
  });

  it("isSpecificRealPlace is true when canonical_place_id is set", () => {
    const snap = buildSnapshot(
      "place",
      "place_header",
      {
        id: "p1", name: "Some Place", category: "attraction", city: "Cebu",
        canonical_place_id: "c-001", provider_place_id: null,
        header_image_url: null, header_image_source: null, header_image_updated_at: null,
      },
      "portava_editorial",
    );
    assert.equal(snap.isSpecificRealPlace, true);
  });

  it("isSpecificRealPlace is true when name+city are both set (even without canonical_place_id)", () => {
    const snap = buildSnapshot(
      "place",
      "place_header",
      {
        id: "p1", name: "Harbor Catch", category: "food", city: "Cebu City",
        canonical_place_id: null, provider_place_id: null,
        header_image_url: null, header_image_source: null, header_image_updated_at: null,
      },
      "portava_editorial",
    );
    assert.equal(snap.isSpecificRealPlace, true);
  });

  it("isSpecificRealPlace is false when entityType is not 'place'", () => {
    const snap = buildSnapshot(
      "event",
      "event_header",
      { id: "e1", title: "Rooftop Party", category: "nightlife", city: "Makati", canonical_place_id: "c-001" },
      "portava_editorial",
    );
    assert.equal(snap.isSpecificRealPlace, false);
  });
});

// ── requestGeneration: no_reference_fallback behaviour ───────────────────────

const ALICE_ID = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
const PLACE_ID  = "place-service-test-001";

function makePlaceFakeSc(placeRow: Record<string, any>) {
  return {
    from(table: string) {
      let _eqCols: Record<string, any> = {};
      const b: any = {
        select()                  { return b; },
        insert()                  { return b; },
        update()                  { return b; },
        eq(col: string, val: any) { _eqCols[col] = val; return b; },
        in()                      { return b; },
        gte()                     { return b; },
        limit()                   { return b; },
        order()                   { return b; },
        maybeSingle()             { return b.single(); },
        async single() {
          if (table === "feature_flags") return { data: null, error: null };
          if (table === "generated_visuals") {
            if (_eqCols["moderation_status"] === "entity_blocked") return { data: null, error: null };
            return { data: null, error: null };
          }
          if (table === "discovery_places") return { data: placeRow, error: null };
          return { data: null, error: null };
        },
        async then(onF: any) { return onF({ data: [], error: null, count: 0 }); },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}

describe("requestGeneration — no_reference_fallback for specific real places", () => {
  afterEach(() => {
    _setTestClient(null as any, false);
  });

  it("returns no_reference_fallback and ok=false when specific real place has no refs", async () => {
    const fakeSc = makePlaceFakeSc({
      id: PLACE_ID,
      name: "Kawasan Falls",
      category: "attraction",
      city: "Cebu",
      country: "Philippines",
      canonical_place_id: "canonical-kawasan-001",
      provider_place_id: null,
      header_image_url: null,
      header_image_source: null,
      header_image_updated_at: null,
    });
    _setTestClient(fakeSc as any, true);

    const outcome = await requestGeneration({
      entityType: "place",
      entityId: PLACE_ID,
      purpose: "place_header",
      ownerUserId: ALICE_ID,
      // No referenceImageUrls
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, "no_reference_fallback");
    assert.equal(outcome.error, "specific_place_requires_reference_images");
  });

  it("does NOT insert a generated_visuals row when returning no_reference_fallback", async () => {
    let insertCalled = false;
    const fakeSc = {
      from(table: string) {
        let _eqCols: Record<string, any> = {};
        const b: any = {
          select()                  { return b; },
          insert() {
            if (table === "generated_visuals") insertCalled = true;
            return b;
          },
          update()                  { return b; },
          eq(col: string, val: any) { _eqCols[col] = val; return b; },
          in()                      { return b; },
          gte()                     { return b; },
          limit()                   { return b; },
          order()                   { return b; },
          maybeSingle()             { return b.single(); },
          async single() {
            if (table === "feature_flags") return { data: null, error: null };
            if (table === "generated_visuals") return { data: null, error: null };
            if (table === "discovery_places") {
              return {
                data: {
                  id: PLACE_ID,
                  name: "SM Seaside",
                  category: "shopping",
                  city: "Cebu City",
                  country: "Philippines",
                  canonical_place_id: "canonical-sm-001",
                  provider_place_id: null,
                  header_image_url: null,
                  header_image_source: null,
                  header_image_updated_at: null,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
          async then(onF: any) { return onF({ data: [], error: null, count: 0 }); },
        };
        return b;
      },
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    };

    _setTestClient(fakeSc as any, true);
    const outcome = await requestGeneration({
      entityType: "place",
      entityId: PLACE_ID,
      purpose: "place_header",
      ownerUserId: ALICE_ID,
    });
    assert.equal(outcome.status, "no_reference_fallback");
    assert.equal(insertCalled, false, "no generated_visuals row must be inserted for no_reference_fallback");
  });
});

// ── Fallback ResolvedHeaderImage for specific places ─────────────────────────

describe("resolveHeaderImage — fallback for specific real places", () => {
  it("category_fallback candidate for a specific place has imageSourceType=category_fallback", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/fallback/attraction.webp", source: "category_fallback" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.source, "category_fallback");
  });

  it("category_fallback for a specific place has disclaimerRequired=true", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/fallback/attraction.webp", source: "category_fallback" }],
      { isSpecificRealPlace: true },
    );
    assert.ok(result !== null);
    assert.equal(result!.disclaimerRequired, true);
  });

  it("category_fallback for a NON-specific entity does not carry disclaimerRequired", () => {
    const result = resolveHeaderImage(
      [{ url: "https://cdn.example.com/fallback/attraction.webp", source: "category_fallback" }],
      { isSpecificRealPlace: false },
    );
    assert.ok(result !== null);
    assert.ok(result!.disclaimerRequired !== true);
  });
});
