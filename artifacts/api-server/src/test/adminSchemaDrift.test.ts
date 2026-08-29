/**
 * Admin schema-drift health endpoint tests
 *
 * GET /admin/health/schema-drift
 *   - admin-only (403 for non-admins)
 *   - serves the cached result when present
 *   - re-runs the check on ?refresh=true (and when no cache exists)
 *
 * Uses the fake-client injection pattern from adminGeo.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/adminSchemaDrift.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import { _resetSchemaDriftCache } from "../lib/schemaDriftCheck.js";

let server: http.Server;
let base: string;

const FAKE_TOKEN = "fake.jwt.token";

function req(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: { authorization: `Bearer ${FAKE_TOKEN}` },
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

type FakeError = { code: string; message?: string } | null;

/**
 * Fake client supporting both the requireAdmin profile lookup and the
 * schema-drift probes (from(t).select(c).limit(1) and rpc()).
 */
function makeFakeClient(opts: {
  role?: string;
  columnErrors?: Record<string, FakeError>; // key "table.column"
  rpcErrors?: Record<string, FakeError>;
  onProbe?: (key: string) => void;
}) {
  const { role = "admin" } = opts;
  return {
    from(table: string) {
      return {
        select(column: string) {
          const b: any = {
            eq: () => b,
            maybeSingle: () =>
              Promise.resolve(
                table === "profiles"
                  ? { data: { id: "uid1", role }, error: null }
                  : { data: null, error: null },
              ),
            limit(_n: number) {
              const key = `${table}.${column}`;
              opts.onProbe?.(key);
              const error = opts.columnErrors?.[key] ?? null;
              return Promise.resolve({ data: error ? null : [], error });
            },
          };
          return b;
        },
      };
    },
    rpc(fn: string, _args?: Record<string, unknown>) {
      opts.onProbe?.(`rpc:${fn}`);
      const error = opts.rpcErrors?.[fn] ?? null;
      return Promise.resolve({ data: null, error });
    },
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "uid1" } }, error: null }),
    },
  } as any;
}

function setClients(opts: Parameters<typeof makeFakeClient>[0]) {
  const c = makeFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
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

beforeEach(() => {
  _resetSchemaDriftCache();
});

describe("GET /admin/health/schema-drift", () => {
  it("rejects non-admins with 403", async () => {
    setClients({ role: "user" });
    const res = await req("GET", "/admin/health/schema-drift");
    assert.equal(res.status, 403);
  });

  it("runs the check when no cache exists and reports ok", async () => {
    setClients({});
    const res = await req("GET", "/admin/health/schema-drift");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.deepEqual(res.body.missingColumns, []);
    assert.deepEqual(res.body.missingFunctions, []);
    assert.equal(res.body.cached, false);
    assert.ok(res.body.checkedAt);
  });

  it("reports drift with missing columns and functions", async () => {
    setClients({
      columnErrors: {
        "profiles.passport_section_order": { code: "42703" },
      },
      rpcErrors: {
        toggle_feature_flag_with_audit: { code: "42883" },
      },
    });
    const res = await req("GET", "/admin/health/schema-drift");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "drift");
    assert.equal(res.body.missingColumns.length, 1);
    assert.equal(res.body.missingColumns[0].table, "profiles");
    assert.equal(res.body.missingColumns[0].column, "passport_section_order");
    assert.ok(res.body.missingColumns[0].migration);
    assert.equal(res.body.missingFunctions.length, 1);
    assert.equal(res.body.missingFunctions[0].fn, "toggle_feature_flag_with_audit");
  });

  it("serves the cached result without re-probing", async () => {
    const probes: string[] = [];
    setClients({ onProbe: (k) => probes.push(k) });

    const first = await req("GET", "/admin/health/schema-drift");
    assert.equal(first.body.cached, false);
    const probesAfterFirst = probes.length;
    assert.ok(probesAfterFirst > 0);

    const second = await req("GET", "/admin/health/schema-drift");
    assert.equal(second.status, 200);
    assert.equal(second.body.cached, true);
    assert.equal(probes.length, probesAfterFirst, "no new probes on cached hit");
    assert.equal(second.body.checkedAt, first.body.checkedAt);
  });

  it("re-probes on ?refresh=true", async () => {
    const probes: string[] = [];
    setClients({ onProbe: (k) => probes.push(k) });

    await req("GET", "/admin/health/schema-drift");
    const probesAfterFirst = probes.length;

    const res = await req("GET", "/admin/health/schema-drift?refresh=true");
    assert.equal(res.status, 200);
    assert.equal(res.body.cached, false);
    assert.ok(probes.length > probesAfterFirst, "refresh re-ran the probes");
  });
});
