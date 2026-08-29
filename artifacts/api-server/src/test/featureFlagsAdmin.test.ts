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
}) {
  const { role = "admin", featureFlags = [] } = opts;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

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
    _rpcCalls: rpcCalls,
    from: (table: string) => {
      if (table === "profiles")      return builder([{ id: "uid1", role }]);
      if (table === "feature_flags") return builder(featureFlags);
      return builder([]);
    },
    // Emulates the toggle_feature_flag_with_audit SQL function (migration 0119):
    // atomically toggles the flag and returns the updated row + audit fields.
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      // Emulates set_feature_flag_metadata_with_audit (migration 2198): replaces
      // the WHOLE metadata document and reports the previous one.
      if (fn === "set_feature_flag_metadata_with_audit") {
        const mrow: any = featureFlags.find((f: any) => f.flag === args.p_flag);
        if (!mrow) {
          return Promise.resolve({ data: null, error: { code: "P0002", message: `Flag not found: ${args.p_flag}` } });
        }
        const previous = mrow.metadata ?? null;
        mrow.metadata = args.p_metadata;          // REPLACE, never merge
        mrow.updated_at = new Date().toISOString();
        return Promise.resolve({
          data: [{ ...mrow, old_metadata: previous, changed_at: mrow.updated_at }],
          error: null,
        });
      }
      if (fn !== "toggle_feature_flag_with_audit") {
        return Promise.resolve({ data: null, error: { code: "42883", message: `function ${fn} does not exist` } });
      }
      const row: any = featureFlags.find((f: any) => f.flag === args.p_flag);
      if (!row) {
        return Promise.resolve({ data: null, error: { code: "P0002", message: `Flag not found: ${args.p_flag}` } });
      }
      const oldEnabled = row.enabled;
      row.enabled = args.p_new_enabled;
      row.updated_at = new Date().toISOString();
      return Promise.resolve({
        data: [{
          ...row,
          old_enabled: oldEnabled,
          changed_at: row.updated_at,
          changed_by_user_id: args.p_changed_by_id,
        }],
        error: null,
      });
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
  // Stub req.log so routes that call req.log.info() don't crash without pino-http
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

  it("toggles atomically via toggle_feature_flag_with_audit RPC with the right args", async () => {
    // The toggle now runs through the atomic toggle_feature_flag_with_audit
    // RPC (migration 0119) instead of a raw update — assert the RPC contract.
    const client = makeFakeClient({
      role: "admin",
      featureFlags: [{ flag: "trip_crew_map_enabled", enabled: false, description: "Crew map" }],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status } = await req("PATCH", "/admin/feature-flags/trip_crew_map_enabled", { enabled: true });
    assert.equal(status, 200);

    const toggles = client._rpcCalls.filter((c: any) => c.fn === "toggle_feature_flag_with_audit");
    assert.equal(toggles.length, 1, "toggle RPC must be called exactly once");
    const args = toggles[0].args;
    assert.equal(args.p_flag, "trip_crew_map_enabled", "RPC must target the requested flag");
    assert.equal(args.p_new_enabled, true, "enabled must be set to the requested value");
    assert.equal(args.p_changed_by_id, "uid1", "audit must record the acting admin");
    assert.deepEqual(
      Object.keys(args).sort(),
      ["p_changed_by_id", "p_flag", "p_new_enabled"],
      "RPC payload must contain only the toggle arguments",
    );
  });

  it("returns 503 server_not_configured when the audit RPC is missing", async () => {
    const client = makeFakeClient({
      role: "admin",
      featureFlags: [{ flag: "some_flag", enabled: false }],
    });
    // Simulate migration 0119 not applied: Postgres "function does not exist"
    (client as any).rpc = () =>
      Promise.resolve({ data: null, error: { code: "42883", message: "function toggle_feature_flag_with_audit does not exist" } });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const { status, body } = await req("PATCH", "/admin/feature-flags/some_flag", { enabled: true });
    assert.equal(status, 503);
    assert.equal(body.error, "server_not_configured");
  });
});


// ── PATCH /admin/feature-flags/:flag/metadata ─────────────────────────────────
//
// Ruling D2=A puts a THREE-valued switch in metadata.mode because
// feature_flags.enabled is a boolean. Before migration 2198 nothing could write
// it: the toggle route accepts { enabled } only, so DISCOVERY_ENGINE_MODE could
// not be moved off `legacy` through any supported surface and the Stage 2/3/4
// ladder sat behind a switch with no handle.

describe("PATCH /admin/feature-flags/:flag/metadata", () => {
  const modeFlag = () => ([{
    flag: "DISCOVERY_ENGINE_MODE",
    enabled: true,
    description: "d",
    metadata: { mode: "legacy", rollout: "p1-discovery" },
    updated_at: "2026-08-28T00:00:00Z",
  }] as any[]);

  it("sets a valid mode and returns the stored document", async () => {
    setClients({ featureFlags: modeFlag() });
    const { status, body } = await req(
      "PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { mode: "shadow", cohort: { pct: 10 } } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.flag.metadata, { mode: "shadow", cohort: { pct: 10 } });
    assert.deepEqual(body.flag.last_change.old_metadata, { mode: "legacy", rollout: "p1-discovery" });
  });

  it("REPLACES the document rather than merging into it", async () => {
    // A merge would make "remove a key" unexpressible and would let two
    // concurrent edits interleave into a document neither operator wrote.
    setClients({ featureFlags: modeFlag() });
    const { body } = await req(
      "PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { mode: "pde" } },
    );
    assert.deepEqual(body.flag.metadata, { mode: "pde" });
    assert.ok(!("rollout" in body.flag.metadata), "the prior key must be gone, not merged through");
  });

  it("REFUSES a mode typo instead of storing it and silently serving legacy", async () => {
    // This is the whole reason the endpoint validates. resolveDiscoveryEngineMode
    // is deliberately fail-closed, so "pdee" would be accepted, stored, and then
    // resolve to legacy — the operator sees 200, believes the rollout advanced,
    // and nothing changes. A rejection turns a silent no-op into a message.
    setClients({ featureFlags: modeFlag() });
    const { status, body } = await req(
      "PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { mode: "pdee" } },
    );
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /legacy \| shadow \| pde/);
  });

  it("refuses a missing mode key on a constrained flag", async () => {
    setClients({ featureFlags: modeFlag() });
    const { status } = await req(
      "PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { rollout: "p1" } },
    );
    assert.equal(status, 400);
  });

  it("accepts arbitrary metadata on an UNCONSTRAINED flag", async () => {
    setClients({ featureFlags: [{ flag: "some_other_flag", enabled: false, description: "d", metadata: null }] });
    const { status, body } = await req(
      "PATCH", "/admin/feature-flags/some_other_flag/metadata",
      { metadata: { anything: 1 } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.flag.metadata, { anything: 1 });
  });

  it("rejects a body that is not { metadata: object }", async () => {
    setClients({ featureFlags: modeFlag() });
    for (const bad of [{}, { metadata: "nope" }, { metadata: 5 }]) {
      const { status } = await req("PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata", bad);
      assert.equal(status, 400, `body ${JSON.stringify(bad)} must be rejected`);
    }
  });

  it("404s an unknown flag rather than creating one", async () => {
    setClients({ featureFlags: modeFlag() });
    const { status } = await req("PATCH", "/admin/feature-flags/no_such_flag/metadata",
      { metadata: { anything: true } });
    assert.equal(status, 404);
  });

  it("does not touch `enabled`", async () => {
    setClients({ featureFlags: modeFlag() });
    const { body } = await req("PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { mode: "pde" } });
    assert.equal(body.flag.enabled, true, "a metadata write must not flip the master switch");
  });

  it("requires admin", async () => {
    setClients({ role: "user", featureFlags: modeFlag() });
    const { status } = await req("PATCH", "/admin/feature-flags/DISCOVERY_ENGINE_MODE/metadata",
      { metadata: { mode: "pde" } });
    assert.ok(status === 401 || status === 403, `non-admin must not write metadata (got ${status})`);
  });
});
