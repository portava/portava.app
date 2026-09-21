/**
 * D11, second half: "…or corrupt exposure accounting".
 *
 * `logDiscoveryServe` writes one `rank_events` impression row per served item
 * and then increments `content_distribution_stats.eligible_impressions`
 * (lib/discoveryServeLog.ts:460-466) — the exposure DENOMINATOR. A serve that
 * failed exposed nothing to nobody, so it must not appear there. If it does,
 * every rate computed against that denominator is wrong in the direction that
 * makes a broken surface look merely unpopular.
 *
 * WHAT THIS FILE PROVES, AND WHY THE POSITIVE CONTROLS ARE HALF OF IT
 * ==================================================================
 * "No rank_events insert was attempted" is worthless on its own: it is also
 * what you observe when the serve-log flag is off, when the fixture never had
 * a client, or when the probe is looking at the wrong thing. So the flag is
 * SEEDED ON here (`discovery_serve_log_enabled`), and every negative assertion
 * is paired with a positive one on the same fixture showing the probe does see
 * an insert when a serve really happens.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryRefusalExposure.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, { _setTestDbPlacesOverride } from "../routes/discovery.js";
import {
  discoveryRefusal,
  sendDiscoveryRefusal,
  logServeUnlessRefused,
  wasRefused,
} from "../lib/discoveryRefusal.js";
import {
  DiscoveryServePoint,
  invalidateServeLogFlagCache,
} from "../lib/discoveryServeLog.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER_TOKEN = "d11-exposure-viewer";
const VIEWER_ID    = "d11bbbbb-0000-0000-0000-000000000001";

let inserts: Array<{ table: string; rows: any }> = [];

/** The serve-log flag is ON in every fixture — see the header. */
const FLAG_ROWS = [{ flag: "discovery_serve_log_enabled", enabled: true }];

function buildFakeClient(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const errorTables = new Set(opts.errorTables ?? []);
  const rowsFor: Record<string, any[]> = { feature_flags: FLAG_ROWS, ...(opts.rows ?? {}) };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rows: any[] = rowsFor[table] ?? [];
    const b: any = {
      select() { return b; },
      insert(payload: any) { inserts.push({ table, rows: payload }); return b; },
      update() { return b; },
      upsert(payload: any) { inserts.push({ table, rows: payload }); return b; },
      delete() { return b; },
      eq(col: string, val: any) { preds.push((r) => r[col] === val); return b; },
      neq() { return b; }, is() { return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      in() { return b; }, or() { return b; }, ilike() { return b; },
      contains() { return b; }, overlaps() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };
    function filtered() { return rows.filter((r) => preds.every((p) => p(r))); }
    async function resolveList() {
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      return { data: filtered(), error: null, count: filtered().length };
    }
    async function resolveOne() {
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` } };
      return { data: filtered()[0] ?? null, error: null };
    }
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === VIEWER_TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
  };
}

function setClient(opts: Parameters<typeof buildFakeClient>[0] = {}) {
  const fc = buildFakeClient(opts);
  _setTestClient(fc as any, true);
  _setTestServiceClient(fc as any);
  invalidateServeLogFlagCache();
  return fc;
}

const rankInserts = () => inserts.filter((i) => i.table === "rank_events");

/** The serve log is fire-and-forget; give its promise chain room to land. */
const settle = () => new Promise<void>((r) => setTimeout(r, 60));

let server: http.Server;
let base = "";

function get(path: string, auth = false): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search,
        method: "GET", headers: auth ? { authorization: `Bearer ${VIEWER_TOKEN}` } : {} },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function fakeRes() {
  return { headersSent: false, status() { return this; }, json() { return this; } } as any;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  globalThis.fetch = _originalFetch;
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  _setTestDbPlacesOverride(null);
});

beforeEach(() => { inserts = []; });
afterEach(() => { _setTestDbPlacesOverride(null); });

// ─────────────────────────────────────────────────────────────────────────────
// The guard itself
// ─────────────────────────────────────────────────────────────────────────────

describe("logServeUnlessRefused", () => {
  const params = {
    userId: VIEWER_ID,
    servePoint: DiscoveryServePoint.FEED,
    route: "GET /discovery/feed",
    items: [{ id: "db/abc" }],
  };

  it("POSITIVE CONTROL: a normal response DOES write impression rows", async () => {
    const sc = setClient();
    const res = fakeRes();
    assert.equal(wasRefused(res), false);
    logServeUnlessRefused(res, sc, params);
    await settle();
    assert.equal(rankInserts().length, 1, "the probe cannot see an insert — every negative below would be vacuous");
  });

  it("a response refused with coverage 'nothing' writes NOTHING", async () => {
    const sc = setClient();
    const res = fakeRes();
    sendDiscoveryRefusal(res, { places: [] },
      discoveryRefusal("transient_db", "feed_assembly_failed", "GET /discovery/feed"));
    assert.equal(wasRefused(res), true);
    // Handed a NON-empty item list on purpose: the guard must hold on its own,
    // not lean on logDiscoveryServe's `items.length === 0` early return, which
    // lives in a file this lane does not own and was written for another reason.
    logServeUnlessRefused(res, sc, params);
    await settle();
    assert.equal(rankInserts().length, 0, "a refused serve entered the exposure denominator");
  });

  it("is inert when the response is already on the wire — no double-send crash", () => {
    // Several Discovery routes fire their serve log AFTER res.json() and INSIDE
    // the try. A throw from that last statement lands in the catch arm with the
    // real page already sent, and a second res.json() there would turn a served
    // response into ERR_HTTP_HEADERS_SENT — the fix breaking what it fixed. This
    // is also why the /discovery/search and /discovery/counts catch arms cannot
    // be reached by a test: every lane beneath them absorbs its own failures, so
    // those arms are defensive, and THIS is the property that matters for them.
    const res = fakeRes();
    res.headersSent = true;
    let sent = 0;
    res.json = () => { sent++; return res; };
    assert.doesNotThrow(() =>
      sendDiscoveryRefusal(res, { results: [] },
        discoveryRefusal("transient_db", "search_failed", "GET /discovery/search")),
    );
    assert.equal(sent, 0, "a refusal overwrote a response that had already been sent");
    assert.equal(wasRefused(res), true, "the response is still marked refused, so no serve may be logged for it");
  });

  it("a PARTIAL refusal still logs — the items it did serve are real exposure", async () => {
    const sc = setClient();
    const res = fakeRes();
    sendDiscoveryRefusal(res, { places: [] },
      discoveryRefusal("transient_db", "feed_places_read_failed", "GET /discovery/feed", "partial", ["food"]));
    assert.equal(wasRefused(res), false, "partial coverage must not mark the response refused");
    logServeUnlessRefused(res, sc, params);
    await settle();
    assert.equal(rankInserts().length, 1, "under-counting a real serve corrupts the denominator too");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the shipping route: GET /api/discovery/feed, serve point 7
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/feed — exposure", () => {
  const PLACE = {
    id: "db/feed-1", name: "Wynwood Walls", category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1, lat: 25.77, lng: -80.19, tags: [], address: null,
    website: null, phone: null, openingHours: null, rating: 4.5, isOpenNow: null,
  };

  it("POSITIVE CONTROL: a real serve writes rank_events", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => [PLACE as any]);
    const r = await get("/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19", true);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.equal(r.body.places.length, 1);
    await settle();
    assert.equal(rankInserts().length, 1, "serve point 7 did not log a real serve — the probe is blind");
  });

  it("a REFUSED feed writes no rank_events at all", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => { throw new Error("discovery_places read exploded"); });
    const r = await get("/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19", true);
    assert.equal(r.body.refusal.coverage, "nothing");
    await settle();
    assert.equal(
      rankInserts().length, 0,
      "GET /discovery/feed logged a failed serve as a serve — the exposure denominator is corrupt",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the shipping route: GET /api/discovery/community, serve point 10
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/community — exposure", () => {
  const ROW = {
    id: "comm-1", city: "Cebu", name: "Sugbo Mercado", place_type: "traveler_pick",
    category: "food", neighborhood: null, blurb: null, image_url: null, submitted_by: null,
    saved_count: 0, tag: null, note: null, rating: null, source: "traveler", status: "active",
    verified: false, created_at: "2026-09-01T00:00:00.000Z", lat: null, lng: null, profiles: null,
  };

  it("POSITIVE CONTROL: a real serve writes rank_events", async () => {
    setClient({ rows: { discovery_places: [ROW] } });
    const r = await get("/api/discovery/community?city=Cebu", true);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.equal(r.body.items.length, 1);
    await settle();
    assert.equal(rankInserts().length, 1, "serve point 10 did not log a real serve — the probe is blind");
  });

  it("a REFUSED community read writes no rank_events at all", async () => {
    setClient({ errorTables: ["discovery_places"] });
    const r = await get("/api/discovery/community?city=Cebu", true);
    assert.equal(r.body.refusal.code, "community_places_read_failed");
    await settle();
    assert.equal(rankInserts().length, 0, "a failed community read was counted as exposure");
  });
});
