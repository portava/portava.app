/**
 * census-discovery §120 — the owner's 30-day TESTING retention for
 * `public.recommendations`, at the scheduler (lib/discoveryServeLogRetentionScheduler.ts).
 * The SQL half (3501's purge, boundary, batches and dependents) is executed on a
 * real PostgreSQL in src/test/db/discoveryServeLogRetention.db.test.ts.
 *
 *   S1  a tick calls the purge with the bounded batch size and stops when the
 *       database says nothing more is expired
 *   S2  bounded: a backlog is drained at most MAX_BATCHES_PER_TICK statements a
 *       tick, and the remainder is reported, not chased
 *   S3  a failed purge SURFACES: counted, named, no success recorded, 503 at
 *       /healthz/schedulers — and a later clean pass clears it
 *   S4  every other way a pass can fail to purge is a failure, never zero work:
 *       flag OFF, flag row absent, database answering disabled, an answer of the
 *       wrong shape, no client, a throw
 *   S5  job_health: the attempt always, the success only when there was one
 *   S6  the scheduler actually runs: started, it calls the purge after the
 *       startup delay and again every interval; and the API entry starts it
 *   S7  the retention is WIRED into /healthz/schedulers by name
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryServeLogRetention.test.ts
 */
import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import {
  JOB_KEY, PURGE_RPC, PURGE_BATCH_SIZE, MAX_BATCHES_PER_TICK, RETENTION_INTERVAL_MS, RETENTION_STARTUP_DELAY_MS,
  DISCOVERY_SERVE_LOG_RETENTION_FLAG,
  runDiscoveryServeLogRetentionTick, getDiscoveryServeLogRetentionStatus, _resetDiscoveryServeLogRetentionStatus,
  startDiscoveryServeLogRetentionScheduler, stopDiscoveryServeLogRetentionScheduler, _setTestClient,
  parsePurgeAnswer, hydrateDiscoveryServeLogRetentionStatus,
} from "../lib/discoveryServeLogRetentionScheduler.js";
import healthRouter from "../routes/health.js";

type Answer = { data: unknown; error: unknown };

function fake(opts: {
  flag?: { enabled: boolean; metadata?: Record<string, unknown> } | null;
  flagError?: boolean;
  answers?: Answer[] | ((n: number) => Answer);
  healthError?: boolean;
  throwOnRpc?: boolean;
} = {}) {
  const rpcs: Array<{ name: string; params: any }> = [];
  const upserts: Array<{ table: string; row: any; opts: any }> = [];
  const flag = opts.flag === undefined ? { enabled: true, metadata: { keep_days: 30 } } : opts.flag;
  const client: any = {
    from(table: string) {
      if (table === "feature_flags") {
        const q: any = {
          select: () => q, eq: () => q,
          maybeSingle: async () => opts.flagError ? { data: null, error: { message: "boom" } } : { data: flag, error: null },
        };
        return q;
      }
      if (table === "job_health") {
        const q: any = {
          select: () => q, eq: () => q,
          maybeSingle: async () => ({ data: { last_run_at: "2026-09-29T00:00:00.000Z", last_success_at: null }, error: null }),
          upsert: async (row: any, o: any) => { upserts.push({ table, row, opts: o }); return { error: opts.healthError ? { message: "no job_health" } : null }; },
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, params: any) => {
      rpcs.push({ name, params });
      if (opts.throwOnRpc) throw new Error("socket hang up");
      const a = opts.answers;
      if (typeof a === "function") return a(rpcs.length);
      if (Array.isArray(a)) return a[rpcs.length - 1] ?? { data: { status: "purged", deleted: 0, more: false, cutoff: "2026-08-31T00:00:00+00:00" }, error: null };
      return { data: { status: "purged", deleted: 0, more: false, cutoff: "2026-08-31T00:00:00+00:00" }, error: null };
    },
  };
  return { client, rpcs, upserts };
}

const purged = (deleted: number, more: boolean): Answer =>
  ({ data: { status: "purged", deleted, more, cutoff: "2026-08-31T16:00:00+00:00", batch_size: PURGE_BATCH_SIZE }, error: null });

beforeEach(() => { _resetDiscoveryServeLogRetentionStatus(); });
afterEach(() => { stopDiscoveryServeLogRetentionScheduler(); _setTestClient(null); });

// The logger's pino transport becomes READY through a poll on the GLOBAL
// setTimeout; with setTimeout mocked below, a slow (loaded) worker would never
// report ready and this file's process would never exit after its tests pass.
// Made ready in real time first — helpers/loggerTransportReady.ts has the why.
before(async () => {
  await awaitLoggerTransportReady();
});

describe("§120 — the serve-log retention scheduler", () => {
  it("S1. a tick calls the purge with the bounded batch size and stops when nothing more is expired", async () => {
    const f = fake({ answers: [purged(1000, true), purged(412, false)] });
    const s = await runDiscoveryServeLogRetentionTick(f.client);
    assert.equal(f.rpcs.length, 2, "two statements: the second answered more=false");
    for (const r of f.rpcs) {
      assert.equal(r.name, PURGE_RPC);
      assert.deepEqual(r.params, { p_batch_size: PURGE_BATCH_SIZE });
    }
    assert.ok(PURGE_BATCH_SIZE >= 1 && PURGE_BATCH_SIZE <= 10_000, "inside what 3501's function admits");
    assert.deepEqual(s.lastFailures, []);
    assert.equal(s.consecutiveFailures, 0);
    assert.ok(s.lastSuccessAt, "a clean pass is a success");
    assert.deepEqual(s.lastReport, { deleted: 1412, batches: 2, backlogRemains: false, cutoff: "2026-08-31T16:00:00+00:00" });
  });

  it("S1b. nothing expired is a SUCCESS with deleted 0 — one statement", async () => {
    const f = fake({ answers: [purged(0, false)] });
    const s = await runDiscoveryServeLogRetentionTick(f.client);
    assert.equal(f.rpcs.length, 1);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastReport?.deleted, 0);
    assert.ok(s.lastSuccessAt);
  });

  it("S2. bounded: a backlog is drained at most MAX_BATCHES_PER_TICK statements a tick, and the rest is reported", async () => {
    const f = fake({ answers: () => purged(PURGE_BATCH_SIZE, true) });
    const s = await runDiscoveryServeLogRetentionTick(f.client);
    assert.equal(f.rpcs.length, MAX_BATCHES_PER_TICK, "never an unbounded loop");
    assert.equal(s.lastReport?.batches, MAX_BATCHES_PER_TICK);
    assert.equal(s.lastReport?.deleted, MAX_BATCHES_PER_TICK * PURGE_BATCH_SIZE);
    assert.equal(s.lastReport?.backlogRemains, true, "the remainder is visible, left for the next tick");
    assert.equal(s.consecutiveFailures, 0, "a bounded pass that made progress is not a failure");
  });

  it("S3. a failed purge surfaces: counted, named, no success — 503 at /healthz/schedulers — and a clean pass clears it", async () => {
    const err = { code: "55000", message: "purge_expired_discovery_recommendations: a foreign key now references public.recommendations" };
    const f = fake({ answers: [purged(1000, true), { data: null, error: err }] });
    const s = await runDiscoveryServeLogRetentionTick(f.client);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null, "a failed pass is never a success");
    assert.equal(s.lastFailures.length, 1);
    assert.match(s.lastFailures[0]!, /after 1 batch\(es\), 1000 row\(s\) deleted: 55000 .*foreign key/);
    assert.equal(s.lastReport?.deleted, 1000, "the partial work is reported, not erased");

    const base = await serve();
    try {
      const r = await get(base);
      assert.equal(r.status, 503, "the status code is the verdict");
      const job = r.body.jobs.find((j: any) => j.job === JOB_KEY);
      assert.equal(job.status, "failing");
      assert.equal(job.consecutiveFailures, 1);
      assert.match(job.detail, /foreign key/);

      await runDiscoveryServeLogRetentionTick(fake({ answers: [purged(3, false)] }).client);
      const after = await get(base);
      const healed = after.body.jobs.find((j: any) => j.job === JOB_KEY);
      assert.equal(healed.status, "healthy");
      assert.equal(healed.consecutiveFailures, 0);
      assert.ok(healed.lastSuccessAt);
    } finally {
      await close();
    }
  });

  it("S4. every other way a pass can fail to purge is a failure, never zero work", async () => {
    const cases: Array<[string, ReturnType<typeof fake> | null, RegExp]> = [
      ["flag OFF", fake({ flag: { enabled: false } }), /is OFF — expired serve-log rows are being kept/],
      ["flag row absent", fake({ flag: null }), /absent or unreadable/],
      ["flag row unreadable", fake({ flagError: true }), /absent or unreadable/],
      ["database answers disabled", fake({ answers: [{ data: { status: "disabled", deleted: 0, more: null, cutoff: null }, error: null }] }), /answered disabled/],
      ["wrong shape", fake({ answers: [{ data: 7, error: null }] }), /unexpected shape/],
      ["negative count", fake({ answers: [{ data: { status: "purged", deleted: -1, more: false }, error: null }] }), /unexpected shape/],
      ["rpc throws", fake({ throwOnRpc: true }), /threw: socket hang up/],
      ["no client", null, /no service client/],
    ];
    for (const [name, f, re] of cases) {
      _resetDiscoveryServeLogRetentionStatus();
      const s = await runDiscoveryServeLogRetentionTick(f ? f.client : null);
      assert.equal(s.consecutiveFailures, 1, name);
      assert.equal(s.lastSuccessAt, null, `${name}: never a success`);
      assert.match(s.lastFailures.join(" | "), re, name);
      if (f && (name.startsWith("flag"))) assert.equal(f.rpcs.length, 0, `${name}: nothing was called`);
    }
  });

  it("S5. job_health: the attempt always, the success only when there was one; a write failure does not fail the pass", async () => {
    const ok = fake({ answers: [purged(0, false)] });
    await runDiscoveryServeLogRetentionTick(ok.client);
    assert.equal(ok.upserts.length, 1);
    assert.equal(ok.upserts[0]!.row.job, JOB_KEY);
    assert.equal(ok.upserts[0]!.row.last_success_at, ok.upserts[0]!.row.last_run_at);
    assert.deepEqual(ok.upserts[0]!.opts, { onConflict: "job" });

    const bad = fake({ answers: [{ data: null, error: { message: "x" } }] });
    await runDiscoveryServeLogRetentionTick(bad.client);
    assert.equal("last_success_at" in bad.upserts[0]!.row, false, "a failed pass writes no success");

    _resetDiscoveryServeLogRetentionStatus();
    const s = await runDiscoveryServeLogRetentionTick(fake({ answers: [purged(0, false)], healthError: true }).client);
    assert.equal(s.consecutiveFailures, 0);

    _resetDiscoveryServeLogRetentionStatus();
    await hydrateDiscoveryServeLogRetentionStatus(fake().client);
    const h = getDiscoveryServeLogRetentionStatus();
    assert.equal(h.lastAttemptAt, "2026-09-29T00:00:00.000Z");
    assert.equal(h.lastSuccessAt, null, "a persisted attempt with no success hydrates as never succeeded");
  });

  it("S6. started, the scheduler calls the purge after the startup delay and again every interval", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const f = fake({ answers: () => purged(0, false) });
      _setTestClient(f.client);
      startDiscoveryServeLogRetentionScheduler();
      startDiscoveryServeLogRetentionScheduler();   // idempotent
      mock.timers.tick(RETENTION_STARTUP_DELAY_MS - 1);
      await flush();
      assert.equal(f.rpcs.length, 0, "not before the startup delay");
      mock.timers.tick(1);
      await flush();
      assert.equal(f.rpcs.length, 1, "the first pass runs at the startup delay");
      mock.timers.tick(RETENTION_INTERVAL_MS);
      await flush();
      assert.equal(f.rpcs.length, 2, "and again one interval later");
      assert.equal(RETENTION_INTERVAL_MS, 60 * 60 * 1000, "hourly");
      stopDiscoveryServeLogRetentionScheduler();
      mock.timers.tick(RETENTION_INTERVAL_MS * 3);
      await flush();
      assert.equal(f.rpcs.length, 2, "stopped means stopped");
    } finally {
      mock.timers.reset();
    }
  });

  it("S6b. the API entry starts it", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(src, /import \{ startDiscoveryServeLogRetentionScheduler \} from "\.\/lib\/discoveryServeLogRetentionScheduler\.js";/);
    assert.match(src, /\n\s[^\n]*\bstartDiscoveryServeLogRetentionScheduler\(\);/, "called, not merely imported");
  });

  it("S7. /healthz/schedulers reports it by name, never_ran on a fresh process", async () => {
    const src = readFileSync(new URL("../routes/health.ts", import.meta.url), "utf8");
    assert.ok(src.includes("getDiscoveryServeLogRetentionStatus"));
    const base = await serve();
    try {
      const r = await get(base);
      const job = r.body.jobs.find((j: any) => j.job === JOB_KEY);
      assert.ok(job, "the retention job is on the aggregate");
      assert.equal(job.status, "never_ran");
      assert.equal(job.lastRunAt, null);
    } finally {
      await close();
    }
  });

  it("S8. the answer parser admits exactly 3501's shape", () => {
    assert.deepEqual(parsePurgeAnswer({ status: "purged", deleted: "5", more: true, cutoff: "c" }), { status: "purged", deleted: 5, more: true, cutoff: "c" });
    assert.equal(parsePurgeAnswer({ status: "purged", deleted: 1 }), null, "more is required when purged");
    assert.equal(parsePurgeAnswer({ status: "ok", deleted: 1, more: false }), null);
    assert.equal(parsePurgeAnswer([]), null);
    assert.equal(parsePurgeAnswer(null), null);
    assert.equal(DISCOVERY_SERVE_LOG_RETENTION_FLAG, "discovery_serve_log_retention_enabled");
  });
});

// ── plumbing ────────────────────────────────────────────────────────────────
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

let server: http.Server | null = null;
async function serve(): Promise<string> {
  const app = express();
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", healthRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as any).port}`;
}
async function close(): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
}
function get(base: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL("/api/healthz/schedulers", base);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET" }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}
