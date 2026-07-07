/**
 * Feature-flag admin route contract tests
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   GET  /admin/feature-flags          — list all flags (admin only)
 *   PATCH /admin/feature-flags/:flag   — toggle a single flag on/off (admin only)
 *
 * Schema reference (migration 0037_feature_flags.sql):
 *   feature_flags(flag TEXT PK, enabled BOOLEAN, description TEXT, updated_at TIMESTAMPTZ)
 *
 * All tests use the fake-client injection pattern from adminGeo.test.ts:
 *   _setTestClient(fakeClient, true) so no real Supabase connection is needed.
 *
 * Run: node --import tsx/esm --test src/test/featureFlagsAdmin.test.ts
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
    const payload = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${FAKE_TOKEN}`,
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
  role?: string;
  featureFlags?: Record<string, unknown>[];
  /** Captures every rpc() call so tests can assert on them. */
  rpcCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}) {
  const { role = "admin", featureFlags = [], rpcCalls } = opts;
  // Mutable copy so rpc() can update flag state in place.
  const flags: Record<string, unknown>[] = featureFlags.map((f) => ({ ...f }));

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

  /**
   * Simulate toggle_feature_flag_with_audit (migration 0119).
   * Atomically updates the in-memory flag state and records the call.
   */
  async function rpc(name: string, args: Record<string, unknown>) {
    if (rpcCalls) rpcCalls.push({ name, args });

    if (name !== "toggle_feature_flag_with_audit") {
      return { data: [], error: null };
    }

    const { p_flag, p_new_enabled } = args as {
      p_flag: string;
      p_new_enabled: boolean;
    };

    const flagRow = flags.find((f: any) => f.flag === p_flag) as any;
    if (!flagRow) {
      return { data: null, error: { message: "Flag not found", code: "P0002" } };
    }

    const oldEnabled  = flagRow.enabled;
    const now         = new Date().toISOString();
    flagRow.enabled   = p_new_enabled;
    flagRow.updated_at = now;

    return {
      data: [{
        flag:        flagRow.flag,
        enabled:     p_new_enabled,
        description: flagRow.description ?? null,
        updated_at:  now,
        changed_at:  now,
        old_enabled: oldEnabled,
      }],
      error: null,
    };
  }

  return {
    from: (table: string) => {
      if (table === "profiles")      return builder([{ id: "uid1", role }]);
      if (table === "feature_flags") return builder(flags);
      return builder([]);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "uid1" } }, error: null }),
    },
    rpc,
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
  // Stub req.log so routes that call req.log.info() don't crash without pino-http
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── GET /admin/feature-flags ──────────────────────────────────────────────────

describe("GET /admin/feature-flags", () => {
  it("returns 200 with flags array for admin", async () => {
    setClients({
      role: "admin",
      featureFlags: [
        { flag: "passport_stamps_enabled", enabled: false, description: "Stamp earning", updated_at: new Date().toISOString() },
        { flag: "location_phase1_gps",     enabled: true,  description: "GPS capture",   updated_at: new Date().toISOString() },
      ],
    });
    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.flags), "body.flags must be an array");
    assert.equal(body.flags.length, 2);
  });

  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user" });
    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns empty array when no flags exist", async () => {
    setClients({ role: "admin", featureFlags: [] });
    const { status, body } = await req("GET", "/admin/feature-flags");
    assert.equal(status, 200);
    assert.deepEqual(body.flags, []);
  });

  it("returns 403 when no authorization header is present", async () => {
    setClients({ role: "admin" });
    const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const url = new URL("/admin/feature-flags", base);
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
          headers: { "content-type": "application/json" } },
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
    assert.equal(status, 401);
    assert.equal(body.error, "unauthenticated");
  });
});

// ── PATCH /admin/feature-flags/:flag ─────────────────────────────────────────

describe("PATCH /admin/feature-flags/:flag", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({
      role: "user",
      featureFlags: [{ flag: "passport_stamps_enabled", enabled: false }],
    });
    const { status, body } = await req("PATCH", "/admin/feature-flags/passport_stamps_enabled", { enabled: true });
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns 404 when flag does not exist", async () => {
    setClients({ role: "admin", featureFlags: [] });
    const { status, body } = await req("PATCH", "/admin/feature-flags/nonexistent_flag", { enabled: true });
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("toggles a flag to true and returns the updated row", async () => {
    setClients({
      role: "admin",
      featureFlags: [
        { flag: "passport_stamps_enabled", enabled: false, description: "Stamp earning", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const { status, body } = await req("PATCH", "/admin/feature-flags/passport_stamps_enabled", { enabled: true });
    assert.equal(status, 200);
    assert.ok(body.flag, "response must have a flag object");
    assert.equal(body.flag.enabled, true);
    assert.equal(body.flag.flag, "passport_stamps_enabled");
  });

  it("toggles a flag to false and returns the updated row", async () => {
    setClients({
      role: "admin",
      featureFlags: [
        { flag: "location_phase1_gps", enabled: true, description: "GPS phase 1", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const { status, body } = await req("PATCH", "/admin/feature-flags/location_phase1_gps", { enabled: false });
    assert.equal(status, 200);
    assert.equal(body.flag.enabled, false);
    assert.equal(body.flag.flag, "location_phase1_gps");
  });

  it("returns 400 when body is missing enabled field", async () => {
    setClients({ role: "admin", featureFlags: [{ flag: "some_flag", enabled: false }] });
    const { status, body } = await req("PATCH", "/admin/feature-flags/some_flag", {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when enabled is not a boolean", async () => {
    setClients({ role: "admin", featureFlags: [{ flag: "some_flag", enabled: false }] });
    const { status, body } = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: "yes" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("calls toggle_feature_flag_with_audit RPC with correct procedure name and arguments", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = makeFakeClient({
      role: "admin",
      featureFlags: [{ flag: "trip_crew_map_enabled", enabled: false, description: "Crew map" }],
      rpcCalls,
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("PATCH", "/admin/feature-flags/trip_crew_map_enabled", { enabled: true });
    assert.equal(status, 200, "toggle must succeed");

    // Exactly one RPC call must have been made (no bare UPDATE).
    assert.equal(rpcCalls.length, 1, "exactly one RPC call must be made per toggle");
    const call = rpcCalls[0];

    // The procedure name must be the atomic audit function (not a raw update).
    assert.equal(call.name, "toggle_feature_flag_with_audit",
      "must call toggle_feature_flag_with_audit, not a bare UPDATE");

    // All three required args must be forwarded correctly.
    assert.equal(call.args.p_flag,        "trip_crew_map_enabled", "p_flag forwarded");
    assert.equal(call.args.p_new_enabled, true,                    "p_new_enabled forwarded");
    assert.ok(typeof call.args.p_changed_by_id === "string" && call.args.p_changed_by_id.length > 0,
      "p_changed_by_id must be the authenticated user's ID");
  });
});
