/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B23, probes PR0–PR2): a paged read is
 * never answered whole over rows a concurrent write shifted between two pages.
 *
 * `readAllPages` paged with an OFFSET (`.range(from, to)`, `from` = rows received). Each page is its own statement, so a
 * row written between two pages shifts every later offset: a delete ahead of the cursor made the next page SKIP a row
 * that existed throughout, an insert ahead of it made the next page REPEAT one, and the read compared the rows received
 * only with the LATEST page's count, which moves with the same write — so it was answered whole (`error: null`) and
 * `liveEventCounters` stamped the wrong count onto the rows GET /events serves and ranks.
 *
 * The read now pages by KEY: each page asks for the rows after the last row received (`(event_id, user_id) > last`),
 * so a write elsewhere in the set moves no boundary; a page that repeats a row (a server that ignored the cursor) is a
 * cut read. An unkeyed read (none in production) treats a total that changed between pages as a cut read.
 *
 * World (the verifier's): E1 has 600 going, E2 900; ordered by (event_id, user_id), E1's rows are 0..599 and E2's
 * 600..1499. The double is a LIVE table behind PostgREST's grammar: every awaited read is one statement over the table
 * as it is then (filters, `.or()` keyset, every `.order()`, `.range()`, an exact count, db-max-rows 1000), and
 * `between(page, t)` writes after page `page` is served.
 *
 *   PW0  CONTROL (the verifier's PR0): nothing written between pages → E1 600, E2 900, nothing named
 *   PW1  (PR1) one E1 traveller leaves between page 1 and 2 → E2 (900 throughout) is never served 899 as measured
 *   PW2  (PR2) one traveller joins E1 between page 1 and 2 → E2 is never served 901, no row is read twice
 *   PW3  an E1 traveller leaves and an E2 traveller joins (the total is unchanged) → every E2 traveller going throughout
 *        is read: no key that existed throughout goes missing
 *   PW4  one event's RSVPs (readEventRsvps), a traveller joins ahead of the cursor between pages → no row read twice
 *   PW5  a server that ignores the cursor (answers the first rows again) → a cut read, never a row answered twice
 *   PW6  an unkeyed read whose total changes between pages → a cut read (PAGED_READ_CUT)
 *   PW7  a server that applies the cursor INCLUSIVELY (the last row again at the head of the next page) → a cut read on
 *        the second page, never that row counted twice
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveEventCounters, readGoingRsvpsForEvents, readEventRsvps } from "../lib/eventRowReads.js";
import { readAllPages, PAGED_READ_CUT } from "../lib/pagedRead.js";
import { logicFilter, sortByOrders } from "./helpers/postgrestKeyset.js";

const E1 = "e1000000-0000-4000-8000-000000000001";
const E2 = "e2000000-0000-4000-8000-000000000002";
const uid = (p: string, i: number) => `${p}${String(i).padStart(12, "0")}`.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
type Row = { event_id: string; user_id: string; status: string };
function table(): Row[] {
  const t: Row[] = [];
  for (let i = 0; i < 600; i++) t.push({ event_id: E1, user_id: uid("a0000000400080", i + 10), status: "going" });
  for (let i = 0; i < 900; i++) t.push({ event_id: E2, user_id: uid("b0000000400080", i + 10), status: "going" });
  return t;
}
const key = (r: { event_id: string; user_id: string }) => `${r.event_id}|${r.user_id}`;

/** A PostgREST-shaped double over a LIVE table; `between(page, t)` runs after page `page` is served. */
function client(t: Row[], between: (page: number, t: Row[]) => void, o: { ignoreCursor?: boolean; inclusive?: boolean } = {}) {
  let served = 0;
  return {
    from(name: string) {
      assert.equal(name, "event_rsvps");
      const preds: Array<(r: Row) => boolean> = []; const orders: Array<{ col: string; asc?: boolean }> = [];
      let rng: [number, number] = [0, 999]; let counted = false;
      const q: any = {
        select: (_c: string, opts?: { count?: string }) => { counted = opts?.count === "exact"; return q; },
        in: (c: string, v: string[]) => { preds.push((r: any) => v.includes(r[c])); return q; },
        eq: (c: string, v: string) => { preds.push((r: any) => r[c] === v); return q; },
        gt: (c: string, v: string) => { if (!o.ignoreCursor) preds.push((r: any) => r[c] > v); return q; },
        or: (expr: string) => { const p = logicFilter(o.inclusive ? expr.replace(/user_id\.gt\./g, "user_id.gte.") : expr); assert.ok(p, `unmodelled .or(${expr})`); if (!o.ignoreCursor) preds.push(p as any); return q; },
        order: (col: string, opts?: { ascending?: boolean }) => { orders.push({ col, asc: opts?.ascending !== false }); return q; },
        range: (a: number, b: number) => { rng = [a, b]; return q; },
        then(res: any, rej: any) {
          const rows = sortByOrders(t.filter((r) => preds.every((p) => p(r))) as any[], orders) as Row[];
          const page = rows.slice(rng[0], Math.min(rng[1] + 1, rng[0] + 1000));
          const out = { data: page.map((r) => ({ event_id: r.event_id, user_id: r.user_id, status: r.status })), error: null, count: counted ? rows.length : null };
          served++; between(served, t);
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}
const none = () => {};
async function run(between: (page: number, t: Row[]) => void) {
  const evRows = [{ id: E1, going_count: 600 }, { id: E2, going_count: 900 }];
  const failed = await liveEventCounters(client(table(), between), evRows, { going: true });
  const read = await readGoingRsvpsForEvents(client(table(), between), [E1, E2]);
  const keys = (read.data ?? []).map(key);
  return { E1: evRows[0].going_count, E2: evRows[1].going_count, failed, rowsRead: keys.length, duplicateKeys: keys.length - new Set(keys).size, keys: new Set(keys), error: read.error };
}
const seen = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify({ ...r, keys: undefined });

describe("census-discovery §118 (B23): a paged read under a write between two pages", () => {
  it("PW0 CONTROL: nothing written between pages → E1 600, E2 900, nothing named", async () => {
    const r = await run(none);
    assert.deepEqual({ E1: r.E1, E2: r.E2, failed: r.failed, dup: r.duplicateKeys, rows: r.rowsRead, error: r.error }, { E1: 600, E2: 900, failed: [], dup: 0, rows: 1500, error: null });
  });
  it("PW1 an E1 traveller leaves between page 1 and 2 → E2 (900 throughout) is never served 899 as measured", async () => {
    const r = await run((page, t) => { if (page === 1) t.splice(10, 1); });
    assert.ok(r.failed.includes("event_rsvps") || r.E2 === 900, seen(r));
    assert.ok(r.error !== null || r.duplicateKeys === 0, seen(r));
  });
  it("PW2 a traveller joins E1 between page 1 and 2 → E2 is never served 901 and no row is read twice", async () => {
    const r = await run((page, t) => { if (page === 1) t.push({ event_id: E1, user_id: uid("a0000000400080", 5), status: "going" }); });
    assert.ok(r.failed.includes("event_rsvps") || r.E2 === 900, seen(r));
    assert.ok(r.error !== null || r.duplicateKeys === 0, seen(r));
  });
  it("PW3 an E1 traveller leaves and an E2 traveller joins (total unchanged) → no E2 traveller going throughout goes missing", async () => {
    const r = await run((page, t) => { if (page === 1) { t.splice(10, 1); t.push({ event_id: E2, user_id: uid("b0000000400080", 5000), status: "going" }); } });
    const throughout = table().filter((x) => x.event_id === E2).map(key);
    const missing = throughout.filter((k) => !r.keys.has(k));
    assert.ok(r.error !== null || missing.length === 0, `${missing.length} key(s) that existed throughout were skipped: ${seen(r)}`);
  });
  it("PW4 one event's RSVPs: a traveller joins ahead of the cursor between pages → no row read twice", async () => {
    const t = Array.from({ length: 1500 }, (_, i) => ({ event_id: E2, user_id: uid("b0000000400080", i + 10), status: "going" }));
    const read = await readEventRsvps(client(t, (page, tt) => { if (page === 1) tt.push({ event_id: E2, user_id: uid("b0000000400080", 1), status: "going" }); }), E2, { status: "going" });
    const ids = (read.data ?? []).map((r) => r.user_id);
    assert.ok(read.error !== null || ids.length === new Set(ids).size, JSON.stringify({ rows: ids.length, distinct: new Set(ids).size, error: read.error }));
    assert.ok(read.error !== null || ids.length >= 1500, JSON.stringify({ rows: ids.length }));
  });
  it("PW5 a server that ignores the cursor → a cut read, never a row answered twice", async () => {
    const read = await readGoingRsvpsForEvents(client(table(), none, { ignoreCursor: true }), [E1, E2]);
    const keys = (read.data ?? []).map(key);
    assert.ok(read.error !== null || keys.length === new Set(keys).size, JSON.stringify({ rows: keys.length, distinct: new Set(keys).size }));
    assert.equal(read.error?.code, PAGED_READ_CUT, JSON.stringify(read.error));
    assert.match(read.error!.message, /repeated a row/, "refused at the second page for the row it repeats, not later for its size");
  });
  it("PW7 a server that applies the cursor inclusively → a cut read on the second page, never that row counted twice", async () => {
    let pages = 0;
    const c = client(table(), () => { pages++; }, { inclusive: true });
    const read = await readGoingRsvpsForEvents(c, [E1, E2]);
    assert.equal(read.error?.code, PAGED_READ_CUT, JSON.stringify({ error: read.error, rows: read.data?.length }));
    assert.equal(pages, 2);
  });
  it("PW6 an unkeyed read whose total changes between pages → a cut read", async () => {
    let n = 1500; const calls: number[] = [];
    const r = await readAllPages(async (from, to) => { calls.push(from); const rows = Array.from({ length: Math.max(0, Math.min(to + 1, n) - from) }, (_, i) => ({ i: from + i })).slice(0, 1000); const out = { data: rows, error: null, count: n }; n += 1; return out; });
    assert.equal(r.error?.code, PAGED_READ_CUT, JSON.stringify({ error: r.error, calls, rows: r.data?.length }));
  });
});
