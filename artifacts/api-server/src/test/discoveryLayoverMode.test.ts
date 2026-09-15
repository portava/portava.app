/**
 * census-discovery A14 / census-layover §25 (L269) — DISCOVERY'S LAYOVER MODE.
 *
 *   §25 L269: "Discovery — only show experiences from the certified action
 *              universe in Layover mode."
 *
 * ── WHAT THIS SUITE IS ABOUT ────────────────────────────────────────────────
 * The Layover lane published the door (`services/airport/LayoverSnapshot.ts`)
 * and this lane walks through it. The arithmetic has its own suites; what is
 * pinned here is the thing a consuming surface can get wrong on its own:
 *
 *   THE THREE STATES MUST STAY APART, ON THE WIRE.
 *
 *   1. UNAVAILABLE MEASUREMENT — we looked, and nobody has stated how long this
 *      place takes. Not admitted, NOT an error. `200`, no `refusal` key, and
 *      the id is named under `layover.excluded` with state `UNMEASURED`.
 *   2. FAILED READ — we could not look. `layover_sessions`, `airport_profiles`
 *      or `layover_plan_stops` did not answer. This must NOT collapse into
 *      "nothing is admitted": the two produce IDENTICAL item lists (`[]`), and
 *      identical is exactly the masquerade `11` §9 and owner ruling D11 forbid.
 *      It carries the refusal envelope — `coverage: "nothing"`, HTTP still 200 —
 *      and it is suppressed from the exposure denominator.
 *   3. GENUINELY INELIGIBLE — measured, and the certified universe refused it:
 *      either the §8 envelope PROVED it unreachable, or the certified window
 *      does not have room for the stated terms. `200`, no `refusal`, named under
 *      `layover.excluded` with state `BLOCKED` (or `CLOSED`).
 *
 * ── AND WHERE THE TWO TIME TERMS COME FROM ──────────────────────────────────
 * `certifiedActionUniverse` needs `travelTimeMin` and `activityTimeMin` per
 * candidate. `discovery_places` carries NEITHER — the Layover lane's own reader
 * says so in as many words (`LayoverRecommendationService.fetchDiscoveryPlaces`:
 * *"`discovery_places` HAS NO DURATION COLUMN … Deleted with no replacement:
 * nobody has said how long this takes."*). So this lane invents nothing:
 *
 *   travel   asked of the travel-time PORT (`LayoverTravelTime.landsideLeg`),
 *            which on this tree answers `null` / `NO_ROUTED_PROVIDER`, and
 *            otherwise the traveller's OWN stated `layover_plan_stops.travel_min`
 *   activity the traveller's OWN stated `layover_plan_stops.duration_min`
 *
 * and both are read through `LayoverPlanFit`'s `statedTravelMin` /
 * `statedDurationMin`, which is what keeps the column's NOT NULL default from
 * reading back as a measurement. The last two suites in this file are about a
 * default number being introduced to make a card appear: the first asserts the
 * BEHAVIOUR (a missing input must not acquire a value, however the fabrication
 * is spelled), and the second is a narrow source guard over what is left.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryLayoverMode.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { readFileSync } from "node:fs";
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
import { LAYOVER_DISCOVERY_MODE_FLAG } from "../services/airport/LayoverSnapshot.js";
import { airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

// ── No network. Nothing in this suite geocodes, but a stray call must fail
// loudly rather than reach the internet from a unit test.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER_TOKEN = "layover-mode-viewer";
const VIEWER_ID    = "aaaa0000-0000-0000-0000-00000000a14a";
const SESSION_ID   = "session-a14";
const CITY         = "Taoyuan";

/** Every `.insert()` batch, keyed by table — the exposure probe. */
let inserts: Array<{ table: string; rows: unknown }> = [];

// ── The four community places this suite reasons about ───────────────────────
//
// TPE sits at (25.0797, 121.2342) — `airportRow()`'s coordinates.
//
//   fits        300 m away, and the traveller has a plan stop for it stating
//               20 minutes there and 60 minutes at it. MEASURED and it fits.
//   unmeasured  300 m away, and nobody has stated a thing about it.
//   overlong    300 m away, with a plan stop stating the column's maxima
//               (240 travel, 720 dwell). MEASURED and it does not fit.
//   far         ~1,000 km away. The §8 envelope proves it out of reach at the
//               straight-line LOWER BOUND, so it is refused whatever is stated.
function placeRow(id: string, lat: number | null, lng: number | null) {
  return {
    id, city: CITY, name: id, place_type: "traveler_pick", category: "food",
    neighborhood: null, blurb: null, image_url: null, submitted_by: null,
    saved_count: 0, tag: null, note: null, rating: null, source: "traveler",
    status: "active", verified: false, created_at: "2026-09-01T00:00:00.000Z",
    lat, lng, profiles: null,
  };
}
const PLACES = [
  placeRow("fits", 25.08, 121.235),
  placeRow("unmeasured", 25.081, 121.236),
  placeRow("overlong", 25.082, 121.237),
  placeRow("far", 34.0, 121.2342),
];
const ALL_IDS = PLACES.map((p) => p.id).sort();

/** A stop the traveller themselves put in their layover plan, for `place_id`. */
function stopRow(placeId: string, travelMin: number, durationMin: number) {
  return {
    id: `stop-${placeId}`, session_id: SESSION_ID, title: placeId, stop_order: 0,
    duration_min: durationMin, travel_min: travelMin, place_id: placeId,
    recommendation_id: null, lat: null, lng: null, location_label: null,
    inside_airport: false, source: "user",
  };
}

/** A live layover, anchored to the REAL clock: the route cannot be given a nowMs. */
function liveSession() {
  const now = Date.now();
  return sessionRow({
    id: SESSION_ID, user_id: VIEWER_ID, airport_id: "airport-tpe",
    arrival_time: new Date(now - 20 * 60_000).toISOString(),
    departure_time: new Date(now + 9 * 3_600_000).toISOString(),
    layover_minutes: 560, wants_to_leave: true, status: "active",
  });
}

const FLAG_ON  = [{ flag: LAYOVER_DISCOVERY_MODE_FLAG, enabled: true }];
const FLAG_OFF: Array<Record<string, unknown>> = [];
const SERVE_LOG_ON = { flag: "discovery_serve_log_enabled", enabled: true };

/**
 * A supabase-js stand-in.
 *
 * `errorTables` RESOLVE with `{ data: null, error }` — which is what supabase-js
 * does on a failed read. It does not reject, and a fixture built the other way
 * is how a fail-open bug gets written and then tested green.
 */
function buildFakeClient(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const errorTables = new Set(opts.errorTables ?? []);
  const rowsFor: Record<string, any[]> = {
    feature_flags: [SERVE_LOG_ON],
    ...(opts.rows ?? {}),
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rows: any[] = rowsFor[table] ?? [];
    let limitN: number | null = null;

    const b: any = {
      select() { return b; },
      insert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      update() { return b; }, delete() { return b; },
      upsert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      eq(col: string, val: any) { preds.push((r) => r[col] === val); return b; },
      neq() { return b; }, not() { return b; }, or() { return b; },
      is(col: string, val: any) { preds.push((r) => (r[col] ?? null) === val); return b; },
      in(col: string, vals: any[]) { preds.push((r) => vals.includes(r[col])); return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      contains() { return b; }, overlaps() { return b; },
      ilike(col: string, v: string) {
        const needle = String(v).replace(/%/g, "").toLowerCase();
        preds.push((r) => typeof r[col] === "string" && r[col].toLowerCase().includes(needle));
        return b;
      },
      like(col: string, pattern: string) {
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        preds.push((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      order() { return b; }, range() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() {
      const out = rows.filter((r) => preds.every((p) => p(r)));
      return limitN === null ? out : out.slice(0, limitN);
    }
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
    rpc: async () => ({ data: null, error: null }),
  };
}

function setClient(opts: Parameters<typeof buildFakeClient>[0] = {}) {
  const fc = buildFakeClient(opts);
  _setTestClient(fc as any, true);
  _setTestServiceClient(fc as any);
}

/**
 * The world this suite mostly runs in: a live layover at a curated airport,
 * four community places, and the traveller's own plan stops.
 */
function layoverWorld(over: {
  flags?: Array<Record<string, unknown>>;
  stops?: any[];
  places?: any[];
} = {}) {
  return {
    feature_flags: [SERVE_LOG_ON, ...(over.flags ?? FLAG_ON)],
    discovery_places: over.places ?? PLACES,
    layover_sessions: [liveSession()],
    airport_profiles: [airportRow()],
    layover_plan_stops: over.stops ?? [stopRow("fits", 20, 60), stopRow("overlong", 240, 720)],
  };
}

let server: http.Server;
let base = "";

function get(path: string, auth = true): Promise<{ status: number; body: any }> {
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

// ── GET /discovery — the other surface §25 L269 names ────────────────────────
//
// Its four serve paths all funnel through `sendDiscoveryPlacesEnvelope`, and
// its id space is NOT the community one: curated rows are served as
// `db/<discovery_places.id>` and live OSM elements as `<type>/<id>`. Both are
// exercised here on purpose — the first has a layover subject behind a prefix,
// the second has none and never can.
const DB_UUID_FITS      = "11111111-1111-4111-8111-111111111111";
const DB_UUID_UNMEASURED = "22222222-2222-4222-8222-222222222222";
const DB_UUID_ZERO_TRAVEL   = "33333333-3333-4333-8333-333333333333";
const DB_UUID_ZERO_DURATION = "44444444-4444-4444-8444-444444444444";
const OSM_ID            = "node/4242";
/** `cacheKey(dest, cat, radius)` — the route's own L1 key shape. */
const DISCOVERY_CACHE_KEY = "taoyuan:food:10";
const DISCOVERY_QS = `destination=${encodeURIComponent(CITY)}&lat=25.08&lng=121.235&radiusKm=10&category=food`;
const DISCOVERY = `/api/discovery?${DISCOVERY_QS}`;

function discoveryDbPlace(uuid: string, lat: number, lng: number): DiscoveryPlace {
  return {
    id: `db/${uuid}`, name: uuid, category: "food", type: "traveler_pick",
    description: null, distanceKm: 1, lat, lng, tags: [],
    address: CITY, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 0,
  } as DiscoveryPlace;
}
function discoveryOsmPlace(id: string, lat: number, lng: number): DiscoveryPlace {
  return {
    id, name: `osm ${id}`, category: "food", type: "cafe",
    description: null, distanceKm: 2, lat, lng, tags: [],
    address: null, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 0,
  } as DiscoveryPlace;
}
const placeIdsOf = (body: any) => ((body?.places ?? []) as any[]).map((p) => p.id).sort();

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
    `this case did not reach the serve path it is about (it reached ${servePathOf(body)}), ` +
    `so whatever it asserts is about a different path. Body keys: ` +
    `${JSON.stringify(Object.keys(body ?? {}))}`,
  );
}

/** The layover world GET /discovery runs in, with a stop for the db place only. */
function discoveryWorld(over: { flags?: Array<Record<string, unknown>>; stops?: any[] } = {}) {
  return {
    feature_flags: [SERVE_LOG_ON, ...(over.flags ?? FLAG_ON)],
    layover_sessions: [liveSession()],
    airport_profiles: [airportRow()],
    // The stop names the DISCOVERY UUID, not the served `db/<uuid>` id — which
    // is exactly the mapping this surface has to do and the community one does
    // not. A test that stated `db/<uuid>` here would pass against a route that
    // never mapped anything.
    layover_plan_stops: over.stops ?? [stopRow(DB_UUID_FITS, 20, 60)],
  };
}

const COMMUNITY = `/api/discovery/community?city=${encodeURIComponent(CITY)}`;
const idsOf = (body: any) => ((body?.items ?? []) as any[]).map((i) => i.id).sort();
const rankInserts = () => inserts.filter((i) => i.table === "rank_events");
const settle = () => new Promise<void>((r) => setTimeout(r, 60));

/** The refusal shape a FAILED READ must carry, whichever table failed. */
function assertFailedReadRefusal(body: any, code: string, source: string, what: string) {
  assert.ok(body?.refusal, `${what}: no \`refusal\` key — a failed read was served as an answer`);
  const r = body.refusal;
  assert.ok(
    (DISCOVERY_REFUSAL_CLASSES as readonly string[]).includes(r.class),
    `${what}: refusal.class ${JSON.stringify(r.class)} is not one of \`11\` §9's classes`,
  );
  assert.equal(r.class, "transient_db", `${what}: wrong §9 class`);
  assert.equal(r.code, code, `${what}: wrong refusal code`);
  assert.equal(r.route, "GET /discovery/community", `${what}: wrong route on the refusal`);
  assert.equal(
    r.coverage, "nothing",
    `${what}: coverage must be "nothing" — no part of this body is a result`,
  );
  assert.deepEqual(
    [...(r.failedSources ?? [])], [source],
    `${what}: the refusal must NAME what could not be read`,
  );
  assert.deepEqual(body.items, [], `${what}: a refusal must not also ship items`);
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
  // Every one of these is a module-level memoisation with its own TTL. Without
  // them the first fixture to be asked decides the answer for every case inside
  // the window — including which of GET /discovery's four serve paths answers.
  invalidateServeLogFlagCache();
  invalidateFlagsCache();
  invalidateDiscoveryEngineModeCache();
  _clearTestCompassCache();
  _setTestDbPlacesOverride(null);
  _clearTestCacheEntry(DISCOVERY_CACHE_KEY);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A14 — the flag is FALSE by absence, and off means byte-identical", () => {
  it("with no flag row at all, Layover mode does not exist: every place is served", async () => {
    setClient({ rows: layoverWorld({ flags: FLAG_OFF }) });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(idsOf(r.body), ALL_IDS, "an absent flag must not gate anything");
    assert.equal(r.body.layover, undefined, "an absent flag must not add a key to the envelope");
    assert.deepEqual(
      Object.keys(r.body), ["items", "city", "total", "ageFilterMeta"],
      "the ordinary success envelope moved",
    );
    assert.equal(r.body.total, ALL_IDS.length);
  });

  // ── DELIBERATE CORRECTION — the owner's correction 1 ───────────────────────
  //
  // WHAT THIS TEST USED TO ASSERT, AND WHY IT WAS WRONG. It asserted that an
  // UNREADABLE `feature_flags` served the ORDINARY, UNGATED list, on the
  // grounds that `isFlagEnabled` answers false for a missing row AND for a
  // failed read, and a consuming lane should not invent a third behaviour.
  //
  // That reasoning is right for a flag that ADDS a capability and backwards for
  // one that WITHHOLDS. Here `false` does not mean "the feature stays off, no
  // harm done"; it means "the restriction does not apply", and the restriction
  // is what stops a traveller being sent to a place they cannot get back from.
  // "We could not read the flag" is not a licence to drop a restriction — it is
  // `discoveryLayoverMode.ts`'s own §33.2 rule (an unreadable read must never
  // produce a settled claim about the world) one layer up from the two reads it
  // already applies it to.
  //
  // THE ASSERTION IS STRENGTHENED, NOT RELAXED: it was one `deepEqual` that the
  // ungated list came back; it is now the full refusal shape, plus the explicit
  // negative that the ungated list did NOT come back.
  it("an UNREADABLE feature_flags must NOT serve the ungated list — it refuses", async () => {
    setClient({ rows: layoverWorld(), errorTables: ["feature_flags"] });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.notDeepEqual(
      idsOf(r.body), ALL_IDS,
      "an unreadable feature_flags served the ORDINARY UNGATED list — a failed " +
      "flag read silently disabled the restriction",
    );
    assertFailedReadRefusal(
      r.body, "layover_flag_unreadable", "feature_flags", "unreadable feature_flags",
    );
  });

  it("an unreadable flag costs a traveller with NO live layover nothing", async () => {
    // THE SCOPE OF THE REFUSAL, pinned from the other side. The restriction can
    // only ever apply to a traveller who is in a live layover, and whether they
    // are is a fact about THEM that is read successfully here. So an unreadable
    // `feature_flags` withholds from exactly the set an ungated list would have
    // been wrong for, and from nobody else. Refusing at the flag read instead
    // would blank Discovery for every signed-in caller on any hiccup of that
    // table — a wider outage, not a stricter guard.
    setClient({ rows: { ...layoverWorld(), layover_sessions: [] }, errorTables: ["feature_flags"] });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.refusal, undefined,
      "'you are not in a layover' is an ANSWER, and it does not depend on the flag",
    );
    assert.deepEqual(idsOf(r.body), ALL_IDS);
    assert.equal(r.body.layover, undefined);
  });

  it("an unreadable flag DOES refuse the traveller who IS in a live layover", async () => {
    // The same unreadable table, the same route, the opposite answer — because
    // for THIS traveller the restriction might apply and nobody can say.
    setClient({ rows: layoverWorld(), errorTables: ["feature_flags"] });
    const r = await get(COMMUNITY);
    assertFailedReadRefusal(
      r.body, "layover_flag_unreadable", "feature_flags",
      "unreadable feature_flags, live layover",
    );
  });

  it("an unreadable flag is DISTINGUISHABLE from an absent one — absence is an answer", async () => {
    // The two must not collapse: a missing row is a real statement about the
    // world ("nobody enabled this"), and a failed read is the absence of one.
    setClient({ rows: layoverWorld({ flags: FLAG_OFF }) });
    const absent = await get(COMMUNITY);
    setClient({ rows: layoverWorld(), errorTables: ["feature_flags"] });
    const unreadable = await get(COMMUNITY);
    assert.equal(absent.body.refusal, undefined, "an ABSENT flag row is an answer, not a failure");
    assert.ok(unreadable.body.refusal, "an UNREADABLE feature_flags is a failure, not an answer");
    assert.notDeepEqual(absent.body, unreadable.body);
  });

  it("an ANONYMOUS caller has no traveller, so there is no layover to gate on", async () => {
    setClient({ rows: layoverWorld() });
    const r = await get(COMMUNITY, false);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(idsOf(r.body), ALL_IDS);
    assert.equal(r.body.layover, undefined);
  });

  it("flag ON but this traveller has no live layover: ordinary Discovery, ungated", async () => {
    setClient({ rows: { ...layoverWorld(), layover_sessions: [] } });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined, "'you are not in a layover' is an ANSWER, not a failure");
    assert.deepEqual(idsOf(r.body), ALL_IDS);
    assert.equal(r.body.layover, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A14 — in Layover mode, ONLY the certified action universe is shown", () => {
  it("serves the admitted place and withholds the other three", async () => {
    setClient({ rows: layoverWorld() });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(idsOf(r.body), ["fits"], "an ungated list reached a traveller in Layover mode");
    assert.equal(r.body.total, 1, "`total` must describe what was served, not what was read");
    assert.equal(r.body.layover?.active, true);
    assert.equal(r.body.layover?.sessionId, SESSION_ID);
    assert.match(String(r.body.layover?.snapshotId ?? ""), /.+/);
    assert.equal(r.body.layover?.landsideOpen, true);
  });

  it("names WHY each withheld place was withheld, in three distinguishable states", async () => {
    setClient({ rows: layoverWorld() });
    const r = await get(COMMUNITY);
    const by = new Map<string, any>(
      ((r.body.layover?.excluded ?? []) as any[]).map((e) => [e.id, e]),
    );
    assert.deepEqual([...by.keys()].sort(), ["far", "overlong", "unmeasured"]);

    // 1. UNAVAILABLE MEASUREMENT — we looked; nobody has stated the terms.
    assert.equal(by.get("unmeasured")?.state, "UNMEASURED");
    // 3. GENUINELY INELIGIBLE, two ways: a §8 proof, and a stated total that
    //    does not fit the certified window. Neither is "unmeasured".
    assert.equal(by.get("far")?.state, "BLOCKED");
    assert.equal(by.get("overlong")?.state, "BLOCKED");
    for (const e of by.values()) {
      assert.equal(typeof e.reason, "string", `${e.id}: a withheld place must say why`);
      assert.ok(e.reason.length > 0);
    }
  });

  it("a place with NO stated terms is UNMEASURED — never quietly admitted", async () => {
    // Everything readable, no plan stops at all: the read SUCCEEDED and found
    // nothing. Nobody has measured any of these places, so nothing is admitted
    // and the answer carries no refusal.
    setClient({ rows: layoverWorld({ stops: [] }) });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined, "'nobody measured this' is not a failure");
    assert.deepEqual(idsOf(r.body), []);
    const states = ((r.body.layover?.excluded ?? []) as any[])
      .filter((e) => e.id !== "far").map((e) => e.state);
    assert.deepEqual(
      states.sort(), ["UNMEASURED", "UNMEASURED", "UNMEASURED"],
      "with no measurement anywhere, no reachable place may be anything but UNMEASURED",
    );
  });

  it("POSITIVE CONTROL: the traveller's own stated stop is what admits a place", async () => {
    // The SAME world, differing only in whether a stop states the terms. If the
    // stop did not reach the universe, the two answers would be identical and
    // every other assertion in this file would be vacuous.
    setClient({ rows: layoverWorld({ stops: [] }) });
    const without = await get(COMMUNITY);
    setClient({ rows: layoverWorld({ stops: [stopRow("unmeasured", 15, 45)] }) });
    const with_ = await get(COMMUNITY);
    assert.deepEqual(idsOf(without.body), []);
    assert.deepEqual(idsOf(with_.body), ["unmeasured"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A14 — a FAILED READ must not masquerade as an empty universe", () => {
  it("an unreadable layover_sessions refuses instead of serving an ungated list", async () => {
    setClient({ rows: layoverWorld(), errorTables: ["layover_sessions"] });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200, "the refusal rides in the 200 envelope — see lib/discoveryRefusal.ts");
    assertFailedReadRefusal(
      r.body, "layover_snapshot_unreadable", "layover_sessions",
      "unreadable layover_sessions",
    );
  });

  it("an unreadable airport_profiles refuses rather than certifying from default buffers", async () => {
    setClient({ rows: layoverWorld(), errorTables: ["airport_profiles"] });
    const r = await get(COMMUNITY);
    assertFailedReadRefusal(
      r.body, "layover_snapshot_unreadable", "airport_profiles",
      "unreadable airport_profiles",
    );
  });

  it("an unreadable layover_plan_stops refuses — the timing read is not an empty universe", async () => {
    // THE CENTRAL CASE. Without the guard, a failed timing read produces null
    // terms for every candidate, every candidate comes back UNMEASURED, and the
    // body is `items: []` — byte-identical to "we looked and nothing fits".
    setClient({ rows: layoverWorld(), errorTables: ["layover_plan_stops"] });
    const r = await get(COMMUNITY);
    assertFailedReadRefusal(
      r.body, "layover_timing_unreadable", "layover_plan_stops",
      "unreadable layover_plan_stops",
    );
  });

  it("the failed timing read and the genuinely-unmeasured city are NOT the same body", async () => {
    setClient({ rows: layoverWorld(), errorTables: ["layover_plan_stops"] });
    const failed = await get(COMMUNITY);
    setClient({ rows: layoverWorld({ stops: [] }) });
    const empty = await get(COMMUNITY);

    assert.deepEqual(failed.body.items, []);
    assert.deepEqual(empty.body.items, []);
    assert.notDeepEqual(
      failed.body, empty.body,
      "a failed timing read and a city nobody has measured produced the SAME body — " +
      "that is the masquerade owner ruling D11 forbids",
    );
    assert.ok(failed.body.refusal, "the failed read must be the one carrying the refusal");
    assert.equal(empty.body.refusal, undefined, "the unmeasured city must NOT carry one");
  });

  it("a refused Layover-mode serve is kept out of the exposure denominator", async () => {
    setClient({ rows: layoverWorld() });
    const served = await get(COMMUNITY);
    assert.equal(served.body.refusal, undefined);
    await settle();
    assert.equal(rankInserts().length, 1, "POSITIVE CONTROL: a real serve must log — else the probe is blind");

    inserts = [];
    setClient({ rows: layoverWorld(), errorTables: ["layover_plan_stops"] });
    await get(COMMUNITY);
    await settle();
    assert.equal(rankInserts().length, 0, "a refused Layover-mode read was counted as exposure");
  });

  it("the serve log records the GATED page, not everything that was read", async () => {
    setClient({ rows: layoverWorld() });
    await get(COMMUNITY);
    await settle();
    const rows = rankInserts().flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows])) as any[];
    const ids = rows.map((x) => x.item_id ?? x.place_id ?? x.entity_id ?? x.subject_id).filter(Boolean);
    assert.deepEqual(
      [...new Set(ids)].sort(), ["fits"],
      "places the certified universe withheld were never shown, so they are not exposure",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//
// CORRECTION 2 — `GET /discovery` is a Layover-mode surface too.
//
// §25 L269 says "Discovery", not "the community tab". The previous pass gated
// only `GET /discovery/community` and left the larger surface serving an
// UNGATED page to a traveller in Layover mode. All four of its serve paths
// funnel through one helper, so the gate is one place — but each path has to be
// reached to prove it, because every Compass branch swallows its own errors and
// falls through to the cold path, and a case that quietly answered from a
// DIFFERENT path would assert nothing about the path it names.
describe("A14 — GET /discovery is gated on all four serve paths", () => {
  it("cache-A: only the certified universe is served, and `total` counts it", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    _injectTestCacheEntry(DISCOVERY_CACHE_KEY, [discoveryOsmPlace(OSM_ID, 25.082, 121.237)]);
    const r = await get(DISCOVERY);
    assertServePath(r.body, "cache_a");
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(
      placeIdsOf(r.body), [`db/${DB_UUID_FITS}`],
      "an ungated GET /discovery page reached a traveller in Layover mode",
    );
    assert.equal(r.body.total, 1, "`total` must describe what was served, not what was read");
    assert.equal(r.body.layover?.active, true);
    assert.equal(r.body.layover?.sessionId, SESSION_ID);
  });

  it("cold fetch: the same gate, on the path that runs the ranker", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    const r = await get(DISCOVERY);
    assertServePath(r.body, "cold");
    assert.deepEqual(placeIdsOf(r.body), [`db/${DB_UUID_FITS}`]);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.layover?.active, true);
  });

  it("Compass fresh rank and cache-B hit: gated on both", async () => {
    const rows = { ...discoveryWorld(), };
    (rows as any).feature_flags = [
      SERVE_LOG_ON, ...FLAG_ON, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true },
    ];
    setClient({ rows });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    const forYou = `/api/discovery?destination=${encodeURIComponent(CITY)}&lat=25.08&lng=121.235&radiusKm=10&category=for_you`;
    const fresh = await get(forYou);
    assertServePath(fresh.body, "compass_fresh");
    assert.deepEqual(placeIdsOf(fresh.body), [`db/${DB_UUID_FITS}`]);
    assert.equal(fresh.body.layover?.active, true);

    const hit = await get(forYou);
    assertServePath(hit.body, "compass_hit");
    assert.deepEqual(placeIdsOf(hit.body), [`db/${DB_UUID_FITS}`]);
    assert.equal(hit.body.layover?.active, true);
  });

  it("an OSM item is UNMEASURED and NAMED — never admitted, never silently dropped", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235)]);
    _injectTestCacheEntry(DISCOVERY_CACHE_KEY, [discoveryOsmPlace(OSM_ID, 25.082, 121.237)]);
    const r = await get(DISCOVERY);
    assertServePath(r.body, "cache_a");
    assert.ok(
      !placeIdsOf(r.body).includes(OSM_ID),
      "an OSM element has no layover subject, so nothing can certify it — it must not be admitted",
    );
    const excluded = (r.body.layover?.excluded ?? []) as any[];
    const osm = excluded.find((e) => e.id === OSM_ID);
    assert.ok(osm, "the OSM item was silently dropped — a withheld place must be NAMED");
    assert.equal(osm.state, "UNMEASURED");
  });

  it("a FAILED read refuses on GET /discovery instead of serving an ungated page", async () => {
    setClient({ rows: discoveryWorld(), errorTables: ["layover_plan_stops"] });
    _setTestDbPlacesOverride(async () => [discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235)]);
    const r = await get(DISCOVERY);
    assert.equal(r.status, 200);
    assert.ok(r.body?.refusal, "a failed timing read served a page instead of a refusal");
    assert.equal(r.body.refusal.code, "layover_timing_unreadable");
    assert.equal(r.body.refusal.route, "GET /discovery");
    assert.equal(r.body.refusal.coverage, "nothing");
    assert.deepEqual([...(r.body.refusal.failedSources ?? [])], ["layover_plan_stops"]);
    assert.deepEqual(r.body.places, [], "a refusal must not also ship places");
  });

  it("the GET /discovery serve log records the GATED page, not everything read", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    await get(DISCOVERY);
    await settle();
    // EXPOSURE only. `rank_events` also carries `outcome: "analytics"` rows from
    // the ranker's assembly pass (CreatorCapEnforcer.ts:72,82), which describe
    // the CANDIDATE POOL and are written for everything ranked, on every page,
    // gate or no gate. The denominator is the impression rows — what
    // logImpression / logDiscoveryServe wrote — and those are what must be in
    // step with the gated page.
    const rows = (rankInserts().flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows])) as any[])
      .filter((x) => x?.outcome === "impression");
    const ids = rows.map((x) => x.item_id ?? x.place_id ?? x.entity_id ?? x.subject_id).filter(Boolean);
    assert.ok(rows.length > 0, "POSITIVE CONTROL: a real serve must log — else the probe is blind");
    assert.deepEqual(
      [...new Set(ids)].sort(), [`db/${DB_UUID_FITS}`],
      "a place the certified universe withheld was never shown, so it is not exposure",
    );
  });

  it("a refused GET /discovery is kept out of the exposure denominator", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235)]);
    await get(DISCOVERY);
    await settle();
    const served = (rankInserts().flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows])) as any[])
      .filter((x) => x?.outcome === "impression");
    assert.ok(served.length > 0, "POSITIVE CONTROL: a real serve must log — else the probe is blind");

    inserts = [];
    setClient({ rows: discoveryWorld(), errorTables: ["layover_plan_stops"] });
    _setTestDbPlacesOverride(async () => [discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235)]);
    await get(DISCOVERY);
    await settle();
    const refused = (rankInserts().flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows])) as any[])
      .filter((x) => x?.outcome === "impression");
    assert.equal(refused.length, 0, "a refused Layover-mode read was counted as exposure");
  });

  it("mode OFF leaves GET /discovery byte-identical — no key, no gate", async () => {
    setClient({ rows: discoveryWorld({ flags: FLAG_OFF }) });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    const r = await get(DISCOVERY);
    assertServePath(r.body, "cold");
    assert.equal(r.body.layover, undefined, "an absent flag must not add a key to the envelope");
    assert.deepEqual(
      placeIdsOf(r.body), [`db/${DB_UUID_FITS}`, `db/${DB_UUID_UNMEASURED}`].sort(),
    );
    assert.deepEqual(
      Object.keys(r.body),
      ["places", "total", "destination", "context", "cached", "ageFilterMeta", "sourceSummary", "meta", "cursor"],
      "the ordinary GET /discovery success envelope moved",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//
// CORRECTION 3 — an UNMEASURED term must say WHICH absence it is.
//
// `UNMEASURED` on its own is one word for at least four different situations,
// and on the wire they are indistinguishable: all four produce the same missing
// number and the same state. That is the census's standing rule one level down
// from the three states — absence of evidence must never read as evidence of
// absence, and two different absences must not read alike.
//
// This drives FOUR of them through ONE surface, in ONE response, and asserts
// four DISTINGUISHABLE provenance records. It is deliberately not four rows
// that merely differ in an id: the assertion is on the `terms` object of each,
// and the four objects are pairwise unequal as a separate, explicit check.
describe("A14 — each UNMEASURED carries WHICH absence it is, per term", () => {
  /**
   * Four situations, in one page:
   *
   *   db/<A>  a place the traveller has no stop for            → no_plan_stop
   *   db/<B>  a stop whose landside travel is the column's
   *           NOT-NULL zero — an ABSENCE, not a measurement    → stop_travel_unstated
   *   db/<C>  a stop whose duration is not a stated figure     → stop_duration_unstated
   *   node/…  a live OSM element, which has no layover
   *           subject and never can                            → no_layover_subject
   *
   * and on every one of them the travel term ALSO carries the PORT's own word,
   * because `LAYOVER_TRAVEL_TIME_PROVIDER` is `noRoutedProvider` on this tree.
   * That is the fifth situation and it is a different fact from all four: it is
   * true of every row here at the same time as exactly one of the four.
   *
   * (The sixth — the plan-stops READ failed — is not an absence at all. It
   * refuses, and the suite above pins that it stays distinct.)
   */
  async function fourAbsences() {
    setClient({
      rows: {
        ...discoveryWorld({
          stops: [
            stopRow(DB_UUID_ZERO_TRAVEL, 0, 60),
            stopRow(DB_UUID_ZERO_DURATION, 20, 0),
          ],
        }),
      },
    });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
      discoveryDbPlace(DB_UUID_ZERO_TRAVEL, 25.0805, 121.2355),
      discoveryDbPlace(DB_UUID_ZERO_DURATION, 25.0806, 121.2356),
    ]);
    _injectTestCacheEntry(DISCOVERY_CACHE_KEY, [discoveryOsmPlace(OSM_ID, 25.082, 121.237)]);
    const r = await get(DISCOVERY);
    assertServePath(r.body, "cache_a");
    assert.equal(r.body.refusal, undefined, "none of these four is a failure");
    const by = new Map<string, any>(
      ((r.body.layover?.excluded ?? []) as any[]).map((e) => [e.id, e]),
    );
    assert.deepEqual(
      [...by.keys()].sort(),
      [`db/${DB_UUID_UNMEASURED}`, `db/${DB_UUID_ZERO_DURATION}`, `db/${DB_UUID_ZERO_TRAVEL}`, OSM_ID].sort(),
      "PRECONDITION: all four must be withheld and NAMED, or this test asserts nothing",
    );
    for (const e of by.values()) {
      assert.equal(e.state, "UNMEASURED", `${e.id}: precondition — all four are the SAME state`);
    }
    return by;
  }

  it("names the four absences apart, per term", async () => {
    const by = await fourAbsences();

    const noStop = by.get(`db/${DB_UUID_UNMEASURED}`).terms;
    assert.equal(noStop.travel.value, null);
    assert.equal(noStop.travel.absence, "no_plan_stop");
    assert.equal(noStop.activity.value, null);
    assert.equal(noStop.activity.absence, "no_plan_stop");

    const zeroTravel = by.get(`db/${DB_UUID_ZERO_TRAVEL}`).terms;
    assert.equal(zeroTravel.travel.value, null, "the column's NOT-NULL zero was promoted to a measurement");
    assert.equal(zeroTravel.travel.absence, "stop_travel_unstated");
    // The OTHER term of the same row is a real figure, which is what proves the
    // two terms are answered separately rather than as one verdict per row.
    assert.equal(zeroTravel.activity.value, 60);
    assert.equal(zeroTravel.activity.absence, null);
    assert.equal(zeroTravel.activity.source, "traveller_plan_stop");

    const zeroDuration = by.get(`db/${DB_UUID_ZERO_DURATION}`).terms;
    assert.equal(zeroDuration.travel.value, 20);
    assert.equal(zeroDuration.travel.absence, null);
    assert.equal(zeroDuration.activity.value, null);
    assert.equal(zeroDuration.activity.absence, "stop_duration_unstated");

    const osm = by.get(OSM_ID).terms;
    assert.equal(osm.travel.absence, "no_layover_subject");
    assert.equal(osm.activity.absence, "no_layover_subject");
  });

  it("the PORT's own reason rides beside the absence, on every travel term", async () => {
    // Fifth situation, and it is not a fifth VALUE of the same field: "no
    // routed provider is configured" is true of every row at the same time as
    // exactly one of the four above. A single slot could only have held one of
    // the two facts, so it would have had to drop the other.
    const by = await fourAbsences();
    for (const e of by.values()) {
      assert.equal(
        e.terms.travel.portReason, "NO_ROUTED_PROVIDER",
        `${e.id}: the port was asked and its answer was thrown away`,
      );
      assert.equal(
        e.terms.activity.portReason, null,
        `${e.id}: the port has no opinion about dwell time — a reason here would be borrowed`,
      );
    }
  });

  it("the four provenance records are PAIRWISE DISTINGUISHABLE, not four ids", async () => {
    // The point of the whole correction. If any two of these serialise the
    // same, a client reading the envelope cannot tell the two situations apart
    // and the word UNMEASURED is doing all four jobs again.
    const by = await fourAbsences();
    const records = [...by.values()].map((e) => JSON.stringify(e.terms));
    assert.equal(
      new Set(records).size, 4,
      "two withheld places reported the SAME provenance for DIFFERENT absences:\n" +
      records.join("\n"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//
// CORRECTION 2, the third surface — GET /discovery/feed.
//
// It was decided ON EVIDENCE rather than left unmentioned. The feed's `places`
// half is the SAME merged population as GET /discovery: `queryDbPlaces` rows
// served as `db/<uuid>` plus live OSM elements, flattened across categories
// (routes/discovery.ts, the `allPlaces` loop). Same rows, same traveller, same
// §25 L269 sentence — so it is gated by the same helper.
//
// Its `posts` half is NOT gated, and the reason is in `layoverGatedPlaces`'
// header: a DiscoveryEventPost's id is a `posts.id`, it has no
// `discovery_places` row, and `layover_plan_stops.place_id` has nothing it
// could ever hold for one. `events` and `memories` are `[]` on every response
// this route sends.
describe("A14 — GET /discovery/feed serves the same rows, so it is gated too", () => {
  const FEED = `/api/discovery/feed?lat=25.08&lng=121.235&city=${encodeURIComponent(CITY)}`;

  it("only the certified universe reaches the feed, and `total` counts it", async () => {
    setClient({ rows: discoveryWorld() });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    const r = await get(FEED);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(
      placeIdsOf(r.body), [`db/${DB_UUID_FITS}`],
      "an ungated feed page reached a traveller in Layover mode",
    );
    assert.equal(r.body.total, 1);
    assert.equal(r.body.layover?.active, true);
  });

  it("a FAILED read refuses on the feed rather than serving a shorter page", async () => {
    setClient({ rows: discoveryWorld(), errorTables: ["layover_plan_stops"] });
    _setTestDbPlacesOverride(async () => [discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235)]);
    const r = await get(FEED);
    assert.ok(r.body?.refusal, "a failed timing read served a feed page instead of a refusal");
    assert.equal(r.body.refusal.code, "layover_timing_unreadable");
    assert.equal(r.body.refusal.route, "GET /discovery/feed");
    assert.equal(r.body.refusal.coverage, "nothing");
    assert.deepEqual(r.body.places, []);
  });

  it("mode OFF leaves the feed byte-identical — no key, no gate", async () => {
    setClient({ rows: discoveryWorld({ flags: FLAG_OFF }) });
    _setTestDbPlacesOverride(async () => [
      discoveryDbPlace(DB_UUID_FITS, 25.08, 121.235),
      discoveryDbPlace(DB_UUID_UNMEASURED, 25.081, 121.236),
    ]);
    const r = await get(FEED);
    assert.equal(r.body.layover, undefined);
    assert.deepEqual(
      placeIdsOf(r.body), [`db/${DB_UUID_FITS}`, `db/${DB_UUID_UNMEASURED}`].sort(),
    );
    assert.deepEqual(
      Object.keys(r.body),
      ["places", "events", "posts", "memories", "sections", "nextCursor", "total",
       "destination", "context", "sourceSummary", "sessionId"],
      "the ordinary GET /discovery/feed success envelope moved",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A14 — the timing resolver, directly", () => {
  it("distinguishes an unreadable plan-stop read from a plan with no stops", async () => {
    const { statedLayoverTimings } = await import("../lib/discoveryLayoverTiming.js");
    const candidates = [{ id: "fits", lat: 25.08, lng: 121.235 }];
    const departAt = new Date();

    const failing = buildFakeClient({ errorTables: ["layover_plan_stops"], rows: layoverWorld() });
    const bad = await statedLayoverTimings(failing as any, SESSION_ID, candidates, { centre: null, departAt });
    assert.equal(bad.ok, false);
    assert.equal((bad as any).reason, "layover_plan_stops_unreadable");

    const empty = buildFakeClient({ rows: { ...layoverWorld(), layover_plan_stops: [] } });
    const good = await statedLayoverTimings(empty as any, SESSION_ID, candidates, { centre: null, departAt });
    assert.equal(good.ok, true);
    const t = (good as any).byId.get("fits");
    assert.equal(t.travelTimeMin, null, "no routed provider and no stated stop is an ABSENCE, not a zero");
    assert.equal(t.activityTimeMin, null);
  });

  it("carries the traveller's stated terms through, and nothing else", async () => {
    const { statedLayoverTimings } = await import("../lib/discoveryLayoverTiming.js");
    const db = buildFakeClient({ rows: layoverWorld() });
    const out = await statedLayoverTimings(
      db as any, SESSION_ID,
      [{ id: "fits", lat: 25.08, lng: 121.235 }, { id: "unmeasured", lat: 25.081, lng: 121.236 }],
      { centre: { lat: 25.0797, lng: 121.2342 }, departAt: new Date() },
    );
    assert.equal(out.ok, true);
    const byId = (out as any).byId as Map<string, any>;
    assert.equal(byId.get("fits").travelTimeMin, 20);
    assert.equal(byId.get("fits").activityTimeMin, 60);
    // The port is what would supersede a self-report, and on this tree it has
    // nothing to say — so the figure above is the traveller's own and says so.
    assert.equal(byId.get("fits").travelSource, "traveller_plan_stop");
    assert.equal(byId.get("unmeasured").travelTimeMin, null);
    assert.equal(byId.get("unmeasured").activityTimeMin, null);
  });

  it("a stop whose landside travel is the column's NOT-NULL zero is an ABSENCE", async () => {
    // `layover_plan_stops.travel_min` is `INTEGER NOT NULL DEFAULT 0`, so the
    // unknown has to be stored as some integer. Outside the airport that zero is
    // not a travel time; it is the lack of one (census L47). `statedTravelMin`
    // is the classifier, and this pins that it is the one being used.
    const { statedLayoverTimings } = await import("../lib/discoveryLayoverTiming.js");
    const db = buildFakeClient({
      rows: { ...layoverWorld(), layover_plan_stops: [stopRow("fits", 0, 60)] },
    });
    const out = await statedLayoverTimings(
      db as any, SESSION_ID, [{ id: "fits", lat: 25.08, lng: 121.235 }],
      { centre: { lat: 25.0797, lng: 121.2342 }, departAt: new Date() },
    );
    const t = (out as any).byId.get("fits");
    assert.equal(t.travelTimeMin, null, "a landside zero was promoted to a measurement");
    assert.equal(t.activityTimeMin, 60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//
// CORRECTION 4 — the property, not a proxy for it.
//
// WHAT WAS HERE, AND WHY IT IS GONE. A test asserted that
// `discoveryLayoverTiming.ts` contains NO DIGIT AT ALL, comments and string
// literals stripped. It was written after a ternary mutant (`stop ?
// stop.durationMin : 30`) evaded the `??`/`||` regex above, and it did catch
// that one — but it is a property of the FILE'S TEXT, not of its behaviour, and
// the two come apart in both directions:
//
//   FALSE POSITIVE   it already forced an unrelated rewrite of honest code
//                    (`placeId.length === 0` had to become `placeId === ""`),
//                    which is a test dictating spelling.
//   FALSE NEGATIVE   it passes for `activityTimeMin ?? FALLBACK_MIN` where
//                    FALLBACK_MIN is imported from another file, and for a
//                    lookup table, and for anything else that puts the digit
//                    somewhere the regex is not reading.
//
// What follows asserts the BEHAVIOUR it was a proxy for: a missing input must
// not acquire a value. That holds however the fabrication is spelled, because
// nothing here reads the source text at all.
describe("A14 — a missing input must NOT acquire a value (the property itself)", () => {
  /**
   * Every number a fabricator would plausibly reach for on this tree.
   *
   *   30 / 90 / 60   the deleted `estimateActivityTime`'s category answers
   *                  (LayoverRecommendationService.fetchDiscoveryPlaces).
   *   30 / 45 / 20 / 60  the airside constants.
   *   30, 0          `layover_plan_stops.duration_min` / `travel_min`'s own
   *                  NOT-NULL column defaults.
   *   30, 15         the pair the 2026-09-15 ternary mutant used.
   *
   * The assertions below do NOT need to know which one would be chosen — they
   * require `null`, so every member of this list fails and so does any number
   * not in it. The list is written out so the failure message can say what the
   * test is about, not because the test depends on it.
   */
  const PLAUSIBLE_DEFAULTS = [0, 15, 20, 30, 45, 60, 90];

  const NOWHERE = { centre: { lat: 25.0797, lng: 121.2342 }, departAt: new Date() };

  async function timeOne(stops: any[], id = "fits") {
    const { statedLayoverTimings } = await import("../lib/discoveryLayoverTiming.js");
    const db = buildFakeClient({ rows: { ...layoverWorld(), layover_plan_stops: stops } });
    const out = await statedLayoverTimings(
      db as any, SESSION_ID, [{ id, lat: 25.08, lng: 121.235 }], NOWHERE,
    );
    assert.equal(out.ok, true, "PRECONDITION: the plan read must have SUCCEEDED");
    return (out as any).byId.get(id);
  }

  function assertNoNumber(actual: unknown, what: string) {
    assert.equal(
      actual, null,
      `${what}: a missing input acquired the value ${JSON.stringify(actual)}. ` +
      `Nobody stated it and no routed provider exists on this tree, so there is ` +
      `nothing for a number to be. (The defaults a fabricator reaches for here ` +
      `are ${PLAUSIBLE_DEFAULTS.join(", ")} — but ANY number fails this, which is ` +
      `the point: the test does not have to guess which one was chosen.)`,
    );
    assert.ok(
      !PLAUSIBLE_DEFAULTS.includes(actual as number),
      `${what}: the value is one of the known substituted defaults`,
    );
  }

  it("no stated stop and no routed estimate ⇒ BOTH terms are null", async () => {
    const t = await timeOne([]);
    assertNoNumber(t.travelTimeMin, "travel");
    assertNoNumber(t.activityTimeMin, "activity");
    assertNoNumber(t.travel.value, "travel (provenance record)");
    assertNoNumber(t.activity.value, "activity (provenance record)");
  });

  it("and the place is NOT ADMITTED — which is what a fabricated default buys", async () => {
    // The behavioural consequence, end to end. A substituted minute count does
    // not just put a number in a field: it makes an UNMEASURED place APPEAR on
    // a traveller's Layover Discovery as though someone had certified it.
    setClient({ rows: layoverWorld({ stops: [] }) });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined, "PRECONDITION: the read SUCCEEDED and found nothing");
    assert.deepEqual(
      idsOf(r.body), [],
      "a place nobody has measured was ADMITTED — the only way that happens is a " +
      "number this tree does not have",
    );
    for (const e of ((r.body.layover?.excluded ?? []) as any[])) {
      assertNoNumber(e.terms.travel.value, `${e.id} travel`);
      assertNoNumber(e.terms.activity.value, `${e.id} activity`);
    }
  });

  it("PROVENANCE: a value that IS present tracks the stop the traveller stated", async () => {
    // A fabricated constant does not move. Three different stated durations,
    // three different reported values, and none of them is the one a default
    // would have produced for all three.
    const seen: number[] = [];
    for (const stated of [25, 55, 115]) {
      const t = await timeOne([stopRow("fits", 35, stated)]);
      assert.equal(
        t.activityTimeMin, stated,
        `the stop stated ${stated} minutes and the surface reported ` +
        `${JSON.stringify(t.activityTimeMin)} — a figure that does not move with ` +
        `the traveller's own row is not the traveller's own figure`,
      );
      assert.equal(t.activity.source, "traveller_plan_stop");
      assert.equal(t.travelTimeMin, 35, "the travel term must track its own column too");
      seen.push(t.activityTimeMin);
    }
    assert.equal(new Set(seen).size, 3, "three different stated durations produced fewer than three answers");
  });

  it("DISCRIMINATION: a stop stating exactly a default's value is still not the absence", async () => {
    // The case a fabricated default makes unreachable. If `duration_min` were
    // defaulted to 30, then a traveller who REALLY stated 30 and a traveller
    // who stated nothing would produce identical output, and the surface would
    // have lost the ability to say which it was looking at.
    const statedThirty = await timeOne([stopRow("fits", 35, 30)]);
    const noStop       = await timeOne([]);

    assert.equal(statedThirty.activity.value, 30);
    assert.equal(statedThirty.activity.source, "traveller_plan_stop");
    assert.equal(statedThirty.activity.absence, null);

    assert.equal(noStop.activity.value, null);
    assert.equal(noStop.activity.source, "unmeasured");
    assert.equal(noStop.activity.absence, "no_plan_stop");

    assert.notDeepEqual(
      statedThirty.activity, noStop.activity,
      "a stop stating 30 minutes and a traveller with no stop at all reported the " +
      "SAME thing — the surface can no longer tell a measurement from its absence",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("A14 — SOURCE GUARD: no timing value may be invented here", () => {
  const SRC = [
    "src/lib/discoveryLayoverTiming.ts",
    "src/lib/discoveryLayoverMode.ts",
  ];

  /** The file with its comments and its string literals taken out. */
  function code(f: string): string {
    return readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("/*") && !l.trim().startsWith("//"))
      .join("\n")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, '""');
  }

  it("neither module defaults a missing minute figure to a number", async () => {
    for (const f of SRC) {
      assert.ok(
        !/(\?\?|\|\|)\s*\d/.test(code(f)),
        `${f}: a numeric fallback appeared. A place nobody has measured stays UNMEASURED; ` +
        "a default minute count is the `estimateActivityTime` defect this row exists to close.",
      );
    }
  });

  it("the terms are read through the layover domain's own classifiers and port", async () => {
    const src = readFileSync(new URL("../../src/lib/discoveryLayoverTiming.ts", import.meta.url), "utf8");
    for (const sym of ["statedTravelMin", "statedDurationMin", "landsideLeg"]) {
      assert.ok(
        src.includes(sym),
        `discoveryLayoverTiming.ts no longer consults ${sym} — a second copy of the ` +
        "stated/absent rule is exactly what census-layover L6 forbids",
      );
    }
  });
});
