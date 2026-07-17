/**
 * PATCH /admin/geofence-settings — missing singleton row guard
 *
 * Confirms the handler returns 404 not_found (instead of 200 with
 * { settings: null }) when the geofence_admin_settings row (id=1)
 * doesn't exist, so admins aren't told a save worked when nothing
 * was written.
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminGeofenceSettingsNotFound.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter, { GEOFENCE_SETTINGS_DEFAULTS } from "../routes/admin.js";

const FAKE_TOKEN = "fake.jwt.token";
const USER_ID    = "aaaaaaaa-1111-1111-1111-000000000001";

let server: http.Server;
let base: string;

/**
 * Admin client where geofence_admin_settings updates match no row —
 * maybeSingle() resolves { data: null, error: null }.
 */
function makeNoSettingsRowClient() {
  const profileRow = {
    id: USER_ID,
    role: "admin",
    account_status: "active",
    handle: "testuser",
    display_name: null,
    username: null,
  };

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") {
          return { data: { user: null }, error: { message: "invalid token" } };
        }
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
    from: (table: string) => {
      const isSettings = table === "geofence_admin_settings";
      const b: any = {
        select:      () => b,
        eq:          () => b,
        neq:         () => b,
        is:          () => b,
        in:          () => b,
        update:      () => b,
        insert:      () => b,
        upsert:      () => b,
        delete:      () => b,
        order:       () => b,
        limit:       () => b,
        maybeSingle: () =>
          isSettings
            ? Promise.resolve({ data: null, error: null })
            : Promise.resolve({ data: profileRow, error: null }),
        single:      () => Promise.resolve({ data: profileRow, error: null }),
        then:        (resolve: any) =>
          Promise.resolve({ data: [profileRow], error: null }).then(resolve),
        get count() { return 1; },
      };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return client;
}

function request(
  method: "PATCH" | "GET",
  path: string,
  token?: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers,
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
  app.use("/", adminRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("PATCH /admin/geofence-settings — missing settings row", () => {
  it("returns 404 not_found instead of 200 with settings:null", async () => {
    const fc = makeNoSettingsRowClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    const r = await request(
      "PATCH",
      "/admin/geofence-settings",
      FAKE_TOKEN,
      { defaultRadiusM: 150 },
    );
    assert.equal(
      r.status,
      404,
      `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body?.error,
      "not_found",
      `expected error "not_found", got "${r.body?.error}"`,
    );
    assert.notEqual(
      r.body?.settings,
      null,
      "must not respond with settings:null success payload",
    );
  });
});

describe("GET /admin/geofence-settings — missing settings row", () => {
  it("returns explicit defaults instead of null/blank settings", async () => {
    const fc = makeNoSettingsRowClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    const r = await request("GET", "/admin/geofence-settings", FAKE_TOKEN);
    assert.equal(
      r.status,
      200,
      `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    const s = r.body?.settings;
    assert.ok(s && typeof s === "object", "settings must be a non-null object");
    assert.equal(s.default_radius_m,          GEOFENCE_SETTINGS_DEFAULTS.default_radius_m);
    assert.equal(s.min_radius_m,              GEOFENCE_SETTINGS_DEFAULTS.min_radius_m);
    assert.equal(s.max_radius_m,              GEOFENCE_SETTINGS_DEFAULTS.max_radius_m);
    assert.equal(s.no_show_affects_reliability, GEOFENCE_SETTINGS_DEFAULTS.no_show_affects_reliability);
  });
});
