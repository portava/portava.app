/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivor V5, fixture KC1): the going read's
 * keyset CURSOR columns are the ORDER BY columns (readGoingRsvpsForEvents, lib/eventRowReads.ts).
 *
 * A cursor on `["user_id", "event_id"]` under `.order("event_id").order("user_id")` survived every round-21 pin, because
 * every multi-event world there gives each later event user ids that all sort AFTER the earlier event's (E1 "a…", E2
 * "b…"). With the cursor on the wrong columns, page 2 asks for `user_id > last.user_id …`, so a later event's
 * travellers whose ids sort below the last row's are silently dropped and the narrowed count agrees: a whole read of 0.
 * These worlds break that assumption. Harness: pagedReadConcurrentWrites' PostgREST-shaped live-table double.
 *
 *   KC0 CONTROL: E1 600 "a…", E2 900 "b…" (the old worlds) → 600 / 900
 *   KC1 E1 1000 travellers "b…", E2 5 travellers "a…" (ids below E1's) → 1000 / 5, nothing named — never E2 0
 *   KC2 three events whose id ranges interleave against the event order (E1 "c…" ×1000, E2 "a…" ×3, E3 "b…" ×1200) →
 *       1000 / 3 / 1200, nothing named
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveEventCounters } from "../lib/eventRowReads.js";
import { logicFilter, sortByOrders } from "./helpers/postgrestKeyset.js";

const E1 = "e1000000-0000-4000-8000-000000000001";
const E2 = "e2000000-0000-4000-8000-000000000002";
const uid = (p: string, i: number) => `${p}${String(i).padStart(12, "0")}`.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
type Row = { event_id: string; user_id: string; status: string };
function tableOrig(): Row[] {
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

describe("census-discovery §119 (V5): the keyset cursor columns are the ORDER BY columns", () => {
  it("KC0 CONTROL: the suite's world → 600 / 900", async () => {
    const t = tableOrig(); const evRows = [{ id: E1, going_count: 1 }, { id: E2, going_count: 1 }];
    const failed = await liveEventCounters(client(t, () => {}), evRows, { going: true });
    assert.deepEqual({ E1: evRows[0].going_count, E2: evRows[1].going_count, failed }, { E1: 600, E2: 900, failed: [] });
  });
  it("KC1 E1 1000 'b…', E2 5 'a…' → 1000 / 5, never E2 0 as measured", async () => {
    const t: Row[] = [];
    for (let i = 0; i < 1000; i++) t.push({ event_id: E1, user_id: uid("b0000000400080", i + 10), status: "going" });
    for (let i = 0; i < 5; i++) t.push({ event_id: E2, user_id: uid("a0000000400080", i + 10), status: "going" });
    const evRows = [{ id: E1, going_count: 1 }, { id: E2, going_count: 1 }];
    const failed = await liveEventCounters(client(t, () => {}), evRows, { going: true });
    const seen = { E1: evRows[0].going_count, E2: evRows[1].going_count, failed };
    assert.deepEqual(seen, { E1: 1000, E2: 5, failed: [] });
  });
  it("KC2 three events whose user ids interleave against the event order → 1000 / 3 / 1200, nothing named", async () => {
    const E3 = "e3000000-0000-4000-8000-000000000003"; const t: Row[] = [];
    for (let i = 0; i < 1000; i++) t.push({ event_id: E1, user_id: uid("c0000000400080", i + 10), status: "going" });
    for (let i = 0; i < 3; i++) t.push({ event_id: E2, user_id: uid("a0000000400080", i + 10), status: "going" });
    for (let i = 0; i < 1200; i++) t.push({ event_id: E3, user_id: uid("b0000000400080", i + 10), status: "going" });
    const evRows = [{ id: E1, going_count: 1 }, { id: E2, going_count: 1 }, { id: E3, going_count: 1 }];
    const failed = await liveEventCounters(client(t, () => {}), evRows, { going: true });
    assert.deepEqual({ E1: evRows[0].going_count, E2: evRows[1].going_count, E3: evRows[2].going_count, failed }, { E1: 1000, E2: 3, E3: 1200, failed: [] });
  });
});
