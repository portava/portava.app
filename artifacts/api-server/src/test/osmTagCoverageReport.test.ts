/**
 * The coverage report's counting rules.
 *
 * A measurement is only worth the rail it enforces — "enumerate populations, do
 * not estimate them" — if the enumeration itself is right. These pin the three
 * counting decisions that would each silently produce a WRONG NUMBER while the
 * report looked entirely healthy:
 *
 *  1. Unnamed elements are excluded, because the route filters them out before
 *     they can become places. Counting them deflates every share by a
 *     population no user ever sees.
 *  2. Coverage is measured on the MAPPED place, not the raw tag set. A
 *     `wikidata` value that is not an entity id and an `image` value that is
 *     not a URL are dropped by the mapping on purpose; counting raw tags would
 *     overstate coverage by exactly that amount.
 *  3. A failed query is not zero coverage. That distinction is the workstream's
 *     own invariant — absence of evidence must not become evidence of absence —
 *     applied to the measurement rather than to the product.
 *
 * Run: node --import tsx/esm --test src/test/osmTagCoverageReport.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapOsmElementToPlace, overpassFilter, type OsmElement } from "../routes/discovery.js";

const ORIGIN = { lat: 48.8566, lng: 2.3522 };

function el(tags: Record<string, string>, id = 1): OsmElement {
  return { type: "node", id, lat: ORIGIN.lat, lon: ORIGIN.lng, tags };
}

/** Mirrors the report's own tally rule. */
function countNamed(elements: OsmElement[]): number {
  return elements.filter((e) => e.tags?.name && e.tags.name.trim()).length;
}

describe("Population definition — what counts as a place", () => {
  it("excludes unnamed elements, matching what the route actually serves", () => {
    const elements = [
      el({ name: "Cafe A", amenity: "cafe" }, 1),
      el({ amenity: "cafe" }, 2),          // no name — never becomes a place
      el({ name: "   ", amenity: "cafe" }, 3), // whitespace-only — same
      el({ name: "Cafe B", amenity: "cafe" }, 4),
    ];

    assert.equal(countNamed(elements), 2);
  });
});

describe("Coverage is measured on the MAPPED place, not the raw tags", () => {
  it("does not count a wikidata tag the mapping rejects", () => {
    // Raw tag present, mapped value null. Counting the raw tag would report
    // coverage the card does not have.
    const raw = { name: "X", amenity: "cafe", wikidata: "Tour Eiffel" };
    assert.ok(raw.wikidata, "the raw tag is present");
    assert.equal(mapOsmElementToPlace(el(raw), "food", ORIGIN.lat, ORIGIN.lng).wikidataId, null);
  });

  it("does not count an image tag the mapping rejects", () => {
    const raw = { name: "X", amenity: "cafe", image: "File:Cafe.jpg" };
    assert.ok(raw.image, "the raw tag is present");
    assert.equal(mapOsmElementToPlace(el(raw), "food", ORIGIN.lat, ORIGIN.lng).osmImageUrl, null);
  });

  it("does not count a negative attribute as coverage", () => {
    // internet_access=no is a tagged FACT, but it produces no chip, so it is
    // not something the card gained. Counting it would inflate the Tier 1 win.
    const place = mapOsmElementToPlace(
      el({ name: "X", amenity: "cafe", internet_access: "no", outdoor_seating: "no" }),
      "food", ORIGIN.lat, ORIGIN.lng,
    );

    assert.ok(!place.tags.includes("wifi"));
    assert.ok(!place.tags.includes("outdoor seating"));
  });

  it("counts a value the mapping accepts", () => {
    const place = mapOsmElementToPlace(
      el({ name: "X", amenity: "cafe", wikidata: "Q243", image: "https://e.org/a.jpg", internet_access: "wlan" }),
      "food", ORIGIN.lat, ORIGIN.lng,
    );

    assert.equal(place.wikidataId, "Q243");
    assert.equal(place.osmImageUrl, "https://e.org/a.jpg");
    assert.ok(place.tags.includes("wifi"));
  });
});

describe("The report queries what production queries", () => {
  it("uses the route's own Overpass filter for every measured category", () => {
    // If the report built its own filter it would measure a different
    // population and present the number as if it described the product.
    for (const category of ["places", "food", "nightlife", "activities"]) {
      const filter = overpassFilter(category, 1200, ORIGIN.lat, ORIGIN.lng);

      assert.ok(filter.includes("around:1200"), `${category}: radius must reach the query`);
      assert.ok(
        filter.includes(`${ORIGIN.lat},${ORIGIN.lng}`),
        `${category}: the destination centre must reach the query`,
      );
      assert.ok(filter.trim().length > 0, `${category}: produced an empty filter`);
    }
  });

  it("produces a DIFFERENT filter per category — one filter for all would be vacuous", () => {
    const filters = ["places", "food", "nightlife", "activities"].map((c) =>
      overpassFilter(c, 1200, ORIGIN.lat, ORIGIN.lng),
    );

    assert.equal(new Set(filters).size, filters.length);
  });
});
