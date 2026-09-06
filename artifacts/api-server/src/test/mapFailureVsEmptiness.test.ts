/**
 * Map spec §19 — "a failed read is not an empty layer", for the three layers
 * that were still saying it was.
 *
 * THE CONTRACT ALREADY EXISTED, AND THREE LAYERS BROKE IT
 * ======================================================
 * `sources` in the /api/map/projection envelope "names what actually arrived
 * through the gateway" (routes/mapProjection.ts). Every producer-backed layer
 * honours that: circle, buddies, trips, places and the four M5 producers all
 * leave themselves OUT of `sources` when their read fails, and
 * src/test/mapProjectionLayers.test.ts pins two of them ("a failed read must
 * not be reported as an empty-but-successful layer").
 *
 * `travelers`, `gems` and `events` did not. Each caught its failure to an empty
 * array and then pushed its name into `sources` anyway, so the client — and any
 * operator reading the envelope — was told the layer had been read successfully
 * and the viewport was empty. That is the difference between "nobody is sharing
 * their location in Da Nang tonight" and "the location table just started
 * returning 42501", and only one of those is a fact about the world.
 *
 * The travelers layer was the worst of the three because the lie was
 * MANUFACTURED INSIDE THE READER: `lib/mapTravelers.loadCandidates` returned []
 * on a PostgREST error, and supabase-js returns errors rather than throwing, so
 * the gateway's `.catch(() => [])` never saw one. No caller could have told the
 * difference however carefully it tried. It also CACHED that empty for 20 s, so
 * a single transient error emptied the layer for every viewer of that viewport
 * until the window rolled.
 *
 * WHAT THESE TESTS ARE, AND WHY EACH HAS A TWIN
 * ============================================
 * Every failure case here is paired with a SUCCESSFUL-BUT-EMPTY twin over the
 * same fixture. Asserting only "the source is absent when the read fails" would
 * pass just as well against a gateway that never named the source at all; the
 * twin is what makes the assertion about the DISTINCTION rather than about
 * absence. The two answers must differ, and they must differ in the direction
 * the envelope documents.
 *
 * No privacy gate moves in any of this. A failed read still yields no objects;
 * it is now nameable, which is the whole of the change.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapFailureVsEmptiness.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import mapTravelersRouter from "../routes/mapTravelers.js";
import { listMapTravelers, _clearMapTravelersCache } from "../lib/mapTravelers.js";

// ── ids and geography ─────────────────────────────────────────────────────────

const TOKEN = "failure-vs-emptiness-token";
const USER = "viewer-user-id";
const TRAVELER = "traveler-user-id";

/** Da Nang-ish, inside BBOX below. */
const POS = { lat: 16.06, lng: 108.21 };
const BBOX = "108.0,15.9,108.4,16.2";

/** Relative so the fixture cannot rot into a vacuous empty case. */
function freshFix(): { last_known_at: string } {
  return { last_known_at: new Date(Date.now() - 60_000).toISOString() };
}

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  /** Every read of this table resolves to this error, data null. */
  error?: { message: string };
  /** Every read of this table REJECTS — the transport-failure shape. */
  throws?: boolean;
}

type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/**
 * A chainable PostgREST-ish query. `eq` and `in` really filter, because
 * `isFlagEnabled` selects one flag row by name and the traveler pipeline joins
 * four tables on a user-id list; the rest are accepted and ignored, which is
 * safe here because every fixture is small enough to be its own answer.
 */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const settle = <T>(value: T): Promise<T> =>
    spec.throws ? Promise.reject(new Error("transport failed")) : Promise.resolve(value);
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });

  const q: any = {
    select() { return q; },
    order() { return q; },
    limit() { return q; },
    range() { return q; },
    or() { return q; },
    ilike() { return q; },
    contains() { return q; },
    gt() { return q; },
    lt() { return q; },
    is() { return q; },
    not() { return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    maybeSingle() {
      return settle(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return settle(result()).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
    rpc: async () => ({ data: [], error: null }),
  };
}

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use(mapProjectionRouter);
  app.use(mapTravelersRouter);
  await new Promise<void>((resolve) => {
    // Bind loopback explicitly: a host-less listen(0) binds [::] and a foreign
    // IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  _clearProtectedZoneCache();
  // The traveler candidate cache is module-level and viewport-keyed, so without
  // this a later scenario would be answered from an earlier scenario's read.
  _clearMapTravelersCache();
});

// ── fixtures ──────────────────────────────────────────────────────────────────

/**
 * One eligible traveler, all four privacy reads present and permissive. A
 * SUCCESSFUL read over this state returns exactly one traveler.
 */
function baseState(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    protected_zones: [],
    user_location_state: [
      { user_id: TRAVELER, lat: POS.lat, lng: POS.lng, city: "Da Nang", country: "VN", ...freshFix() },
    ],
    location_preferences: [
      { user_id: TRAVELER, location_mode: "nearby", sharing_paused: false, discovery_visibility: null },
    ],
    profiles: [
      {
        id: TRAVELER, handle: "trav", name: "Trav", display_name: "Trav", avatar_url: null,
        show_profile_picture_publicly: true, verified: false, open_to_meet: false,
        is_private: false, account_status: "active",
      },
    ],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    canonical_locations: [],
    hidden_gems: [],
    events: [],
    ...over,
  };
}

async function projection(kinds: string, state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=${kinds}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The travelers layer
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/map/projection — travelers layer tells a failure from an empty city", () => {
  it("names the source when the read SUCCEEDS and finds a traveler", async () => {
    const r = await projection("social_zone", baseState());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sources, ["travelers"]);
    assert.equal(r.body.objects.length, 1, "the eligible traveler should be on the map");
  });

  it("still names the source when the read succeeds and the city is EMPTY", async () => {
    // The twin that makes the failure assertions mean something: an empty
    // neighbourhood is a successful read and must keep saying so.
    const r = await projection("social_zone", baseState({ user_location_state: [] }));
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(
      r.body.sources,
      ["travelers"],
      "zero travelers is a fact about the world, not a failure to look",
    );
  });

  it("does NOT name the source when user_location_state cannot be read", async () => {
    const r = await projection(
      "social_zone",
      baseState({ user_location_state: { error: { message: "permission denied" } } }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(
      r.body.sources,
      [],
      "a failed candidate read must not be reported as an empty-but-successful layer",
    );
  });

  it("does NOT name the source when a PRIVACY read fails", async () => {
    // profiles is one of the four reads that decide who is eligible. Losing it
    // means eligibility is unknown — the layer suppresses (unchanged) and now
    // also declines to claim it looked.
    for (const table of [
      "profiles",
      "location_preferences",
      "profile_privacy_settings",
      "user_privacy_settings",
    ]) {
      _clearMapTravelersCache();
      const r = await projection(
        "social_zone",
        baseState({ [table]: { error: { message: "permission denied" } } }),
      );
      assert.deepEqual(r.body.objects, [], `${table}: a privacy read failure must show nobody`);
      assert.deepEqual(r.body.sources, [], `${table}: and must not claim the layer was read`);
    }
  });

  it("does NOT name the source when the block set is unresolvable", async () => {
    // The whole request already answers an empty envelope with no sources when
    // blocks cannot be read; this pins that the traveler layer agrees rather
    // than relying on the earlier bail-out alone.
    const r = await projection("social_zone", baseState({ blocks: { error: { message: "blocks down" } } }));
    assert.deepEqual(r.body.sources, []);
    assert.deepEqual(r.body.objects, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The gems layer
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/map/projection — gems layer tells a failure from an empty viewport", () => {
  it("names the source when the gem read succeeds and returns nothing", async () => {
    const r = await projection("hidden_gem", baseState());
    assert.deepEqual(r.body.sources, ["gems"]);
  });

  it("does NOT name the source when the gem read fails", async () => {
    // `discoverGems` THROWS on a query error, so the gateway's catch is the only
    // thing between the failure and the layer. It used to catch to [].
    const r = await projection(
      "hidden_gem",
      baseState({ hidden_gems: { error: { message: "gems down" } } }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.sources, []);
  });

  it("does NOT name the source when the gem PRIVACY pass fails", async () => {
    // A `reveal_after_save` gem asks hidden_gem_saves whether this viewer has
    // earned the exact coordinate. If that read throws, the redaction decision
    // was never made — the gems must not be served, and the layer was not read.
    const r = await projection(
      "hidden_gem",
      baseState({
        hidden_gems: [
          {
            id: "gem-1", name: "Quiet rooftop", status: "active",
            sensitivity_level: "reveal_after_save",
            latitude: POS.lat, longitude: POS.lng,
            approx_latitude: POS.lat, approx_longitude: POS.lng,
            submitted_by: "someone-else", vibe_tags: [], created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        hidden_gem_saves: { throws: true },
      }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.sources, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The events layer
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/map/projection — events layer tells a failure from an empty calendar", () => {
  it("names the source when the event read succeeds and finds nothing", async () => {
    const r = await projection("event", baseState());
    assert.deepEqual(r.body.sources, ["events"]);
  });

  it("does NOT name the source when the event read fails", async () => {
    // `loadNearbyEvents` has returned null for a failed read all along — and the
    // §10 inferred-cause path already reported it as `eventsReadFailed`. The
    // event LAYER coalesced the same null to [] and claimed the source anyway,
    // so one request could report the identical failure both ways at once.
    const r = await projection(
      "event",
      baseState({ events: { error: { message: "events down" } } }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.sources, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. lib/mapTravelers — the reader that manufactured the ambiguity
// ═════════════════════════════════════════════════════════════════════════════

const READ_OPTS = { viewerId: USER, lat: POS.lat, lng: POS.lng, radiusKm: 50 };

describe("listMapTravelers reports WHY it returned nobody", () => {
  beforeEach(() => _clearMapTravelersCache());

  it("an empty city is ok:true with an empty list", async () => {
    const r = await listMapTravelers(
      makeClient(baseState({ user_location_state: [] })) as any,
      { ...READ_OPTS, blockedSet: new Set<string>() },
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.travelers.length === 0);
  });

  it("a populated city is ok:true with the traveler", async () => {
    const r = await listMapTravelers(makeClient(baseState()) as any, {
      ...READ_OPTS,
      blockedSet: new Set<string>(),
    });
    assert.ok(r.ok && r.travelers.length === 1 && r.travelers[0]!.id === TRAVELER);
  });

  it("a candidate read failure is a NAMED refusal, not an empty city", async () => {
    const r = await listMapTravelers(
      makeClient(baseState({ user_location_state: { error: { message: "boom" } } })) as any,
      { ...READ_OPTS, blockedSet: new Set<string>() },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "candidate_read_failed");
  });

  it("a privacy read failure is its own named refusal", async () => {
    const r = await listMapTravelers(
      makeClient(baseState({ profiles: { error: { message: "boom" } } })) as any,
      { ...READ_OPTS, blockedSet: new Set<string>() },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "privacy_read_failed");
  });

  it("an unresolvable block set refuses rather than returning an empty list", async () => {
    const r = await listMapTravelers(makeClient(baseState()) as any, {
      ...READ_OPTS,
      blockedSet: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "blocks_unknown");
  });

  it("a FAILED read is never cached — the next read sees the recovered table", async () => {
    // The 20 s candidate cache is keyed on the rounded viewport and shared by
    // every viewer. Caching a failed read held the layer empty for the rest of
    // the window and, worse, erased the fact that anything had failed: the
    // cache hit is served as ok:true.
    const failed = await listMapTravelers(
      makeClient(baseState({ user_location_state: { error: { message: "boom" } } })) as any,
      { ...READ_OPTS, blockedSet: new Set<string>() },
    );
    assert.equal(failed.ok, false);

    // Same viewport, same cache key, healthy client, no cache clear in between.
    const recovered = await listMapTravelers(makeClient(baseState()) as any, {
      ...READ_OPTS,
      blockedSet: new Set<string>(),
    });
    assert.ok(
      recovered.ok && recovered.travelers.length === 1,
      "a transient failure must not hold the viewport empty for the cache window",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. GET /api/map/travelers — one failure, one answer
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/map/travelers answers db_error rather than an empty map", () => {
  it("serves the traveler on a healthy read", async () => {
    _setTestClient(makeClient(baseState()) as any, true);
    const r = await get(`/map/travelers?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50`);
    assert.equal(r.status, 200);
    assert.equal(r.body.travelers.length, 1);
  });

  it("serves an empty list when the city really is empty", async () => {
    _setTestClient(makeClient(baseState({ user_location_state: [] })) as any, true);
    const r = await get(`/map/travelers?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.travelers, []);
  });

  it("answers db_error when the read fails, matching its own throw path", async () => {
    // This route already answered db_error when the read THREW. supabase-js
    // returns its errors instead, so the identical failure used to arrive as
    // 200 { travelers: [] } — "nobody is on the map".
    _setTestClient(
      makeClient(baseState({ user_location_state: { error: { message: "boom" } } })) as any,
      true,
    );
    const r = await get(`/map/travelers?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });
});
