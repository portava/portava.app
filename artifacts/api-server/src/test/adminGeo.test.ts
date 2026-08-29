/**
 * Admin geo-control contract tests
 *
 * Verifies schema alignment against actual migrations:
 *   0034_geo_zones.sql  — geo_zones columns: zone_type, name, city, country_code,
 *                         bounds_json, center_lat/lng, radius_meters,
 *                         safety_rating, featured, verified, created_by
 *   0033_location_sessions.sql — location_trust_events columns: event_type,
 *                         confidence, details, reviewed_at, reviewed_by
 *   0029_discovery_places.sql  — discovery_places: status = provisional|verified|blocked
 *                         submitted_by references profiles
 *
 * All tests use the fake-client injection pattern from pulseGps.test.ts:
 *   _setTestClient(fakeClient) so no real Supabase connection is needed.
 *
 * Run: node --import tsx/esm --test src/test/adminGeo.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

// Reusable HTTP helper — always sends a fake bearer token so requireUser passes
const FAKE_TOKEN = "fake.jwt.token";

function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
      ...headers,
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers: reqHeaders },
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

// ── Fake client builder ───────────────────────────────────────────────────────

function makeFakeClient(opts: {
  role?: string;                            // profiles.role for the authed user
  geoZones?: Record<string, unknown>[];     // rows for geo_zones
  trustEvents?: Record<string, unknown>[];  // rows for location_trust_events
  discoveryPlaces?: Record<string, unknown>[];
}) {
  const { role = "admin", geoZones = [], trustEvents = [], discoveryPlaces = [] } = opts;

  // A minimal chainable builder
  function builder(rows: unknown[], single = false) {
    let _rows = [...rows];
    let _single = single;
    const b: any = {
      select: () => b,
      insert: (data: any) => { _rows = [data]; return b; },
      update: (data: any) => {
        _rows = _rows.map((r: any) => ({ ...r, ...data }));
        return b;
      },
      delete: () => { _rows = []; return b; },
      eq:     () => b,
      is:     () => b,
      ilike:  () => b,
      not:    () => b,
      in:     () => b,
      order:  () => b,
      limit:  () => b,
      range:  () => b,
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      then:   (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") return builder([{ id: "uid1", role }]);
      if (table === "geo_zones") return builder(geoZones);
      if (table === "location_trust_events") return builder(trustEvents);
      if (table === "discovery_places") return builder(discoveryPlaces);
      return builder([]);
    },
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "uid1" } }, error: null }),
    },
  } as any;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── Helpers to set both client slots ─────────────────────────────────────────

function setClients(opts: Parameters<typeof makeFakeClient>[0]) {
  const c = makeFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("admin — geo zones", () => {
  it("GET /admin/geo-zones returns 200 for admin role", async () => {
    setClients({ role: "admin", geoZones: [{ id: "gz1", name: "Lahug", zone_type: "neighborhood" }] });
    const { status, body } = await req("GET", "/admin/geo-zones");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.zones));
  });

  it("GET /admin/geo-zones returns 403 for non-admin", async () => {
    setClients({ role: "user" });
    const { status } = await req("GET", "/admin/geo-zones");
    assert.equal(status, 403);
  });

  it("POST /admin/geo-zones uses correct columns (no is_system, no metadata)", async () => {
    const captured: any[] = [];
    const client = makeFakeClient({ role: "admin" });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "geo_zones") {
        const origInsert = b.insert.bind(b);
        b.insert = (data: any) => {
          captured.push(data);
          return origInsert(data);
        };
      }
      return b;
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await req("POST", "/admin/geo-zones", {
      name: "Poblacion",
      zoneType: "neighborhood",
      city: "Makati",
      countryCode: "PH",
    });

    assert.equal(captured.length, 1);
    const row = captured[0];
    // Must use correct DB column names
    assert.equal(row.zone_type, "neighborhood");
    assert.equal(row.city, "Makati");
    assert.equal(row.country_code, "PH");
    // Must NOT include columns absent from the migration
    assert.ok(!("is_system" in row), "is_system must not be sent to DB");
    assert.ok(!("metadata" in row),  "metadata must not be sent to DB (not in geo_zones)");
    assert.ok(!("polygon_geojson" in row), "polygon_geojson must not be sent");
  });

  it("POST /admin/geo-zones rejects unknown zoneType", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("POST", "/admin/geo-zones", {
      name: "Test",
      zoneType: "invalid_type",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("PATCH /admin/geo-zones/:id only sends defined fields", async () => {
    const captured: any[] = [];
    const client = makeFakeClient({ role: "admin", geoZones: [{ id: "gz1", name: "Old Name" }] });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "geo_zones") {
        const origUpdate = b.update.bind(b);
        b.update = (data: any) => { captured.push(data); return origUpdate(data); };
      }
      return b;
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    await req("PATCH", "/admin/geo-zones/gz1", { name: "New Name" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, "New Name");
    assert.ok(!("zone_type" in captured[0]), "zone_type must not be sent when not patched");
    assert.ok(!("is_system" in captured[0]), "is_system must never appear");
  });

  it("PATCH /admin/geo-zones returns 400 when body is empty", async () => {
    setClients({ role: "admin", geoZones: [{ id: "gz1" }] });
    const { status, body } = await req("PATCH", "/admin/geo-zones/gz1", {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("DELETE /admin/geo-zones/:id returns 204 for admin", async () => {
    setClients({ role: "admin", geoZones: [{ id: "gz1" }] });
    const { status } = await req("DELETE", "/admin/geo-zones/gz1");
    assert.equal(status, 204);
  });
});

describe("admin — suspicious GPS queue", () => {
  it("GET /admin/suspicious-gps returns unreviewed events", async () => {
    setClients({
      role: "admin",
      trustEvents: [
        { id: "te1", user_id: "u1", event_type: "impossible_speed", confidence: "high", details: null, created_at: new Date().toISOString() },
      ],
    });
    const { status, body } = await req("GET", "/admin/suspicious-gps");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events));
  });

  it("GET /admin/suspicious-gps never includes lat/lng", async () => {
    setClients({
      role: "admin",
      trustEvents: [{ id: "te1", lat: 10.3, lng: 123.9, event_type: "coordinate_jump", confidence: "medium" }],
    });
    const { status, body } = await req("GET", "/admin/suspicious-gps");
    assert.equal(status, 200);
    const event = body.events[0] ?? {};
    assert.ok(!("lat" in event), "lat must not appear in suspicious GPS response");
    assert.ok(!("lng" in event), "lng must not appear in suspicious GPS response");
  });

  it("POST /admin/suspicious-gps/:id/resolve uses reviewed_at (not resolved_at)", async () => {
    const captured: any[] = [];
    const client = makeFakeClient({ role: "admin", trustEvents: [{ id: "te1" }] });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "location_trust_events") {
        const origUpdate = b.update.bind(b);
        b.update = (data: any) => { captured.push(data); return origUpdate(data); };
      }
      return b;
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("POST", "/admin/suspicious-gps/te1/resolve", { resolution: "cleared" });
    assert.equal(status, 200);

    assert.equal(captured.length, 1);
    const update = captured[0];
    // Must use schema column names
    assert.ok("reviewed_at" in update,     "must use reviewed_at (migration column)");
    assert.ok("reviewed_by" in update,     "must use reviewed_by (migration column)");
    assert.ok(!("resolved_at" in update),  "resolved_at does not exist in migration");
    assert.ok(!("resolved_by" in update),  "resolved_by does not exist in migration");
    assert.ok(!("trust_level" in update),  "trust_level does not exist in migration");
  });

  it("POST /admin/suspicious-gps/:id/resolve rejects invalid resolution", async () => {
    setClients({ role: "admin", trustEvents: [{ id: "te1" }] });
    const { status, body } = await req("POST", "/admin/suspicious-gps/te1/resolve", { resolution: "deleted" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

describe("admin — venue moderation", () => {
  it("GET /admin/venues/pending queries discovery_places with status=provisional", async () => {
    const queried: string[] = [];
    const client = makeFakeClient({ role: "admin" });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => { queried.push(table); return origFrom(table); };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("GET", "/admin/venues/pending");
    assert.equal(status, 200);
    assert.ok(queried.includes("discovery_places"), "must query discovery_places table");
    assert.ok(!queried.includes("place_profiles"),  "must NOT query place_profiles (wrong table)");
  });

  it("POST /admin/venues/:id/moderate approve sets status=verified", async () => {
    const captured: any[] = [];
    const dpId = "dddddddd-0000-0000-0001-000000000001";
    const client = makeFakeClient({
      role: "admin",
      discoveryPlaces: [{ id: dpId, name: "Abaca", status: "provisional" }],
    });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "discovery_places") {
        const origUpdate = b.update.bind(b);
        b.update = (data: any) => { captured.push(data); return origUpdate(data); };
      }
      return b;
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("POST", `/admin/venues/${dpId}/moderate`, { action: "approve" });
    assert.equal(status, 200);
    assert.equal(captured[0]?.status, "verified",
      "approve must set status=verified (valid place_profiles enum)");
  });

  it("POST /admin/venues/:id/moderate reject sets status=blocked", async () => {
    const captured: any[] = [];
    const dpId = "dddddddd-0000-0000-0001-000000000001";
    const client = makeFakeClient({
      role: "admin",
      discoveryPlaces: [{ id: dpId, name: "Bad Spot", status: "provisional" }],
    });
    const origFrom = client.from.bind(client);
    client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "discovery_places") {
        const origUpdate = b.update.bind(b);
        b.update = (data: any) => { captured.push(data); return origUpdate(data); };
      }
      return b;
    };
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("POST", `/admin/venues/${dpId}/moderate`, { action: "reject" });
    assert.equal(status, 200);
    assert.equal(captured[0]?.status, "blocked",
      "reject must set status=blocked (not rejected — not a valid enum value)");
  });

  it("POST /admin/venues/:id/moderate rejects invalid action", async () => {
    const dpId = "dddddddd-0000-0000-0001-000000000001";
    setClients({ role: "admin", discoveryPlaces: [{ id: dpId }] });
    const { status, body } = await req("POST", `/admin/venues/${dpId}/moderate`, { action: "delete" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});
