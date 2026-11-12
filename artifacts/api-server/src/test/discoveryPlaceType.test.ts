import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalDisplayType, readSpecificPlaceTypes, PLACE_TYPE_ENRICHMENT_BUDGET_MS } from "../lib/discoveryPlaceType.js";
import { mapCanonicalPlacesRow } from "../lib/discoveryCandidates/materialize.js";

function providerTypes(data: unknown, error: unknown = null) {
  const queried: string[][] = [];
  return { queried, from(table: string) {
    assert.equal(table, "external_place_references");
    return { select(columns: string) { assert.equal(columns, "place_id, raw_category"); return {
      async in(column: string, ids: string[]) { assert.equal(column, "place_id"); queried.push(ids); return { data, error }; },
    }; } };
  } };
}

describe("Discovery displays explicit provider place types without guessing from names", () => {
  it("recovers bank and ATM source types only for generic rows in one lookup", async () => {
    const db = providerTypes([{ place_id: "bank", raw_category: "Bank" }, { place_id: "atm", raw_category: "amenity=atm" }, { place_id: "food", raw_category: "bank" }]);
    const result = await readSpecificPlaceTypes(db, [{ id: "bank", primary_category: "other" }, { id: "atm", primary_category: "other" }, { id: "food", primary_category: "food" }]);
    assert.deepEqual([...result], [["bank", "bank"], ["atm", "ATM"]]);
    assert.deepEqual(db.queried, [["bank", "atm"]]);
    const mapped = mapCanonicalPlacesRow({ id: "bank", name: "VPBank", primary_category: "other" }, null, result.get("bank"));
    assert.equal(mapped.type, "bank");
    assert.deepEqual(mapped.tags, ["bank"]);
  });

  it("does no enrichment query when the existing category is specific", async () => {
    const db = providerTypes([]);
    assert.equal((await readSpecificPlaceTypes(db, [{ id: "cafe", primary_category: "food" }])).size, 0);
    assert.equal(db.queried.length, 0);
    assert.equal(canonicalDisplayType("food", "bank"), "food");
  });

  it("conflicting, unavailable and unsupported source categories remain unknown", async () => {
    const rows = [{ id: "bank", primary_category: "other" }];
    for (const db of [
      providerTypes([{ place_id: "bank", raw_category: "bank" }, { place_id: "bank", raw_category: "atm" }]),
      providerTypes([{ place_id: "bank", raw_category: "suspicious bank-like label" }]),
      providerTypes(null, { code: "42501" }),
      { from() { throw new Error("unreachable"); } },
    ]) assert.equal((await readSpecificPlaceTypes(db, rows)).size, 0);
    const mapped = mapCanonicalPlacesRow({ id: "bank", name: "VPBank", primary_category: "other" });
    assert.equal(mapped.type, null);
    assert.deepEqual(mapped.tags, []);
  });

  it("an optional provider-type read cannot hold Discovery indefinitely", async () => {
    let signal: AbortSignal | undefined;
    const db = { from: () => ({ select: () => ({ in: () => ({ abortSignal(s: AbortSignal) { signal = s; return new Promise(() => {}); } }) }) }) };
    const start = performance.now();
    const result = await readSpecificPlaceTypes(db, [{ id: "bank", primary_category: "other" }]);
    assert.equal(result.size, 0);
    assert.equal(signal?.aborted, true, "the underlying HTTP read is cancelled too");
    assert.ok(performance.now() - start < PLACE_TYPE_ENRICHMENT_BUDGET_MS + 250);
  });
});
