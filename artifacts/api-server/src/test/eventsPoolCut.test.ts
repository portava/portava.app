/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B32, and sweep): GET /events/following
 * and GET /events/circles never answer a pool their per-viewer filter emptied as the END of the list, and page by a key
 * that never skips events that start together.
 *
 * Both lists read a pool of `limit * 3` events in start order, filter it per viewer (visibility, block, eligibility),
 * and answered `cursor: null` whenever fewer than `limit` survived — so a pool the filter emptied was answered as the
 * whole, final list (`events: []`, no `truncated`), and the events tab said "No events yet" although events past the
 * pool were never read. /events/search marks this exact shape (`truncated`, §118 B28). Now a FULL pool with fewer than
 * `limit` survivors answers `truncated: true` and a cursor after the pool's last row, so a client that pages reads on.
 *
 * Their cursor was the last event's `starts_at` alone, read back with `starts_at > cursor`: an event starting at the
 * same instant as the last one served (events start on the hour) was skipped by the next page, unsaid. The cursor is
 * now `(starts_at, id)`, ordered and compared as a pair; a cursor an earlier server answered (the start time alone)
 * is read as before.
 *
 *   PC0 CONTROL (/following, limit 1): one eligible event → listed
 *   PC1 (/following, limit 1): the 3 earliest events (the whole pool) are ones the viewer is banned from, a 4th is open
 *       → `truncated: true` and a cursor; the next page lists the open event (the verifier's PC1)
 *   PC2 (/circles): the same (the verifier's PC2)
 *   PC3 CONTROL (/following, limit 2): the viewer is banned from the only 2 events (the pool of 6 is not full) → the
 *       end: `events: []`, no cursor, no `truncated`
 *   PC4 CONTROL (/circles): the same → the end, unmarked
 *   PT1 (/following, limit 1): two events start at the same instant → page 1 lists one, page 2 the other, never skipped
 *   PT2 (/circles): the same
 *   PT3 (/following): an earlier server's cursor (the start time alone) is read as before
 *
 * Harness: the events world (eventsWorld.ts), its `events` reads answered as PostgREST does: every `.order()` in turn,
 * the `.or()` keyset honoured, `.limit()` after both.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, eventRow, HOST, VIEWER } from "./helpers/eventsWorld.js";
import { logicFilter, sortByOrders } from "./helpers/postgrestKeyset.js";
import { _setTestClient } from "../lib/http.js";

const ev = (i: number, over: Record<string, any> = {}) => eventRow({ id: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`, state: "open", starts_at: `2030-01-0${i}T00:00:00.000Z`, circle_id: HOST, ...over });

/** The events reads answered as PostgREST does: every `.order()` in turn, an `.or()` keyset, `.limit()` after both. */
function keyedEvents(w: ReturnType<typeof world>) {
  const from = w.client.from.bind(w.client);
  w.client.from = (t: string) => {
    const b = from(t);
    if (t !== "events") return b;
    const orders: Array<{ col: string; asc?: boolean; nullsFirst?: boolean }> = []; const preds: Array<(r: any) => boolean> = []; let lim: number | null = null;
    b.order = (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst }); return b; };  // census-discovery §122: NULLs where PostgreSQL puts them
    b.limit = (n: number) => { lim = n; return b; };
    b.or = (expr: string) => { const p = logicFilter(expr); assert.ok(p, `unmodelled .or(${expr})`); preds.push(p as any); return b; };
    const then = b.then;
    b.then = (f: any, r: any) => then.call(b, (res: any) => {
      if (!res || !Array.isArray(res.data)) return res;
      const rows = sortByOrders(res.data.filter((row: any) => preds.every((p) => p(row))), orders);
      return { ...res, data: lim === null ? rows : rows.slice(0, lim) };
    }).then(f, r);
    return b;
  };
  return w;
}
function setup(evs: any[], banned: string[]) {
  return keyedEvents(world({
    ev: { state: "cancelled" }, moreEvents: evs,
    extra: { user_follows: [{ follower_id: VIEWER, following_id: HOST }], circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }], event_roles: banned.map((id) => ({ event_id: id, user_id: VIEWER, role: "banned" })) },
  }));
}
async function get(path: string) {
  const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", path); return { status: r.status, events: (r.body?.events ?? []).map((e: any) => e.id) as string[], cursor: (r.body?.cursor ?? null) as string | null, truncated: r.body?.truncated ?? null, text: r.text }; } finally { s.close(); }
}
const page = (path: string, cursor: string | null) => get(cursor === null ? path : `${path}&cursor=${encodeURIComponent(cursor)}`);

describe("census-discovery §119 (B32): a pool the per-viewer filter emptied is never answered as the end of the list", () => {
  after(() => _setTestClient(null as any, false));
  it("PC0 CONTROL (/following, limit 1): one eligible event → listed", async () => {
    const open = ev(1); setup([open], []);
    const r = await get("/events/following?limit=1");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.events, [open.id]);
  });
  for (const [id, path] of [["PC1", "/events/following?limit=1"], ["PC2", "/events/circles?limit=1"]] as const) {
    it(`${id} (${path.split("?")[0]}): the pool is all banned events, a 4th is open → truncated, a cursor, and the next page lists it`, async () => {
      const evs = [ev(1), ev(2), ev(3), ev(4)]; setup(evs, [evs[0].id, evs[1].id, evs[2].id]);
      const r1 = await get(path);
      assert.equal(r1.status, 200, r1.text);
      assert.deepEqual({ events: r1.events, truncated: r1.truncated, cursored: r1.cursor !== null }, { events: [], truncated: true, cursored: true }, r1.text);
      const r2 = await page(path, r1.cursor);
      assert.deepEqual(r2.events, [evs[3].id], r2.text);
    });
  }
  for (const [id, path] of [["PC3", "/events/following?limit=2"], ["PC4", "/events/circles?limit=2"]] as const) {
    it(`${id} CONTROL (${path.split("?")[0]}, limit 2): the pool is not full and the filter empties it → the end, unmarked`, async () => {
      const evs = [ev(1), ev(2)]; setup(evs, [evs[0].id, evs[1].id]);
      const r = await get(path);
      assert.deepEqual({ status: r.status, events: r.events, cursor: r.cursor, truncated: r.truncated }, { status: 200, events: [], cursor: null, truncated: null }, r.text);
    });
  }
});

describe("census-discovery §119 (sweep): /following and /circles page by (starts_at, id), never skipping events that start together", () => {
  after(() => _setTestClient(null as any, false));
  for (const [id, path] of [["PT1", "/events/following?limit=1"], ["PT2", "/events/circles?limit=1"]] as const) {
    it(`${id} (${path.split("?")[0]}): two events start at the same instant → both are read, one per page`, async () => {
      const a = ev(1, { starts_at: "2030-01-05T19:00:00.000Z" }); const b = ev(2, { starts_at: "2030-01-05T19:00:00.000Z" }); const c = ev(3, { starts_at: "2030-01-06T19:00:00.000Z" });
      setup([b, c, a], []);
      const seen: string[] = []; let cursor: string | null = null;
      for (let i = 0; i < 4; i++) { const r = await page(path, cursor); assert.equal(r.status, 200, r.text); seen.push(...r.events); cursor = r.cursor; if (cursor === null) break; }
      assert.deepEqual(seen, [a.id, b.id, c.id]);
    });
  }
  it("PT3 (/following): an earlier server's cursor, the start time alone → the events after it, as before", async () => {
    const evs = [ev(1), ev(2), ev(3)]; setup(evs, []);
    const r = await page("/events/following?limit=5", "2030-01-01T00:00:00.000Z");
    assert.deepEqual(r.events, [evs[1].id, evs[2].id], r.text);
  });
});
