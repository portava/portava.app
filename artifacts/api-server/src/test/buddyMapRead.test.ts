/**
 * buddyMapRead — the buddy layer's move into the Map Intelligence Gateway
 * (Map spec §19), and the proof that the move changed nothing.
 *
 * WHAT THESE TESTS ARE FOR
 * ========================
 * 1. EQUIVALENCE. `readBuddyMapPins` is an EXTRACTION of the privacy-complete
 *    half of POST /api/rent-a-buddy/search — the feature gate, the
 *    status/admin_status visibility predicate, the BUDDY_PUBLIC_COLUMNS
 *    allow-list and the stripBuddyPrivateFields → mapBuddyPublicProfile field
 *    strip. A refactor of a privacy predicate is only safe if it is provably
 *    behaviour-preserving, so these tests do not merely assert what the
 *    extracted function returns: they drive the REAL HTTP search route and the
 *    extracted reader over the SAME fake client, scenario by scenario, and
 *    assert the two agree about who is visible and which fields are exposed.
 *
 * 2. THE NARROWING IS ONE-WAY. The map read is deliberately narrower than the
 *    marketplace: it drops blocked people, buddies with no meetup base, and
 *    buddies outside the viewport. Every scenario therefore asserts the
 *    invariant that matters — PINS ⊆ SEARCH RESULTS — so the reader can never
 *    surface a buddy the marketplace itself would not, whatever else changes.
 *    Each narrowing is named explicitly; an unexpected one fails.
 *
 * 3. HONEST RUNGS. A buddy pin is `approximate` (an area-rounded meetup base),
 *    never `place_level`, and carries no invented freshness or confidence.
 *
 * Run:
 *   node --import tsx/esm --test src/test/buddyMapRead.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import {
  BUDDY_PUBLIC_COLUMNS,
  mapBuddyPublicProfile,
  readBuddyMapPins,
  stripBuddyPrivateFields,
} from "../lib/buddyMapRead.js";
import { BUDDY_PRIVACY_CLASS, projectBuddy } from "../lib/mapProjection.js";
import { KIND_DEFAULT_PRIORITY, isServable } from "../lib/mapObjects.js";

// ── ids and geography ─────────────────────────────────────────────────────────

const TOKEN = "buddy-map-test-token";
const USER = "viewer-user-id";

const CENTER = { lat: 16.05, lng: 108.2 };
const RADIUS_KM = 27;
/** Matches CENTER/RADIUS_KM closely enough for the gateway route's own parse. */
const BBOX = "108.0,15.9,108.4,16.2";

/**
 * Values that must NEVER cross the wire on either path.
 *
 * They are put on the fixture row on purpose: the fake client returns whole
 * rows, as if BUDDY_PUBLIC_COLUMNS had not filtered the select, so the wire
 * assertions below are testing the SERVING code rather than the fake's own
 * column handling.
 *
 * Stated honestly, because a test that claims more than it proves is worse than
 * no test: there are THREE independent barriers here — BUDDY_PUBLIC_COLUMNS on
 * the select, stripBuddyPrivateFields, and mapBuddyPublicProfile's allow-list —
 * and the mapper alone is sufficient, so removing the strip does not fail these
 * wire assertions. The strip is therefore checked directly as well (see "the
 * private-field strip removes exactly the private fields"), and it is kept
 * because it is the barrier that protects callers which do NOT go through the
 * mapper (routes/rentABuddy.ts line ~615 spreads it before mapping).
 */
const PRIVATE_SENTINELS = {
  legal_name: "LEGAL-NAME-SENTINEL",
  phone_number: "PHONE-SENTINEL",
  exact_address: "EXACT-ADDRESS-SENTINEL",
  home_address: "HOME-ADDRESS-SENTINEL",
  id_verification_ref: "IDREF-SENTINEL",
};

function buddyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b1",
    user_id: "buddy-user-1",
    display_name: "Ada",
    tagline: "Street food guide",
    bio: "Ten years of eating.",
    city: "Da Nang",
    country: "VN",
    status: "active",
    admin_status: "active",
    risk_hold: false,
    verified: true,
    verified_at: "2026-01-02T00:00:00.000Z",
    verification_status: "approved",
    languages: ["en", "vi"],
    categories: ["food"],
    hourly_rate_usd: "20",
    review_count: 12,
    average_rating: "4.8",
    completed_count: 30,
    response_time_h: "2",
    buddy_level: "seasoned",
    meetup_base_lat: 16.06,
    meetup_base_lng: 108.21,
    featured: true,
    available_now: true,
    cancel_count: 0,
    no_show_count: 0,
    favorites_count: 4,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    profiles: { verification_level: "id_verified" },
    ...PRIVATE_SENTINELS,
    ...over,
  };
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
 * two paths under test actually use are implemented; anything else would be a
 * silent no-op, so they are omitted on purpose.
 *
 * `count` is captured BEFORE limit/range, matching `count: "exact"`.
 */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  let count = rows.length;
  const err = spec.error ?? null;
  const sync = () => { count = rows.length; };
  const result = () =>
    err ? { data: null, count: null, error: err } : { data: rows, count, error: null };

  const q: any = {
    select() { return q; },
    order() { return q; },
    limit(n: number) { sync(); rows = rows.slice(0, n); return q; },
    range(from: number, to: number) { sync(); rows = rows.slice(from, to + 1); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); sync(); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); sync(); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); sync(); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); sync(); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); sync(); return q; },
    ilike(col: string, pattern: string) {
      const needle = String(pattern).replace(/%/g, "").toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
      sync();
      return q;
    },
    contains(col: string, vals: any[]) {
      rows = rows.filter((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
      sync();
      return q;
    },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      sync();
      return q;
    },
    or(expr: string) {
      const parts = expr
        .split(",")
        .map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/))
        .filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      sync();
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

function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
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
    if (payload) r.write(payload);
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
  app.use("/api", rentABuddyRouter);
  app.use(mapProjectionRouter);
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. EQUIVALENCE — the extracted reader vs the live marketplace route
// ─────────────────────────────────────────────────────────────────────────────

function searchState(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
    rent_buddy_profiles: [buddyRow()],
    blocks: [],
    ...over,
  };
}

/**
 * Drive BOTH implementations over one fake client and return what each said.
 *
 * The search request deliberately carries NO lat/lng: with an origin the route
 * enters its marketplace proximity path, which is precisely the ranking (and,
 * for un-pinned buddies, the outbound Nominatim geocode) that was left behind.
 * Comparing without it compares the halves that are supposed to be shared.
 */
async function bothPaths(state: FakeState, blockedSet: Set<string> | null = new Set()) {
  const client = makeClient(state);
  _setTestClient(client as any, true);
  const route = await request("POST", "/api/rent-a-buddy/search", { perPage: 100 });
  const direct = await readBuddyMapPins(client as any, USER, {
    lat: CENTER.lat,
    lng: CENTER.lng,
    radiusKm: RADIUS_KM,
    blockedSet,
  });
  return { route, direct };
}

/** What a value looks like after it has been through JSON, i.e. on the wire. */
function onTheWire<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The equivalence assertion, in one place so every scenario checks the same
 * thing.
 *
 * `narrowedIds` names the buddies the map read is EXPECTED to drop that the
 * marketplace still lists. Anything dropped without being named fails, and a
 * pin the marketplace would not have served fails unconditionally — that is the
 * direction a privacy regression would travel.
 */
async function assertEquivalent(
  name: string,
  state: FakeState,
  opts: { narrowedIds?: string[]; blockedSet?: Set<string> | null } = {},
) {
  // `??` would swallow an explicit null, which is the fail-closed case itself.
  const { route, direct } = await bothPaths(
    state,
    opts.blockedSet !== undefined ? opts.blockedSet : new Set(),
  );
  const routeBuddies: any[] = route.status === 200 ? (route.body.buddies ?? []) : [];
  const routeById = new Map(routeBuddies.map((b) => [String(b.id), b]));
  const pins = direct.ok ? direct.pins : [];

  for (const pin of pins) {
    const row = routeById.get(String(pin.id));
    assert.ok(
      row,
      `${name}: the map read served buddy ${pin.id}, which the marketplace search does NOT — ` +
        `the extraction may only ever narrow`,
    );
    const { distanceKm, ...exposed } = row as any;
    // Compared as the wire sees them: JSON drops undefined-valued keys, so the
    // route's already-serialized row is matched against the reader's row put
    // through the same transform. Field VALUES and field PRESENCE are both
    // compared; only the JSON representation is normalized.
    assert.deepEqual(
      onTheWire(pin),
      exposed,
      `${name}: buddy ${pin.id} must expose IDENTICAL fields on both paths`,
    );
  }

  const dropped = [...routeById.keys()].filter((id) => !pins.some((p) => String(p.id) === id));
  assert.deepEqual(
    dropped.sort(),
    [...(opts.narrowedIds ?? [])].sort(),
    `${name}: the map read dropped buddies the marketplace lists, and did not say why`,
  );

  return { route, direct, pins };
}

describe("buddy search extraction is behaviour-preserving", () => {
  it("agrees on an active, admin-active buddy with a meetup base", async () => {
    const { direct, route } = await assertEquivalent("active buddy", searchState());
    assert.ok(direct.ok && direct.pins.length === 1);
    assert.equal(route.body.buddies.length, 1);
  });

  for (const [label, over] of [
    ["status = pending", { status: "pending" }],
    ["status = suspended", { status: "suspended" }],
    ["admin_status = disabled", { admin_status: "disabled" }],
    ["admin_status = under_review", { admin_status: "under_review" }],
  ] as const) {
    it(`agrees that '${label}' is invisible on BOTH paths`, async () => {
      const { direct, route } = await assertEquivalent(
        label,
        searchState({ rent_buddy_profiles: [buddyRow(over as any)] }),
      );
      assert.ok(direct.ok && direct.pins.length === 0);
      assert.equal(route.body.buddies.length, 0);
    });
  }

  it("agrees on a mixed set: only the doubly-active buddy is visible", async () => {
    const { direct } = await assertEquivalent(
      "mixed",
      searchState({
        rent_buddy_profiles: [
          buddyRow({ id: "ok", user_id: "u-ok" }),
          buddyRow({ id: "pending", user_id: "u-p", status: "pending" }),
          buddyRow({ id: "disabled", user_id: "u-d", admin_status: "disabled" }),
        ],
      }),
    );
    assert.ok(direct.ok);
    assert.deepEqual(direct.pins.map((p) => p.id), ["ok"]);
  });

  for (const [label, flags] of [
    ["the flag is off", [{ flag: "rent_buddy_enabled", enabled: false }]],
    ["the flag row is absent", []],
  ] as const) {
    it(`agrees that no buddy is exposed when ${label}`, async () => {
      const { route, direct } = await bothPaths(searchState({ feature_flags: flags as any }));
      assert.equal(route.status, 403, "the marketplace answers feature_disabled");
      assert.equal(route.body.error, "feature_disabled");
      assert.ok(direct.ok && direct.pins.length === 0, "the map read serves nobody");
    });
  }

  it("agrees that an UNREADABLE flag table exposes nobody (fail-closed)", async () => {
    const { route, direct } = await bothPaths(
      searchState({ feature_flags: { error: { message: "flags down" } } }),
    );
    assert.equal(route.status, 403);
    assert.ok(direct.ok && direct.pins.length === 0);
  });

  it("neither path emits a private buddy field", async () => {
    const { route, direct } = await bothPaths(searchState());
    const wire = JSON.stringify(route.body) + JSON.stringify(direct);
    for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
      assert.ok(!wire.includes(sentinel), `${sentinel} must never cross the wire`);
    }
    assert.ok(direct.ok && direct.pins.length === 1);
    for (const key of ["legalName", "phoneNumber", "exactAddress", "homeAddress", "riskHold", "adminStatus"]) {
      assert.ok(!(key in (direct.ok ? direct.pins[0] : {})), `${key} must not be on a pin`);
    }
  });

  it("the private-field strip removes exactly the private fields", () => {
    // Checked directly, because the DTO mapper's allow-list would mask a broken
    // strip on the serving path. This is the one assertion that fails if the
    // strip stops stripping.
    const stripped = stripBuddyPrivateFields(buddyRow(), false);
    for (const key of Object.keys(PRIVATE_SENTINELS)) {
      assert.ok(!(key in stripped), `${key} must be stripped`);
    }
    assert.equal(stripped.display_name, "Ada", "a public field must survive");
    // `confirmed: true` is the counterparty path; no map code ever passes it.
    assert.equal(stripBuddyPrivateFields(buddyRow(), true).legal_name, PRIVATE_SENTINELS.legal_name);
    assert.equal(stripBuddyPrivateFields(null, false), null);
  });

  it("a read failure is reported, not served as an empty marketplace", async () => {
    const { route, direct } = await bothPaths(
      searchState({ rent_buddy_profiles: { error: { message: "profiles down" } } }),
    );
    assert.equal(route.status, 500, "the marketplace answers db_error");
    assert.equal(route.body.error, "db_error");
    assert.equal(direct.ok, false, "the reader must not report an empty list");
    assert.equal(direct.ok === false && direct.stage, "profiles");
    assert.ok(direct.ok === false && direct.message.length > 0, "the loggable detail survives");
  });

  it("the public column list and the private strip have ONE definition", async () => {
    // The route imports both from lib/buddyMapRead; if a second copy were ever
    // reintroduced this composition would stop matching the served row.
    const row = buddyRow();
    const expected = mapBuddyPublicProfile(stripBuddyPrivateFields(row, false));
    const { route } = await bothPaths(searchState());
    const { distanceKm, ...served } = route.body.buddies[0];
    assert.deepEqual(served, onTheWire(expected));
    assert.ok(BUDDY_PUBLIC_COLUMNS.includes("meetup_base_lat"), "the map needs the meetup base");
    assert.ok(!BUDDY_PUBLIC_COLUMNS.includes("admin_status"), "admin_status is not public");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE NARROWING — one-way, and named
// ─────────────────────────────────────────────────────────────────────────────

describe("the map read narrows, and only narrows", () => {
  it("drops a buddy the viewer blocked (the marketplace still lists them)", async () => {
    const { direct } = await assertEquivalent(
      "blocked buddy",
      searchState({
        rent_buddy_profiles: [
          buddyRow({ id: "ok", user_id: "u-ok" }),
          buddyRow({ id: "blocked", user_id: "u-blocked" }),
        ],
      }),
      { narrowedIds: ["blocked"], blockedSet: new Set(["u-blocked"]) },
    );
    assert.ok(direct.ok);
    assert.deepEqual(direct.pins.map((p) => p.id), ["ok"]);
  });

  it("serves NOBODY when the block set is null (fail-closed)", async () => {
    const { direct } = await assertEquivalent("null block set", searchState(), {
      narrowedIds: ["b1"],
      blockedSet: null,
    });
    assert.ok(direct.ok && direct.pins.length === 0);
  });

  it("drops a buddy with no meetup base rather than inventing a city pin", async () => {
    const { direct } = await assertEquivalent(
      "no meetup base",
      searchState({
        rent_buddy_profiles: [
          buddyRow({ id: "pinned", user_id: "u-pinned" }),
          buddyRow({ id: "unpinned", user_id: "u-unpinned", meetup_base_lat: null, meetup_base_lng: null }),
        ],
      }),
      { narrowedIds: ["unpinned"] },
    );
    assert.ok(direct.ok);
    assert.deepEqual(direct.pins.map((p) => p.id), ["pinned"]);
  });

  it("drops a buddy outside the viewport radius", async () => {
    const { direct } = await assertEquivalent(
      "out of radius",
      searchState({
        rent_buddy_profiles: [
          buddyRow({ id: "near", user_id: "u-near" }),
          // Bangkok — well outside a Da Nang viewport.
          buddyRow({ id: "far", user_id: "u-far", meetup_base_lat: 13.75, meetup_base_lng: 100.5 }),
        ],
      }),
      { narrowedIds: ["far"] },
    );
    assert.ok(direct.ok);
    assert.deepEqual(direct.pins.map((p) => p.id), ["near"]);
  });

  it("caps how many pins one viewport can produce, without widening anything", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      buddyRow({ id: `b${i}`, user_id: `u${i}`, review_count: 100 - i }),
    );
    const client = makeClient(searchState({ rent_buddy_profiles: rows }));
    const capped = await readBuddyMapPins(client as any, USER, {
      lat: CENTER.lat,
      lng: CENTER.lng,
      radiusKm: RADIUS_KM,
      blockedSet: new Set(),
      maxPins: 2,
    });
    assert.ok(capped.ok && capped.pins.length === 2);
  });

  it("never geocodes: the reader makes no outbound call for an un-pinned buddy", async () => {
    // A buddy with a city but no meetup base is exactly the row the marketplace
    // would send to Nominatim. The reader must simply drop it. `fetch` is
    // replaced so an outbound call would fail the test loudly rather than
    // silently hitting the network.
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      throw new Error("the map read must not geocode");
    }) as typeof fetch;
    try {
      const client = makeClient(
        searchState({
          rent_buddy_profiles: [
            buddyRow({ id: "unpinned", user_id: "u-unpinned", city: "Nowhere City", meetup_base_lat: null, meetup_base_lng: null }),
          ],
        }),
      );
      const read = await readBuddyMapPins(client as any, USER, {
        lat: CENTER.lat,
        lng: CENTER.lng,
        radiusKm: RADIUS_KM,
        blockedSet: new Set(),
      });
      assert.ok(read.ok && read.pins.length === 0);
      assert.equal(called, 0, "no outbound request may be made");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE PROJECTOR — honest rungs, no invented intelligence
// ─────────────────────────────────────────────────────────────────────────────

const PIN = mapBuddyPublicProfile(stripBuddyPrivateFields(buddyRow(), false))!;

describe("projectBuddy", () => {
  it("is `approximate` — a meetup base is an area, not a place", () => {
    assert.equal(projectBuddy(PIN)!.privacyClass, "approximate");
    assert.equal(BUDDY_PRIVACY_CLASS, "approximate");
    // The client projector stamps the same rung; the two transports must not
    // label the same buddy differently.
    assert.notEqual(projectBuddy(PIN)!.privacyClass, "place_level");
    assert.notEqual(projectBuddy(PIN)!.privacyClass, "precise_temporary");
  });

  it("invents neither freshness nor confidence (spec §37)", () => {
    const obj = projectBuddy(PIN)!;
    assert.equal(obj.freshness, undefined);
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.activity, undefined);
    assert.equal(obj.observedAt, undefined);
  });

  it("uses the meetup base verbatim and never sharpens it", () => {
    assert.deepEqual(projectBuddy(PIN)!.geometry, {
      type: "Point",
      coordinates: [108.21, 16.06],
    });
  });

  it("has no pin without a meetup base", () => {
    assert.equal(projectBuddy({ ...PIN, meetupBaseLat: null }), null);
    assert.equal(projectBuddy({ ...PIN, meetupBaseLng: null }), null);
    assert.equal(projectBuddy({ ...PIN, id: "" } as any), null);
  });

  it("matches the contract the client projector already produced", () => {
    const obj = projectBuddy(PIN)!;
    assert.equal(obj.id, "buddy:b1");
    assert.equal(obj.kind, "buddy_zone");
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.buddy_zone);
    assert.equal(obj.interaction!.detailRoute, "/(rent-a-buddy)/buddy/b1");
    assert.deepEqual(obj.interaction!.actions, ["view", "book", "message", "report"]);
    assert.equal(obj.interaction!.contributable, undefined);
    assert.ok(isServable(obj));
  });

  it("falls back to a generic title rather than naming nobody", () => {
    assert.equal(projectBuddy({ ...PIN, displayName: null })!.title, "Buddy");
    assert.equal(projectBuddy({ ...PIN, city: null, tagline: null })!.subtitle, undefined);
  });

  it("carries no field the marketplace listing does not already expose", () => {
    const obj = projectBuddy(PIN)!;
    assert.deepEqual(obj.payload, PIN);
    const wire = JSON.stringify(obj);
    for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
      assert.ok(!wire.includes(sentinel));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE GATEWAY serves the layer
// ─────────────────────────────────────────────────────────────────────────────

function gatewayState(over: FakeState = {}): FakeState {
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
    ],
    rent_buddy_profiles: [buddyRow()],
    blocks: [],
    protected_zones: [],
    ...over,
  };
}

async function projection(state: FakeState, query: string) {
  _clearProtectedZoneCache();
  _setTestClient(makeClient(state) as any, true);
  return request("GET", `/map/projection?bbox=${BBOX}&zoom=16&${query}`);
}

describe("GET /api/map/projection serves the buddy layer (§19)", () => {
  it("returns the buddy as a buddy_zone and names the source", async () => {
    const res = await projection(gatewayState(), "kinds=buddy_zone");
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.sources.includes("buddies"), "the layer arrived through the gateway");
    const objs = res.body.objects.filter((o: any) => o.kind === "buddy_zone");
    assert.equal(objs.length, 1);
    assert.equal(objs[0].id, "buddy:b1");
    assert.equal(objs[0].privacyClass, "approximate");
    assert.equal(objs[0].freshness, undefined);
    assert.equal(objs[0].confidence, undefined);
  });

  it("is gated by `kinds` like every other layer", async () => {
    const res = await projection(gatewayState(), "kinds=event");
    assert.equal(res.status, 200);
    assert.ok(!res.body.sources.includes("buddies"), "an unrequested layer is not read");
    assert.equal(res.body.objects.filter((o: any) => o.kind === "buddy_zone").length, 0);
  });

  it("does not name the source when the read failed", async () => {
    const res = await projection(
      gatewayState({ rent_buddy_profiles: { error: { message: "down" } } }),
      "kinds=buddy_zone",
    );
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.sources.includes("buddies"),
      "'we could not tell' must not be reported as 'no buddies here'",
    );
    assert.equal(res.body.objects.length, 0);
  });

  it("serves nobody when the shared block set cannot be read (fail-closed)", async () => {
    const res = await projection(
      gatewayState({ blocks: { error: { message: "blocks down" } } }),
      "kinds=buddy_zone",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.objects, []);
    assert.deepEqual(res.body.sources, []);
  });

  it("never puts a private buddy field on the wire", async () => {
    const res = await projection(gatewayState(), "kinds=buddy_zone");
    const wire = JSON.stringify(res.body);
    for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
      assert.ok(!wire.includes(sentinel), `${sentinel} must never cross the wire`);
    }
  });
});
