/**
 * Geofence admin settings route contract tests
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   GET   /admin/geofence-settings  — read global check-in radius config
 *   PATCH /admin/geofence-settings  — update radius defaults
 *
 * Schema (geofenceSettingsSchema):
 *   defaultRadiusM           int  min 10  max 10 000   (optional)
 *   minRadiusM               int  min 10  max 1 000    (optional)
 *   maxRadiusM               int  min 100 max 50 000   (optional)
 *   noShowAffectsReliability boolean                   (optional)
 *
 * GET falls back to hardcoded defaults when no row exists in geofence_admin_settings.
 *
 * Follows the fake-client injection pattern from featureFlagsAdmin.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/geofenceAdminSettings.test.ts
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

const FAKE_TOKEN = "fake.jwt.token";

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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
  role?: string;
  geofenceSettings?: Record<string, unknown> | null;
}) {
  const { role = "admin", geofenceSettings = null } = opts;

  function builder(rows: unknown[]) {
    let _rows = [...rows];
    const b: any = {
      select:      () => b,
      insert:      (data: any) => { _rows = [data]; return b; },
      update:      (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return b; },
      delete:      () => { _rows = []; return b; },
      eq:          () => b,
      is:          () => b,
      ilike:       () => b,
      not:         () => b,
      in:          () => b,
      order:       () => b,
      limit:       () => b,
      range:       () => b,
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      then:        (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles")
        return builder([{ id: "uid1", role }]);
      if (table === "geofence_admin_settings")
        return builder(geofenceSettings ? [geofenceSettings] : []);
      return builder([]);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "uid1" } }, error: null }),
    },
  } as any;
}

function setClients(opts: Parameters<typeof makeFakeClient>[0]) {
  const c = makeFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── GET /admin/geofence-settings ──────────────────────────────────────────────

describe("GET /admin/geofence-settings", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const { status, body } = await req("GET", "/admin/geofence-settings");
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns hardcoded defaults when no row exists in the table", async () => {
    setClients({ role: "admin", geofenceSettings: null });
    const { status, body } = await req("GET", "/admin/geofence-settings");
    assert.equal(status, 200);
    assert.ok(body.settings, "response must have a settings key");
    assert.equal(body.settings.default_radius_m, 150,   "default_radius_m default is 150");
    assert.equal(body.settings.min_radius_m,      50,    "min_radius_m default is 50");
    assert.equal(body.settings.max_radius_m,      5000,  "max_radius_m default is 5000");
    assert.equal(body.settings.no_show_affects_reliability, false, "no_show_affects_reliability default is false");
  });

  it("returns the stored row when one exists", async () => {
    setClients({
      role: "admin",
      geofenceSettings: {
        default_radius_m: 200,
        min_radius_m:     75,
        max_radius_m:     8000,
        no_show_affects_reliability: true,
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    const { status, body } = await req("GET", "/admin/geofence-settings");
    assert.equal(status, 200);
    assert.equal(body.settings.default_radius_m, 200);
    assert.equal(body.settings.min_radius_m,     75);
    assert.equal(body.settings.max_radius_m,     8000);
    assert.equal(body.settings.no_show_affects_reliability, true);
  });
});

// ── PATCH /admin/geofence-settings ────────────────────────────────────────────

describe("PATCH /admin/geofence-settings", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: 200 });
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns 200 and applies a valid defaultRadiusM update", async () => {
    setClients({
      role: "admin",
      geofenceSettings: {
        default_radius_m: 150,
        min_radius_m: 50,
        max_radius_m: 5000,
        no_show_affects_reliability: false,
        updated_at: "2026-01-01T00:00:00Z",
      },
    });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: 300 });
    assert.equal(status, 200);
    assert.ok(body.settings, "response must have a settings key");
    assert.equal(body.settings.default_radius_m, 300);
  });

  it("returns 200 and updates noShowAffectsReliability", async () => {
    setClients({
      role: "admin",
      geofenceSettings: {
        default_radius_m: 150,
        min_radius_m: 50,
        max_radius_m: 5000,
        no_show_affects_reliability: false,
        updated_at: "2026-01-01T00:00:00Z",
      },
    });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { noShowAffectsReliability: true });
    assert.equal(status, 200);
    assert.equal(body.settings.no_show_affects_reliability, true);
  });

  it("returns 200 and updates multiple fields at once", async () => {
    setClients({
      role: "admin",
      geofenceSettings: {
        default_radius_m: 150,
        min_radius_m: 50,
        max_radius_m: 5000,
        no_show_affects_reliability: false,
        updated_at: "2026-01-01T00:00:00Z",
      },
    });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", {
      defaultRadiusM: 250,
      minRadiusM:     25,
      maxRadiusM:     9000,
      noShowAffectsReliability: true,
    });
    assert.equal(status, 200);
    assert.equal(body.settings.default_radius_m, 250);
    assert.equal(body.settings.min_radius_m,     25);
    assert.equal(body.settings.max_radius_m,     9000);
    assert.equal(body.settings.no_show_affects_reliability, true);
  });

  // ── Out-of-range rejection (defaultRadiusM: min 10, max 10 000) ─────────────

  it("returns 400 when defaultRadiusM is below the minimum (< 10)", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: 5 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when defaultRadiusM is above the maximum (> 10 000)", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: 10_001 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  // ── Out-of-range rejection (maxRadiusM: min 100, max 50 000) ────────────────

  it("returns 400 when maxRadiusM is below the minimum (< 100)", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { maxRadiusM: 50 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when maxRadiusM is above the maximum (> 50 000)", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { maxRadiusM: 50_001 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  // ── Out-of-range rejection (minRadiusM: min 10, max 1 000) ──────────────────

  it("returns 400 when minRadiusM is above the maximum (> 1 000)", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { minRadiusM: 1_001 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  // ── Type rejection ────────────────────────────────────────────────────────────

  it("returns 400 when a radius value is a float (schema requires .int())", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: 150.5 });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when a radius value is a string instead of a number", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", { defaultRadiusM: "200" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  // ── Unknown field rejection ───────────────────────────────────────────────────
  // Schema uses .strict() so any unrecognised key returns 400 invalid_payload.

  it("returns 400 when body contains only unknown fields", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", {
      unknownRadiusField: 9999,
      anotherUnknown:     true,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when body mixes valid and unknown fields", async () => {
    setClients({ role: "admin" });
    const { status, body } = await req("PATCH", "/admin/geofence-settings", {
      defaultRadiusM:  200,
      unknownField:    "bad",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});
