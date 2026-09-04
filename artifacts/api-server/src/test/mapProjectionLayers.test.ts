/**
 * mapProjectionLayers — the layers that moved from the client into the Map
 * Intelligence Gateway (Map spec §19): friends/circle and trips.
 *
 * WHAT THESE TESTS ARE FOR
 * ========================
 * 1. EQUIVALENCE. lib/circleLocationsRead is an EXTRACTION of the logic that
 *    still lives inline in GET /api/me/circle-locations. A refactor of a
 *    privacy predicate is only safe if it is provably behaviour-preserving, so
 *    these tests do not merely assert what the extracted function returns —
 *    they drive the REAL HTTP route and the extracted function over the SAME
 *    fake client, scenario by scenario, and assert the two agree. Any divergence
 *    (a gate lost, a gate added, an error swallowed) fails here. The same
 *    technique pins the trips scope against GET /api/trips/me.
 *
 * 2. SERVER-SIDE COARSENING. The reason this layer mattered: today the mobile
 *    client applies ±0.01° jitter AFTER fetching, which cannot protect a
 *    coordinate that has already been delivered to the device. These tests
 *    assert the RAW coordinate never appears in the projection response and
 *    that the served value is exactly `coarsenPosition`'s output.
 *
 * 3. HONEST RUNGS. A coarsened friend is `approximate`, never `place_level`.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapProjectionLayers.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import locationRouter from "../routes/location.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { readCircleLocations } from "../lib/circleLocationsRead.js";
import { coarsenPosition } from "../lib/mapTravelers.js";
import {
  CIRCLE_PRIVACY_CLASS,
  TRIP_PRIVACY_CLASS,
  projectCircleMember,
  projectTrip,
} from "../lib/mapProjection.js";
import { KIND_DEFAULT_PRIORITY, isServable } from "../lib/mapObjects.js";

// ── ids ───────────────────────────────────────────────────────────────────────

const TOKEN = "layers-test-token";
const USER = "viewer-user-id";
const MEM_A = "member-a-id";
const MEM_B = "member-b-id";

/** A deliberately distinctive raw position, so a leak is greppable. */
const RAW = { lat: 16.054412, lng: 108.202233 };

/**
 * Position-fix timestamps must be RELATIVE now that lib/circleLocationsRead
 * drops positions older than the map-wide 60-minute bound. The absolute
 * literals these fixtures used to carry ("2026-08-31T11:00:00.000Z") were fresh
 * on the day they were written and would have silently turned every
 * "1 location" expectation below into "0 locations" the following morning —
 * the fixtures would rot into vacuous passes of the empty case.
 *
 * `updated_at` and `last_known_at` are BOTH set: the reader serves the former
 * and gates on the latter (only `last_known_at` tracks an actual position fix —
 * routes/location.ts bumps `updated_at` on settings-only upserts too).
 */
const FRESH_AGO_MS = 60_000;
function freshFix(): { updated_at: string; last_known_at: string } {
  const iso = new Date(Date.now() - FRESH_AGO_MS).toISOString();
  return { updated_at: iso, last_known_at: iso };
}

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  /** When set, every read of this table returns this error (data null). */
  error?: { message: string };
}

type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/**
 * A chainable PostgREST-ish query over in-memory rows. Only the operators the
 * routes under test actually use are implemented; anything else would be a
 * silent no-op, so they are omitted on purpose.
 */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });

  const q: any = {
    select() { return q; },
    order() { return q; },
    limit() { return q; },
    range() { return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      return q;
    },
    or(expr: string) {
      const parts = expr
        .split(",")
        .map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/))
        .filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      return q;
    },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
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
  // routes/location.ts logs read failures through req.log; the real app installs
  // pino-http. A no-op keeps the DB-error scenarios exercising the same branch.
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use(locationRouter);
  app.use(tripsExpansionRouter);
  app.use(mapProjectionRouter);
  await new Promise<void>((resolve) => {
    // Bind the loopback address explicitly: a host-less listen(0) binds [::] and
    // a foreign IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  _clearProtectedZoneCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. EQUIVALENCE — the extracted reader vs the live route
// ─────────────────────────────────────────────────────────────────────────────

function circleState(over: FakeState = {}): FakeState {
  return {
    profiles: [
      { id: USER, account_status: "active", name: "Viewer", avatar_url: null },
      { id: MEM_A, account_status: "active", name: "Ada", avatar_url: "https://cdn/a.jpg" },
      { id: MEM_B, account_status: "active", name: "Bo", avatar_url: null },
    ],
    circle_memberships: [{ user_id: USER, other_id: MEM_A }],
    location_preferences: [
      { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", sharing_paused: false, discovery_visibility: null },
    ],
    user_privacy_settings: [],
    user_location_state: [
      { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", ...freshFix() },
    ],
    blocks: [],
    profile_privacy_settings: [],
    feature_flags: [],
    ...over,
  };
}

/**
 * Drive BOTH implementations over one fake client and return what each said.
 * The route is untouched production code — that is what makes this evidence
 * rather than a restatement of the extraction.
 */
async function bothPaths(state: FakeState) {
  const client = makeClient(state);
  _setTestClient(client as any, true);
  const route = await get("/me/circle-locations");
  const direct = await readCircleLocations(client as any, USER);
  return { route, direct };
}

/** The equivalence assertion, in one place so every scenario checks the same thing. */
async function assertEquivalent(name: string, state: FakeState) {
  const { route, direct } = await bothPaths(state);
  if (direct.ok) {
    assert.equal(route.status, 200, `${name}: route should succeed when the reader does`);
    assert.equal(route.body.ok, true, `${name}: envelope`);
    assert.deepEqual(
      route.body.locations,
      direct.locations,
      `${name}: extracted reader and live route must return IDENTICAL rows`,
    );
  } else {
    // The reader reports the failure; the route turns it into its db_error
    // envelope — no silent empty list on either path. The wire message is the
    // sanitized one (sendError redacts db_error detail so PostgREST text cannot
    // leak table/column names), which is why the reader returns the underlying
    // message separately: callers log it, they do not serve it.
    assert.equal(route.status, 500, `${name}: a read failure must not answer 200`);
    assert.equal(route.body.error, "db_error", `${name}: error code`);
    assert.equal(
      route.body.message,
      "A database error occurred. Please try again.",
      `${name}: db_error detail must stay sanitized on the wire`,
    );
    assert.ok(direct.message.length > 0, `${name}: reader must carry the loggable detail`);
  }
  return direct;
}

describe("circle-locations extraction is behaviour-preserving", () => {
  it("agrees with the route on a consenting member", async () => {
    const d = await assertEquivalent("consenting member", circleState());
    assert.ok(d.ok && d.locations.length === 1);
  });

  it("agrees that a MISSING prefs row is not consent", async () => {
    const d = await assertEquivalent("no prefs row", circleState({ location_preferences: [] }));
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees on an explicit opt-out (trusted_circle_share = false)", async () => {
    const d = await assertEquivalent(
      "opted out",
      circleState({
        location_preferences: [
          { user_id: MEM_A, trusted_circle_share: false, location_mode: "nearby" },
        ],
      }),
    );
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees on the master switch (allow_location_sharing = false)", async () => {
    const d = await assertEquivalent(
      "master switch off",
      circleState({ user_privacy_settings: [{ user_id: MEM_A, allow_location_sharing: false }] }),
    );
    assert.ok(d.ok && d.locations.length === 0);
  });

  for (const [label, prefs] of [
    ["sharing_paused", { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", sharing_paused: true }],
    ["location_mode off", { user_id: MEM_A, trusted_circle_share: true, location_mode: "off" }],
    ["discovery_visibility no_location", { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby", discovery_visibility: "no_location" }],
  ] as const) {
    it(`agrees that '${label}' emits NOTHING (not a coarsened city fallback)`, async () => {
      const d = await assertEquivalent(label, circleState({ location_preferences: [prefs as any] }));
      assert.ok(d.ok && d.locations.length === 0, `${label} must not leak city/country/updatedAt`);
    });
  }

  it("agrees on a member the caller blocked, and on the reverse direction", async () => {
    for (const blocks of [
      [{ blocker_id: USER, blocked_id: MEM_A }],
      [{ blocker_id: MEM_A, blocked_id: USER }],
    ]) {
      const d = await assertEquivalent("blocked", circleState({ blocks }));
      assert.ok(d.ok && d.locations.length === 0);
    }
  });

  it("agrees when the block list cannot be read (fail-closed, both empty)", async () => {
    const d = await assertEquivalent(
      "block read failure",
      circleState({ blocks: { error: { message: "blocks down" } } }),
    );
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees when the emergency stop is engaged", async () => {
    const d = await assertEquivalent(
      "kill switch",
      circleState({ feature_flags: [{ flag: "disable_location_sharing", enabled: true }] }),
    );
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees that an unreadable kill switch ENGAGES the stop", async () => {
    const d = await assertEquivalent(
      "kill switch unreadable",
      circleState({ feature_flags: { error: { message: "flags down" } } }),
    );
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees on mixed consent across several members", async () => {
    const d = await assertEquivalent(
      "mixed consent",
      circleState({
        circle_memberships: [
          { user_id: USER, other_id: MEM_A },
          { user_id: USER, other_id: MEM_B },
        ],
        location_preferences: [
          { user_id: MEM_A, trusted_circle_share: true, location_mode: "nearby" },
          { user_id: MEM_B, trusted_circle_share: false, location_mode: "nearby" },
        ],
        user_location_state: [
          { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", ...freshFix() },
          { user_id: MEM_B, lat: 13.75, lng: 100.5, city: "Bangkok", country: "TH", ...freshFix() },
        ],
      }),
    );
    assert.ok(d.ok && d.locations.length === 1 && d.locations[0].userId === MEM_A);
  });

  it("agrees on the caller's OWN entry bypassing the consent gates", async () => {
    const d = await assertEquivalent(
      "self entry",
      circleState({
        circle_memberships: [{ user_id: USER, other_id: USER }],
        location_preferences: [],
        user_location_state: [
          { user_id: USER, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", ...freshFix() },
        ],
      }),
    );
    assert.ok(d.ok && d.locations.length === 1 && d.locations[0].userId === USER);
    // Own row or not, the coordinate is still coarsened.
    assert.notEqual(d.ok && d.locations[0].lat, RAW.lat);
  });

  it("agrees that a member with no location row is simply absent", async () => {
    const d = await assertEquivalent("no location row", circleState({ user_location_state: [] }));
    assert.ok(d.ok && d.locations.length === 0);
  });

  it("agrees on the display-name gate (show_real_name)", async () => {
    const withoutOptIn = await assertEquivalent("name withheld", circleState());
    assert.ok(withoutOptIn.ok && withoutOptIn.locations[0].name === null);

    const withOptIn = await assertEquivalent(
      "name shown",
      circleState({ profile_privacy_settings: [{ user_id: MEM_A, show_real_name: true }] }),
    );
    assert.ok(withOptIn.ok && withOptIn.locations[0].name === "Ada");
  });

  // Both surfaces gained the freshness and account-standing gates at once,
  // because they share the reader. These two scenarios are here (rather than
  // only in circleLocationsRead.test.ts) to prove the LEGACY ENDPOINT drops the
  // rows too — the endpoint returning fewer rows than it used to IS the fix.
  it("agrees that a stale position is dropped by BOTH the route and the reader", async () => {
    const old = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const d = await assertEquivalent(
      "stale position",
      circleState({
        user_location_state: [
          { user_id: MEM_A, lat: RAW.lat, lng: RAW.lng, city: "Da Nang", country: "VN", updated_at: old, last_known_at: old },
        ],
      }),
    );
    assert.ok(d.ok && d.locations.length === 0, "a 90-minute-old pin must not be served");
  });

  it("agrees that a suspended member is dropped by BOTH the route and the reader", async () => {
    const d = await assertEquivalent(
      "suspended member",
      circleState({
        profiles: [
          { id: USER, account_status: "active", name: "Viewer", avatar_url: null },
          { id: MEM_A, account_status: "suspended", name: "Ada", avatar_url: "https://cdn/a.jpg" },
        ],
      }),
    );
    assert.ok(d.ok && d.locations.length === 0, "a suspended member must leak no field at all");
  });

  for (const [stage, table] of [
    ["circle", "circle_memberships"],
    ["prefs", "location_preferences"],
    ["privacy_settings", "user_privacy_settings"],
    ["location_state", "user_location_state"],
    // profiles carries account_status now, so its failure is fail-closed
    // (db_error) rather than the old silent degradation to nameless rows.
    ["profiles", "profiles"],
  ] as const) {
    it(`agrees on a ${table} read failure (db_error, not an empty list)`, async () => {
      const d = await assertEquivalent(
        `${table} failure`,
        circleState({ [table]: { error: { message: `${table} down` } } }),
      );
      assert.equal(d.ok, false);
      assert.equal(d.ok === false && d.stage, stage);
    });
  }

  it("neither path ever emits the raw coordinate", async () => {
    const { route, direct } = await bothPaths(circleState());
    const expected = coarsenPosition(MEM_A, RAW.lat, RAW.lng, "neighborhood");
    assert.ok(direct.ok);
    assert.deepEqual(
      { lat: direct.ok ? direct.locations[0].lat : null, lng: direct.ok ? direct.locations[0].lng : null },
      { lat: expected.lat, lng: expected.lng },
    );
    const serialized = JSON.stringify(route.body);
    assert.ok(!serialized.includes("16.054412"), "raw latitude must never cross the wire");
    assert.ok(!serialized.includes("108.202233"), "raw longitude must never cross the wire");
  });

  it("passing an explicit blockedSet reuses it instead of re-reading blocks", async () => {
    // The projection resolves ONE fail-closed block set per request and hands it
    // to every people-bearing source. `null` must keep its fail-closed meaning.
    const client = makeClient(circleState());
    const withNull = await readCircleLocations(client as any, USER, { blockedSet: null });
    assert.deepEqual(withNull, { ok: true, locations: [] });

    const withBlocked = await readCircleLocations(client as any, USER, {
      blockedSet: new Set([MEM_A]),
    });
    assert.ok(withBlocked.ok && withBlocked.locations.length === 0);

    const withEmpty = await readCircleLocations(client as any, USER, { blockedSet: new Set() });
    assert.ok(withEmpty.ok && withEmpty.locations.length === 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pure projectors
// ─────────────────────────────────────────────────────────────────────────────

const CIRCLE_ENTRY = {
  userId: MEM_A,
  name: "Ada",
  avatarUrl: "https://cdn/a.jpg",
  lat: 16.0435,
  lng: 108.2035,
  city: "Da Nang",
  country: "VN",
  updatedAt: "2026-08-31T11:00:00.000Z",
};

const TRIP = {
  id: "t1",
  title: "Da Nang winter",
  visibility: "public",
  destinationCity: "Da Nang",
  destinationCountry: "VN",
  destinationLat: 16.06,
  destinationLng: 108.21,
  startDate: "2026-09-01",
  endDate: "2026-09-10",
  status: "upcoming",
};

describe("projectCircleMember", () => {
  it("is 'approximate' — never place_level, never precise_temporary", () => {
    const obj = projectCircleMember(CIRCLE_ENTRY)!;
    assert.equal(obj.privacyClass, "approximate");
    assert.equal(CIRCLE_PRIVACY_CLASS, "approximate");
  });

  it("is a crew_member at the trip-crew priority tier", () => {
    const obj = projectCircleMember(CIRCLE_ENTRY)!;
    assert.equal(obj.kind, "crew_member");
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.crew_member);
    assert.ok(isServable(obj));
  });

  it("echoes the coordinate it was given and nothing sharper", () => {
    const obj = projectCircleMember(CIRCLE_ENTRY)!;
    assert.deepEqual(obj.geometry, { type: "Point", coordinates: [108.2035, 16.0435] });
  });

  it("invents no freshness and no confidence from updatedAt", () => {
    const obj = projectCircleMember(CIRCLE_ENTRY)!;
    assert.equal(obj.freshness, undefined);
    assert.equal(obj.confidence, undefined);
    // The timestamp still travels as a payload fact.
    assert.equal((obj.payload as any).updatedAt, "2026-08-31T11:00:00.000Z");
  });

  it("falls back to a generic title when the name gate withheld the name", () => {
    const obj = projectCircleMember({ ...CIRCLE_ENTRY, name: null })!;
    assert.equal(obj.title, "Circle member");
  });

  it("produces no object without a coordinate or without an id", () => {
    assert.equal(projectCircleMember({ ...CIRCLE_ENTRY, lat: null }), null);
    assert.equal(projectCircleMember({ ...CIRCLE_ENTRY, lng: null }), null);
    assert.equal(projectCircleMember({ ...CIRCLE_ENTRY, userId: "" }), null);
  });
});

describe("projectTrip", () => {
  it("is place_level and a trip_stop", () => {
    const obj = projectTrip(TRIP)!;
    assert.equal(obj.privacyClass, TRIP_PRIVACY_CLASS);
    assert.equal(obj.privacyClass, "place_level");
    assert.equal(obj.kind, "trip_stop");
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.trip_stop);
  });

  it("drops a private trip — the client's isMapVisibleTrip rule, now server-side", () => {
    assert.equal(projectTrip({ ...TRIP, visibility: "private" }), null);
  });

  it("drops a trip without destination coordinates", () => {
    assert.equal(projectTrip({ ...TRIP, destinationLat: null }), null);
    assert.equal(projectTrip({ ...TRIP, destinationLng: null }), null);
  });

  it("invents no freshness or confidence from the itinerary dates", () => {
    const obj = projectTrip(TRIP)!;
    assert.equal(obj.freshness, undefined);
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.subtitle, "Da Nang · 2026-09-01 → 2026-09-10");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/map/projection serves the new layers
// ─────────────────────────────────────────────────────────────────────────────

const BBOX = "108.0,15.9,108.4,16.2";

function projectionState(over: FakeState = {}): FakeState {
  return {
    ...circleState(),
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    protected_zones: [],
    trip_members: [
      { user_id: USER, trip_id: "t1", role: "owner" },
      { user_id: USER, trip_id: "t-invited", role: "invited" },
    ],
    trips: [
      { id: "t1", owner_id: USER, title: "Da Nang winter", status: "upcoming", visibility: "public",
        destination_city: "Da Nang", destination_country: "VN", destination_lat: 16.06, destination_lng: 108.21,
        start_date: "2026-09-01", end_date: "2026-09-10", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
      { id: "t-invited", owner_id: MEM_B, title: "Not mine", status: "upcoming", visibility: "public",
        destination_city: "Bangkok", destination_country: "TH", destination_lat: 16.05, destination_lng: 108.20,
        start_date: "2026-09-01", end_date: "2026-09-10", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
      { id: "t-private", owner_id: USER, title: "Private", status: "upcoming", visibility: "private",
        destination_city: "Da Nang", destination_country: "VN", destination_lat: 16.05, destination_lng: 108.21,
        start_date: "2026-09-01", end_date: "2026-09-10", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
    ],
    ...over,
  };
}

async function projection(kinds: string, state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=${kinds}`);
}

describe("GET /api/map/projection — circle layer", () => {
  it("serves circle members as crew_member objects at the coarsened position", async () => {
    const r = await projection("crew_member", projectionState());
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.sources, ["circle"]);

    const friend = r.body.objects.find((o: any) => o.id === `friend:${MEM_A}`);
    assert.ok(friend, "the consenting circle member should be on the map");
    assert.equal(friend.privacyClass, "approximate");
    assert.equal(friend.kind, "crew_member");

    const expected = coarsenPosition(MEM_A, RAW.lat, RAW.lng, "neighborhood");
    assert.deepEqual(friend.geometry.coordinates, [expected.lng, expected.lat]);
  });

  it("the raw coordinate never reaches the wire — coarsening is SERVER-side", async () => {
    const r = await projection("crew_member", projectionState());
    const serialized = JSON.stringify(r.body);
    assert.ok(!serialized.includes("16.054412"), "raw latitude leaked into the projection");
    assert.ok(!serialized.includes("108.202233"), "raw longitude leaked into the projection");
  });

  it("honours the same consent gate as the standalone route", async () => {
    const r = await projection(
      "crew_member",
      projectionState({
        location_preferences: [{ user_id: MEM_A, trusted_circle_share: false, location_mode: "nearby" }],
      }),
    );
    assert.deepEqual(r.body.objects, []);
    // The layer was still READ successfully — an empty circle is not a failure.
    assert.deepEqual(r.body.sources, ["circle"]);
  });

  it("honours the disable_location_sharing emergency stop", async () => {
    const r = await projection(
      "crew_member",
      projectionState({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: "disable_location_sharing", enabled: true },
        ],
      }),
    );
    assert.deepEqual(r.body.objects, []);
  });

  it("drops a blocked member using the request's single block set", async () => {
    const r = await projection(
      "crew_member",
      projectionState({ blocks: [{ blocker_id: MEM_A, blocked_id: USER }] }),
    );
    assert.deepEqual(r.body.objects, []);
  });

  it("does not claim the circle source when the read failed", async () => {
    const r = await projection(
      "crew_member",
      projectionState({ circle_memberships: { error: { message: "circle down" } } }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(
      r.body.sources,
      [],
      "a failed read must not be reported as an empty-but-successful layer",
    );
  });
});

describe("GET /api/map/projection — trips layer", () => {
  it("serves the viewer's own visible trips and excludes invited-only trips", async () => {
    const r = await projection("trip_stop", projectionState());
    assert.deepEqual(r.body.sources, ["trips"]);
    const ids = r.body.objects.map((o: any) => o.id);
    assert.deepEqual(ids, ["trip:t1"]);
  });

  it("never serves a trip whose visibility is private", async () => {
    const r = await projection(
      "trip_stop",
      projectionState({ trip_members: [{ user_id: USER, trip_id: "t-private", role: "owner" }] }),
    );
    assert.deepEqual(r.body.objects, []);
  });

  it("matches GET /api/trips/me on WHICH trips the viewer may see", async () => {
    // The scope predicate is restated in the projection; this pins the two
    // together over the same data instead of trusting they stay in step.
    const state = projectionState();
    _setTestClient(makeClient(state) as any, true);
    const canonical = await get("/trips/me");
    const projected = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=trip_stop`);

    const canonicalVisible = canonical.body.trips
      .filter((t: any) => t.visibility !== "private" && t.destinationLat != null && t.destinationLng != null)
      .map((t: any) => `trip:${t.id}`)
      .sort();
    const projectedIds = projected.body.objects.map((o: any) => o.id).sort();
    assert.deepEqual(projectedIds, canonicalVisible);
  });

  it("does not claim the trips source when the read failed", async () => {
    const r = await projection(
      "trip_stop",
      projectionState({ trip_members: { error: { message: "members down" } } }),
    );
    assert.deepEqual(r.body.sources, []);
  });
});

describe("GET /api/map/projection — kinds gating", () => {
  it("kinds=hidden_gem asks for neither of the new layers", async () => {
    const r = await projection("hidden_gem", projectionState());
    assert.ok(!r.body.sources.includes("circle"));
    assert.ok(!r.body.sources.includes("trips"));
  });

  it("both new layers arrive when both kinds are requested", async () => {
    const r = await projection("crew_member,trip_stop", projectionState());
    assert.deepEqual([...r.body.sources].sort(), ["circle", "trips"]);
    const ids = r.body.objects.map((o: any) => o.id).sort();
    assert.deepEqual(ids, [`friend:${MEM_A}`, "trip:t1"]);
  });
});
