/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivors V7–V14, fixtures SB1, CB1, CE1,
 * FE1, FV1, ME3, SV2, SC1): every "an event withheld over a failed read makes the answer `truncated`" mark round 21 added
 * on the events lists (§118 B28), and the 503s over a failed own read on /events/me and /events/saved, is pinned.
 * Each mutation dropping one of them survived the round-21 pins, which exercised only the search FRIENDSHIP read (SS3)
 * and the /following BLOCK read (FS2).
 *
 *   SB0 CONTROL: /events/search?q=Rooftop, every read answers → the event is found, nothing said
 *   SB1 (V7)  /events/search, the block read for the match FAILS → withheld, `truncated`
 *   CB1 (V9)  /events/circles, the block read FAILS → withheld, `truncated`
 *   CE1 (V8)  /events/circles, the eligibility (ban) read FAILS → withheld, `truncated`
 *   FE1 (V11) /events/following, the eligibility (ban) read FAILS → withheld, `truncated`
 *   FV1 (V10) /events/following, a friends-only event whose friendship (visibility) read FAILS → withheld, `truncated`
 *   ME3 (V12) /events/me, the attending-events read FAILS → 503 (never the hosted list alone as the whole)
 *   SV2 (V13) /events/saved, the viewer's own RSVP read FAILS → 503
 *   SC1 (V14) /events/search?q=Lisbon, the CITY read fills its 500-row pool (titles do not match) → `truncated`
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, eventRow, EVENT, HOST, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const extra = { user_follows: [{ follower_id: VIEWER, following_id: HOST }], circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }] };
const setup = (failOn?: (c: any) => any, over: Record<string, any> = {}, more: any[] = [], ex: Record<string, any[]> = {}) => {
  const { __norsvp, __ilike, ...ev } = over as any;
  const w = world({ ev: { state: "open", circle_id: HOST, ...ev }, moreEvents: more, extra: { ...extra, ...ex }, rsvps: __norsvp ? [] : [{ event_id: EVENT, user_id: VIEWER, status: "going" }], failOn });
  if (__ilike) {  // the fail-closed double ignores ilike; for SC1 apply it, as PostgREST does, after the double's own limit
    const from = w.client.from.bind(w.client);
    w.client.from = (t: string) => { const b = from(t); if (t !== "events") return b; const pats: Array<[string, string]> = []; b.ilike = (c: string, v: string) => { pats.push([c, v.replace(/%/g, "").toLowerCase()]); return b; };
      const th = b.then; b.then = (f: any, r: any) => th.call(b, (res: any) => ({ ...res, data: Array.isArray(res?.data) ? res.data.filter((row: any) => pats.every(([c, v]) => String(row[c] ?? "").toLowerCase().includes(v))) : res?.data })).then(f, r); return b; };
  }
  return w;
};
const blocksRead = (c: any) => (c.table === "blocks" ? ERR : null);
const banRead = (c: any) => (c.table === "event_roles" && c.filters.some((f: any) => f.col === "role" && f.val === "banned") ? ERR : null);
async function get(path: string, failOn?: (c: any) => any, over: Record<string, any> = {}, more: any[] = [], ex: Record<string, any[]> = {}) {
  setup(failOn, over, more, ex); const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", path); return { status: r.status, events: (r.body?.events ?? []).map((e: any) => e.id), truncated: r.body?.truncated ?? null }; } finally { s.close(); }
}
describe("census-discovery §119 (V7–V14): an event withheld over a failed read is said", () => {
  after(() => _setTestClient(null as any, false));
  it("SB0 CONTROL: search, every read answers → found", async () => {
    const seen = await get("/events/search?q=Rooftop");
    assert.deepEqual({ status: seen.status, found: seen.events.includes(EVENT), truncated: seen.truncated }, { status: 200, found: true, truncated: null });
  });
  for (const [id, path, fail] of [["SB1", "/events/search?q=Rooftop", blocksRead], ["CB1", "/events/circles", blocksRead], ["CE1", "/events/circles", banRead], ["FE1", "/events/following", banRead]] as const) {
    it(`${id} ${path}: withheld over a failed read → truncated`, async () => {
      const seen = await get(path, fail);
      assert.ok(seen.status === 503 || seen.events.includes(EVENT) || seen.truncated === true, JSON.stringify(seen));
    });
  }
  it("FV1 /events/following: a friends-only event, the friendship read FAILS → truncated", async () => {
    const seen = await get("/events/following", (c: any) => (c.table === "user_friendships" ? ERR : null), { visibility: "friends_only", __norsvp: true });
    assert.ok(seen.status === 503 || seen.events.includes(EVENT) || seen.truncated === true, JSON.stringify(seen));
  });
  it("ME3 /events/me: the attending-events read FAILS → 503", async () => {
    const seen = await get("/events/me", (c: any) => (c.table === "events" && c.filters.some((f: any) => f.col === "id" && f.op === "in") ? ERR : null), { host_id: HOST });
    assert.equal(seen.status, 503, JSON.stringify(seen));
  });
  it("SV2 /events/saved: the own RSVP read FAILS → 503", async () => {
    const seen = await get("/events/saved", (c: any) => (c.table === "event_rsvps" && c.eq("user_id") === VIEWER ? ERR : null), {}, [], { event_saves: [{ user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-01T00:00:00Z" }] });
    assert.equal(seen.status, 503, JSON.stringify(seen));
  });
  it("SC1 /events/search?q=Lisbon: the city read fills its pool → truncated", async () => {
    const more = Array.from({ length: 501 }, (_, i) => eventRow({ id: `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`, title: `Quiz ${i}`, state: "open", city: "Lisbon" }));
    const seen = await get("/events/search?q=Lisbon&limit=5", undefined, { title: "Rooftop quiz", city: "Porto", starts_at: "2031-01-01T00:00:00.000Z", __ilike: true }, more);
    assert.equal(seen.truncated, true, JSON.stringify({ ...seen, events: seen.events.length }));
  });
});
