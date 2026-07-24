/**
 * FSQ Places — category mapping + transform + read service tests.
 *
 * The DuckDB ingestion script itself needs the real (gated) parquet, so it's
 * exercised operationally; here we lock down the pure, verifiable core: the
 * category mapper, the row transform (drops/normalization), and the flag-gated
 * read service.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapFsqCategory, primaryLabel } from "../lib/fsq/categoryMap.js";
import { fsqRowToDbRow, FSQ_SOURCE } from "../lib/fsq/fsqTransform.js";
import { getCityPlaces, getCityCategoryCounts, fsqEnabled, FSQ_ATTRIBUTION } from "../lib/fsq/fsqPlaces.js";

// ── Category mapping ────────────────────────────────────────────────────────

describe("mapFsqCategory", () => {
  it("maps lodging to accommodation (before anything else)", () => {
    assert.equal(mapFsqCategory(["Travel and Transportation > Lodging > Hotel"]), "accommodation");
    assert.equal(mapFsqCategory(["Hostel"]), "accommodation");
    assert.equal(mapFsqCategory(["Resort"]), "accommodation");
  });
  it("maps bars/clubs to nightlife before generic dining", () => {
    assert.equal(mapFsqCategory(["Dining and Drinking > Bar > Cocktail Bar"]), "nightlife");
    assert.equal(mapFsqCategory(["Nightlife Spot > Night Club"]), "nightlife");
    assert.equal(mapFsqCategory(["Brewery"]), "nightlife");
  });
  it("maps restaurants/cafés to food", () => {
    assert.equal(mapFsqCategory(["Dining and Drinking > Restaurant > Italian Restaurant"]), "food");
    assert.equal(mapFsqCategory(["Café"]), "food");
    assert.equal(mapFsqCategory(["Coffee Shop"]), "food");
  });
  it("maps museums/landmarks to culture", () => {
    assert.equal(mapFsqCategory(["Arts and Entertainment > Museum"]), "culture");
    assert.equal(mapFsqCategory(["Landmarks and Outdoors > Monument"]), "culture");
    assert.equal(mapFsqCategory(["Temple"]), "culture");
  });
  it("maps retail to shopping", () => {
    assert.equal(mapFsqCategory(["Retail > Clothing Store"]), "shopping");
    assert.equal(mapFsqCategory(["Shopping Mall"]), "shopping");
  });
  it("word-boundary: 'barber' is not nightlife, 'barbecue' is food-ish not bar", () => {
    assert.notEqual(mapFsqCategory(["Barbershop"]), "nightlife");
    assert.notEqual(mapFsqCategory(["Barber"]), "nightlife");
  });
  it("unknown → other; empty → other", () => {
    assert.equal(mapFsqCategory(["Business and Professional Services > Accountant"]), "other");
    assert.equal(mapFsqCategory([]), "other");
    assert.equal(mapFsqCategory(null), "other");
  });
  it("primaryLabel returns the deepest segment", () => {
    assert.equal(primaryLabel(["Dining and Drinking > Restaurant > Thai Restaurant"]), "Thai Restaurant");
    assert.equal(primaryLabel(["Hotel"]), "Hotel");
    assert.equal(primaryLabel([]), null);
  });
});

// ── Transform ────────────────────────────────────────────────────────────────

describe("fsqRowToDbRow", () => {
  const ctx = { cityKey: "cebu-ph", datasetDate: "2026-06-01" };
  const good = {
    fsq_place_id: "abc123", name: "Café Lechon", latitude: 10.3, longitude: 123.9,
    address: "1 Colon St", locality: "Cebu City", region: "Cebu", postcode: "6000", country: "PH",
    fsq_category_ids: ["4bf58dd8d48988d16d941735"], fsq_category_labels: ["Dining and Drinking > Café"],
  };

  it("transforms a good row with provider labeling", () => {
    const r = fsqRowToDbRow(good, ctx)!;
    assert.equal(r.fsq_id, "abc123");
    assert.equal(r.category, "food");
    assert.equal(r.city_key, "cebu-ph");
    assert.equal(r.source, FSQ_SOURCE);
    assert.equal(r.confidence, "provider");
    assert.equal(r.dataset_date, "2026-06-01");
    assert.equal(r.fsq_primary_label, "Café");
  });

  it("drops rows with no id / no name / no coords / closed / out-of-range", () => {
    assert.equal(fsqRowToDbRow({ ...good, fsq_place_id: null }, ctx), null);
    assert.equal(fsqRowToDbRow({ ...good, name: "  " }, ctx), null);
    assert.equal(fsqRowToDbRow({ ...good, latitude: null }, ctx), null);
    assert.equal(fsqRowToDbRow({ ...good, date_closed: "2025-01-01" }, ctx), null);
    assert.equal(fsqRowToDbRow({ ...good, latitude: 999 }, ctx), null);
  });

  it("tolerates missing optional fields", () => {
    const r = fsqRowToDbRow({ fsq_place_id: "x", name: "Spot", latitude: 1, longitude: 2 }, ctx)!;
    assert.equal(r.category, "other");
    assert.deepEqual(r.fsq_category_labels, []);
    assert.equal(r.address, null);
  });
});

// ── Read service ─────────────────────────────────────────────────────────────

function makeSc(opts: { flagOn?: boolean; rows?: any[] } = {}) {
  return {
    from(table: string) {
      const b: any = {
        _f: [] as Array<[string, any]>,
        select() { return b; },
        eq(k: string, v: any) { b._f.push([k, v]); return b; },
        limit() { return b; },
        maybeSingle: async () => (table === "feature_flags" ? { data: { enabled: opts.flagOn === true }, error: null } : { data: null, error: null }),
        then(resolve: any) {
          if (table === "fsq_places") {
            const cat = b._f.find((f: any) => f[0] === "category")?.[1];
            const rows = (opts.rows ?? []).filter((r) => !cat || r.category === cat);
            resolve({ data: rows, error: null });
          } else resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as any;
}

const ROWS = [
  { fsq_id: "1", name: "Hotel A", latitude: 10.3, longitude: 123.9, category: "accommodation", fsq_primary_label: "Hotel", address: null, locality: "Cebu", country: "PH", confidence: "provider", dataset_date: "2026-06-01" },
  { fsq_id: "2", name: "Bar B", latitude: 10.31, longitude: 123.91, category: "nightlife", fsq_primary_label: "Bar", address: null, locality: "Cebu", country: "PH", confidence: "provider", dataset_date: "2026-06-01" },
];

describe("FSQ read service", () => {
  it("fsqEnabled reflects the flag / fails closed", async () => {
    assert.equal(await fsqEnabled(makeSc({ flagOn: true })), true);
    assert.equal(await fsqEnabled(makeSc({ flagOn: false })), false);
    assert.equal(await fsqEnabled({ from() { throw new Error("x"); } } as any), false);
  });

  it("getCityPlaces returns places + attribution, filters by category", async () => {
    const all = await getCityPlaces(makeSc({ rows: ROWS }), { cityKey: "cebu-ph" });
    assert.equal(all.places.length, 2);
    assert.equal(all.attribution, FSQ_ATTRIBUTION);
    assert.equal(all.datasetDate, "2026-06-01");

    const hotels = await getCityPlaces(makeSc({ rows: ROWS }), { cityKey: "cebu-ph", category: "accommodation" });
    assert.equal(hotels.places.length, 1);
    assert.equal(hotels.places[0].category, "accommodation");
  });

  it("getCityCategoryCounts tallies by category", async () => {
    const counts = await getCityCategoryCounts(makeSc({ rows: ROWS }), "cebu-ph");
    assert.equal(counts.accommodation, 1);
    assert.equal(counts.nightlife, 1);
  });

  it("fail-soft empty on missing client / city", async () => {
    const r = await getCityPlaces(null, { cityKey: "x" });
    assert.deepEqual(r.places, []);
  });
});
