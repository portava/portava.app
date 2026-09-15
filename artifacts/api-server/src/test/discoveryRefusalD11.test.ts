/**
 * D11 — an internal failure must not masquerade as a successful empty result.
 *
 * OWNER RULING (verbatim, binding):
 *   "internal failures must not masquerade as successful empty results or
 *    corrupt exposure accounting"
 *
 * SPEC CLAUSE: `11` §9 — docs/specs/discovery-v1/11_API_Specification.md:103
 *   "A failure must not masquerade as success."
 * over the six classes at :96-101 (validation, authorization, constraint
 * mismatch, transient DB, feature-disabled, unsupported surface).
 *
 * WHAT THIS PINS
 * ==============
 * For every Discovery collection route, THREE answers that used to be one:
 *   1. a genuine empty result   ⇒ 200, empty collection, NO `refusal` key
 *   2. an internal failure      ⇒ 200, empty collection, `refusal` naming the
 *                                 §9 class, a route-specific code, and
 *                                 coverage:"nothing"
 *   3. genuinely-invalid input  ⇒ still 4xx, NOT softened into (1) or (2)
 *
 * (1) and (3) are as load-bearing as (2). (1) is the control that proves the
 * refusal is not simply stamped on every empty body — a refusal that is always
 * present distinguishes nothing. (3) is the regression guard for the defect a
 * prior mutation proved: downgrading an existing `400 invalid_payload` to
 * `200 { places: [] }` is the very shape D11 forbids, so a "fix" that softened
 * it would be the defect wearing the fix's clothes.
 *
 * And exposure: a refused response must write NO `rank_events` impression row,
 * because `logDiscoveryServe` rows are what
 * `content_distribution_stats.eligible_impressions` mirrors — the exposure
 * denominator. A failed serve counted as a serve is the second half of the
 * ruling.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryRefusalD11.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, { _setTestDbPlacesOverride } from "../routes/discovery.js";
import discoverySearchRouter from "../routes/discoverySearch.js";
import {
  DISCOVERY_REFUSAL_CLASSES, discoveryRefusal, sendDiscoveryRefusal, logServeUnlessRefused,
} from "../lib/discoveryRefusal.js";
import { invalidateServeLogFlagCache, DiscoveryServePoint } from "../lib/discoveryServeLog.js";

// ── No network. Overpass/Nominatim throw immediately rather than hanging 25s.
//
// `nominatimHandler` is the one seam the upstream_unavailable block below needs:
// the difference between "Nominatim is down" and "Nominatim answered, and knows
// no such city" is a property OF THE UPSTREAM RESPONSE, so it cannot be probed
// through a database fixture. Left null, the original blanket throw applies and
// every pre-existing test in this file keeps the behaviour it was written for.
type NominatimReply = { status: number; body: unknown };
let nominatimHandler: ((query: string) => NominatimReply) | null = null;
/** Every Nominatim URL the route actually reached out on. */
let nominatimCalls: string[] = [];

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("nominatim.openstreetmap.org")) {
    nominatimCalls.push(s);
    if (nominatimHandler) {
      const { status, body } = nominatimHandler(s);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER_TOKEN = "d11-viewer";
const VIEWER_ID    = "d11aaaaa-0000-0000-0000-000000000001";

/** Every `.from(table)` the route asked for, in order. The exposure probe. */
let fromCalls: string[] = [];
/** Every row batch handed to `.insert()`, keyed by table. The denominator probe. */
let inserts: Array<{ table: string; rows: unknown }> = [];

/**
 * A supabase-js stand-in.
 *
 * `errorTables` RESOLVE with `{ data: null, error }` — which is what supabase-js
 * actually does on a failed read. It does not reject. Building the fixture the
 * other way is how a fail-open bug gets written and then tested green.
 */
function buildFakeClient(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const errorTables = new Set(opts.errorTables ?? []);
  // THE SERVE LOG FLAG IS ON IN EVERY FIXTURE, DELIBERATELY.
  //
  // `logDiscoveryServe` returns before its insert unless
  // `feature_flags.discovery_serve_log_enabled` is true. With the flag absent —
  // which is what an unseeded fake client reports — NO request in this file
  // could write a rank_events row, refused or not, and every `assertNoExposure`
  // below was passing VACUOUSLY: it was measuring a disabled flag, not a guard.
  // Seeding the flag on is what makes the negative assertions mean something,
  // and it is what lets the positive controls exist at all.
  const rowsFor: Record<string, any[]> = {
    feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }],
    ...(opts.rows ?? {}),
  };

  function from(table: string) {
    fromCalls.push(table);
    const preds: Array<(r: any) => boolean> = [];
    const rows: any[] = rowsFor[table] ?? [];

    const b: any = {
      select() { return b; },
      insert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      update() { return b; },
      upsert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      delete() { return b; },
      eq(col: string, val: any) { preds.push((r) => r[col] === val); return b; },
      neq() { return b; },
      is() { return b; },
      // `.not(col, op, val)` was MISSING from this builder, and its absence was
      // not inert: `searchTrips` and `searchPlans` both end their `trips` query
      // with `.not("status", "in", …)`, so every request that reached one died
      // on `b.not is not a function` inside that function's own catch arm and
      // returned `[]` — for a reason that had nothing to do with the fixture.
      // Any assertion about those two lanes was passing on a TypeError.
      not() { return b; },
      gt() { return b; }, gte() { return b; },
      lt() { return b; }, lte() { return b; },
      in() { return b; },
      or() { return b; },
      ilike() { return b; },
      contains() { return b; },
      overlaps() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
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
}

// ── One app carrying BOTH discovery routers, so every route under test is
// reached exactly the way the shipping product mounts it: under /api.
let server: http.Server;
let base = "";

function get(path: string, auth = false): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: auth ? { authorization: `Bearer ${VIEWER_TOKEN}` } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers as any });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/**
 * The assertion the whole lane is about: this body says "I failed", not
 * "there was nothing".
 */
function assertRefusal(
  body: any,
  expected: { class: string; code: string; route: string; coverage?: string },
  what: string,
) {
  assert.ok(
    body && typeof body === "object" && body.refusal,
    `${what}: no \`refusal\` on the body — an internal failure is still ` +
    `indistinguishable from a genuine empty result. Body: ${JSON.stringify(body)}`,
  );
  const r = body.refusal;
  assert.ok(
    (DISCOVERY_REFUSAL_CLASSES as readonly string[]).includes(r.class),
    `${what}: refusal.class ${JSON.stringify(r.class)} is not one of \`11\` §9's six classes`,
  );
  assert.equal(r.class, expected.class, `${what}: wrong §9 class`);
  assert.equal(r.code, expected.code, `${what}: wrong refusal code`);
  assert.equal(r.route, expected.route, `${what}: wrong route on the refusal`);
  assert.equal(r.coverage, expected.coverage ?? "nothing", `${what}: wrong coverage`);
}

/** No impression row may be written for a response that served nothing. */
function assertNoExposure(what: string) {
  const rankInserts = inserts.filter((i) => i.table === "rank_events");
  assert.equal(
    rankInserts.length, 0,
    `${what}: ${rankInserts.length} rank_events insert(s) were attempted for a ` +
    `REFUSED response — a failed serve entered the exposure denominator`,
  );
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  app.use("/api", discoverySearchRouter);
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

beforeEach(() => {
  fromCalls = []; inserts = []; nominatimCalls = [];
  // The flag read is memoised for 30s; without this the first fixture to be
  // asked would decide the answer for the whole file.
  invalidateServeLogFlagCache();
});
afterEach(() => { _setTestDbPlacesOverride(null); nominatimHandler = null; });

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/feed — serve point 7
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/feed", () => {
  it("names the failure when the place read throws, instead of serving an empty feed", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => { throw new Error("discovery_places read exploded"); });
    const r = await get("/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200, "additive shape: the status stays 200");
    assert.deepEqual(r.body.places, [], "the body still carries the empty collection for old clients");
    assertRefusal(r.body, {
      class: "transient_db", code: "feed_assembly_failed", route: "GET /discovery/feed",
    }, "/discovery/feed internal failure");
    assertNoExposure("/discovery/feed internal failure");
  });

  it("names the failure on the PRODUCTION path — supabase RESOLVES a read error, it does not throw", async () => {
    // The arm above is reached by a throw. This one is reached the way a real
    // outage arrives: postgrest hands back `{ data: null, error }` and nothing
    // rejects. `queryDbPlaces` used to turn that into `[]` — the exact moment
    // the failure became indistinguishable from an empty city, one funnel above
    // every serve point.
    setClient({ errorTables: ["discovery_places"] });
    const r = await get("/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "feed_places_read_failed", route: "GET /discovery/feed",
    }, "/discovery/feed production-path read failure");
    assert.deepEqual(
      r.body.refusal.failedSources, ["for_you"],
      "the refusal must name the category whose community rows are missing",
    );
    assertNoExposure("/discovery/feed production-path read failure");
  });

  it("a GENUINELY empty feed carries NO refusal — the control", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => []);
    const r = await get("/api/discovery/feed?city=Nowheresville&lat=1&lng=1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assert.equal(
      r.body.refusal, undefined,
      "a refusal on a genuinely empty result distinguishes nothing — it would " +
      "make every empty body look like a failure, which is the same lie inverted",
    );
  });

  it("keeps invalid input a 4xx — it must not be softened into an empty 200", async () => {
    setClient();
    const r = await get("/api/discovery/feed");            // no city, no lat/lng
    assert.equal(r.status, 400, "invalid_payload must stay 400");
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.refusal, undefined, "a 400 already distinguishes itself; do not restate it");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/counts
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/counts", () => {
  it("refuses when EVERY category count failed, instead of answering `counts: {}`", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => { throw new Error("discovery_places read exploded"); });
    const r = await get("/api/discovery/counts?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.counts, {});
    assertRefusal(r.body, {
      class: "transient_db", code: "category_counts_failed", route: "GET /discovery/counts",
    }, "/discovery/counts total failure");
    assertNoExposure("/discovery/counts total failure");
  });

  it("marks a PARTIAL count set partial, naming the categories that failed", async () => {
    setClient();
    _setTestDbPlacesOverride(async (_dest, cat) => {
      if (cat === "food" || cat === "nightlife") throw new Error("read exploded");
      return [];
    });
    const r = await get("/api/discovery/counts?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200);
    assertRefusal(r.body, {
      class: "transient_db", code: "category_counts_partial",
      route: "GET /discovery/counts", coverage: "partial",
    }, "/discovery/counts partial failure");
    assert.deepEqual(
      [...(r.body.refusal.failedSources ?? [])].sort(), ["food", "nightlife"],
      "a partial answer must say WHICH counts are missing, or its zeros are unreadable",
    );
    assert.ok(
      !("food" in r.body.counts),
      "a category whose read failed must not appear with a number",
    );
  });

  it("names the failure on the PRODUCTION path — a resolved read error, not a throw", async () => {
    setClient({ errorTables: ["discovery_places"] });
    const r = await get("/api/discovery/counts?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.counts, {});
    assertRefusal(r.body, {
      class: "transient_db", code: "category_counts_failed", route: "GET /discovery/counts",
    }, "/discovery/counts production-path read failure");
  });

  it("does NOT hand a failure a five-minute cache header", async () => {
    // The success path sets `Cache-Control: public, max-age=300`. Leaving it on
    // the refusal would pin the masquerade in every CDN between here and the
    // user for five minutes — a failure cached is a failure multiplied.
    setClient({ errorTables: ["discovery_places"] });
    const failed = await get("/api/discovery/counts?destination=Miami&lat=25.77&lng=-80.19");
    assert.ok(failed.body.refusal, "precondition: this request must have refused");
    assert.equal(
      failed.headers["cache-control"], undefined,
      `a refusal was served with Cache-Control: ${failed.headers["cache-control"]}`,
    );

    // Positive control: the success path really does set the header, so the
    // assertion above is about the refusal and not about a header nobody sets.
    setClient();
    _setTestDbPlacesOverride(async () => []);
    const ok = await get("/api/discovery/counts?destination=Miami&lat=25.77&lng=-80.19");
    assert.equal(ok.body.refusal, undefined);
    assert.equal(ok.headers["cache-control"], "public, max-age=300");
  });

  it("a genuinely empty city carries counts and NO refusal — the control", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => []);
    const r = await get("/api/discovery/counts?destination=Nowheresville&lat=1&lng=1");
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
  });

  it("keeps a missing destination a 400", async () => {
    setClient();
    const r = await get("/api/discovery/counts");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery  — the category surface (serve points 1-6)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery", () => {
  it("names the failure when assembly throws, instead of `places: [], total: 0`", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => { throw new Error("discovery_places read exploded"); });
    const r = await get("/api/discovery?destination=Miami&lat=25.77&lng=-80.19&category=food");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "discovery_assembly_failed", route: "GET /discovery",
    }, "/discovery internal failure");
    assertNoExposure("/discovery internal failure");
  });

  it("a genuinely empty city carries NO refusal — the control", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => []);
    const r = await get("/api/discovery?destination=Nowheresville&lat=1&lng=1&category=food");
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/community — serve point 10
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/community", () => {
  it("names the failure when discovery_places cannot be read", async () => {
    setClient({ errorTables: ["discovery_places"] });
    const r = await get("/api/discovery/community?city=Cebu");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "community_places_read_failed", route: "GET /discovery/community",
    }, "/discovery/community read failure");
    assertNoExposure("/discovery/community read failure");
  });

  it("a city with no community places carries NO refusal — the control", async () => {
    setClient({ rows: { discovery_places: [] } });
    const r = await get("/api/discovery/community?city=Nowheresville");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.refusal, undefined);
  });

  it("keeps a missing city a 400", async () => {
    setClient();
    const r = await get("/api/discovery/community");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/community/saved-ids
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/community/saved-ids", () => {
  it("names the failure instead of answering `ids: []` — an unreadable save set is not an empty one", async () => {
    setClient({ errorTables: ["discovery_place_saves"] });
    const r = await get("/api/discovery/community/saved-ids", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "saved_ids_read_failed",
      route: "GET /discovery/community/saved-ids",
    }, "/discovery/community/saved-ids read failure");
  });

  it("a user who has saved nothing gets NO refusal — the control", async () => {
    setClient({ rows: { discovery_place_saves: [] } });
    const r = await get("/api/discovery/community/saved-ids", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids, []);
    assert.equal(r.body.refusal, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/search — serve point 8
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/search", () => {
  it("refuses when the block/age state is unreadable, instead of `results: []`", async () => {
    setClient({ errorTables: ["blocks"] });
    const r = await get("/api/discovery/search?q=kopitiam&type=places", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "visibility_state_unreadable", route: "GET /discovery/search",
    }, "/discovery/search fail-closed");
    assertNoExposure("/discovery/search fail-closed");
  });

  it("a query that matches nothing carries NO refusal — the control", async () => {
    setClient({ rows: { discovery_places: [] } });
    const r = await get("/api/discovery/search?q=kopitiam&type=places", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
    assert.equal(r.body.refusal, undefined);
  });

  it("keeps a missing q a 400 — NOT softened to an empty 200", async () => {
    setClient();
    const r = await get("/api/discovery/search", true);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── P1/P2 — the refusal envelope's own back door, on `type=plans`.
  //
  // `searchPlans` resolves each plan's PARENT TRIP, and with
  // `discovery_trip_projection_enabled` unseeded (which is production: census
  // §6 D3 — migration 2420 unapplied, 2550 seeded FALSE) the gate resolves to
  // `legacy` and the parents come from a direct `trips` read. supabase-js
  // RESOLVES on a read failure, so a dropped `error` there makes `parents` empty
  // and every plan is discarded as "no allowed parent trip" — the route then
  // answers `200 { results: [] }` with no refusal on it. That body is
  // byte-identical to the one a query that genuinely matches nothing gets, which
  // is the exact masquerade `11` §9 and owner ruling D11 forbid, arriving
  // through a read this route's own catch never sees.
  //
  // P2 is the control and is as load-bearing as P1: with `trips` READABLE and
  // carrying no admissible parent, the same empty `results` must carry NO
  // refusal. Without it, a "fix" that stamps a refusal on every empty plans
  // response passes P1 and distinguishes nothing.
  const PLAN_ROW = {
    id: "d11plan0-0000-0000-0000-000000000001",
    title: "Kopitiam crawl",
    trip_id: "d11trip0-0000-0000-0000-000000000001",
    creator_id: "d11user0-0000-0000-0000-000000000002",
    created_at: "2026-09-01T00:00:00.000Z",
    removed_at: null,
  };

  it("P1 — refuses when the parent-trip read fails, instead of `results: []`", async () => {
    setClient({ rows: { trip_plan_items: [PLAN_ROW] }, errorTables: ["trips"] });
    const r = await get("/api/discovery/search?q=kopitiam&type=plans", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "search_failed", route: "GET /discovery/search",
    }, "/discovery/search?type=plans with an unreadable `trips`");
    assertNoExposure("/discovery/search?type=plans with an unreadable `trips`");
  });

  // ── P3/P4 — the same back door, one level up, on `type=all`.
  //
  // P1 above works because `searchPlans` re-raises DiscoverySearchReadError and
  // the route's catch arm turns it into a refusal. `type=all` does not go
  // through that arm. `searchAll` fans the 17 types out under
  // `Promise.allSettled` and then collapses every REJECTED bucket to `[]`:
  //
  //     const items = r.status === "fulfilled" ? r.value : [];
  //
  // So the named error P1 invented, whose whole purpose is to re-enter the
  // front door the refusal envelope guards, is caught by allSettled and thrown
  // away — and `type=all`, which is the DEFAULT type and what the global search
  // bar actually sends, answers `200 { results: [...] }` with a silently
  // missing bucket and no refusal on it. The failure is now invisible in the
  // one place a user is most likely to meet it.
  //
  // Coverage is "partial", not "nothing": the other buckets really were read
  // and really were served, so their items are genuine exposure. `failedSources`
  // names which ones were not, because "some of this is missing" without saying
  // which part is not a usable answer either.
  //
  // P4 is the control and is as load-bearing as P3: with every table readable,
  // the same `type=all` request must carry NO refusal. A fix that stamps a
  // partial refusal on every fan-out response distinguishes nothing.
  const HASHTAG_ROW = {
    id: "d11hash0-0000-0000-0000-000000000001",
    slug: "kopitiam",
    name: "Kopitiam",
    usage_count: 5,
    created_at: "2026-09-01T00:00:00.000Z",
    is_blocked: false,
  };

  it("P3 — type=all refuses PARTIAL when a bucket's read fails, instead of a silently short list", async () => {
    setClient({
      rows: { trip_plan_items: [PLAN_ROW], hashtags: [HASHTAG_ROW] },
      errorTables: ["trips"],
    });
    const r = await get("/api/discovery/search?q=kopitiam&type=all", true);
    assert.equal(r.status, 200);

    // The buckets that worked are still served — throwing them away would be
    // the same corruption in the other direction.
    assert.ok(
      r.body.results.some((x: any) => x.type === "hashtags"),
      "the readable buckets must still be served on a partial refusal",
    );

    assertRefusal(r.body, {
      class: "transient_db", code: "search_sources_unreadable", route: "GET /discovery/search",
      coverage: "partial",
    }, "/discovery/search?type=all with an unreadable `trips`");
    assert.ok(
      Array.isArray(r.body.refusal.failedSources) && r.body.refusal.failedSources.includes("plans"),
      `failedSources must name the buckets that failed, got ${JSON.stringify(r.body.refusal?.failedSources)}`,
    );
  });

  it("P4 — type=all over readable tables carries NO refusal (control)", async () => {
    setClient({ rows: { trip_plan_items: [PLAN_ROW], trips: [], hashtags: [HASHTAG_ROW] } });
    const r = await get("/api/discovery/search?q=kopitiam&type=all", true);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.refusal, undefined,
      "a fan-out where every source answered must NOT be stamped with a refusal",
    );
  });

  it("P2 — a readable `trips` with no admissible parent carries NO refusal (control)", async () => {
    setClient({ rows: { trip_plan_items: [PLAN_ROW], trips: [] } });
    const r = await get("/api/discovery/search?q=kopitiam&type=plans", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, []);
    assert.equal(
      r.body.refusal, undefined,
      "a plans search that genuinely admits nothing must NOT be stamped with a refusal",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/discovery/suggest — serve point 9. The row C14 certified as correct.
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /discovery/suggest", () => {
  it("refuses when the block/age state is unreadable, instead of `groups: []`", async () => {
    setClient({ errorTables: ["blocks"] });
    const r = await get("/api/discovery/suggest?q=kopitiam", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups, []);
    assertRefusal(r.body, {
      class: "transient_db", code: "visibility_state_unreadable", route: "GET /discovery/suggest",
    }, "/discovery/suggest fail-closed");
    assertNoExposure("/discovery/suggest fail-closed");
  });

  it("a too-short query is a VALIDATION refusal, not the same empty body as a DB failure", async () => {
    setClient();
    const r = await get("/api/discovery/suggest?q=k", true);
    assert.equal(r.status, 200, "typeahead must keep its 200 — see lib/discoveryRefusal.ts");
    assert.deepEqual(r.body.groups, []);
    assertRefusal(r.body, {
      class: "validation", code: "query_too_short", route: "GET /discovery/suggest",
    }, "/discovery/suggest short query");
  });

  it("the three suggest exits are three DIFFERENT answers — C14's whole complaint", async () => {
    setClient();
    const short = await get("/api/discovery/suggest?q=k", true);
    setClient({ errorTables: ["blocks"] });
    const failed = await get("/api/discovery/suggest?q=kopitiam", true);
    setClient({ rows: { discovery_places: [] } });
    const empty = await get("/api/discovery/suggest?q=kopitiam", true);

    assert.notDeepEqual(short.body, failed.body, "validation and transient-DB still collapse to one body");
    assert.notDeepEqual(failed.body, empty.body, "a DB failure still looks exactly like a genuine empty");
    assert.equal(empty.body.refusal, undefined, "the genuine empty must remain unmarked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upstream_unavailable — the SEVENTH class.
//
// OWNER RULING of 2026-09-14, verbatim and binding:
//
//   "Add upstream_unavailable for upstream dependency failures. Do not cache
//    rate limits or outages as 'this location does not exist.' Verify that
//    clients recognize refusal responses, preserve existing bookmarks on read
//    failures, and exclude failed responses from exposure accounting. A
//    distinguishable response body alone is insufficient if consumers still
//    treat it as successful empty data."
//
// `11` §9 names SIX classes. The owner added the seventh, and the reason is the
// defect these tests pin: Discovery's geocoder is Nominatim, an upstream nobody
// here operates. When Nominatim answers 429 or 503 the route knows nothing
// about the city — and the six §9 classes have no honest home for that.
// `transient_db` is the nearest, and it is false: no database was involved.
// Filing an upstream outage under `transient_db` is a lie about the failure,
// which is the thing lib/discoveryRefusal.ts exists to stop.
//
// THE CACHE IS THE REAL DAMAGE, AND IT OUTLIVES THE OUTAGE.
// `geocode()` returned `null` on `!res.ok`, and `geocodeCached` cached that
// null for 24 HOURS in L1 (in-process) and would have persisted it to L2
// (`discovery_geocode_cache`) had the null been truthy. So one Nominatim 429
// did not merely fail one request: it wrote down "this city does not exist" and
// served that answer to every user for the rest of the day, long after
// Nominatim recovered. A wrong answer cached is a wrong answer multiplied.
//
// The tests below therefore assert TWO things that are easy to confuse:
//   (a) the outage is NAMED (upstream_unavailable), and
//   (b) NOTHING about it is written down — the very next request re-asks.
// And the control that keeps (b) honest: a genuine "no such city" is a FACT,
// and it must still cache and must still be a plain empty result with no
// refusal on it. Conflating the two in EITHER direction is the defect.
// ─────────────────────────────────────────────────────────────────────────────

/** Nominatim is down: every lookup 429s. */
const NOMINATIM_RATE_LIMITED = () => ({ status: 429, body: { error: "Too Many Requests" } });
/** Nominatim is up and knows the place. */
const NOMINATIM_KNOWS_MIAMI = () => ({
  status: 200,
  body: [{ lat: "25.7743", lon: "-80.1937", display_name: "Miami, Florida, United States" }],
});
/** Nominatim is up and has never heard of it — a FACT, not a failure. */
const NOMINATIM_KNOWS_NOTHING = () => ({ status: 200, body: [] });

/** No row may be written to the geocode L2 cache for an outage. */
function assertNoGeocodePersisted(what: string) {
  const writes = inserts.filter((i) => i.table === "discovery_geocode_cache");
  assert.equal(
    writes.length, 0,
    `${what}: ${writes.length} write(s) to discovery_geocode_cache for an OUTAGE — ` +
    `the L2 cache now holds a failure dressed as a fact: ${JSON.stringify(writes)}`,
  );
}

describe("upstream_unavailable — `11` §9's six plus the owner's seventh", () => {
  it("is declared, and is NOT one of the six the spec named", () => {
    assert.ok(
      (DISCOVERY_REFUSAL_CLASSES as readonly string[]).includes("upstream_unavailable"),
      "the seventh class does not exist — an upstream outage has no honest class to be filed under",
    );
    assert.equal(
      DISCOVERY_REFUSAL_CLASSES.length, 7,
      "the vocabulary must be exactly `11` §9's six plus the owner's one addition",
    );
  });
});

describe("GET /discovery/counts — a geocoder outage", () => {
  it("is named upstream_unavailable, not `counts: {}` and not transient_db", async () => {
    setClient();
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const r = await get("/api/discovery/counts?destination=Outagetown-Counts");
    assert.equal(r.status, 200, "additive shape: the status stays 200");
    assert.deepEqual(r.body.counts, {}, "the empty collection still ships for old clients");
    assertRefusal(r.body, {
      class: "upstream_unavailable", code: "nominatim_http_429", route: "GET /discovery/counts",
    }, "/discovery/counts geocoder outage");
    assertNoExposure("/discovery/counts geocoder outage");
    assertNoGeocodePersisted("/discovery/counts geocoder outage");
  });

  it("does not hand the outage a five-minute cache header", async () => {
    setClient();
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const r = await get("/api/discovery/counts?destination=Outagetown-Header");
    assert.ok(r.body.refusal, "precondition: this request must have refused");
    assert.equal(
      r.headers["cache-control"], undefined,
      `an outage was served with Cache-Control: ${r.headers["cache-control"]}`,
    );
  });

  it("CACHES NOTHING: the request after the outage re-asks Nominatim and succeeds", async () => {
    // The whole point. Under the old code the 429 wrote `null` into the 24-hour
    // L1 geocode cache, so THIS second request never touched the network and
    // answered "Miami does not exist" until tomorrow.
    setClient();
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const outage = await get("/api/discovery/counts?destination=Cachetown");
    assert.ok(outage.body.refusal, "precondition: the first request must have refused");
    const callsAfterOutage = nominatimCalls.length;

    _setTestDbPlacesOverride(async () => []);
    nominatimHandler = NOMINATIM_KNOWS_MIAMI;
    const recovered = await get("/api/discovery/counts?destination=Cachetown");
    assert.ok(
      nominatimCalls.length > callsAfterOutage,
      "the second request never re-asked Nominatim — the outage was cached as a fact",
    );
    assert.equal(
      recovered.body.refusal, undefined,
      "the recovered request still refused — a cached outage is still being served",
    );
    assert.ok(
      Object.keys(recovered.body.counts).length > 0,
      "the recovered request answered empty counts — the cached null survived the outage",
    );
  });

  it("a genuine `no such city` still caches and is still a plain empty result — the control", async () => {
    // The other direction of the same conflation. Nominatim ANSWERED; it simply
    // has no such place. That is a fact about the world, it is cacheable, and it
    // must NOT be dressed up as a refusal — a refusal on every empty answer
    // distinguishes nothing.
    setClient();
    _setTestDbPlacesOverride(async () => []);
    nominatimHandler = NOMINATIM_KNOWS_NOTHING;
    const first = await get("/api/discovery/counts?destination=Nowheresville-XYZ");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.counts, {});
    assert.equal(
      first.body.refusal, undefined,
      "a genuine miss was marked as a refusal — that is the same lie inverted",
    );
    const callsAfterMiss = nominatimCalls.length;

    const second = await get("/api/discovery/counts?destination=Nowheresville-XYZ");
    assert.equal(second.body.refusal, undefined);
    assert.equal(
      nominatimCalls.length, callsAfterMiss,
      "a genuine `no such city` was NOT cached — the 1 req/s fair-use budget is now spent re-asking a settled question",
    );
  });
});

describe("GET /discovery/feed — a geocoder outage", () => {
  it("is named upstream_unavailable, not an empty feed", async () => {
    setClient();
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const r = await get("/api/discovery/feed?city=Outagetown-Feed", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assertRefusal(r.body, {
      class: "upstream_unavailable", code: "nominatim_http_429", route: "GET /discovery/feed",
    }, "/discovery/feed geocoder outage");
    assertNoExposure("/discovery/feed geocoder outage");
    assertNoGeocodePersisted("/discovery/feed geocoder outage");
  });

  it("a genuine `no such city` carries NO refusal — the control", async () => {
    setClient();
    nominatimHandler = NOMINATIM_KNOWS_NOTHING;
    const r = await get("/api/discovery/feed?city=Nowheresville-ABC", true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assert.equal(r.body.refusal, undefined);
  });
});

describe("GET /discovery — a geocoder outage", () => {
  it("is named upstream_unavailable, not transient_db", async () => {
    // This route already refused — but as `transient_db`, because a Nominatim
    // throw landed in a catch that assumed every failure was a database one.
    // The body was distinguishable from an empty city and STILL said the wrong
    // thing about what broke.
    setClient();
    _setTestDbPlacesOverride(async () => []);
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const r = await get("/api/discovery?destination=Outagetown-Discovery&category=food");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.places, []);
    assertRefusal(r.body, {
      class: "upstream_unavailable", code: "nominatim_http_429", route: "GET /discovery",
    }, "/discovery geocoder outage");
    assertNoExposure("/discovery geocoder outage");
    assertNoGeocodePersisted("/discovery geocoder outage");
  });

  it("a DATABASE failure on the same route is still transient_db — the control that keeps the seventh class honest", async () => {
    // If every failure became `upstream_unavailable` the new class would be as
    // uninformative as the old one. The two must stay distinguishable.
    setClient();
    nominatimHandler = NOMINATIM_KNOWS_MIAMI;
    _setTestDbPlacesOverride(async () => { throw new Error("discovery_places read exploded"); });
    const r = await get("/api/discovery?destination=Healthytown-Discovery&category=food");
    assertRefusal(r.body, {
      class: "transient_db", code: "discovery_assembly_failed", route: "GET /discovery",
    }, "/discovery database failure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exposure accounting, with the POSITIVE CONTROL beside every "no insert".
//
// "No rank_events row was written" is a weak assertion on its own: it also
// holds when the fixture never reaches the serve log at all, when the table
// name changed, or when the probe is watching the wrong client. Each arm below
// therefore pairs the refusal with A REAL SERVE ON THE SAME FIXTURE and asserts
// that the real serve writes EXACTLY ONE impression batch. If the positive
// control goes quiet, the negative one has stopped proving anything.
// ─────────────────────────────────────────────────────────────────────────────

describe("exposure accounting — refused responses vs. real serves", () => {
  /** rank_events insert calls recorded so far. */
  const rankInserts = () => inserts.filter((i) => i.table === "rank_events");

  it("GET /discovery/feed: an upstream outage writes NO impression, a real serve writes exactly one", async () => {
    // NEGATIVE — the refusal.
    setClient({ rows: { discovery_places: [] } });
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const refused = await get("/api/discovery/feed?city=Outagetown-Exposure", true);
    assert.ok(refused.body.refusal, "precondition: this request must have refused");
    assert.equal(refused.body.refusal.coverage, "nothing");
    assert.equal(
      rankInserts().length, 0,
      "a refused feed entered the exposure denominator",
    );

    // POSITIVE CONTROL — same fixture, same viewer, same route, a real serve.
    // Without this the assertion above would also pass if nothing on this route
    // could ever write an impression.
    fromCalls = []; inserts = [];
    setClient({ rows: { discovery_places: [] } });
    _setTestDbPlacesOverride(async () => [{
      id: "db/11111111-1111-1111-1111-111111111111",
      name: "A real served place", category: "for_you", type: null, description: null,
      distanceKm: null, lat: 25.77, lng: -80.19, tags: [], address: null,
      website: null, phone: null, openingHours: null, rating: null, isOpenNow: null,
    } as any]);
    nominatimHandler = NOMINATIM_KNOWS_MIAMI;
    const served = await get("/api/discovery/feed?city=Healthytown-Exposure", true);
    assert.equal(served.body.refusal, undefined, "the positive control must not itself be a refusal");
    assert.ok(served.body.places.length > 0, "the positive control served nothing — it proves nothing");
    await new Promise((r) => setTimeout(r, 60)); // the serve log is fire-and-forget
    assert.equal(
      rankInserts().length, 1,
      `POSITIVE CONTROL FAILED: a genuine serve wrote ${rankInserts().length} rank_events batches, ` +
      `not 1 — the "no insert" assertion above is not proving anything`,
    );
  });

  it("GET /discovery/counts: an upstream outage writes NO impression, and counts never log one at all", async () => {
    setClient();
    nominatimHandler = NOMINATIM_RATE_LIMITED;
    const refused = await get("/api/discovery/counts?destination=Outagetown-CountsExp");
    assert.ok(refused.body.refusal);
    assert.equal(rankInserts().length, 0);

    // The honest positive control for THIS route is that it has no serve point:
    // a successful /counts writes no impression either, because it serves totals
    // and never content. Stating that here stops the negative assertion above
    // from being read as evidence the guard fired.
    fromCalls = []; inserts = [];
    setClient();
    _setTestDbPlacesOverride(async () => []);
    nominatimHandler = NOMINATIM_KNOWS_MIAMI;
    const ok = await get("/api/discovery/counts?destination=Healthytown-CountsExp");
    assert.equal(ok.body.refusal, undefined);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      rankInserts().length, 0,
      "/discovery/counts wrote an impression — it serves totals, not content, and has no serve point",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The exposure guard ITSELF, not the route that happens to satisfy it.
//
// WHY THIS BLOCK EXISTS (a surviving mutant, recorded rather than hidden).
// Deleting the `wasRefused` early-return from `logServeUnlessRefused` did NOT
// turn any route test above red. That is not a gap in the routes; it is the
// point lib/discoveryRefusal.ts already makes in prose: a `coverage: "nothing"`
// refusal carries an EMPTY collection, and `logDiscoveryServe` returns before
// its insert whenever `items.length === 0`. So on today's routes the invariant
// is held by a guard written for a different reason, in a file this lane does
// not own — "REAL but INCIDENTAL", in the module's own words.
//
// A test that only ever exercises the incidental path cannot tell the guard
// from its absence. These two call the guard DIRECTLY, with a non-empty item
// list — the shape a future partial-refusal call site would produce, and the
// one the incidental `length === 0` check does not cover.
// ─────────────────────────────────────────────────────────────────────────────

describe("logServeUnlessRefused — the guard, exercised directly", () => {
  /** Minimal express-Response stand-in: enough for sendDiscoveryRefusal. */
  function fakeRes() {
    const r: any = {
      headersSent: false,
      status() { return r; },
      json() { r.headersSent = true; return r; },
    };
    return r;
  }

  const ITEMS = [{ id: "db/aaaaaaaa-0000-0000-0000-000000000001" }, { id: "node/99" }];
  const PARAMS = {
    userId: VIEWER_ID,
    servePoint: DiscoveryServePoint.FEED,
    route: "GET /discovery/feed",
    sessionId: "11111111-2222-3333-4444-555555555555",
    items: ITEMS,
    context: { destination: "Miami" },
  };

  it("suppresses the serve log for a refused response even when HANDED items", async () => {
    setClient();
    const res = fakeRes();
    sendDiscoveryRefusal(res, { places: [] },
      discoveryRefusal("upstream_unavailable", "nominatim_http_429", "GET /discovery/feed"));
    logServeUnlessRefused(res, buildFakeClient({
      rows: { feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }] },
    }) as any, PARAMS);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      inserts.filter((i) => i.table === "rank_events").length, 0,
      "a REFUSED response wrote impressions — the guard is not doing anything",
    );
  });

  it("POSITIVE CONTROL: the same items on a NOT-refused response write exactly one batch", async () => {
    // This is what makes the assertion above about the guard rather than about
    // a fixture that can never insert. Same items, same params, same client —
    // the only difference is that this response was never marked refused.
    setClient();
    const res = fakeRes();
    logServeUnlessRefused(res, buildFakeClient({
      rows: { feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }] },
    }) as any, PARAMS);
    await new Promise((r) => setTimeout(r, 60));
    const rank = inserts.filter((i) => i.table === "rank_events");
    assert.equal(
      rank.length, 1,
      `POSITIVE CONTROL FAILED: an unrefused serve wrote ${rank.length} batches, not 1`,
    );
    assert.equal((rank[0]!.rows as unknown[]).length, ITEMS.length, "one impression row per served item");
  });
});
