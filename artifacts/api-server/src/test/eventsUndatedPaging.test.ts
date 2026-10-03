/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; the round-22 verifier's survivors X1–X3, fixture UD0/UD1, adapted):
 * GET /events/following and /events/circles page undated events (`starts_at` NULL, ordered last) past the first page,
 * each once, in order.
 *
 * Round 22's keyset cursor (SW24) has two undated arms: a dated cursor also asks for `starts_at.is.null` rows, and a
 * cursor after an undated row asks for `starts_at IS NULL AND id > …`. No lane world pinned them, because the shared
 * double sorted NULL first (postgrestKeysetNullOrder NK0). Over the corrected helper:
 *
 *   UD0 /following, limit 1: E1 dated, U2 and U3 undated (their ids sort below E1's) → E1, U2, U3 once each, then the end
 *   UD1 /circles: the same
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, eventRow, HOST, VIEWER } from "./helpers/eventsWorld.js";
import { logicFilter, sortByOrders } from "./helpers/postgrestKeyset.js";
import { _setTestClient } from "../lib/http.js";

const ev = (i: number, over: Record<string, any> = {}) => eventRow({ id: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`, state: "open", starts_at: `2030-01-0${i}T00:00:00.000Z`, circle_id: HOST, ...over });

/** The events reads answered as PostgREST does: every `.order()` in turn (NULLs where PostgreSQL puts them), an `.or()` keyset, `.limit()` after both. */
function keyedEvents(w: ReturnType<typeof world>) {
  const from = w.client.from.bind(w.client);
  w.client.from = (t: string) => {
    const b = from(t);
    if (t !== "events") return b;
    const orders: Array<{ col: string; asc?: boolean; nullsFirst?: boolean }> = []; const preds: Array<(r: any) => boolean> = []; let lim: number | null = null;
    b.order = (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst }); return b; };
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
function setup(evs: any[]) {
  return keyedEvents(world({
    ev: { state: "cancelled" }, moreEvents: evs,
    extra: { user_follows: [{ follower_id: VIEWER, following_id: HOST }], circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }] },
  }));
}
async function get(path: string) {
  const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", path); return { status: r.status, events: (r.body?.events ?? []).map((e: any) => e.id) as string[], cursor: (r.body?.cursor ?? null) as string | null, text: r.text }; } finally { s.close(); }
}
const page = (path: string, cursor: string | null) => get(cursor === null ? path : `${path}&cursor=${encodeURIComponent(cursor)}`);

describe("census-discovery §122 (X1–X3): undated events past the first page are read, once each", () => {
  after(() => _setTestClient(null as any, false));
  for (const [id, path] of [["UD0", "/events/following?limit=1"], ["UD1", "/events/circles?limit=1"]] as const) {
    it(`${id} ${path.split("?")[0]}: E1 dated, U2/U3 undated → E1, U2, U3 once each, then the end`, async () => {
      const e1 = ev(1, { id: "77777777-7777-4777-8777-ffffffffffff" });
      const u2 = ev(2, { id: "77777777-7777-4777-8777-000000000002", starts_at: null });
      const u3 = ev(3, { id: "77777777-7777-4777-8777-000000000003", starts_at: null });
      setup([e1, u2, u3]);
      const seen: string[] = []; let cursor: string | null = null; let pages = 0;
      for (; pages < 6; pages++) { const r = await page(path, cursor); assert.equal(r.status, 200, r.text); seen.push(...r.events); cursor = r.cursor; if (cursor === null) break; }
      assert.deepEqual(seen, [e1.id, u2.id, u3.id], JSON.stringify({ seen, cursor }));
    });
  }
});
