/**
 * Safe Return admin route contract tests
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   GET  /admin/safe-return/config  — read Safe Return flag state (admin + gate flag)
 *   PATCH /admin/safe-return/config — update Safe Return flags (admin + gate flag)
 *
 * Both routes have a double gate:
 *   1. requireAdmin  — profiles.role must be 'admin'
 *   2. isSafeReturnAdminEnabled — feature_flags.safe_return_admin_logs_enabled must be true
 *
 * All tests use the fake-client injection pattern from featureFlagsAdmin.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/safeReturnAdmin.test.ts
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
//
// feature_flags rows are stored as-is. Because the fake builder ignores .eq()
// and .in() chains, maybeSingle() always returns the first row — so put the gate
// flag (safe_return_admin_logs_enabled) first in every featureFlags fixture.
// The full list is returned by the batch .in() query via `then`.

function makeFakeClient(opts: {
  role?: string;
  featureFlags?: Record<string, unknown>[];
}) {
  const { role = "admin", featureFlags = [] } = opts;

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
      if (table === "profiles")      return builder([{ id: "uid1", role }]);
      if (table === "feature_flags") return builder(featureFlags);
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

// Fixture: gate flag enabled + the four Safe Return config flags
const GATE_ENABLED = { flag: "safe_return_admin_logs_enabled", enabled: true,  description: "Admin gate",          updated_at: "2026-01-01T00:00:00Z" };
const GATE_DISABLED = { flag: "safe_return_admin_logs_enabled", enabled: false, description: "Admin gate",          updated_at: "2026-01-01T00:00:00Z" };
const CONFIG_FLAGS = [
  GATE_ENABLED,
  { flag: "safe_return_enabled",                      enabled: false, description: "Safe Return",      updated_at: "2026-01-01T00:00:00Z" },
  { flag: "safe_return_live_share_enabled",            enabled: false, description: "Live share",       updated_at: "2026-01-01T00:00:00Z" },
  { flag: "safe_return_trusted_circle_alerts_enabled", enabled: false, description: "Circle alerts",    updated_at: "2026-01-01T00:00:00Z" },
];

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

// ── GET /admin/safe-return/config ─────────────────────────────────────────────

describe("GET /admin/safe-return/config", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("GET", "/admin/safe-return/config");
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns feature_disabled when gate flag is false", async () => {
    setClients({ role: "admin", featureFlags: [GATE_DISABLED] });
    const { status, body } = await req("GET", "/admin/safe-return/config");
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("returns feature_disabled when gate flag row does not exist", async () => {
    // Empty feature_flags → maybeSingle returns null → isSafeReturnAdminEnabled returns false
    setClients({ role: "admin", featureFlags: [] });
    const { status, body } = await req("GET", "/admin/safe-return/config");
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("returns 200 with a config array when admin and gate flag is enabled", async () => {
    setClients({ role: "admin", featureFlags: CONFIG_FLAGS });
    const { status, body } = await req("GET", "/admin/safe-return/config");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.config), "body.config must be an array");
    assert.ok(body.config.length > 0, "config must include at least one flag row");
  });

  it("config response includes only Safe Return flag rows", async () => {
    setClients({ role: "admin", featureFlags: CONFIG_FLAGS });
    const { status, body } = await req("GET", "/admin/safe-return/config");
    assert.equal(status, 200);
    const flagNames = body.config.map((f: any) => f.flag);
    for (const name of flagNames) {
      assert.ok(
        name.startsWith("safe_return_"),
        `Unexpected flag '${name}' in config response`,
      );
    }
  });
});

// ── PATCH /admin/safe-return/config ──────────────────────────────────────────

describe("PATCH /admin/safe-return/config", () => {
  it("returns 403 for non-admin users", async () => {
    setClients({ role: "user", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: { safe_return_enabled: true },
    });
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns feature_disabled when gate flag is false", async () => {
    setClients({ role: "admin", featureFlags: [GATE_DISABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: { safe_return_enabled: true },
    });
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("returns 400 invalid_payload when body is missing the flags key", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {});
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 invalid_payload when flags object is empty", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", { flags: {} });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 invalid_payload when only unknown flag keys are provided", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: { unknown_flag_xyz: true, another_unknown: false },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 200 and updates a single allowed flag", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: { safe_return_enabled: true },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.updated.safe_return_enabled, true, "updated must reflect the requested value");
  });

  it("returns 200 and updates multiple allowed flags at once", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: {
        safe_return_enabled:                      true,
        safe_return_live_share_enabled:            false,
        safe_return_trusted_circle_alerts_enabled: true,
      },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.updated.safe_return_enabled,                      true);
    assert.equal(body.updated.safe_return_live_share_enabled,            false);
    assert.equal(body.updated.safe_return_trusted_circle_alerts_enabled, true);
  });

  it("silently strips unknown flags — only allowed keys appear in updated", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: {
        safe_return_enabled: true,
        totally_unknown_flag: true,
      },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok("safe_return_enabled" in body.updated, "allowed flag must be in updated");
    assert.ok(!("totally_unknown_flag" in body.updated), "unknown flag must not appear in updated");
  });

  it("returns 400 invalid_payload when a flag value is not boolean", async () => {
    setClients({ role: "admin", featureFlags: [GATE_ENABLED] });
    // "yes" is a string, not a boolean — should be filtered as not-boolean;
    // with only one key and it being invalid, the updates array is empty → invalid_payload
    const { status, body } = await req("PATCH", "/admin/safe-return/config", {
      flags: { safe_return_enabled: "yes" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});
