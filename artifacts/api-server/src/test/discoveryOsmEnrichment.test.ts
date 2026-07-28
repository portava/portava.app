/**
 * Unit tests for the enrichOsmSavedCounts enrichment pipeline.
 *
 * Exercises the internal helper (exposed via _testEnrichOsmSavedCounts) that
 * attaches vote aggregates (worthItCount / avgRating / reviewCount) and
 * savedCount to OSM places that have a matching row in discovery_places.
 *
 * Three scenarios are covered:
 *  1. Matching discovery_places row with vote data → counts appear on the returned place.
 *  2. No matching discovery_places row → place returned unchanged.
 *  3. DB error during enrichment → places returned as-is (non-fatal).
 *
 * Run: node --import tsx/esm --test src/test/discoveryOsmEnrichment.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _testEnrichOsmSavedCounts, type DiscoveryPlace } from "../routes/discovery.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function osmPlace(osmId: string, overrides: Partial<DiscoveryPlace> = {}): DiscoveryPlace {
  return {
    id:           osmId,
    name:         `Place ${osmId}`,
    category:     "for_you",
    type:         "traveler_pick",
    description:  "A spot",
    distanceKm:   1.0,
    lat:          25.77,
    lng:          -80.19,
    tags:         [],
    address:      "Miami, FL",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       null,
    isOpenNow:    null,
    ...overrides,
  };
}

/**
 * Minimal fake Supabase service client.
 *
 * Supports:
 *   - discovery_places: .select("id, osm_id, saved_count").in("osm_id", ids)
 *   - place_votes:      .select("entity_id, vote").eq("entity_type","place").in("entity_id", ids)
 *   - reviews:          .select("entity_id, rating").eq("entity_type","place").in("entity_id", ids).eq("state","published")
 *
 * Rows are filtered in-memory using the accumulated eq/in predicates.
 */
function makeFakeClient(opts: {
  discoveryPlaces: Array<{ id: string; osm_id: string; saved_count: number }>;
  placeVotes:      Array<{ entity_id: string; entity_type: string; vote: string }>;
  reviews:         Array<{ entity_id: string; entity_type: string; state: string; rating: string | number }>;
  throwOnTable?:   string;
}) {
  function buildChain(rows: Record<string, unknown>[]) {
    const eqFilters:  Array<(r: Record<string, unknown>) => boolean> = [];
    const inFilters:  Array<(r: Record<string, unknown>) => boolean> = [];

    const obj: any = {
      select() { return obj; },
      eq(col: string, val: unknown) {
        eqFilters.push((r) => r[col] === val);
        return obj;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push((r) => vals.includes(r[col] as unknown));
        return obj;
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        if (opts.throwOnTable) {
          // Simulated DB error: resolve with an error envelope (Supabase style)
          return resolve({ data: null, error: new Error("simulated DB error") });
        }
        const allFilters = [...eqFilters, ...inFilters];
        const matched    = rows.filter((r) => allFilters.every((f) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
    return obj;
  }

  return {
    from(table: string) {
      if (table === "discovery_places") {
        if (opts.throwOnTable === "discovery_places") {
          return buildChain([]);
        }
        return buildChain(opts.discoveryPlaces as unknown as Record<string, unknown>[]);
      }
      if (table === "place_votes") {
        return buildChain(opts.placeVotes as unknown as Record<string, unknown>[]);
      }
      if (table === "reviews") {
        return buildChain(opts.reviews as unknown as Record<string, unknown>[]);
      }
      return buildChain([]);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  _clearTestClient();
});

describe("enrichOsmSavedCounts — vote data attached when discovery_places row exists", () => {
  it("populates worthItCount, avgRating, reviewCount, and savedCount from matched row", async () => {
    const OSM_ID = "node/cafe-enrich-1";
    const UUID   = "uuid-cafe-enrich-1";

    const fake = makeFakeClient({
      discoveryPlaces: [{ id: UUID, osm_id: OSM_ID, saved_count: 7 }],
      placeVotes:      [
        { entity_id: UUID, entity_type: "place", vote: "worth_it" },
        { entity_id: UUID, entity_type: "place", vote: "worth_it" },
        { entity_id: UUID, entity_type: "place", vote: "not_worth_it" },
      ],
      reviews: [
        { entity_id: UUID, entity_type: "place", state: "published", rating: "4.0" },
        { entity_id: UUID, entity_type: "place", state: "published", rating: "5.0" },
      ],
    });
    _setTestClient(fake, true);

    const places  = [osmPlace(OSM_ID)];
    const result  = await _testEnrichOsmSavedCounts(places);

    assert.equal(result.length, 1, "must return one place");
    const p = result[0];

    assert.equal(p.savedCount,   7,   "savedCount must be taken from discovery_places.saved_count");
    assert.equal(p.worthItCount, 2,   "worthItCount must count only 'worth_it' votes");
    assert.equal(p.reviewCount,  2,   "reviewCount must reflect the number of published reviews");
    assert.equal(p.avgRating,    4.5, "avgRating must be the mean of review ratings (rounded to 1dp)");
  });

  it("does not alter other fields while attaching vote aggregates", async () => {
    const OSM_ID = "node/cafe-fields-1";
    const UUID   = "uuid-cafe-fields-1";

    const fake = makeFakeClient({
      discoveryPlaces: [{ id: UUID, osm_id: OSM_ID, saved_count: 3 }],
      placeVotes:      [{ entity_id: UUID, entity_type: "place", vote: "worth_it" }],
      reviews:         [],
    });
    _setTestClient(fake, true);

    const original = osmPlace(OSM_ID, { name: "Biscayne Café", rating: 4.2 });
    const [enriched] = await _testEnrichOsmSavedCounts([original]);

    assert.equal(enriched.name,   "Biscayne Café", "name must be preserved");
    assert.equal(enriched.rating, 4.2,             "OSM rating must be preserved");
    assert.equal(enriched.id,     OSM_ID,          "id must be preserved");
  });
});

describe("enrichOsmSavedCounts — place without a matching discovery_places row is unchanged", () => {
  it("returns the place unchanged when no discovery_places row matches", async () => {
    const OSM_ID = "node/park-no-match-1";

    const fake = makeFakeClient({
      discoveryPlaces: [], // no match for this osm_id
      placeVotes:      [],
      reviews:         [],
    });
    _setTestClient(fake, true);

    const original = osmPlace(OSM_ID, { rating: 3.9 });
    const [result]  = await _testEnrichOsmSavedCounts([original]);

    assert.equal(result.id,        OSM_ID, "id must be unchanged");
    assert.equal(result.rating,    3.9,    "rating must be unchanged");
    assert.equal(result.savedCount,    undefined, "savedCount must not be set");
    assert.equal(result.worthItCount,  undefined, "worthItCount must not be set");
    assert.equal(result.avgRating,     undefined, "avgRating must not be set");
    assert.equal(result.reviewCount,   undefined, "reviewCount must not be set");
  });

  it("handles a mixed list — matched place gets counts, unmatched place stays unchanged", async () => {
    const MATCHED_ID   = "node/bar-matched-1";
    const UNMATCHED_ID = "node/bar-unmatched-1";
    const UUID         = "uuid-bar-matched-1";

    const fake = makeFakeClient({
      discoveryPlaces: [{ id: UUID, osm_id: MATCHED_ID, saved_count: 4 }],
      placeVotes:      [{ entity_id: UUID, entity_type: "place", vote: "worth_it" }],
      reviews:         [{ entity_id: UUID, entity_type: "place", state: "published", rating: "3.5" }],
    });
    _setTestClient(fake, true);

    const places = [osmPlace(MATCHED_ID), osmPlace(UNMATCHED_ID)];
    const result = await _testEnrichOsmSavedCounts(places);

    assert.equal(result.length, 2, "must return both places");

    const matched   = result.find((p) => p.id === MATCHED_ID)!;
    const unmatched = result.find((p) => p.id === UNMATCHED_ID)!;

    assert.ok(matched,   "matched place must be present");
    assert.ok(unmatched, "unmatched place must be present");

    assert.equal(matched.savedCount,   4,   "matched place must have savedCount");
    assert.equal(matched.worthItCount, 1,   "matched place must have worthItCount");
    assert.equal(matched.reviewCount,  1,   "matched place must have reviewCount");
    assert.equal(matched.avgRating,    3.5, "matched place must have avgRating");

    assert.equal(unmatched.savedCount,   undefined, "unmatched place must not have savedCount");
    assert.equal(unmatched.worthItCount, undefined, "unmatched place must not have worthItCount");
  });
});

describe("enrichOsmSavedCounts — non-fatal on DB error", () => {
  it("returns places unchanged when the discovery_places query returns an error", async () => {
    const OSM_ID = "node/err-place-1";

    const fake = makeFakeClient({
      discoveryPlaces: [],
      placeVotes:      [],
      reviews:         [],
      throwOnTable:    "discovery_places", // simulates a DB error response
    });
    _setTestClient(fake, true);

    const original = osmPlace(OSM_ID, { rating: 4.1 });
    // Must resolve (not throw) and return the original place as-is
    const result   = await _testEnrichOsmSavedCounts([original]);

    assert.equal(result.length, 1,      "must still return one place on error");
    assert.equal(result[0].id,  OSM_ID, "id must be preserved on error path");
    assert.equal((result[0] as any).worthItCount, undefined, "worthItCount must not be set on error path");
  });

  it("returns an empty input list when no places are given (no DB call)", async () => {
    // No client needed — enrichOsmSavedCounts bails out immediately for empty input.
    const result = await _testEnrichOsmSavedCounts([]);
    assert.deepEqual(result, [], "empty input must return empty array");
  });
});
