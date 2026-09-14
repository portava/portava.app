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
import { DISCOVERY_REFUSAL_CLASSES } from "../lib/discoveryRefusal.js";

// ── No network. Overpass/Nominatim throw immediately rather than hanging 25s.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
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
  const rowsFor = opts.rows ?? {};

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

beforeEach(() => { fromCalls = []; inserts = []; });
afterEach(() => { _setTestDbPlacesOverride(null); });

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
