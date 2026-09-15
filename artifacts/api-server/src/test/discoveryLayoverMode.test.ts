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
 * reading back as a measurement. The last test in this file is a SOURCE GUARD
 * that fails if a default number is ever introduced to make a card appear.
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
import discoveryRouter from "../routes/discovery.js";
import { DISCOVERY_REFUSAL_CLASSES } from "../lib/discoveryRefusal.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
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
});

beforeEach(() => {
  inserts = [];
  invalidateServeLogFlagCache();
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

  it("an UNREADABLE feature_flags is also off — not a refusal, and not a gate", async () => {
    // `isFlagEnabled` returns false for a missing row AND for an unreadable
    // table (lib/featureFlags.ts). A consuming lane must not invent a third
    // behaviour for the second case.
    setClient({ rows: layoverWorld(), errorTables: ["feature_flags"] });
    const r = await get(COMMUNITY);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(idsOf(r.body), ALL_IDS);
    assert.equal(r.body.layover, undefined);
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

  it("the timing resolver contains NO NUMBER AT ALL — the strongest form of the rule", async () => {
    // A `??`/`||` guard catches the obvious fabrication and misses the ternary
    // (`stop ? stop.durationMin : 30`), which a mutation of this file got past
    // it on 2026-09-15. Every minute this module handles comes from a row or
    // from the port, so there is nothing left for a numeric literal to be.
    const src = code("src/lib/discoveryLayoverTiming.ts");
    const digits = src.split("\n").filter((l) => /\d/.test(l));
    assert.deepEqual(
      digits, [],
      "a number appeared in discoveryLayoverTiming.ts. Every figure here is read " +
      "off `layover_plan_stops` or off the travel-time port; a literal is a " +
      "measurement this tree does not have.",
    );
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
