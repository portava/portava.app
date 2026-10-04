/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B44, probes CC1 ×4): the viewer's own
 * saved state on every events answer is measured from WHOLE reads, never from a list PostgREST cut at 1000 rows.
 *
 * `viewerSavedEventIds` (routes/events.ts) and GET /events' own copy read the viewer's `collections` with one unbounded
 * read, then the `collection_items` of those collections with another. PostgREST caps a response at db-max-rows (1000
 * here) silently, so a viewer with more than 1000 collections had only the first 1000 consulted, and an event saved in
 * a later one was served `isSaved: false` ("not saved") as measured. The item read could be cut the same way. Both are
 * now read whole (`viewerCollectionSavedIds`, lib/viewerSavedReads.ts: the plain read with an exact count, then by key
 * when the count says rows were left out; the collection ids are consulted in chunks). A read that cannot be read whole
 * is a failed read: the lists refuse (503) and the event screen serves `isSaved: null` and names the read, as over any
 * other failed saved read (§122).
 *
 * `collections` and `collection_items` are served by `cappedClient` (every response cut at 1000 rows, an exact count
 * when asked); every other table by the events world.
 *
 *   CC0  CONTROL (each answer): the event sits in the viewer's only collection → isSaved true
 *   CC1  (each answer): 1200 collections, the event in one past the cap → isSaved true
 *   CC2  the collections list is cut and its keyed re-read FAILS → the lists answer 503; the event screen isSaved null, `event_saves` named
 *   CC3  CONTROL (each answer): 1200 collections, the event in none → isSaved false
 *   CI1  GET /events and /events/following: 1201 item rows over three listed events, this event's row past the cap → isSaved true
 *   CI2  the server's max-rows (300) is below the page size → CC1 still holds on /events/following
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, eventRow, EVENT, HOST, VIEWER } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const EV_A = "66666666-6666-4666-8666-66666666666a";
const EV_B = "66666666-6666-4666-8666-66666666666b";
const LAST_COL = seqId("fffffff0", 999_999);  // sorts after every other collection id

/** `n` collections of the viewer's; `LAST_COL` at insertion index `at` when `at >= 0`. */
function collections(n: number, at: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ id: i === at ? LAST_COL : seqId("c0110000", i), owner_id: VIEWER });
  return out;
}
const item = (n: number, collection_id: string, entity_id: string): Row => ({ id: seqId("17e00000", n), collection_id, entity_type: "event", entity_id });

interface Scene { collections: Row[]; items: Row[]; moreEvents?: Row[]; fail?: (r: SeenRead) => boolean | "throw"; dbMaxRows?: number }
async function get(path: string, s: Scene) {
  const w = world({
    ev: { state: "open", circle_id: HOST, starts_at: "2030-01-05T18:00:00.000Z" },
    moreEvents: s.moreEvents,
    extra: { user_follows: [{ follower_id: VIEWER, following_id: HOST }], circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }], event_saves: [] },
    rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }, ...(s.moreEvents ?? []).map((e) => ({ event_id: e.id, user_id: VIEWER, status: "going" }))],
  });
  const capped = cappedClient({ collections: s.collections, collection_items: s.items }, { fail: s.fail, dbMaxRows: s.dbMaxRows });
  const from = w.client.from.bind(w.client);
  w.client.from = (t: string) => (t === "collections" || t === "collection_items" ? capped.from(t) : from(t));
  const srv = await eventsServer();
  try {
    const r = await srv.req("t-viewer", "GET", path);
    const ev = path === `/events/${EVENT}` ? r.body : (r.body?.events ?? []).find((e: any) => e.id === EVENT);
    return { status: r.status, isSaved: ev ? ev.isSaved : "(not listed)", failedSources: r.body?.failedSources ?? null, text: r.text.slice(0, 300) };
  } finally { srv.close(); }
}

const ANSWERS = [["GET /events", "/events?limit=10"], ["/events/me", "/events/me"], ["/events/circles", "/events/circles"], ["/events/following", "/events/following"], ["GET /events/:id", `/events/${EVENT}`]] as const;
const LISTS = ANSWERS.filter(([, p]) => p !== `/events/${EVENT}`);

describe("census-discovery §123 (B44): the viewer's saved events are measured from whole collection reads", () => {
  after(() => _setTestClient(null as any, false));
  for (const [name, path] of ANSWERS) {
    it(`CC0 CONTROL ${name}: the event sits in the viewer's only collection → isSaved true`, async () => {
      const r = await get(path, { collections: collections(1, 0), items: [item(1, LAST_COL, EVENT)] });
      assert.deepEqual({ status: r.status, isSaved: r.isSaved }, { status: 200, isSaved: true }, r.text);
    });
    it(`CC1 ${name}: 1200 collections, the event in one past the cap → isSaved true`, async () => {
      const r = await get(path, { collections: collections(1200, 1100), items: [item(1, LAST_COL, EVENT)] });
      assert.deepEqual({ status: r.status, isSaved: r.isSaved }, { status: 200, isSaved: true }, `a saved event was served as not saved: ${r.text}`);
    });
    it(`CC3 CONTROL ${name}: 1200 collections, the event in none → isSaved false`, async () => {
      const r = await get(path, { collections: collections(1200, -1), items: [item(1, seqId("c0110000", 5), EV_A)] });
      assert.deepEqual({ status: r.status, isSaved: r.isSaved }, { status: 200, isSaved: false }, r.text);
    });
  }
  for (const [name, path] of LISTS) {
    it(`CC2 ${name}: the collections list is cut and its keyed re-read FAILS → 503`, async () => {
      const r = await get(path, { collections: collections(1200, 1100), items: [item(1, LAST_COL, EVENT)], fail: (x) => x.table === "collections" && x.ordered });
      assert.equal(r.status, 503, r.text);
    });
  }
  it("CC2 GET /events/:id: the collections list is cut and its keyed re-read FAILS → isSaved null, event_saves named", async () => {
    const r = await get(`/events/${EVENT}`, { collections: collections(1200, 1100), items: [item(1, LAST_COL, EVENT)], fail: (x) => x.table === "collections" && x.ordered });
    assert.deepEqual({ status: r.status, isSaved: r.isSaved, failedSources: r.failedSources }, { status: 200, isSaved: null, failedSources: ["event_saves"] }, r.text);
  });

  // 700 collections (under the cap); two other listed events sit in 600 of them each, so 1200 item rows match the list's
  // ids before this event's single row, which is last in insertion order and whose id sorts last.
  function itemScene(): Scene {
    const cols = collections(700, 699);
    const items: Row[] = [];
    let n = 0;
    for (let i = 0; i < 600; i++) { items.push(item(n++, seqId("c0110000", i), EV_A)); items.push(item(n++, seqId("c0110000", i), EV_B)); }
    items.push(item(9_999_999, LAST_COL, EVENT));
    const more = [eventRow({ id: EV_A, state: "open", circle_id: HOST, title: "A", starts_at: "2030-01-06T18:00:00.000Z" }), eventRow({ id: EV_B, state: "open", circle_id: HOST, title: "B", starts_at: "2030-01-07T18:00:00.000Z" })];
    return { collections: cols, items, moreEvents: more };
  }
  for (const [name, path] of [["GET /events", "/events?limit=10"], ["/events/following", "/events/following"]] as const) {
    it(`CI1 ${name}: 1201 item rows over three listed events, this event's row past the cap → isSaved true`, async () => {
      const r = await get(path, itemScene());
      assert.deepEqual({ status: r.status, isSaved: r.isSaved }, { status: 200, isSaved: true }, `a saved event was served as not saved: ${r.text}`);
    });
  }
  it("CI2 /events/following: the server's max-rows (300) is below the page size → still isSaved true", async () => {
    const r = await get("/events/following", { collections: collections(1200, 1100), items: [item(1, LAST_COL, EVENT)], dbMaxRows: 300 });
    assert.deepEqual({ status: r.status, isSaved: r.isSaved }, { status: 200, isSaved: true }, `a saved event was served as not saved: ${r.text}`);
  });
});
