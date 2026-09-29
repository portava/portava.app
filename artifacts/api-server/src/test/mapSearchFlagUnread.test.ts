/**
 * census-discovery §107 (DV-83 round 10, lane W11-X2, register D-W11X2-71): GET /map/search — a
 * Discovery serve point (DiscoveryServePoint.MAP_SEARCH) — never answers an UNREAD
 * `map_search_enabled` with the flag-off body. Adapted from the round-9 verifier's probe
 * (scratchpad v9-probes/zz-v9-mapSearchFlagUnread).
 *
 * The route read the flag through `isFlagEnabled`, which answers a failed read as false, so a
 * timed-out read was `{ enabled: false, results: [] }` with nothing naming the failure (§107.1 BK5)
 * — the class §105 closed on GET /compass/feed. It now reads the flag's state strictly and answers
 * an unread flag the way the route already answers an unread block set: `enabled: false` with a
 * named refusal.
 *
 *   MS0  CONTROL (V9-MS0): the flag READ and off → the flag-off body, no refusal
 *   MS0b CONTROL: no flag row → the flag-off body, no refusal
 *   MS1  (V9-MS1) the flag read fails → enabled:false WITH refusal "flag_unreadable"
 *   MS1b the flag read throws → the same
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import mapSearchRouter from "../routes/mapSearch.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000077";
const TOKEN = "tok-r10-map";
type Flag = "off" | "absent" | "fails" | "throws";
function client(flag: Flag) {
  const b = (table: string): any => {
    const answer = () => {
      if (table !== "feature_flags") return { data: null, error: null };
      if (flag === "fails") return { data: null, error: { code: "57014", message: "timeout" } };
      if (flag === "throws") throw new Error("socket hang up");
      return { data: flag === "off" ? { enabled: false } : null, error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve().then(answer).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve().then(answer);
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: null, error: null }) };
}
let server: Server; let base = "";
before(async () => {
  const app = express(); app.use((req, _r, n) => { (req as any).log = { info() {}, warn() {}, error() {} }; n(); }); app.use("/api", mapSearchRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(() => server.close());
const get = async () => { const r = await fetch(`${base}/map/search?lat=48.85&lng=2.35`, { headers: { Authorization: `Bearer ${TOKEN}` } }); return { status: r.status, body: await r.json() }; };
const OFF_KEYS = ["enabled", "results", "viewport", "total", "nextCursor", "sources", "generatedAt"];

describe("census-discovery §107 (DV-83, D-W11X2-71): GET /map/search with its flag unread", () => {
  it("MS0 (V9-MS0) CONTROL: the flag READ and off → the flag-off body, no refusal", async () => {
    _setTestClient(client("off") as any, true);
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), OFF_KEYS);
    assert.equal(r.body.enabled, false);
  });

  it("MS0b CONTROL: no flag row → the flag-off body, no refusal", async () => {
    _setTestClient(client("absent") as any, true);
    const r = await get();
    assert.deepEqual(Object.keys(r.body), OFF_KEYS);
    assert.equal(r.body.enabled, false, "an absent flag row is off, never served");
  });

  it("MS1 (V9-MS1) the flag read fails → enabled:false WITH refusal flag_unreadable, never the flag-off body alone", async () => {
    _setTestClient(client("fails") as any, true);
    const r = await get();
    assert.ok(!(r.status === 200 && r.body.enabled === false && r.body.refusal == null), "an unread flag is answered as map search being off");
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.refusal, "flag_unreadable");
    assert.deepEqual(r.body.results, []);
  });

  it("MS1b the flag read throws → the same refusal", async () => {
    _setTestClient(client("throws") as any, true);
    const r = await get();
    assert.equal(r.body.refusal, "flag_unreadable");
  });
});
