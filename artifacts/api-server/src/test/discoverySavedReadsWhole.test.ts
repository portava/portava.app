/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B44, probe SI1, and its sweep): the
 * viewer's saved community places are read WHOLE, never as the first page PostgREST cut.
 *
 * GET /discovery/community/saved-ids answered `discovery_place_saves` from one unbounded read: a viewer with more than
 * 1000 saved places was told their first 1000 were all of them, and the client pre-fills every bookmark from that list,
 * so each place past the cut was drawn "not saved". GET /discovery/community decided `isSaved` from the viewer's
 * `collections` and `collection_items`, read the same way. Both now read whole (lib/viewerSavedReads.ts); a set that
 * cannot be read whole is a failed read, answered as each route already answers one.
 *
 * `discovery_place_saves`, `collections` and `collection_items` are served by `cappedClient` (every response cut at
 * 1000 rows, an exact count when asked); every other table by the discovery world.
 *
 *   SI0  CONTROL: three saved places → those three ids, no refusal
 *   SI1  1200 saved places → all 1200 ids, the one past the cap among them, no refusal
 *   SI2  the list is cut and its keyed re-read FAILS → refused (`saved_ids_read_failed`), never a shorter list
 *   SI3  the server's max-rows (300) is below the page size → still all 1200
 *   SI4  CONTROL: the plain read FAILS → refused, as before
 *   CW0  CONTROL: GET /discovery/community, the place in the viewer's only collection → isSaved true
 *   CW1  1200 collections, the place in one past the cap → isSaved true, nothing named
 *   CW2  the collections list is cut and its keyed re-read FAILS → isSaved null, `collections` named
 *   CW3  CONTROL: 1200 collections, the place in none → isSaved false, nothing named
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { _clearTestCompassCache } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { newWorld, worldClient, communityRow, profileRow } from "./helpers/fakeDiscoveryWorld.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER = "a1110000-0000-4000-8000-000000000001";
const P1 = "c1000000-0000-4000-8000-000000000001";
const LAST = seqId("fffffff0", 999_999);  // sorts after every other id of its kind
const CAPPED = new Set(["discovery_place_saves", "collections", "collection_items"]);

interface Scene { saves?: Row[]; collections?: Row[]; items?: Row[]; fail?: (r: SeenRead) => boolean | "throw"; dbMaxRows?: number }
function use(s: Scene) {
  const w = newWorld({
    users: { "tok-viewer": VIEWER },
    tables: {
      feature_flags: [], discovery_places: [communityRow(P1)], profiles: [profileRow(VIEWER)],
      user_follows: [], blocks: [], user_mutes: [], profile_privacy_settings: [], identity_verifications: [], rank_events: [],
    },
  });
  const c: any = worldClient(w);
  const capped = cappedClient({ discovery_place_saves: s.saves ?? [], collections: s.collections ?? [], collection_items: s.items ?? [] }, { fail: s.fail, dbMaxRows: s.dbMaxRows });
  const client = { ...c, from: (t: string) => (CAPPED.has(t) ? capped.from(t) : c.from(t)) };
  _setTestServiceClient(client as any); _setTestClient(client as any, true);
}
let server: Server; let base = "";
before(async () => {
  server = createServer(express().use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); }).use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { globalThis.fetch = _originalFetch; _setTestServiceClient(null); _setTestClient(null as any, false); await new Promise<void>((r) => server.close(() => r())); });
const call = async (path: string) => { _clearTestCompassCache?.(); const res = await fetch(`${base}${path}`, { headers: { authorization: "Bearer tok-viewer" } }); return { status: res.status, body: await res.json() as any }; };

/** `n` saves of the viewer's; `LAST` at insertion index `at`. */
function saves(n: number, at: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ user_id: VIEWER, place_id: i === at ? LAST : seqId("5a0e0000", i) });
  return out;
}
function collections(n: number, at: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ id: i === at ? LAST : seqId("c0110000", i), owner_id: VIEWER });
  return out;
}
const item = (collection_id: string, entity_id: string): Row => ({ id: seqId("17e00000", 1), collection_id, entity_type: "place", entity_id });

describe("census-discovery §123 (B44): GET /discovery/community/saved-ids answers the whole saved list", () => {
  it("SI0 CONTROL: three saved places → those three ids, no refusal", async () => {
    use({ saves: saves(3, 1) });
    const r = await call("/discovery/community/saved-ids");
    assert.equal(r.status, 200);
    assert.deepEqual([...r.body.ids].sort(), [seqId("5a0e0000", 0), seqId("5a0e0000", 2), LAST].sort());
    assert.equal(r.body.refusal, undefined);
  });
  it("SI1 1200 saved places → all 1200 ids, the one past the cap among them", async () => {
    use({ saves: saves(1200, 1100) });
    const r = await call("/discovery/community/saved-ids");
    assert.equal(r.body.refusal, undefined, JSON.stringify(r.body.refusal));
    assert.equal(r.body.ids.length, 1200, `the list holds ${r.body.ids.length} of 1200 saved places`);
    assert.equal(r.body.ids.includes(LAST), true, "a saved place past the cap is missing from the list");
  });
  it("SI2 the list is cut and its keyed re-read FAILS → refused, never a shorter list", async () => {
    use({ saves: saves(1200, 1100), fail: (x) => x.table === "discovery_place_saves" && x.ordered });
    const r = await call("/discovery/community/saved-ids");
    assert.deepEqual({ ids: r.body.ids, code: r.body.refusal?.code, coverage: r.body.refusal?.coverage }, { ids: [], code: "saved_ids_read_failed", coverage: "nothing" });
  });
  it("SI3 the server's max-rows (300) is below the page size → still all 1200", async () => {
    use({ saves: saves(1200, 1100), dbMaxRows: 300 });
    const r = await call("/discovery/community/saved-ids");
    assert.equal(r.body.ids.length, 1200, `the list holds ${r.body.ids.length} of 1200 saved places`);
  });
  it("SI4 CONTROL: the plain read FAILS → refused", async () => {
    use({ saves: saves(3, 1), fail: (x) => x.table === "discovery_place_saves" });
    const r = await call("/discovery/community/saved-ids");
    assert.deepEqual({ ids: r.body.ids, code: r.body.refusal?.code }, { ids: [], code: "saved_ids_read_failed" });
  });
});

describe("census-discovery §123 (B44): GET /discovery/community measures isSaved from whole collection reads", () => {
  const seen = async () => { const r = await call("/discovery/community?city=Miami&limit=50"); const it = (r.body.items ?? []).find((i: any) => i.id === P1); return { status: r.status, isSaved: it ? it.isSaved : "(not listed)", failedSources: r.body.failedSources ?? null }; };
  it("CW0 CONTROL: the place in the viewer's only collection → isSaved true", async () => {
    use({ collections: collections(1, 0), items: [item(LAST, P1)] });
    assert.deepEqual(await seen(), { status: 200, isSaved: true, failedSources: null });
  });
  it("CW1 1200 collections, the place in one past the cap → isSaved true, nothing named", async () => {
    use({ collections: collections(1200, 1100), items: [item(LAST, P1)] });
    assert.deepEqual(await seen(), { status: 200, isSaved: true, failedSources: null });
  });
  it("CW2 the collections list is cut and its keyed re-read FAILS → isSaved null, `collections` named", async () => {
    use({ collections: collections(1200, 1100), items: [item(LAST, P1)], fail: (x) => x.table === "collections" && x.ordered });
    assert.deepEqual(await seen(), { status: 200, isSaved: null, failedSources: ["collections"] });
  });
  it("CW3 CONTROL: 1200 collections, the place in none → isSaved false, nothing named", async () => {
    use({ collections: collections(1200, -1), items: [item(seqId("c0110000", 4), "c1000000-0000-4000-8000-0000000000ff")] });
    assert.deepEqual(await seen(), { status: 200, isSaved: false, failedSources: null });
  });
});
