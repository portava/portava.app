/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B21): `readAllPages` reads every row a
 * filter matches, or says it could not. A page PostgREST cut at db-max-rows is never taken for the whole set.
 *
 *   PR1   one short page → its rows, one request
 *   PR2   1250 rows, an exact count → two pages, [0,999] then [1000,1999]
 *   PR3   the server's max-rows (500) is below the page size → paged on from the rows received, never taken as the end
 *   PR4   no count in the answer → a short page is the last; a full one asks for the next
 *   PR4b  no count, exactly one full page → one more request answers 0 rows → whole
 *   PR5   an error on the second page → `{ data: null, error }`, never the first page's rows
 *   PR6   the count says 1500 but the second page is empty → a cut read (PAGED_READ_CUT), never 1000 rows as whole
 *   PR7   more rows than maxRows → a cut read
 *   PR8   a page whose data is not an array → a cut read
 *   PR9   a count of 0 → [] in one request
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readAllPages, PAGED_READ_CUT, PAGED_READ_PAGE_SIZE } from "../lib/pagedRead.js";

/** A table of `n` rows behind `.range()`, capped at `maxRows` per answer; `count` on or off. */
function table(n: number, o: { maxRows?: number; count?: boolean; countSays?: number; failAtPage?: number; badPage?: number } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  const calls: Array<[number, number]> = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    if (o.failAtPage === calls.length) return { data: null, error: { message: "timeout", code: "57014" }, count: null };
    if (o.badPage === calls.length) return { data: null, error: null, count: null };
    const slice = rows.slice(from, to + 1).slice(0, o.maxRows ?? 1000);
    return { data: slice, error: null, count: o.count === false ? null : (o.countSays ?? n) };
  };
  return { page, calls };
}

describe("census-discovery §117 (B21): readAllPages never takes a cut page for the whole set", () => {
  it("PR1 one short page → its rows, one request", async () => {
    const t = table(40); const r = await readAllPages(t.page);
    assert.equal(r.error, null); assert.equal(r.data?.length, 40); assert.deepEqual(t.calls, [[0, PAGED_READ_PAGE_SIZE - 1]]);
  });
  it("PR2 1250 rows with an exact count → two pages", async () => {
    const t = table(1250); const r = await readAllPages(t.page);
    assert.equal(r.data?.length, 1250); assert.deepEqual(t.calls, [[0, 999], [1000, 1999]]);
    assert.deepEqual(r.data!.map((x: any) => x.i), Array.from({ length: 1250 }, (_, i) => i));
  });
  it("PR3 the server's max-rows (500) is below the page size → paged on from the rows received", async () => {
    const t = table(1250, { maxRows: 500 }); const r = await readAllPages(t.page);
    assert.equal(r.error, null); assert.equal(r.data?.length, 1250);
    assert.deepEqual(t.calls, [[0, 999], [500, 1499], [1000, 1999]]);
  });
  it("PR4 no count → a short page is the last; a full page asks for the next", async () => {
    const t = table(1250, { count: false }); const r = await readAllPages(t.page);
    assert.equal(r.data?.length, 1250); assert.deepEqual(t.calls, [[0, 999], [1000, 1999]]);
  });
  it("PR4b no count, exactly one full page → one more request answers 0 rows → whole", async () => {
    const t = table(1000, { count: false }); const r = await readAllPages(t.page);
    assert.equal(r.data?.length, 1000); assert.deepEqual(t.calls, [[0, 999], [1000, 1999]]);
  });
  it("PR5 an error on the second page → no rows, the error", async () => {
    const t = table(1250, { failAtPage: 2 }); const r = await readAllPages(t.page);
    assert.equal(r.data, null); assert.equal(r.error?.code, "57014");
  });
  it("PR6 the count says 1500, the second page is empty → a cut read", async () => {
    const t = table(1000, { countSays: 1500 }); const r = await readAllPages(t.page);
    assert.equal(r.data, null); assert.equal(r.error?.code, PAGED_READ_CUT);
  });
  it("PR7 more rows than maxRows → a cut read", async () => {
    const t = table(2500); const r = await readAllPages(t.page, { maxRows: 2000 });
    assert.equal(r.data, null); assert.equal(r.error?.code, PAGED_READ_CUT);
    const ok = await readAllPages(table(2000).page, { maxRows: 2000 });
    assert.equal(ok.data?.length, 2000);
  });
  it("PR8 a page whose data is not an array → a cut read", async () => {
    const t = table(1250, { badPage: 2 }); const r = await readAllPages(t.page);
    assert.equal(r.data, null); assert.equal(r.error?.code, PAGED_READ_CUT);
  });
  it("PR9 a count of 0 → [] in one request", async () => {
    const t = table(0); const r = await readAllPages(t.page);
    assert.deepEqual(r.data, []); assert.equal(r.error, null); assert.equal(t.calls.length, 1);
  });
});
