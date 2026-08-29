/**
 * Map search + compass-command routes — gating, fail-closed, envelope shape.
 * Run: node --import tsx/esm --test src/test/mapSearchRoutes.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setForwardGeocoder, _clearGeocodeCache } from "../lib/geocodeForward.js";
import mapSearchRouter from "../routes/mapSearch.js";

let server: http.Server;
let base: string;
const TOKEN = "map-search-token";
const USER_ID = "c0000000-0000-4000-a000-000000000001";

function req(method: string, path: string, body?: any, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function makeClient(opts: { flags?: Record<string, boolean>; blocksError?: boolean } = {}) {
  const flags = opts.flags ?? {};
  function builder(table: string) {
    let error: any = null;
    if (table === "blocks" && opts.blocksError) error = { message: "blocks down" };
    const b: any = {
      select() { return b; },
      eq() { return b; }, neq() { return b; }, in() { return b; }, not() { return b; },
      is() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      or() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() {
        if (table === "feature_flags") {
          // isFlagEnabled reads .eq("flag", X); we can't see X here, so answer
          // from a single-flag stash set per request via lastFlag.
          return Promise.resolve({ data: { enabled: flags[lastFlag] === true }, error: null });
        }
        return Promise.resolve({ data: null, error });
      },
      then(onF: any, onR: any) { return Promise.resolve({ data: [], error }).then(onF, onR); },
    };
    return b;
  }
  // Capture the flag name isFlagEnabled asks for.
  let lastFlag = "";
  const origBuilder = builder;
  const client: any = {
    from(table: string) {
      const b = origBuilder(table);
      if (table === "feature_flags") {
        const origEq = b.eq;
        b.eq = (col: string, val: any) => { if (col === "flag") lastFlag = val; return origEq(); };
      }
      return b;
    },
    auth: {
      getUser: async (t: string) => t === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
  };
  return client;
}

function setClients(c: any) { _setTestClient(c, true); _setTestServiceClient(c); }

before(() => {
  _setForwardGeocoder(async (q: string) =>
    q.toLowerCase().includes("cebu") ? { lat: 10.3157, lng: 123.8854, label: "Cebu City" } : null);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", mapSearchRouter);
  return new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); }); });
});

after(() => { _setForwardGeocoder(null); _clearGeocodeCache(); return new Promise<void>((r) => server.close(() => r())); });

describe("GET /api/map/search", () => {
  it("flag off → enabled:false, empty envelope", async () => {
    setClients(makeClient({ flags: { map_search_enabled: false } }));
    const r = await req("GET", "/api/map/search?lat=10.3&lng=123.9");
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.deepEqual(r.body.results, []);
  });

  it("missing lat/lng → 400", async () => {
    setClients(makeClient({ flags: { map_search_enabled: true } }));
    const r = await req("GET", "/api/map/search");
    assert.equal(r.status, 400);
  });

  it("flag on, no data → enabled:true, empty results, viewport echoed", async () => {
    setClients(makeClient({ flags: { map_search_enabled: true } }));
    const r = await req("GET", "/api/map/search?lat=10.3&lng=123.9&radiusKm=15");
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.results, []);
    assert.deepEqual(r.body.viewport, { lat: 10.3, lng: 123.9, radiusKm: 15 });
    assert.equal(r.body.total, 0);
  });

  it("block-list read error → fail closed (empty results, still enabled)", async () => {
    setClients(makeClient({ flags: { map_search_enabled: true }, blocksError: true }));
    const r = await req("GET", "/api/map/search?lat=10.3&lng=123.9");
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.results, []);
  });

  it("401 without a token", async () => {
    setClients(makeClient({ flags: { map_search_enabled: true } }));
    const r = await req("GET", "/api/map/search?lat=1&lng=1", undefined, null);
    assert.equal(r.status, 401);
  });
});

describe("POST /api/map/compass-command", () => {
  it("flag off → enabled:false, no commands", async () => {
    setClients(makeClient({ flags: { map_compass_commands_enabled: false } }));
    const r = await req("POST", "/api/map/compass-command", { intent: { kind: "clear" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.deepEqual(r.body.commands, []);
  });

  it("invalid intent kind → 400", async () => {
    setClients(makeClient({ flags: { map_compass_commands_enabled: true } }));
    const r = await req("POST", "/api/map/compass-command", { intent: { kind: "explode" } });
    assert.equal(r.status, 400);
  });

  it("go_to with coords → a validated set-viewport", async () => {
    setClients(makeClient({ flags: { map_compass_commands_enabled: true } }));
    const r = await req("POST", "/api/map/compass-command", { intent: { kind: "go_to", lat: 10.3, lng: 123.9, radiusKm: 12 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.commands.length, 1);
    assert.equal(r.body.commands[0].type, "set-viewport");
    assert.equal(r.body.commands[0].radiusKm, 12);
  });

  it("go_to with a query → server-geocoded set-viewport", async () => {
    setClients(makeClient({ flags: { map_compass_commands_enabled: true } }));
    const r = await req("POST", "/api/map/compass-command", { intent: { kind: "go_to", query: "Cebu" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.commands[0].type, "set-viewport");
    assert.equal(r.body.commands[0].label, "Cebu City");
  });
});
