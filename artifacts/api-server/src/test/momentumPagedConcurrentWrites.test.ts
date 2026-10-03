/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; sweep SW22, B23's class): the three momentum reads over
 * `rank_events` never answer a read a concurrent write shifted as whole.
 *
 * Local momentum (lib/discoveryLocalMomentum.ts), the emerging-Trails list (lib/discoveryTrendExplanation.ts) and a
 * Trail's member events (services/trails/TrailService.ts readMemberEvents) paged `rank_events` newest first by OFFSET.
 * `rank_events` is written on every serve, and every new serve lands at the HEAD of that order — ahead of the cursor —
 * so a serve logged between two pages shifted every later page by one: the next page repeated a row the read already
 * had, and the momentum, the trend reading or the impression count was computed over it as whole. Each read now pages by
 * key (`(served_at, id)` before the last row received), and a page that repeats a row (a server that ignored the cursor)
 * is a failed read.
 *
 * The double is a LIVE `rank_events` table behind PostgREST's grammar (filters, the `.or()` keyset, every `.order()`,
 * `.range()`, db-max-rows 1000); `between(page, t)` writes after page `page` is served, and every row served is
 * recorded, so a test sees what the read gathered.
 *
 *   MW0  CONTROL: local momentum over 2100 rows, nothing written between pages → no row served twice
 *   MW1  local momentum, a serve logged between page 1 and 2 → no row served twice, and the map equals MW0's
 *   MW2  a Trail's member impressions, a serve logged between pages → no row served twice, counts equal the control's
 *   MW3  the emerging-Trails read, a serve logged between pages → no row served twice
 *   MW4  local momentum over a server that ignores the cursor → a failed read (the empty map), never a row counted twice
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadLocalMomentum, computeLocalMomentum, _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import { readMemberImpressions } from "../services/trails/TrailService.js";
import { emergingPlacesAndTrails } from "../lib/discoveryTrendExplanation.js";
import { logicFilter, sortByOrders } from "./helpers/postgrestKeyset.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const P1 = "a1000000-0000-4000-8000-000000000001";
const P2 = "a2000000-0000-4000-8000-000000000002";
const T1 = "b1000000-0000-4000-8000-000000000001";
type Row = Record<string, any>;
const uuid = (i: number) => `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** 2100 serves over the last 20 days, alternating the two places, newest first by served_at. */
function rankEvents(itemOf: (p: string) => string = (p) => p): Row[] {
  return Array.from({ length: 2100 }, (_, i) => ({
    id: uuid(i), item_id: itemOf(i % 2 === 0 ? P1 : P2), outcome: i % 7 === 0 ? "save" : "impression", surface: "discovery", user_id: uuid(10_000 + (i % 40)),
    served_at: new Date(NOW - (i + 1) * 13 * 60_000).toISOString(), outcome_at: null,
  }));
}

function liveClient(world: Record<string, Row[]>, between: (page: number, t: Row[]) => void, o: { ignoreCursor?: boolean } = {}) {
  let pages = 0; const served: string[] = [];
  return {
    served,
    client: {
      from(table: string) {
        const rows = world[table] ?? [];
        const preds: Array<(r: Row) => boolean> = []; const orders: Array<{ col: string; asc?: boolean }> = [];
        let rng: [number, number] | null = null; let single = false;
        const q: any = {
          select: () => q, eq: (c: string, v: any) => { preds.push((r) => r[c] === v); return q; }, neq: (c: string, v: any) => { preds.push((r) => r[c] !== v); return q; },
          in: (c: string, v: any[]) => { preds.push((r) => v.includes(r[c])); return q; }, gte: (c: string, v: any) => { preds.push((r) => r[c] >= v); return q; },
          lte: (c: string, v: any) => { preds.push((r) => r[c] <= v); return q; },
          gt: (c: string, v: any) => { if (!o.ignoreCursor) preds.push((r) => String(r[c]) > String(v)); return q; },
          lt: (c: string, v: any) => { if (!o.ignoreCursor) preds.push((r) => String(r[c]) < String(v)); return q; },
          or: (expr: string) => { const p = logicFilter(expr); assert.ok(p, `unmodelled .or(${expr})`); if (!o.ignoreCursor) preds.push(p); return q; },
          order: (col: string, opts?: { ascending?: boolean }) => { orders.push({ col, asc: opts?.ascending !== false }); return q; },
          range: (a: number, b: number) => { rng = [a, b]; return q; }, limit: (n: number) => { rng = [0, n - 1]; return q; },
          is: () => q, not: () => q, ilike: () => q, like: () => q, contains: () => q, overlaps: () => q,
          maybeSingle: () => { single = true; return q; }, single: () => { single = true; return q; },
          then(res: any, rej: any) {
            let out = sortByOrders(rows.filter((r) => preds.every((p) => p(r))), orders);
            if (rng) out = out.slice(rng[0], rng[1] + 1);
            out = out.slice(0, 1000);
            if (table === "rank_events") { pages++; for (const r of out) served.push(String(r.id)); between(pages, world.rank_events!); }
            return Promise.resolve(single ? { data: out[0] ?? null, error: null } : { data: out, error: null }).then(res, rej);
          },
        };
        return q;
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
}
const none = () => {};
/** A serve logged now: it lands at the head of the newest-first order, ahead of every cursor. */
const serveLogged = (item: string) => (page: number, t: Row[]) => { if (page === 1) t.push({ id: uuid(99_999), item_id: item, outcome: "impression", surface: "discovery", user_id: uuid(10_001), served_at: new Date(NOW - 1_000).toISOString(), outcome_at: null }); };
const dupes = (served: string[]) => served.length - new Set(served).size;

describe("census-discovery §118 (SW22): the momentum reads page rank_events by key", () => {
  beforeEach(() => _resetLocalMomentumCacheForTest());
  it("MW0 CONTROL: local momentum over 2100 rows, nothing written → no row served twice", async () => {
    const w = liveClient({ rank_events: rankEvents() }, none);
    await loadLocalMomentum(w.client, [P1, P2], { cacheKey: "mw0", nowMs: NOW });
    assert.equal(dupes(w.served), 0); assert.equal(w.served.length, 2100);
  });
  it("MW1 a serve logged between page 1 and 2 → no row served twice, and the map equals the control's", async () => {
    const c = liveClient({ rank_events: rankEvents() }, none);
    const control = await loadLocalMomentum(c.client, [P1, P2], { cacheKey: "mw1c", nowMs: NOW });
    const w = liveClient({ rank_events: rankEvents() }, serveLogged(P1));
    const map = await loadLocalMomentum(w.client, [P1, P2], { cacheKey: "mw1", nowMs: NOW });
    assert.equal(dupes(w.served), 0, `${dupes(w.served)} row(s) read twice`);
    assert.deepEqual(map, control);
  });
  it("MW2 a Trail's member impressions, a serve logged between pages → no row served twice, the control's counts", async () => {
    const members = [{ source_type: "place", source_id: P1 }, { source_type: "place", source_id: P2 }] as any[];
    const c = liveClient({ rank_events: rankEvents() }, none);
    const control = await readMemberImpressions(c.client, members, NOW);
    const w = liveClient({ rank_events: rankEvents() }, serveLogged(P1));
    const got = await readMemberImpressions(w.client, members, NOW);
    assert.equal(dupes(w.served), 0, `${dupes(w.served)} row(s) read twice`);
    assert.ok(control && got, JSON.stringify({ control, got }));
    assert.equal(got![P2], control![P2]);
  });
  it("MW3 the emerging-Trails read, a serve logged between pages → no row served twice", async () => {
    const world = {
      rank_events: rankEvents(),
      trails: [{ id: T1, destination: "Lisbon", lifecycle_status: "active" }],
      content_trails: [{ trail_id: T1, source_type: "place", source_id: P1 }, { trail_id: T1, source_type: "place", source_id: P2 }],
    };
    const w = liveClient(world, serveLogged(P1));
    const r = await emergingPlacesAndTrails(w.client, uuid(1), "Lisbon", NOW);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(w.served.length > 1000, `the read paged: ${w.served.length}`);
    assert.equal(dupes(w.served), 0, `${dupes(w.served)} row(s) read twice`);
  });
  it("MW4 a server that ignores the cursor → a failed read (the empty map), never a row counted twice", async () => {
    const w = liveClient({ rank_events: rankEvents() }, none, { ignoreCursor: true });
    const map = await loadLocalMomentum(w.client, [P1, P2], { cacheKey: "mw4", nowMs: NOW });
    assert.deepEqual(map, computeLocalMomentum([], NOW));
  });
});
