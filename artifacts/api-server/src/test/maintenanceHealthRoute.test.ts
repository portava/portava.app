/**
 * GET /api/admin/trust/maintenance/health — the trust maintenance scheduler's
 * health, and the proof that anyone can actually READ it.
 *
 * WHY THIS EXISTS
 * ---------------
 * lib/trustMaintenanceScheduler maintained `consecutiveFailures`,
 * `lastSkippedReason`, `lastEventsSeen` and the rest, and exported
 * `getTrustMaintenanceStatus()` — which had NO CALLER anywhere in the tree.
 * Every counter was computed and then dropped. A maintenance pass could fail on
 * every tick indefinitely and the only trace was a log line, in the job that
 * keeps `trust_profiles.overall_score` current — the score that gates event
 * RSVPs and ranks both the buddy marketplace and Pulse.
 *
 * WHAT IS ASSERTED, AND THE TRAPS AVOIDED
 * ---------------------------------------
 *   - The exact STATUS CODE, never merely `!== 200`. `status !== 200` is
 *     satisfied by a 404 from an unmounted route and by a 500 from a crash, so
 *     it cannot tell "denied" from "broken".
 *   - `req.log` is installed, because the real server installs it. Omitting it
 *     makes the handler THROW inside requireAdmin's error path and the
 *     resulting 500-from-crash reads exactly like a fail-closed denial.
 *   - The server binds AND is dialled on the explicit loopback address, awaited
 *     through the listening callback: `listen(0)` with no host binds the IPv6
 *     wildcard and can be served by a foreign process holding the same
 *     ephemeral port on 127.0.0.1.
 *   - Reachability is checked through the COMPOSED router (routes/index.ts),
 *     the same object the server mounts. Mounting the router under test
 *     directly proves the handler works and proves nothing about whether the
 *     real app ever reaches it.
 *   - The verdict is driven by REAL passes through `tickOnce()`, not by poking
 *     the status object, so the endpoint and the scheduler are proven to agree.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest, no supertest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/maintenanceHealthRoute.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { tickOnce, _resetStatus } from "../lib/trustMaintenanceScheduler.js";
import trustAdminRouter from "../routes/trust-admin.js";

const PATH = "/api/admin/trust/maintenance/health";
const TOKEN = "test-bearer-token";
const ADMIN = "11111111-1111-4111-8111-111111111111";

const DB_ERROR = { message: "connection terminated unexpectedly", code: "57P01" };

// ── Stub client ──────────────────────────────────────────────────────────────
// One client serves both the request (auth + profiles.role) and the maintenance
// pass, because requireAdmin resolves `sc` as `getServiceClient() ?? client` and
// _setTestClient injects both.

type Resolver = (table: string, ops: string[]) => { data: any; error: any } | null;

function stubClient(opts: { role: string | null; resolve?: Resolver }) {
  const settled: { table: string; ops: string[] }[] = [];

  function builder(table: string, ops: string[]): any {
    const b: any = {};
    for (const op of [
      "select", "insert", "update", "delete", "upsert",
      "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not",
    ]) {
      b[op] = (...args: any[]) => {
        const a0 = args[0];
        const a1 = args[1];
        const label =
          (op === "eq" || op === "in" || op === "is") && typeof a0 === "string"
            ? `${op}:${a0}=${Array.isArray(a1) ? a1.join("|") : String(a1)}`
            : op;
        return builder(table, [...ops, label]);
      };
    }
    const settle = (single: boolean) => (onOk: any, onErr: any) => {
      settled.push({ table, ops: [...ops] });
      const custom = opts.resolve?.(table, ops);
      if (custom) return Promise.resolve({ count: null, ...custom }).then(onOk, onErr);
      if (table === "profiles") {
        const row = opts.role === null ? null : { id: ADMIN, role: opts.role };
        return Promise.resolve({ data: single ? row : row ? [row] : [], error: null, count: null })
          .then(onOk, onErr);
      }
      if (table === "feature_flags") {
        // Trust engine ON, everything else (gaming detection) OFF.
        const engine = ops.some((o) => o.includes("trust_engine_enabled"));
        return Promise.resolve({ data: { enabled: engine }, error: null, count: null })
          .then(onOk, onErr);
      }
      return Promise.resolve({ data: single ? null : [], error: null, count: null })
        .then(onOk, onErr);
    };
    b.maybeSingle = () => {
      const s: any = { then: settle(true) };
      return s;
    };
    b.single = () => ({ then: settle(true) });
    b.then = settle(false);
    return b;
  }

  return {
    settled,
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async getUser(token: string) {
        if (token !== TOKEN) return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: { id: ADMIN } }, error: null };
      },
    },
    from(table: string) {
      return builder(table, []);
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

interface Reply { status: number; body: any }

function get(base: string, path: string, token?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let body: any = null;
          try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A pino-shaped no-op, exactly what the real server puts on req. */
function noopLog(): any {
  const l: any = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  };
  l.child = () => l;
  return l;
}

const servers: http.Server[] = [];

async function serve(router: any): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = noopLog(); next(); });
  app.use("/api", router);
  const server = http.createServer(app);
  servers.push(server);
  // Bind the explicit loopback address AND await the listening callback:
  // listen(0, host) resolves the host on a later tick, so address() is null
  // immediately after the call.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;
  return `http://127.0.0.1:${addr.port}`;
}

let base = "";
let composedBase = "";

before(async () => {
  base = await serve(trustAdminRouter);
  // The composed router, exactly as src/routes/index.ts hands it to the server.
  const { default: composedRouter } = await import("../routes/index.js");
  composedBase = await serve(composedRouter);
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

beforeEach(() => {
  _clearTestClient();
  _setTestServiceClient(null as any);
  _resetStatus();
});

afterEach(() => {
  _clearTestClient();
  _setTestServiceClient(null as any);
  _resetStatus();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("authorisation (the SHARED requireAdmin, not a local copy)", () => {
  it("no Authorization header → 401 unauthenticated", async () => {
    _setTestClient(stubClient({ role: "admin" }), true);
    const r = await get(base, PATH);
    assert.equal(r.status, 401);
    assert.equal(r.body?.error, "unauthenticated");
  });

  it("a signed-in non-admin → 403 forbidden", async () => {
    _setTestClient(stubClient({ role: "user" }), true);
    const r = await get(base, PATH, TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "forbidden");
  });

  it("the route file defines NO local admin check — it uses the shared guard", () => {
    // This repository once carried 30 hand-rolled admin guards under four
    // names; a thirty-first would be thirty-one chances for one to drift
    // weaker. The behavioural half of the shared guard (including its
    // "a read failure is not a role denial" 503) is proven in
    // adminGuardSharedPath.test.ts; what belongs here is that this route did
    // not quietly grow its own.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "routes", "trust-admin.ts"),
      "utf8",
    );
    assert.match(
      src,
      /import \{ requireAdmin \} from "\.\.\/lib\/requireAdmin\.js";/,
      "trust-admin.ts must import the shared requireAdmin",
    );
    assert.equal(
      /(function|const)\s+require(Admin|AdminGuard|AdminCtx)\b/.test(src),
      false,
      "trust-admin.ts must not define a local admin guard",
    );
  });
});

describe("reachability through the composed router", () => {
  it("the path is MOUNTED — an unauthenticated call is refused by the guard, not 404'd", async () => {
    _setTestClient(stubClient({ role: "admin" }), true);
    const r = await get(composedBase, PATH);
    assert.equal(
      r.status,
      401,
      "401 means the request reached the handler's own gate; 404 would mean nothing claimed the path",
    );
  });

  it("control: a path nothing registers really does 404 through the same router", async () => {
    // Without this the assertion above would still pass if the app answered
    // non-404 for absolutely everything.
    _setTestClient(stubClient({ role: "admin" }), true);
    const r = await get(composedBase, "/api/admin/trust/maintenance/health-not-a-route");
    assert.equal(r.status, 404);
  });
});

describe("the verdict", () => {
  it("no pass yet, inside the startup delay → 200 pending", async () => {
    _setTestClient(stubClient({ role: "admin" }), true);
    const r = await get(base, PATH, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body?.verdict, "pending");
    assert.equal(r.body?.status?.lastRunAt, null);
  });

  it("after a clean pass → 200 ok, with a lastSuccessAt", async () => {
    const c = stubClient({ role: "admin" });
    _setTestClient(c, true);
    await tickOnce();

    const r = await get(base, PATH, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body?.verdict, "ok");
    assert.equal(r.body?.status?.consecutiveFailures, 0);
    assert.notEqual(r.body?.status?.lastSuccessAt, null);
    assert.ok(
      c.settled.some((s: any) => s.table === "trust_events"),
      "vacuity check: a real maintenance pass must have run",
    );
  });

  it("after a pass that could not read trust_events → 503 failing", async () => {
    const c = stubClient({
      role: "admin",
      resolve: (table, ops) =>
        table === "trust_events" && ops.some((o) => o.startsWith("in:status="))
          ? { data: null, error: DB_ERROR }
          : null,
    });
    _setTestClient(c, true);
    await tickOnce();

    const r = await get(base, PATH, TOKEN);
    assert.equal(r.status, 503, "a failing job must not answer 200");
    assert.equal(r.body?.verdict, "failing");
    assert.equal(r.body?.status?.consecutiveFailures, 1);
    assert.ok(
      (r.body?.status?.lastFailures ?? []).includes("events_unreadable"),
      `expected events_unreadable, got ${JSON.stringify(r.body?.status?.lastFailures)}`,
    );
    assert.equal(
      r.body?.status?.lastEventsSeen,
      null,
      "null is 'the read failed' — the endpoint must not round it to 0",
    );
  });

  it("a deliberately disabled engine reads as ok, with the skip reason named", async () => {
    const c = stubClient({
      role: "admin",
      resolve: (table) => (table === "feature_flags" ? { data: { enabled: false }, error: null } : null),
    });
    _setTestClient(c, true);
    await tickOnce();

    const r = await get(base, PATH, TOKEN);
    assert.equal(r.status, 200, "flag_off is a configured state, not breakage");
    assert.equal(r.body?.verdict, "ok");
    assert.equal(r.body?.status?.lastSkippedReason, "flag_off");
  });

  it("reports the cadence the verdict was judged against", async () => {
    _setTestClient(stubClient({ role: "admin" }), true);
    const r = await get(base, PATH, TOKEN);
    assert.equal(typeof r.body?.schedule?.intervalMs, "number");
    assert.ok(r.body.schedule.intervalMs > 0);
    assert.equal(r.body.schedule.staleAfterMs, r.body.schedule.intervalMs * 2);
  });
});
