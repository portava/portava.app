/**
 * THE CONSUMER OF THE §19.4 TRIP MAP PROJECTION — end to end.
 *
 *   Trip Kernel event → trip_outbox → trip_map_projection_drain (2520)
 *     → trip_map_projections (+ the 2610 Map anchor)
 *     → lib/mapProjectionTripRead → routes/mapProjection.ts
 *     → GET /api/map/projection → mobile Map
 *
 * Migration 2520 and lib/mapTripProjectionWorker.ts shipped a correct
 * projection worker with NO READER. These tests exist to prove the reader
 * closes that chain and, more importantly, that it closes it SAFELY: the
 * capability gate, the fail-closed read, the version contract and the privacy
 * scope are each driven through the REAL HTTP route over a fake database, not
 * asserted about in isolation.
 *
 * WHAT EACH SECTION PROVES (every one is red-proofed — see the report):
 *   1. ordering        the highest aggregate_version wins, in any delivery order
 *   2. replay          a duplicate row changes nothing
 *   3. staleness       a lower version is never applied backwards
 *   4. cancellation    a cancel/removal propagates to the wire
 *   5. privacy         the projection path never widens the canonical path
 *   6. authorization   a projection row outside the viewer's membership is
 *                      never served
 *   7. fail-closed     a projection read ERROR is not an empty projection
 *   8. capability off  the canonical path runs and its output is identical
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/mapProjectionTripConsumer.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { projectTrip } from "../lib/mapProjection.js";
import { toAuthorizedTripView } from "../lib/privacy/tripSerializers.js";
import { resetSchemaCapabilityMemo } from "../lib/capability/schemaCapability.js";
import {
  MAP_TRIP_CONTRACT_VERSION,
  MAP_TRIP_PROJECTION_CAPABILITY,
  MAP_TRIP_PROJECTION_COLUMNS,
  MAP_TRIP_PROJECTION_READ_FLAG,
  foldTripProjectionRows,
  isProjectionRowMapEligible,
  projectionRowToTripView,
  type TripMapProjectionRow,
} from "../lib/mapProjectionTripContract.js";
import {
  loadViewerTripsCanonical,
  readTripStopLayer,
} from "../lib/mapProjectionTripRead.js";

const TOKEN = "trip-projection-token";
const USER = "viewer-user-id";
const OTHER = "other-user-id";
const BBOX = "108.0,15.9,108.4,16.2";

/** A distinctive anchor so a leak or a substitution is greppable. */
const ANCHOR = { lat: 16.061234, lng: 108.213456 };

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase client that can model an ABSENT TABLE and an ABSENT COLUMN
// ─────────────────────────────────────────────────────────────────────────────
//
// The capability probe's entire job is to tell "the column is not there" from
// "the read failed" from "it worked", so a fake that cannot produce PGRST204 /
// PGRST205 would make every capability test vacuous.

interface TableSpec {
  rows?: any[];
  /** Absent from the schema entirely → PGRST205 on any read. */
  absent?: boolean;
  /** Columns this database does NOT have → PGRST204 when one is selected. */
  missingColumns?: string[];
  /** Any other error (a transport/RLS/whatever failure), on EVERY read. */
  error?: { message: string; code?: string };
  /**
   * An error on the LIST read only — `.maybeSingle()` still succeeds. This is
   * the state the capability contract cannot cover and the reader must handle
   * on its own: the probe passed (the schema is there) and then the real query
   * failed. Without it, a fake that errors on everything would make the probe
   * refuse first and the read-failure tests would prove nothing.
   */
  listError?: { message: string; code?: string };
}

type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

function buildQuery(table: string, spec: TableSpec, seen: string[]) {
  let rows = [...(spec.rows ?? [])];
  let selected: string[] = [];

  const failure = (): { data: null; error: any } | null => {
    if (spec.absent) {
      return {
        data: null,
        error: {
          code: "PGRST205",
          message: `Could not find the table 'public.${table}' in the schema cache`,
        },
      };
    }
    const miss = (spec.missingColumns ?? []).find((c) => selected.includes(c));
    if (miss) {
      return {
        data: null,
        error: {
          code: "PGRST204",
          message: `Could not find the '${miss}' column of '${table}' in the schema cache`,
        },
      };
    }
    if (spec.error) return { data: null, error: spec.error };
    return null;
  };

  const q: any = {
    select(list?: string) {
      selected = String(list ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      seen.push(`${table}:${selected.join("|")}`);
      return q;
    },
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
    or() { return q; },
    maybeSingle() {
      const f = failure();
      return Promise.resolve(f ?? { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      const f = failure() ?? (spec.listError ? { data: null, error: spec.listError } : null);
      return Promise.resolve(f ?? { data: rows, error: null }).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  const seen: string[] = [];
  const client: any = {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(table, specOf(state, table), seen),
    _seen: seen,
  };
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — one canonical trip and its projection, kept in lockstep
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical `trips` row the legacy path reads. */
function tripRow(over: Record<string, any> = {}) {
  return {
    id: "t1",
    owner_id: USER,
    title: "Da Nang winter",
    status: "upcoming",
    visibility: "public",
    destination_city: "Da Nang",
    destination_country: "VN",
    destination_lat: ANCHOR.lat,
    destination_lng: ANCHOR.lng,
    start_date: "2026-09-01",
    end_date: "2026-09-10",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * The `trip_map_projections` row 2520's drain + 2610's trigger would write for
 * that trip. The body is 2520's coordinate-free envelope verbatim; the anchor
 * and map_contract_version are 2610's columns.
 */
function projectionRow(over: Record<string, any> = {}, body: Record<string, any> = {}) {
  return {
    trip_id: "t1",
    source_trip_version: 4,
    projection_schema_version: 1,
    map_contract_version: MAP_TRIP_CONTRACT_VERSION,
    generated_at: "2026-09-06T00:00:00.000Z",
    destination_lat: ANCHOR.lat,
    destination_lng: ANCHOR.lng,
    body: {
      trip_id: "t1",
      stage: "upcoming",
      visibility: "public",
      title: "Da Nang winter",
      destination_city: "Da Nang",
      destination_country: "VN",
      start_date: "2026-09-01",
      end_date: "2026-09-10",
      has_destination_coordinates: true,
      plans: { active: 2, confirmed: 1, done: 0, cancelled: 0, total: 3 },
      crew: { accepted: 2, invited: 1 },
      ...body,
    },
    ...over,
  };
}

function baseState(over: FakeState = {}): FakeState {
  return {
    profiles: [{ id: USER, account_status: "active", name: "Viewer", avatar_url: null }],
    blocks: [],
    protected_zones: [],
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: MAP_TRIP_PROJECTION_READ_FLAG, enabled: false },
    ],
    trip_members: [
      { user_id: USER, trip_id: "t1", role: "owner" },
      { user_id: USER, trip_id: "t-invited", role: "invited" },
    ],
    trips: [tripRow()],
    trip_map_projections: [projectionRow()],
    ...over,
  };
}

/** The same state with the capability READY: flag on, table+columns present. */
function readyState(over: FakeState = {}): FakeState {
  return baseState({
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: MAP_TRIP_PROJECTION_READ_FLAG, enabled: true },
    ],
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test server — the REAL route
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any; headers: Record<string, any> }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers as any });
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
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  _clearProtectedZoneCache();
  resetSchemaCapabilityMemo();
  _resetRateLimit();
});

/** Drive the real endpoint for the trip layer over one fake database. */
async function tripLayer(state: FakeState) {
  const client = makeClient(state);
  _setTestClient(client as any, true);
  const r = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=trip_stop`);
  return { ...r, client };
}

// ═════════════════════════════════════════════════════════════════════════════
// 0. THE CHAIN IS CLOSED — a real API reader consumes the projection
// ═════════════════════════════════════════════════════════════════════════════

describe("the chain: trip_map_projections reaches GET /api/map/projection", () => {
  it("serves a pin built from the PROJECTION, not from canonical trips", async () => {
    // Prove the canonical table cannot be the source: it is ABSENT here, so a
    // pin can only have come from trip_map_projections.
    const r = await tripLayer(readyState({ trips: { absent: true } }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sources, ["trips"]);
    assert.equal(r.body.trips.path, "projection");
    assert.equal(r.body.trips.refusal, null);
    assert.equal(r.body.trips.served, 1);
    assert.equal(r.body.trips.maxSourceTripVersion, 4);

    const obj = r.body.objects.find((o: any) => o.id === "trip:t1");
    assert.ok(obj, "the projected trip must reach the wire");
    assert.equal(obj.kind, "trip_stop");
    assert.deepEqual(obj.geometry.coordinates, [ANCHOR.lng, ANCHOR.lat]);
  });

  it("the branch that ran is observable in the body AND in a header", async () => {
    const on = await tripLayer(readyState());
    assert.equal(on.body.trips.path, "projection");
    assert.equal(on.headers["x-map-trip-source"], "projection");

    const off = await tripLayer(baseState());
    assert.equal(off.body.trips.path, "canonical");
    assert.equal(off.headers["x-map-trip-source"], "canonical");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. ORDERING BY aggregate_version
// ═════════════════════════════════════════════════════════════════════════════

describe("ordering: the highest source_trip_version wins, in any delivery order", () => {
  const low = projectionRow(
    { source_trip_version: 4 },
    { title: "OLD TITLE", stage: "planning" },
  );
  const high = projectionRow(
    { source_trip_version: 9 },
    { title: "NEW TITLE", stage: "active" },
  );

  it("folds to the highest version regardless of the order rows arrive in", () => {
    for (const rows of [[low, high], [high, low]] as TripMapProjectionRow[][]) {
      const fold = foldTripProjectionRows(rows);
      assert.equal(fold.rows.size, 1);
      assert.equal(fold.maxSourceTripVersion, 9);
      assert.equal((fold.rows.get("t1")!.body as any).title, "NEW TITLE");
    }
  });

  it("the ROUTE serves the highest-version state whichever order the rows come back in", async () => {
    for (const rows of [[low, high], [high, low]]) {
      _resetRateLimit();
      resetSchemaCapabilityMemo();
      const r = await tripLayer(readyState({ trip_map_projections: rows }));
      const obj = r.body.objects.find((o: any) => o.id === "trip:t1");
      assert.equal(obj.title, "NEW TITLE", "a lower-version row must never win");
      assert.equal(obj.payload.status, "active");
      assert.equal(r.body.trips.maxSourceTripVersion, 9);
    }
  });

  it("a version that is not a non-negative integer is refused, not coerced", () => {
    const fold = foldTripProjectionRows([
      projectionRow({ source_trip_version: null }),
      projectionRow({ trip_id: "t2", source_trip_version: "not-a-number" }),
      projectionRow({ trip_id: "t3", source_trip_version: -1 }),
    ] as TripMapProjectionRow[]);
    assert.equal(fold.rows.size, 0);
    assert.equal(fold.counts.invalid, 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. DUPLICATE REPLAY IS A NO-OP
// ═════════════════════════════════════════════════════════════════════════════

describe("replay: a duplicate row at the same version changes nothing", () => {
  it("the fold keeps the first row and counts the duplicate", () => {
    const first = projectionRow({ source_trip_version: 7 }, { title: "FIRST" });
    const replay = projectionRow({ source_trip_version: 7 }, { title: "SECOND" });
    const fold = foldTripProjectionRows([first, replay] as TripMapProjectionRow[]);
    assert.equal(fold.rows.size, 1);
    assert.equal(fold.counts.duplicatesIgnored, 1);
    assert.equal(
      (fold.rows.get("t1")!.body as any).title,
      "FIRST",
      "a replay at the same version must not change what is served",
    );
  });

  it("the ROUTE serves exactly one object and reports the replay", async () => {
    const row = projectionRow({ source_trip_version: 7 });
    const r = await tripLayer(
      readyState({ trip_map_projections: [row, { ...row }, { ...row }] }),
    );
    const ids = r.body.objects.map((o: any) => o.id);
    assert.deepEqual(ids, ["trip:t1"], "a replayed event must not produce a second pin");
    assert.equal(r.body.trips.rows, 3);
    assert.equal(r.body.trips.duplicatesIgnored, 2);
    assert.equal(r.body.trips.served, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. A STALE ROW IS IGNORED, NEVER APPLIED BACKWARDS
// ═════════════════════════════════════════════════════════════════════════════

describe("staleness: a lower version is never applied over a higher one", () => {
  it("the fold ignores the stale row and counts it", () => {
    const current = projectionRow({ source_trip_version: 12 }, { title: "CURRENT" });
    const stale = projectionRow({ source_trip_version: 3 }, { title: "STALE" });
    const fold = foldTripProjectionRows([current, stale] as TripMapProjectionRow[]);
    assert.equal(fold.counts.staleIgnored, 1);
    assert.equal((fold.rows.get("t1")!.body as any).title, "CURRENT");
    assert.equal(fold.maxSourceTripVersion, 12);
  });

  it("a stale row cannot resurrect a visibility the current version retracted", async () => {
    // The user made the trip private at version 12. A stale version-3 row still
    // says "public". Applying it backwards would put a private trip on the map.
    const current = projectionRow({ source_trip_version: 12 }, { visibility: "private" });
    const stale = projectionRow({ source_trip_version: 3 }, { visibility: "public" });
    const r = await tripLayer(readyState({ trip_map_projections: [current, stale] }));
    assert.deepEqual(r.body.objects, [], "a retracted trip must stay off the map");
    assert.equal(r.body.trips.staleIgnored, 1);
    assert.equal(r.body.trips.eligible, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. CANCELLATION / REMOVAL PROPAGATES
// ═════════════════════════════════════════════════════════════════════════════

describe("cancellation and removal propagate to the wire", () => {
  it("a cancelled stage reaches the served payload — the map shows the new state", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: [projectionRow({ source_trip_version: 8 }, { stage: "cancelled" })],
      }),
    );
    const obj = r.body.objects.find((o: any) => o.id === "trip:t1");
    assert.ok(obj);
    assert.equal(
      obj.payload.status,
      "cancelled",
      "the pre-cancellation stage must not be what the map shows",
    );
  });

  it("a trip removed from the projection (ON DELETE CASCADE) is removed from the map", async () => {
    const r = await tripLayer(readyState({ trip_map_projections: [] }));
    assert.deepEqual(r.body.objects, []);
    // Read successfully, and empty — NOT the same as unread.
    assert.deepEqual(r.body.sources, ["trips"]);
    assert.equal(r.body.trips.refusal, null);
    assert.equal(r.body.trips.rows, 0);
  });

  it("crew removal takes the pin away even while the projection row survives", async () => {
    // The projection is per-trip and has no viewer dimension; membership is the
    // only thing that removes it for THIS viewer.
    const r = await tripLayer(readyState({ trip_members: [] }));
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.trips.scoped, 0);
    assert.equal(r.body.trips.refusal, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. PRIVACY AND LOCATION PRECISION — NO WIDENING
// ═════════════════════════════════════════════════════════════════════════════

describe("privacy: the projection path never widens the canonical path", () => {
  it("a private trip is dropped on BOTH paths", async () => {
    const canonical = await tripLayer(
      baseState({ trips: [tripRow({ visibility: "private" })] }),
    );
    assert.equal(canonical.body.trips.path, "canonical");
    assert.deepEqual(canonical.body.objects, []);

    const projected = await tripLayer(
      readyState({
        trip_map_projections: [projectionRow({}, { visibility: "private" })],
      }),
    );
    assert.equal(projected.body.trips.path, "projection");
    assert.deepEqual(projected.body.objects, []);
  });

  it("a body with NO visibility is NOT assumed public", () => {
    const row = projectionRow({}, { visibility: undefined }) as TripMapProjectionRow;
    delete (row.body as any).visibility;
    assert.equal(
      isProjectionRowMapEligible(row),
      false,
      "an unreadable privacy setting must never be guessed as public",
    );
  });

  it("the served coordinate is the canonical one, at the canonical precision", async () => {
    const canonical = await tripLayer(baseState());
    const projected = await tripLayer(readyState());
    const cObj = canonical.body.objects.find((o: any) => o.id === "trip:t1");
    const pObj = projected.body.objects.find((o: any) => o.id === "trip:t1");
    assert.deepEqual(pObj.geometry.coordinates, cObj.geometry.coordinates);
    assert.deepEqual(pObj.geometry.coordinates, [ANCHOR.lng, ANCHOR.lat]);
    assert.equal(pObj.privacyClass, cObj.privacyClass);
  });

  it("the projection carries no field the canonical DTO would not have shown", async () => {
    // The Map contract is TEN fields. Anything the projection body happens to
    // hold that the canonical path never served (crew counts, plan counts)
    // must not reach the wire.
    const r = await tripLayer(readyState());
    const serialized = JSON.stringify(r.body.objects);
    for (const leak of ["crew", "accepted", "invited", "plans", "confirmed", "has_destination_coordinates"]) {
      assert.ok(!serialized.includes(leak), `projection-only field "${leak}" leaked to the wire`);
    }
  });

  it("the two paths produce IDENTICAL MapObjects over equivalent data", async () => {
    const canonical = await tripLayer(baseState());
    const projected = await tripLayer(readyState());
    assert.equal(
      JSON.stringify(projected.body.objects),
      JSON.stringify(canonical.body.objects),
      "switching branches must not change a single byte of the served objects",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. AUTHORIZATION — AN UNAUTHORIZED TRIP IS EXCLUDED
// ═════════════════════════════════════════════════════════════════════════════

describe("authorization: the projection is per-trip, so the reader scopes it", () => {
  it("a projection row for a trip the viewer is not a member of is never served", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: [
          projectionRow(),
          projectionRow({ trip_id: "t-stranger" }, { title: "SOMEONE ELSE'S TRIP" }),
        ],
      }),
    );
    const ids = r.body.objects.map((o: any) => o.id);
    assert.deepEqual(ids, ["trip:t1"]);
    assert.ok(!JSON.stringify(r.body).includes("SOMEONE ELSE'S TRIP"));
    assert.equal(r.body.trips.rows, 1, "the unauthorized row must not even be fetched");
  });

  it("an INVITED-but-not-accepted membership grants no pin, on either path", async () => {
    const state = {
      trip_members: [{ user_id: USER, trip_id: "t-invited", role: "invited" }],
      trips: [tripRow({ id: "t-invited" })],
      trip_map_projections: [projectionRow({ trip_id: "t-invited" })],
    };
    const canonical = await tripLayer(baseState(state));
    assert.deepEqual(canonical.body.objects, []);
    const projected = await tripLayer(readyState(state));
    assert.deepEqual(projected.body.objects, []);
    assert.equal(projected.body.trips.scoped, 0);
  });

  it("a different user's membership does not scope THIS viewer", async () => {
    const r = await tripLayer(
      readyState({ trip_members: [{ user_id: OTHER, trip_id: "t1", role: "owner" }] }),
    );
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.trips.scoped, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. FAIL-CLOSED: A READ FAILURE IS NOT AN EMPTY PROJECTION
// ═════════════════════════════════════════════════════════════════════════════

describe("a projection read failure is refused, never served as an empty layer", () => {
  it("an .error on the projection read leaves the layer OUT of sources", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: {
          rows: [projectionRow()],
          listError: { message: "projection down", code: "57P01" },
        },
      }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(
      r.body.sources,
      [],
      "supabase-js RESOLVES on a DB error; an unchecked .error would look like an empty projection",
    );
    assert.equal(r.body.trips.path, "projection");
    assert.equal(r.body.trips.refusal, "projection_read_failed");
    assert.equal(r.headers["x-map-trip-source"], "projection:unread");
  });

  it("it does NOT silently fall back to the canonical path", async () => {
    // The canonical table is fully populated and would have served a pin. A
    // fallback here would make a permanently broken projection invisible.
    const r = await tripLayer(
      readyState({
        trip_map_projections: {
          rows: [projectionRow()],
          listError: { message: "projection down" },
        },
        trips: [tripRow()],
      }),
    );
    assert.deepEqual(r.body.objects, [], "a broken projection must not be papered over");
    assert.equal(r.body.trips.path, "projection");
  });

  it("a scope read failure refuses the layer on the projection path too", async () => {
    const r = await tripLayer(
      readyState({ trip_members: { error: { message: "members down" } } }),
    );
    assert.deepEqual(r.body.sources, []);
    assert.equal(r.body.trips.refusal, "scope_read_failed");
  });

  it("a row below the Map contract version refuses the WHOLE layer", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: [
          projectionRow(),
          projectionRow({ trip_id: "t2", map_contract_version: 1, destination_lat: null, destination_lng: null }),
        ],
        trip_members: [
          { user_id: USER, trip_id: "t1", role: "owner" },
          { user_id: USER, trip_id: "t2", role: "member" },
        ],
      }),
    );
    assert.deepEqual(r.body.sources, [], "a partly-drawn trip layer is indistinguishable from a smaller one");
    assert.equal(r.body.trips.refusal, "projection_contract_stale");
    assert.equal(r.body.trips.contractVersion, 1);
  });

  it("an unexpected projection_schema_version refuses the layer rather than guessing", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: [projectionRow({ projection_schema_version: 2 })],
      }),
    );
    assert.deepEqual(r.body.sources, []);
    assert.equal(r.body.trips.refusal, "projection_schema_unexpected");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE CAPABILITY GATE — FLAG_ENABLED && SCHEMA_CAPABILITY_READY
// ═════════════════════════════════════════════════════════════════════════════

describe("the capability gate is fail-closed and the not-ready branch is the legacy path", () => {
  /**
   * The layer output the UNTOUCHED legacy helpers produce over the same rows.
   * `distanceKm` is stamped later by the gateway's shared pipeline, identically
   * for every kind and every branch, so it is removed on both sides rather
   * than reconstructed here — everything projectTrip itself produces is
   * compared byte for byte.
   */
  function legacyObjects(rows: any[]) {
    return rows
      .map((r) => projectTrip(toAuthorizedTripView(r) as any))
      .filter((o) => o !== null);
  }
  function withoutDistance(objects: any[]) {
    return objects.map(({ distanceKm, ...rest }: any) => rest);
  }

  it("flag OFF → canonical path, and the layer output is byte-identical to today's", async () => {
    const state = baseState();
    const r = await tripLayer(state);
    assert.equal(r.body.trips.path, "canonical");
    assert.equal(r.body.trips.capability.reason, "flag_off");
    assert.deepEqual(r.body.sources, ["trips"]);
    assert.equal(
      JSON.stringify(withoutDistance(r.body.objects)),
      JSON.stringify(legacyObjects([tripRow()])),
      "the not-ready branch must serve exactly what projectTrip(toAuthorizedTripView(row)) serves",
    );
  });

  it("flag OFF makes NO contact with trip_map_projections at all", async () => {
    const r = await tripLayer(baseState());
    assert.ok(
      !r.client._seen.some((s: string) => s.startsWith("trip_map_projections:")),
      "a dark capability must not probe or read the projection",
    );
  });

  it("flag ON but the TABLE is absent → canonical path, loudly, not an empty map", async () => {
    // This is production and portava-ci as measured 2026-09-07.
    const r = await tripLayer(readyState({ trip_map_projections: { absent: true } }));
    assert.equal(r.body.trips.path, "canonical");
    assert.equal(r.body.trips.capability.reason, "schema_missing");
    assert.equal(r.body.trips.capability.schema, "missing");
    assert.deepEqual(r.body.sources, ["trips"]);
    assert.equal(
      JSON.stringify(withoutDistance(r.body.objects)),
      JSON.stringify(legacyObjects([tripRow()])),
      "43 real production trips must not vanish because a flag was flipped",
    );
  });

  it("flag ON but the 2610 ANCHOR COLUMN is absent → canonical path", async () => {
    // 2520 applied, 2610 not. The table exists; the probe must still refuse.
    const r = await tripLayer(
      readyState({
        trip_map_projections: {
          rows: [projectionRow()],
          missingColumns: ["destination_lat", "destination_lng", "map_contract_version"],
        },
      }),
    );
    assert.equal(r.body.trips.path, "canonical");
    assert.equal(r.body.trips.capability.reason, "schema_missing");
    assert.ok(
      r.body.trips.capability.missing.length > 0,
      "the refusal must name what is missing so an operator knows what to apply",
    );
    assert.deepEqual(r.body.sources, ["trips"]);
  });

  it("an UNKNOWN probe result refuses too — unknown is not ready", async () => {
    const r = await tripLayer(
      readyState({
        trip_map_projections: { error: { message: "connection reset", code: "08006" } },
      }),
    );
    assert.equal(r.body.trips.path, "canonical");
    assert.equal(r.body.trips.capability.reason, "schema_unknown");
    assert.deepEqual(r.body.sources, ["trips"]);
  });

  it("an UNREADABLE feature_flags table is treated as off, not as on", async () => {
    const r = await tripLayer(readyState({ feature_flags: { error: { message: "flags down" } } }));
    // map_projection_enabled itself reads false, so the envelope is the
    // disabled one — the point is that nothing took the projection branch.
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.trips, null);
  });

  it("the capability probe names trip_id, not id — a wrong key would refuse forever", () => {
    const req = MAP_TRIP_PROJECTION_CAPABILITY.requires.tables.trip_map_projections;
    assert.equal(req.probe?.column, "trip_id");
    assert.deepEqual([...req.columns], [...MAP_TRIP_PROJECTION_COLUMNS]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. THE PURE CONTRACT
// ═════════════════════════════════════════════════════════════════════════════

describe("the Map-owned contract", () => {
  it("a row with no anchor is not a pin, and is not invented into one", () => {
    const row = projectionRow({ destination_lat: null, destination_lng: null });
    assert.equal(projectionRowToTripView(row as TripMapProjectionRow), null);
    assert.equal(isProjectionRowMapEligible(row as TripMapProjectionRow), false);
  });

  it("the view carries exactly the ten fields projectTrip reads", () => {
    const view = projectionRowToTripView(projectionRow() as TripMapProjectionRow)!;
    assert.deepEqual(
      Object.keys(view).sort(),
      [
        "destinationCity", "destinationCountry", "destinationLat", "destinationLng",
        "endDate", "id", "startDate", "status", "title", "visibility",
      ],
    );
  });

  it("PostgREST bigint-as-string and numeric-as-string are handled, not silently dropped", () => {
    const fold = foldTripProjectionRows([
      projectionRow({ source_trip_version: "17", destination_lat: "16.5", destination_lng: "108.5" }),
    ] as TripMapProjectionRow[]);
    assert.equal(fold.maxSourceTripVersion, 17);
    const view = projectionRowToTripView(fold.rows.get("t1")!)!;
    assert.equal(view.destinationLat, 16.5);
    assert.equal(view.destinationLng, 108.5);
  });

  it("loadViewerTripsCanonical distinguishes a failed scope read from an empty one", async () => {
    const failing = makeClient(baseState({ trip_members: { error: { message: "down" } } }));
    const bad = await loadViewerTripsCanonical(failing as any, USER);
    assert.equal(bad.trips, null);
    assert.equal(bad.refusal, "scope_read_failed");

    const empty = makeClient(baseState({ trip_members: [] }));
    const ok = await loadViewerTripsCanonical(empty as any, USER);
    assert.deepEqual(ok.trips, []);
    assert.equal(ok.refusal, null);
  });

  it("readTripStopLayer never throws, even on a client that explodes", async () => {
    const exploding: any = { from() { throw new Error("client is gone"); } };
    const r = await readTripStopLayer(exploding, USER);
    assert.equal(r.trips, null);
    assert.equal(r.report.path, "canonical");
  });
});
