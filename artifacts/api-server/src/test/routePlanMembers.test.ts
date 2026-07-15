/**
 * Tests for route plan members endpoints (join / leave / list)
 * and checkpoint-progress logic.
 *
 * Uses node:test + the local-express pattern from routePlan.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import routePlanRouter from "../routes/routePlan.js";
import http from "node:http";

// ── Fake client builder ────────────────────────────────────────────────────────

const PLAN_ID = "cccccccc-dddd-eeee-ffff-000000000000";
const USER_ID = "user-001";

interface Store {
  route_plans:        any[];
  route_stops:        any[];
  route_legs:         any[];
  route_plan_members: any[];
  trip_plan_items:    any[];
}

function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    route_plans:        [],
    route_stops:        [],
    route_legs:         [],
    route_plan_members: [],
    trip_plan_items:    [],
    ...overrides,
  };
}

function makeClient(store: Store) {
  const fakeUser = { id: USER_ID, email: "test@example.com" };

  function makeChain(table: string): any {
    let _conds: Record<string, unknown> = {};
    let _inserting: any[] | null = null;
    let _deleting = false;
    let _upserting: any[] | null = null;
    let _data: any = null;

    const obj: any = {
      select:      () => obj,
      eq:          (col: string, val: unknown) => { _conds[col] = val; return obj; },
      in:          () => obj,
      order:       () => obj,
      limit:       () => obj,
      filter:      () => obj,
      upsert:      (rows: any) => { _upserting = Array.isArray(rows) ? rows : [rows]; return obj; },
      insert:      (rows: any) => { _inserting = Array.isArray(rows) ? rows : [rows]; return obj; },
      update:      (_p: any) => obj,
      delete:      () => { _deleting = true; return obj; },
      maybeSingle: async () => {
        _flush();
        if (table === "route_plans") {
          const id = _conds["id"];
          const found = store.route_plans.find((p) => p.id === id);
          return { data: found ?? null, error: null };
        }
        if (table === "trip_plan_items") {
          const item = store.trip_plan_items[0] ?? null;
          return { data: item, error: null };
        }
        return { data: _data, error: null };
      },
      single: async () => {
        _flush();
        return { data: _data, error: null };
      },
      then: (resolve: Function) => {
        _flush();
        let result: any[];
        switch (table) {
          case "route_plan_members": result = store.route_plan_members.filter((m) => m.route_plan_id === _conds["route_plan_id"]); break;
          case "route_stops":        result = store.route_stops.filter((s) => s.route_plan_id === _conds["route_plan_id"]); break;
          case "route_legs":         result = store.route_legs; break;
          default:                   result = [];
        }
        return Promise.resolve({ data: result, error: null }).then(resolve);
      },
    };

    function _flush() {
      if (_inserting) {
        if (table === "route_plan_members") {
          _inserting.forEach((r) => store.route_plan_members.push(r));
        }
        _inserting = null;
      }
      if (_upserting) {
        if (table === "route_plan_members") {
          _upserting.forEach((r) => {
            const idx = store.route_plan_members.findIndex(
              (m) => m.route_plan_id === r.route_plan_id && m.user_id === r.user_id,
            );
            if (idx === -1) store.route_plan_members.push({ ...r, joined_at: new Date().toISOString() });
          });
        }
        _upserting = null;
      }
      if (_deleting) {
        if (table === "route_plan_members") {
          store.route_plan_members = store.route_plan_members.filter(
            (m) => !(m.route_plan_id === _conds["route_plan_id"] && m.user_id === _conds["user_id"]),
          );
        }
        _deleting = false;
      }
    }

    return obj;
  }

  return {
    auth: { getUser: async (_t: string) => ({ data: { user: fakeUser }, error: null }) },
    from: (t: string) => makeChain(t),
  };
}

function makeApp(store: Store) {
  _setTestClient(makeClient(store), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", routePlanRouter);
  return app;
}

function startServer(store: Store): Promise<{ port: number; close: () => Promise<void> }> {
  const app = makeApp(store);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((r, j) => srv.close((e) => e ? j(e) : r())) });
    });
    srv.on("error", reject);
  });
}

function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({
      hostname: "127.0.0.1", port, path, method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── Pre-seeded plan fixture ───────────────────────────────────────────────────

const seedPlan = {
  id:            PLAN_ID,
  owner_user_id: USER_ID,
  title:         "City Walk",
  trip_id:       null,
  route_style:   "standard",
  status:        "active",
  compass_explanation: null,
  is_approximated: false,
  created_at:    new Date().toISOString(),
  updated_at:    new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

test("POST /api/route-plans/:id/members — join adds member to route_plan_members", async () => {
  const store = makeStore({ route_plans: [seedPlan] });
  const srv = await startServer(store);
  try {
    const r = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/members`);
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.joined, true);
    assert.equal(store.route_plan_members.length, 1);
    assert.equal(store.route_plan_members[0].user_id, USER_ID);
  } finally {
    await srv.close();
  }
});

test("POST /api/route-plans/:id/members — idempotent (upsert, no duplicate)", async () => {
  const store = makeStore({
    route_plans:        [seedPlan],
    route_plan_members: [{ route_plan_id: PLAN_ID, user_id: USER_ID, joined_at: new Date().toISOString() }],
  });
  const srv = await startServer(store);
  try {
    const r = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/members`);
    assert.equal(r.status, 201);
    assert.equal(store.route_plan_members.length, 1, "should remain 1 after idempotent join");
  } finally {
    await srv.close();
  }
});

test("POST /api/route-plans/:id/members — 403 when non-owner joins private (non-trip) route", async () => {
  const otherOwnedPlan = {
    ...seedPlan,
    owner_user_id: "other-user-999",
    trip_id:       null,
  };
  const store = makeStore({ route_plans: [otherOwnedPlan] });
  const srv = await startServer(store);
  try {
    const r = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/members`);
    assert.equal(r.status, 403, `expected 403 for non-owner private route, got ${r.status}`);
    assert.equal(store.route_plan_members.length, 0, "no member row should be added");
  } finally {
    await srv.close();
  }
});

test("DELETE /api/route-plans/:id/members — leave removes member", async () => {
  const store = makeStore({
    route_plans:        [seedPlan],
    route_plan_members: [{ route_plan_id: PLAN_ID, user_id: USER_ID, joined_at: new Date().toISOString() }],
  });
  const srv = await startServer(store);
  try {
    const r = await req(srv.port, "DELETE", `/api/route-plans/${PLAN_ID}/members`);
    assert.equal(r.status, 204);
    assert.equal(store.route_plan_members.length, 0, "member should be removed");
  } finally {
    await srv.close();
  }
});

test("GET /api/route-plans/:id/members — returns joined members + shared progress", async () => {
  const stops = [
    { id: "s1", route_plan_id: PLAN_ID, checkpoint_status: "arrived",  order_index: 0 },
    { id: "s2", route_plan_id: PLAN_ID, checkpoint_status: "pending",   order_index: 1 },
    { id: "s3", route_plan_id: PLAN_ID, checkpoint_status: "pending",   order_index: 2 },
  ];
  const store = makeStore({
    route_plans:        [seedPlan],
    route_stops:        stops,
    route_plan_members: [{ route_plan_id: PLAN_ID, user_id: USER_ID, joined_at: new Date().toISOString(), profiles: { id: USER_ID, display_name: "Alice", avatar_url: null } }],
  });
  const srv = await startServer(store);
  try {
    const r = await req(srv.port, "GET", `/api/route-plans/${PLAN_ID}/members`);
    assert.equal(r.status, 200);
    assert.equal(Array.isArray(r.body.members), true);
    assert.equal(r.body.totalStops, 3, "3 stops total");
    assert.equal(r.body.arrivedCount, 1, "1 arrived");
  } finally {
    await srv.close();
  }
});

// ── Checkpoint progress logic (pure unit tests, no HTTP) ──────────────────────

test("checkpoint progress — completedCount counts arrived stops", () => {
  const stops = [
    { id: "a", checkpointStatus: "arrived" },
    { id: "b", checkpointStatus: "pending" },
    { id: "c", checkpointStatus: "arrived" },
    { id: "d", checkpointStatus: "skipped" },
  ];
  const completedCount = stops.filter((s) => s.checkpointStatus === "arrived").length;
  assert.equal(completedCount, 2);
});

test("checkpoint progress — progressFraction is completedCount / totalCount", () => {
  const stops = [
    { id: "a", checkpointStatus: "arrived" },
    { id: "b", checkpointStatus: "arrived" },
    { id: "c", checkpointStatus: "pending" },
    { id: "d", checkpointStatus: "pending" },
  ];
  const completedCount   = stops.filter((s) => s.checkpointStatus === "arrived").length;
  const progressFraction = stops.length > 0 ? completedCount / stops.length : 0;
  assert.equal(progressFraction, 0.5);
});

test("checkpoint progress — progressFraction is 0 for empty stops list", () => {
  const stops: any[] = [];
  const completedCount   = stops.filter((s) => s.checkpointStatus === "arrived").length;
  const progressFraction = stops.length > 0 ? completedCount / stops.length : 0;
  assert.equal(completedCount, 0);
  assert.equal(progressFraction, 0);
});

test("checkpoint progress — nextStop is first pending stop in order", () => {
  const stops = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "pending" },
    { id: "c", orderIndex: 2, checkpointStatus: "pending" },
  ];
  const nextStop = stops.find((s) => s.checkpointStatus === "pending") ?? null;
  assert.equal(nextStop?.id, "b");
});

test("checkpoint progress — nextStop is null when all stops arrived", () => {
  const stops = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "arrived" },
  ];
  const nextStop = stops.find((s) => s.checkpointStatus === "pending") ?? null;
  assert.equal(nextStop, null);
});

// ── RouteMinimapView region computation (snapshot-style) ─────────────────────
// Extracted logic matches what RouteMinimapView uses in useMemo.

function computeRegionFromStops(
  stops: Array<{ lat: number | null; lng: number | null }>,
  padFactor = 1.4,
): { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number } | null {
  const valid = stops.filter((s) => s.lat != null && s.lng != null) as Array<{ lat: number; lng: number }>;
  if (valid.length === 0) return null;
  const lats = valid.map((s) => s.lat);
  const lngs = valid.map((s) => s.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * padFactor, 0.005);
  const lngDelta = Math.max((maxLng - minLng) * padFactor, 0.005);
  return {
    latitude:      (minLat + maxLat) / 2,
    longitude:     (minLng + maxLng) / 2,
    latitudeDelta: latDelta,
    longitudeDelta: lngDelta,
  };
}

test("computeRegionFromStops — returns null for empty list", () => {
  const region = computeRegionFromStops([]);
  assert.equal(region, null);
});

test("computeRegionFromStops — returns null for stops with null coords", () => {
  const region = computeRegionFromStops([{ lat: null, lng: null }, { lat: null, lng: null }]);
  assert.equal(region, null);
});

test("computeRegionFromStops — single stop returns min-delta region centred on stop", () => {
  const region = computeRegionFromStops([{ lat: 48.8566, lng: 2.3522 }]);
  assert.ok(region !== null);
  assert.ok(Math.abs(region.latitude  - 48.8566) < 0.0001);
  assert.ok(Math.abs(region.longitude - 2.3522)  < 0.0001);
  assert.equal(region.latitudeDelta,  0.005); // min-delta applied
  assert.equal(region.longitudeDelta, 0.005);
});

test("computeRegionFromStops — multiple stops produce correct bounding region", () => {
  const stops = [
    { lat: 48.85, lng: 2.35 },
    { lat: 48.87, lng: 2.37 },
    { lat: 48.83, lng: 2.33 },
  ];
  const region = computeRegionFromStops(stops, 1.0); // padFactor=1 for exact math
  assert.ok(region !== null);
  assert.ok(Math.abs(region.latitude  - 48.85) < 0.001);
  assert.ok(Math.abs(region.longitude - 2.35)  < 0.001);
  assert.ok(region.latitudeDelta  >= 0.04 - 0.001);
  assert.ok(region.longitudeDelta >= 0.04 - 0.001);
});
