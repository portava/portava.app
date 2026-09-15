/**
 * D11's LAST RESIDUAL — `GET /discovery` and the curated half of its merge.
 *
 * OWNER RULING (verbatim, binding):
 *   "internal failures must not masquerade as successful empty results or
 *    corrupt exposure accounting"
 *
 * SPEC CLAUSE: `11` §9 — "A failure must not masquerade as success."
 *
 * WHAT THIS FILE PINS, AND WHY IT IS SEPARATE FROM discoveryRefusalD11.test.ts
 * ===========================================================================
 * `queryDbPlaces` distinguishes "discovery_places could not be read" (`null`)
 * from "this city has no community places" (`[]`). GET /discovery/feed and
 * GET /discovery/counts propagate that distinction because they call it
 * directly. GET /discovery did NOT: the merge helper
 * `loadCuratedAndCanonicalPlaces` collapsed it in a `curated ?? []` and handed
 * its FOUR serve paths a SHORT LIST with nothing on the envelope to say a
 * source was missing — on the single largest Discovery surface, one funnel above
 * every serve point. No client can branch on a field that was never sent.
 *
 * THE FOUR SERVE PATHS, how each is reached here, and how each is RECOGNISED:
 *
 *   1. cache-A serve       `serveCachedPlaces` (L1 / L2_fresh / L2_stale).
 *                          Reached by seeding the L1 cache. Recognised by
 *                          `cached: true` WITH `meta.cacheLevel`.
 *   2. Compass cache-B hit the stored per-user ranked page. Reached by ranking
 *                          once and asking again. `cached: true`, NO `meta`.
 *   3. Compass fresh rank  Compass flag on, cache B empty. `cached: false`,
 *                          NO `meta`.
 *   4. cold fetch          the legacy/PDE tail. `meta.cacheLevel: "miss"`.
 *
 * Recognising them is not decoration. Every Compass branch in the route swallows
 * its own errors and falls through to the cold path, so a fixture that cannot
 * carry the ranking pipeline does not fail — it silently answers from a
 * DIFFERENT path. Without the discriminator a "Compass" case here would be a
 * cold-path case wearing its name, and would keep passing after the Compass
 * serve paths stopped refusing.
 *
 * WHY "partial" AND NOT "nothing", ON ALL FOUR.
 * The route has three retrievals — Overpass, the canonical `places` registry and
 * curated `discovery_places` — and only the last can report that it failed. The
 * other two ANSWERED, so their emptiness is trustworthy and the rows they
 * produced really were served. That is GET /discovery/search's rule verbatim
 * (routes/discoverySearch.ts): "partial as long as ANY source answered, even
 * when this page happens to be empty". It is also the only coverage that leaves
 * exposure accounting alone — `sendDiscoveryRefusal` marks a response refused
 * (suppressing its serve log) only at coverage "nothing" — which the last test
 * in this file pins from the other side.
 *
 * WHY A SEPARATE FILE. `docs/architecture/census-*.md` carries ANCHORED
 * citations into `src/test/discoveryRefusalD11.test.ts` (`:296`, `:629`, `:738`,
 * `:801`, `:837`), and `npm run check:doc-citations` fails the moment the named
 * symbol leaves the named line. Inserting these cases into that file moved five
 * of those anchors, all in a directory this lane does not own.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryCuratedSourceRefusal.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _injectTestCacheEntry, _clearTestCacheEntry,
  _clearTestCompassCache, type DiscoveryPlace,
} from "../routes/discovery.js";
import { DISCOVERY_REFUSAL_CLASSES } from "../lib/discoveryRefusal.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";

// ── No network. Overpass and Nominatim throw immediately rather than hanging.
// Every case supplies lat/lng, so the route never needs to geocode; Overpass
// failing is what makes the OSM half empty except where a case seeds cache A.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER_TOKEN = "curated-viewer";
const VIEWER_ID    = "cccc0000-0000-0000-0000-000000000001";

/** Every row batch handed to `.insert()`, keyed by table. The exposure probe. */
let inserts: Array<{ table: string; rows: unknown }> = [];

/**
 * A supabase-js stand-in.
 *
 * `errorTables` RESOLVE with `{ data: null, error }` — which is what supabase-js
 * actually does on a failed read. It does not reject, and a fixture built the
 * other way is how a fail-open bug gets written and then tested green. It is
 * also the ONLY way to reach this defect: `_setTestDbPlacesOverride` returns
 * rows, so it cannot express "the table could not be read" at all.
 */
function buildFakeClient(
  opts: { errorTables?: string[]; throwTables?: string[]; rows?: Record<string, any[]> } = {},
) {
  const errorTables = new Set(opts.errorTables ?? []);
  // `throwTables` is the OTHER failure supabase-js can produce — a driver or
  // socket error that rejects rather than resolving with `{ error }`. Both are
  // failed reads and both must reach the caller as `null`; a reader that handles
  // only the resolved one leaves its `catch` free to reinstate the masquerade.
  const throwTables = new Set(opts.throwTables ?? []);
  // The serve-log flag is ON in every fixture: with it absent no request could
  // write a rank_events row, refused or not, and the exposure control at the
  // foot of this file would pass vacuously against a disabled flag.
  const rowsFor: Record<string, any[]> = {
    feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }],
    ...(opts.rows ?? {}),
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rows: any[] = rowsFor[table] ?? [];

    const b: any = {
      select() { return b; },
      insert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      update() { return b; },
      upsert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      delete() { return b; },
      eq(col: string, val: any) { preds.push((r) => r[col] === val); return b; },
      neq() { return b; }, is() { return b; }, not() { return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      in() { return b; }, or() { return b; }, ilike() { return b; },
      contains() { return b; }, overlaps() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      // `fetchCompassFlags` selects the COMPASS_% family with `.like()`. The
      // pattern is honoured rather than stubbed true, so a case cannot switch on
      // a flag it did not seed.
      like(col: string, pattern: string) {
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        preds.push((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() { return rows.filter((r) => preds.every((p) => p(r))); }
    async function resolveList() {
      if (throwTables.has(table)) throw new Error(`${table} connection reset`);
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      return { data: filtered(), error: null, count: filtered().length };
    }
    async function resolveOne() {
      if (throwTables.has(table)) throw new Error(`${table} connection reset`);
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
    // The Compass ranking pipeline calls `.rpc()`. A missing method is a THROW
    // the route's own catch absorbs, which would move every Compass case onto
    // the cold path without saying so.
    rpc: async () => ({ data: null, error: null }),
  };
}

function setClient(opts: Parameters<typeof buildFakeClient>[0] = {}) {
  const fc = buildFakeClient(opts);
  _setTestClient(fc as any, true);
  _setTestServiceClient(fc as any);
}

let server: http.Server;
let base = "";

function get(path: string, auth = false): Promise<{ status: number; body: any }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/** The refusal every one of the four paths must carry when the curated read fails. */
const CURATED_REFUSAL = {
  class: "transient_db",
  code: "discovery_places_read_failed",
  route: "GET /discovery",
  coverage: "partial",
} as const;

/** Compass ON alongside the serve log, so serve paths 2 and 3 are reachable at all. */
const COMPASS_ON_FLAGS = [
  { flag: "discovery_serve_log_enabled", enabled: true },
  { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true },
];

function curatedPlace(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

function osmPlace(id: string): DiscoveryPlace {
  return {
    id, name: `osm ${id}`, category: "food", type: "cafe",
    description: null, distanceKm: 2, lat: 25.78, lng: -80.2, tags: [],
    address: null, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 0,
  } as DiscoveryPlace;
}

/** Which of the four serve paths answered — read off the envelope, never assumed. */
function servePathOf(body: any): string {
  const level = body?.meta?.cacheLevel;
  if (level === "error") return "assembly_error";
  if (body?.cached === true) return typeof level === "string" ? "cache_a" : "compass_hit";
  if (level === "miss") return "cold";
  if (body?.cached === false && level === undefined) return "compass_fresh";
  return `unrecognised(${JSON.stringify(body?.cached)}/${JSON.stringify(level)})`;
}

function assertServePath(body: any, expected: string): void {
  assert.equal(
    servePathOf(body), expected,
    `this case did not reach the serve path it is about (it reached ` +
    `${servePathOf(body)}), so whatever it asserts is about a different path. ` +
    `Body keys: ${JSON.stringify(Object.keys(body ?? {}))}`,
  );
}

/** The residual assertion: a named, partial refusal that says WHICH source failed. */
function assertCuratedPartial(body: any, what: string): void {
  assert.ok(
    body && typeof body === "object" && body.refusal,
    `${what}: no \`refusal\` on the body — a half-failed read is still ` +
    `indistinguishable from a small city. Body: ${JSON.stringify(body)}`,
  );
  const r = body.refusal;
  assert.ok(
    (DISCOVERY_REFUSAL_CLASSES as readonly string[]).includes(r.class),
    `${what}: refusal.class ${JSON.stringify(r.class)} is not one of \`11\` §9's classes`,
  );
  assert.equal(r.class, CURATED_REFUSAL.class, `${what}: wrong §9 class`);
  assert.equal(r.code, CURATED_REFUSAL.code, `${what}: wrong refusal code`);
  assert.equal(r.route, CURATED_REFUSAL.route, `${what}: wrong route on the refusal`);
  assert.equal(
    r.coverage, CURATED_REFUSAL.coverage,
    `${what}: coverage must be "partial" — the OSM and canonical reads answered, ` +
    `so their emptiness is trustworthy and their rows really were served`,
  );
  assert.deepEqual(
    [...(r.failedSources ?? [])], ["discovery_places"],
    `${what}: the refusal must NAME the source whose rows are missing — ` +
    `"some of this is missing" without saying which part is not a usable answer either`,
  );
}

const MIAMI = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";
/** `cacheKey(dest, cat, radius)` — the route's own L1 key shape. */
const CACHE_A_FOOD = "miami:food:10";

// ── DC-22 leg 2 — the cursor the envelope now OWES the client ────────────────
//
// `docs/specs/discovery-v1/11_API_Specification.md` §5 "Recommendation API"
// lists `cursor` under **Outputs**. These helpers spell the contract out once,
// independently of the route, so a wrong cursor is as fatal as a missing one.

/** `routes/discovery.ts` `PAGE_SIZE`, and `encodeOffset`'s alphabet. */
const PAGE_SIZE  = 20;
const cursorFor  = (offset: number) => Buffer.from(String(offset)).toString("base64url");

/**
 * The cursor a window at `offset` in a set of `total` must carry: the token for
 * the NEXT window, or `null` once this window reaches the end of the set. The
 * key is always PRESENT — `null` is the terminator, absence is not, because a
 * key that comes and goes is a key set that moves and CONTROL 2 pins it.
 */
const expectedCursor = (offset: number, total: number): string | null =>
  offset + PAGE_SIZE < total ? cursorFor(offset + PAGE_SIZE) : null;

/** 45 curated rows — more than two windows, with a SHORT final one. */
const WALK_TOTAL = 45;
const walkPlaces = (): DiscoveryPlace[] =>
  Array.from({ length: WALK_TOTAL }, (_, i) =>
    curatedPlace(`w${String(i).padStart(2, "0")}`, WALK_TOTAL - i));
const walkIds  = Array.from({ length: WALK_TOTAL }, (_, i) => `db/w${String(i).padStart(2, "0")}`);
const osmWalk  = (): DiscoveryPlace[] =>
  Array.from({ length: WALK_TOTAL }, (_, i) => osmPlace(`node/${5000 + i}`));

/** The cursor assertion every path shares: present, typed, and the RIGHT value. */
function assertCursor(body: any, offset: number, what: string): void {
  assert.ok(
    Object.prototype.hasOwnProperty.call(body ?? {}, "cursor"),
    `${what}: no \`cursor\` key — \`11\` §5 lists it as an OUTPUT, so a client ` +
    `must not have to rebuild the offset arithmetic to walk this route`,
  );
  assert.ok(
    typeof body.total === "number" && body.total > PAGE_SIZE,
    `${what}: precondition — this fixture must serve more than one window ` +
    `(total=${JSON.stringify(body?.total)}), or the cursor assertion below is vacuously null===null`,
  );
  assert.equal(
    body.cursor, expectedCursor(offset, body.total),
    `${what}: the cursor names the wrong window. A cursor that is emitted but ` +
    `off by even one page silently drops or repeats items on every walk — worse ` +
    `than emitting none at all`,
  );
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

beforeEach(() => {
  inserts = [];
  // All three are module-level memoisations with their own TTLs. Without these,
  // the first fixture to be asked decides the answer for every case that runs
  // inside the window — including whether Compass is on at all.
  invalidateServeLogFlagCache();
  invalidateFlagsCache();
  invalidateDiscoveryEngineModeCache();
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOOD);
});
afterEach(() => {
  _setTestDbPlacesOverride(null);
  _clearTestCacheEntry(CACHE_A_FOOD);
  _clearTestCompassCache();
});

describe("GET /discovery — the curated half of the merge (D11's last residual)", () => {
  // ── Serve path 1 of 4 — the cache-A serve ─────────────────────────────────
  it("1/4 cache-A serve: names the unreadable curated half instead of shipping a short list", async () => {
    setClient({ errorTables: ["discovery_places"] });
    _injectTestCacheEntry(CACHE_A_FOOD, [osmPlace("node/4242")]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200, "additive shape: the status stays 200");
    assertServePath(r.body, "cache_a");
    assert.equal(r.body.places.length, 1, "the OSM half is a real result and is still served");
    assertCuratedPartial(r.body, "cache-A serve with an unreadable discovery_places");
  });

  // ── Serve path 2 of 4 — the Compass cache-B hit ───────────────────────────
  it("2/4 Compass cache-B hit: names the unreadable curated half of THIS request", async () => {
    // The ranked PAGE is replayed from cache B, but the curated read still runs
    // in this request — it feeds sourceSummary.seededDbCount — and it is THIS
    // request's read that failed. A replayed page over a source that never
    // answered is still a half-answer.
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS } });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10), curatedPlace("p2", 5)]);
    const first = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assertServePath(first.body, "compass_fresh");
    assert.equal(first.body.refusal, undefined, "precondition: the seeding request is healthy");

    _setTestDbPlacesOverride(null);
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS }, errorTables: ["discovery_places"] });
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assert.equal(r.status, 200);
    assertServePath(r.body, "compass_hit");
    assert.ok(r.body.places.length > 0, "precondition: the replayed page carries real rows");
    assertCuratedPartial(r.body, "Compass cache-B hit with an unreadable discovery_places");
  });

  // ── Serve path 3 of 4 — the Compass fresh rank ────────────────────────────
  it("3/4 Compass fresh rank: names the unreadable curated half", async () => {
    // Compass is authoritative on this path — only pipeline-passed items appear
    // — so an unreadable curated half is invisible in the output by
    // construction, which is exactly why it has to be stated on the envelope.
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS }, errorTables: ["discovery_places"] });
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assert.equal(r.status, 200);
    assertServePath(r.body, "compass_fresh");
    assertCuratedPartial(r.body, "Compass fresh rank with an unreadable discovery_places");
  });

  // ── Serve path 4 of 4 — the cold fetch ────────────────────────────────────
  it("4/4 cold fetch: names the unreadable curated half", async () => {
    setClient({ errorTables: ["discovery_places"] });
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cold");
    assertCuratedPartial(r.body, "cold fetch with an unreadable discovery_places");
  });

  // ── CONTROL 1 — empty is not refused ──────────────────────────────────────
  //
  // As load-bearing as the four above. A refusal stamped on every empty body
  // distinguishes nothing, and it is the same lie inverted: "we could not look"
  // told about a city that was looked at and found empty.
  it("CONTROL: a GENUINELY empty curated read carries NO refusal on any of the four paths", async () => {
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS } });
    _setTestDbPlacesOverride(async () => []);

    _injectTestCacheEntry(CACHE_A_FOOD, [osmPlace("node/4242")]);
    const cacheA = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(cacheA.body, "cache_a");
    assert.equal(cacheA.body.refusal, undefined, "cache-A serve: empty is not refused");
    _clearTestCacheEntry(CACHE_A_FOOD);

    const cold = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(cold.body, "cold");
    assert.equal(cold.body.refusal, undefined, "cold fetch: empty is not refused");

    const fresh = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assertServePath(fresh.body, "compass_fresh");
    assert.equal(fresh.body.refusal, undefined, "Compass fresh rank: empty is not refused");

    const hit = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assertServePath(hit.body, "compass_hit");
    assert.equal(hit.body.refusal, undefined, "Compass cache-B hit: empty is not refused");
  });

  // ── CONTROL 2 — the success envelope does not move ────────────────────────
  //
  // The refusal key is ADDITIVE. A healthy read must answer with exactly the
  // keys, in exactly the order, it answered with before: every existing client
  // reads this body, and `11` §9 asks for a distinguishable FAILURE, not a
  // different success.
  it("CONTROL: a fully successful read is byte-identical — same keys, same order, no refusal", async () => {
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS } });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);

    // ── DELIBERATE CONTRACT CHANGE — DC-22 leg 2, `cursor` joins the pin ────
    //
    // WHAT CHANGED: one key, `cursor`, appended to both expected lists (and so
    // to the envelope of all four serve paths).
    //
    // WHICH SPEC LINE REQUIRES IT: `docs/specs/discovery-v1/11_API_Specification.md`
    // §5 "Recommendation API" lists, under **Outputs**: recommendation_id,
    // items, reason labels where user-facing, `cursor`, model/version metadata.
    // `cursor` appears under Inputs AND under Outputs. An earlier pass shipped
    // it as an input only and recorded the reason as THIS pin (see the closing
    // comment of `routes/discovery.ts`, now rewritten). That was a compromise
    // against the spec, not a reading of it; this is the correction.
    //
    // THE PIN'S STRENGTH IS UNCHANGED. Still `assert.deepEqual` over
    // `Object.keys(...)`: the EXACT key set in the EXACT order, on each of the
    // four paths. It was not relaxed to a subset check, `toMatchObject`, or a
    // "contains" assertion. Any further shape drift — an accidental key, a
    // reordering, a key lost on one path only — still fails here, exactly as
    // loudly as it did before. `cursor` is last because it is appended to the
    // envelope at the single send helper, which is also what keeps the four
    // paths from disagreeing about where it sits.
    const WITH_META = ["places", "total", "destination", "context", "cached", "ageFilterMeta", "sourceSummary", "meta", "cursor"];
    const NO_META   = ["places", "total", "destination", "context", "cached", "ageFilterMeta", "sourceSummary", "cursor"];

    _injectTestCacheEntry(CACHE_A_FOOD, [osmPlace("node/4242")]);
    const cacheA = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(cacheA.body, "cache_a");
    assert.deepEqual(Object.keys(cacheA.body), WITH_META, "cache-A success envelope changed shape");
    assert.equal(cacheA.body.refusal, undefined);
    assert.deepEqual(cacheA.body.sourceSummary, { seededDbCount: 1, osmCount: 1, userCreatedCount: 0 });
    assert.equal(cacheA.body.meta.cacheLevel, "L1");
    _clearTestCacheEntry(CACHE_A_FOOD);

    const cold = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(cold.body, "cold");
    assert.deepEqual(Object.keys(cold.body), WITH_META, "cold-fetch success envelope changed shape");
    assert.equal(cold.body.refusal, undefined);

    const fresh = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assertServePath(fresh.body, "compass_fresh");
    assert.deepEqual(Object.keys(fresh.body), NO_META, "Compass fresh-rank success envelope changed shape");
    assert.equal(fresh.body.refusal, undefined);

    const hit = await get(`/api/discovery?${MIAMI}&category=for_you`, true);
    assertServePath(hit.body, "compass_hit");
    assert.deepEqual(Object.keys(hit.body), NO_META, "Compass cache-B hit success envelope changed shape");
    assert.equal(hit.body.refusal, undefined);
  });

  // ── CONTROL 3 — the other half of the ruling ──────────────────────────────
  //
  // "…or corrupt exposure accounting". A PARTIAL refusal must NOT suppress the
  // serve log: those items really were served and really are exposure, and
  // dropping them under-counts the denominator — the same corruption in the
  // other direction. This is what pins the coverage at "partial" rather than
  // "nothing", which would mark the response refused in the WeakSet while its
  // items went out on the wire.
  it("CONTROL: a partial refusal still counts the items it really served", async () => {
    setClient({ errorTables: ["discovery_places"] });
    _injectTestCacheEntry(CACHE_A_FOOD, [osmPlace("node/4242")]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`, true);
    assertServePath(r.body, "cache_a");
    assertCuratedPartial(r.body, "cache-A partial and its exposure");
    await new Promise((done) => setTimeout(done, 80));
    const rank = inserts.filter((i) => i.table === "rank_events");
    assert.equal(
      rank.length, 1,
      `a PARTIAL serve wrote ${rank.length} rank_events batches, not 1 — the items ` +
      `on this page WERE served, and dropping them under-counts the exposure ` +
      `denominator just as surely as counting a failure over-counts it`,
    );
  });

  // ── CURSOR 1 — the walk a client actually performs ────────────────────────
  //
  // CONTROL 2 above proves the KEY is there on all four paths. It cannot prove
  // the VALUE is right, and an emitted-but-wrong cursor is worse than none: it
  // looks walkable and silently drops or repeats items. So this walks the set
  // the only way that can fail for the real reason — by FOLLOWING the token the
  // envelope hands back, never by rebuilding the offset the route used.
  it("CURSOR: following the emitted cursor covers the result set exactly once and terminates", async () => {
    setClient();
    _setTestDbPlacesOverride(async () => walkPlaces());

    const seen: string[] = [];
    const cursors: Array<string | null> = [];
    let cursor: string | null = null;
    let windows = 0;

    for (;;) {
      // The cold path re-populates cache A after it serves, so each window is
      // taken cold deliberately — otherwise window 2 would silently be testing
      // a different serve path from window 1.
      _clearTestCacheEntry(CACHE_A_FOOD);
      const q = cursor === null && windows === 0 ? "" : `&cursor=${cursor}`;
      const r = await get(`/api/discovery?${MIAMI}&category=food${q}`);
      assertServePath(r.body, "cold");
      assert.equal(r.body.total, WALK_TOTAL, "`total` is the whole set in every window");
      assert.equal(r.body.refusal, undefined, "precondition: a healthy read");
      assert.ok(
        Object.prototype.hasOwnProperty.call(r.body, "cursor"),
        `window ${windows}: no \`cursor\` key — \`11\` §5 lists it as an OUTPUT, ` +
        `so the walk has nothing to follow`,
      );
      seen.push(...r.body.places.map((pl: any) => pl.id));
      cursor = r.body.cursor;
      cursors.push(cursor);
      windows += 1;
      assert.ok(windows <= 8, "the walk never terminated — the cursor is not advancing");
      if (cursor === null) break;
    }

    assert.equal(windows, 3, "45 rows at PAGE_SIZE 20 is exactly three windows, the last short");
    assert.deepEqual(
      cursors, [cursorFor(PAGE_SIZE), cursorFor(2 * PAGE_SIZE), null],
      "the emitted tokens must be base64url(20), base64url(40), then null — a cursor " +
      "off by one page is a walk that skips or repeats twenty items",
    );
    assert.deepEqual(
      [...seen].sort(), [...walkIds].sort(),
      "a cursor walk must cover the result set exactly once — no gap, no repeat",
    );
    assert.equal(new Set(seen).size, WALK_TOTAL, "no item may be served twice by one walk");
  });

  // ── CURSOR 2 — one answer, not four ───────────────────────────────────────
  //
  // Recognised by the envelope discriminator, exactly as the four refusal cases
  // above are, so a Compass case that silently fell through to the cold path
  // cannot pass wearing a Compass name.
  it("CURSOR: all four serve paths emit the same cursor for the same window", async () => {
    setClient({ rows: { feature_flags: COMPASS_ON_FLAGS } });
    _setTestDbPlacesOverride(async () => walkPlaces());
    const AT_20 = `&cursor=${cursorFor(PAGE_SIZE)}`;

    _injectTestCacheEntry(CACHE_A_FOOD, osmWalk());
    const cacheA = await get(`/api/discovery?${MIAMI}&category=food${AT_20}`);
    assertServePath(cacheA.body, "cache_a");
    assertCursor(cacheA.body, PAGE_SIZE, "cache-A serve");
    _clearTestCacheEntry(CACHE_A_FOOD);

    const cold = await get(`/api/discovery?${MIAMI}&category=food${AT_20}`);
    assertServePath(cold.body, "cold");
    assertCursor(cold.body, PAGE_SIZE, "cold fetch");

    const fresh = await get(`/api/discovery?${MIAMI}&category=for_you${AT_20}`, true);
    assertServePath(fresh.body, "compass_fresh");
    assertCursor(fresh.body, PAGE_SIZE, "Compass fresh rank");

    const hit = await get(`/api/discovery?${MIAMI}&category=for_you${AT_20}`, true);
    assertServePath(hit.body, "compass_hit");
    assertCursor(hit.body, PAGE_SIZE, "Compass cache-B hit");

    // And the terminator is the same fact on the same paths: the LAST window
    // says null rather than dropping the key, so the key set never moves.
    const END = `&cursor=${cursorFor(2 * PAGE_SIZE)}`;
    const coldEnd = await get(`/api/discovery?${MIAMI}&category=food${END}`);
    assertServePath(coldEnd.body, "cold");
    assert.equal(coldEnd.body.cursor, null, "the final window terminates the walk with null");
    assert.ok(
      Object.prototype.hasOwnProperty.call(coldEnd.body, "cursor"),
      "null is the terminator; DROPPING the key would make the key set CONTROL 2 pins depend on the window",
    );
  });

  // ── CURSOR 3 — the refusal is untouched ───────────────────────────────────
  //
  // `sendDiscoveryRefusal` ships `{ ...envelope, refusal }`, and the whole point
  // of that shape is that a refused body is the successful body plus ONE key.
  // Emitting the cursor only on the healthy branch would have broken that: a
  // client could then tell the two apart by a second, undesigned signal, and a
  // walk that crossed a transient partial failure would lose its place.
  it("CURSOR: a refusal response is unaffected — same refusal, same envelope plus one key", async () => {
    setClient({ errorTables: ["discovery_places"] });
    _injectTestCacheEntry(CACHE_A_FOOD, osmWalk());
    const r = await get(`/api/discovery?${MIAMI}&category=food&cursor=${cursorFor(PAGE_SIZE)}`);

    assert.equal(r.status, 200, "additive shape: the status stays 200");
    assertServePath(r.body, "cache_a");
    assertCuratedPartial(r.body, "cache-A partial while paging");
    assertCursor(r.body, PAGE_SIZE, "cache-A partial refusal");
    assert.deepEqual(
      Object.keys(r.body),
      ["places", "total", "destination", "context", "cached", "ageFilterMeta", "sourceSummary", "meta", "cursor", "refusal"],
      "a refused body is the successful body plus `refusal`, and nothing else moved",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL HALF — §30.5's third open item, which named itself as the next
// instance of the class the curated cases above closed:
//
//   "`queryCanonicalPlaces` cannot report failure at all — it returns `[]` for
//    unreadable and empty alike, so `failedSources` can only ever name the
//    curated half. The canonical half's silence was deliberately not guessed
//    at, and it is the next instance of exactly the class this section closed."
//
// `GET /discovery` merges THREE retrievals: Overpass, curated `discovery_places`
// and the canonical `places` registry. Two of the three could report a failed
// read. The third answered `[]` for "the table is down" and for "this city has
// no canonical rows" alike — which is the D11 masquerade, in the one source that
// carries the most rows in every city outside the demo eight (`queryCanonicalPlaces`
// exists precisely because Da Nang has ~2.6k canonical rows and 0 curated ones).
//
// The cases below are the curated ones' exact mirror, plus the case neither file
// could express before: BOTH halves unreadable at once.
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical registry's name on `refusal.failedSources` — the table, as with the curated half. */
const CANONICAL_SOURCE = "places";

/**
 * A partial refusal that names exactly `expected`, in merge order.
 *
 * Deliberately a deepEqual over the WHOLE array rather than a `.includes()`:
 * "some of this is missing" without saying which part is not a usable answer,
 * and a `failedSources` that quietly grows a source that did not fail is the
 * same untruth in the other direction.
 */
function assertPartialNaming(body: any, expected: string[], code: string, what: string): void {
  assert.ok(
    body && typeof body === "object" && body.refusal,
    `${what}: no \`refusal\` on the body — a half-failed read is still ` +
    `indistinguishable from a small city. Body: ${JSON.stringify(body)}`,
  );
  const r = body.refusal;
  assert.ok(
    (DISCOVERY_REFUSAL_CLASSES as readonly string[]).includes(r.class),
    `${what}: refusal.class ${JSON.stringify(r.class)} is not one of \`11\` §9's classes`,
  );
  assert.equal(r.class, "transient_db", `${what}: wrong §9 class`);
  assert.equal(r.route, "GET /discovery", `${what}: wrong route on the refusal`);
  assert.equal(
    r.coverage, "partial",
    `${what}: coverage must be "partial" — at least one retrieval ANSWERED, so ` +
    `its emptiness is trustworthy and whatever rows went out really were served`,
  );
  assert.deepEqual(
    [...(r.failedSources ?? [])], expected,
    `${what}: the refusal must name EXACTLY the sources whose rows are missing`,
  );
  assert.equal(
    r.code, code,
    `${what}: the code must say WHICH halves failed. A single frozen code makes a ` +
    `canonical-only failure indistinguishable on the wire from a curated-only one, ` +
    `which is the same collapse one level up from the one this row is about`,
  );
}

describe("GET /discovery — the canonical half of the merge (§30.5's third open item)", () => {
  // ── The canonical half alone, on the cold fetch ───────────────────────────
  it("cold fetch: an unreadable canonical `places` registry is NAMED, not absorbed", async () => {
    // The curated half succeeds and carries rows, so the body is a plausible,
    // non-empty answer. That is the whole danger: nothing in `places` or `total`
    // hints that the largest of the three retrievals never answered.
    setClient({ errorTables: ["places"] });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200, "additive shape: the status stays 200");
    assertServePath(r.body, "cold");
    assert.equal(r.body.places.length, 1, "the curated half is a real result and is still served");
    assertPartialNaming(r.body, [CANONICAL_SOURCE], "canonical_places_read_failed",
      "cold fetch with an unreadable canonical registry");
  });

  // ── The canonical half alone, on the cache-A serve ────────────────────────
  it("cache-A serve: the canonical read still runs for THIS request, and its failure is named", async () => {
    setClient({ errorTables: ["places"] });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);
    _injectTestCacheEntry(CACHE_A_FOOD, [osmPlace("node/4242")]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cache_a");
    assertPartialNaming(r.body, [CANONICAL_SOURCE], "canonical_places_read_failed",
      "cache-A serve with an unreadable canonical registry");
  });

  // ── BOTH halves — the case neither half could express before ──────────────
  it("BOTH DB halves unreadable: the refusal names both, in merge order", async () => {
    // Overpass throws in this file, so this body genuinely has nothing in it —
    // and it is STILL `partial`, not `nothing`. `coverage: "nothing"` suppresses
    // the serve log, and an OSM retrieval that failed at the network is not the
    // same claim as "we did not look at all"; the route's three-retrieval rule
    // is that ANY answering source keeps it partial. The control at the foot of
    // the curated block pins the exposure consequence from the other side.
    setClient({ errorTables: ["discovery_places", "places"] });
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cold");
    assertPartialNaming(r.body, ["discovery_places", CANONICAL_SOURCE],
      "discovery_place_sources_read_failed", "both DB halves unreadable");
  });

  // ── The throw path — the other shape a failed read takes ─────────────────
  it("a canonical read that THROWS is named too, not just one that resolves with an error", async () => {
    // `queryCanonicalPlaces` has two exits for a failed read: the resolved
    // `{ error }` supabase-js returns for a query error, and the `catch` that
    // takes a driver/socket rejection. Both are "the registry could not be
    // read". A fix that only changed the first would leave the `catch` returning
    // `[]` — the same masquerade, reachable by the failure mode that happens
    // when a database goes away rather than when a query is wrong.
    setClient({ throwTables: ["places"] });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cold");
    assertPartialNaming(r.body, [CANONICAL_SOURCE], "canonical_places_read_failed",
      "cold fetch where the canonical read threw");
  });

  // ── CONTROL 1 — a genuinely empty canonical registry is not a refusal ─────
  it("CONTROL: a canonical registry that ANSWERS with no rows carries NO refusal", async () => {
    // `places` is readable and simply has nothing for Miami. Stamping a refusal
    // here is the same lie inverted: "we could not look", told about a table
    // that was looked at.
    setClient();
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(r.body, "cold");
    assert.equal(
      r.body.refusal, undefined,
      "an empty canonical registry is a real, trustworthy answer and must not acquire a refusal",
    );
  });

  // ── CONTROL 2 — a tab the canonical vocabulary cannot serve is not a failure
  it("CONTROL: a category with no canonical vocabulary is NOT reported as a failed source", async () => {
    // `primaryCategoriesFor("beaches")` is empty — `public.places`'s coarse
    // `primary_category` vocabulary maps nothing to that tab — so
    // `queryCanonicalPlaces` returns before touching the table. The table being
    // unreadable in this fixture is therefore IRRELEVANT to this request, and
    // naming `places` here would accuse a source this request never consulted.
    setClient({ errorTables: ["places"] });
    _setTestDbPlacesOverride(async () => [curatedPlace("p1", 10)]);
    const r = await get(`/api/discovery?${MIAMI}&category=beaches`);
    assertServePath(r.body, "cold");
    assert.equal(
      r.body.refusal, undefined,
      "`beaches` maps to no canonical primary_category, so the registry was never " +
      "read for this request and cannot be among the sources that failed it",
    );
  });

  // ── CONTROL 3 — the curated-only contract is unchanged ────────────────────
  it("CONTROL: a curated-only failure still names only the curated half, with its original code", async () => {
    // The four curated cases above assert `failedSources: ["discovery_places"]`.
    // This restates the CODE half of that contract inside the new helper, so a
    // future change that broadened the code to cover both halves at once would
    // fail here rather than silently re-labelling every curated refusal.
    setClient({ errorTables: ["discovery_places"] });
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assertServePath(r.body, "cold");
    assertPartialNaming(r.body, ["discovery_places"], "discovery_places_read_failed",
      "curated-only failure");
  });
});
