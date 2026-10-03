/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; the round-22 verifier's survivors X1–X3): the shared PostgREST
 * double helper orders NULL keys where PostgreSQL does.
 *
 * `sortByOrders` (helpers/postgrestKeyset.ts) compared a NULL key with `>` and so sorted it FIRST ascending. PostgreSQL,
 * and so PostgREST, sorts NULL LAST ascending and FIRST descending unless `NULLS FIRST` / `NULLS LAST` says otherwise
 * (supabase-js `nullsFirst`). No lane world could therefore hold an undated event (`starts_at` NULL, ordered last by the
 * events lists' `nullsFirst: false`) behind a dated one, and the events cursor's undated arms went unpinned: X1–X3
 * survived. The helper now takes `nullsFirst` and defaults it as PostgreSQL does.
 *
 *   NK0 ascending, no nullsFirst → NULL last
 *   NK1 descending, no nullsFirst → NULL first
 *   NK2 ascending, nullsFirst true → NULL first; NK3 descending, nullsFirst false → NULL last
 *   NK4 an undefined key is a NULL key; a tie on the first column falls to the next
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortByOrders } from "./helpers/postgrestKeyset.js";

const rows = [{ id: "c", t: "2030-01-02" }, { id: "a", t: null }, { id: "b", t: "2030-01-01" }];
const ids = (r: Array<{ id: string }>) => r.map((x) => x.id);

describe("census-discovery §122 (X1–X3): sortByOrders orders NULL keys as PostgreSQL does", () => {
  it("NK0 ascending → NULL last", () => {
    assert.deepEqual(ids(sortByOrders(rows, [{ col: "t", asc: true }])), ["b", "c", "a"]);
  });
  it("NK1 descending → NULL first", () => {
    assert.deepEqual(ids(sortByOrders(rows, [{ col: "t", asc: false }])), ["a", "c", "b"]);
  });
  it("NK2 ascending, nullsFirst true → NULL first", () => {
    assert.deepEqual(ids(sortByOrders(rows, [{ col: "t", asc: true, nullsFirst: true }])), ["a", "b", "c"]);
  });
  it("NK3 descending, nullsFirst false → NULL last", () => {
    assert.deepEqual(ids(sortByOrders(rows, [{ col: "t", asc: false, nullsFirst: false }])), ["c", "b", "a"]);
  });
  it("NK4 an undefined key is NULL; a tie falls to the next column", () => {
    const r = [{ id: "z", t: undefined }, { id: "y", t: null }, { id: "x", t: "2030-01-01" }] as Array<{ id: string; t: string | null | undefined }>;
    assert.deepEqual(ids(sortByOrders(r, [{ col: "t", asc: true }, { col: "id", asc: true }])), ["x", "y", "z"]);
  });
});
