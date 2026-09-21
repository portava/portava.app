/**
 * GET /api/healthz/schedulers — the one readable verdict for ten background
 * jobs whose health was computed and then dropped on the floor.
 *
 * WHY THIS EXISTS
 * ---------------
 * Eight scheduler status getters had ZERO CALLERS anywhere in the tree:
 * `getReconcileStatus` (inviteSlotReconciler), three separate `getSweepStatus`
 * (zombieTokenSweeper, eventWaitlistSweeper, rentBuddyRequestSweeper),
 * `getSweeperStatus` (inviteSlotSweeper), `callSweepFailureState`,
 * `getLiveShareSweepStatus` and `getNotificationMaintenanceStatus`. Each of
 * them maintained `consecutiveFailures` on every tick. Every one of those
 * counters was written and never read. A job that fails on every tick for days
 * and reports nothing an operator can read is indistinguishable from a job
 * that is working.
 *
 * WHAT IS ASSERTED, AND THE TRAPS AVOIDED
 * ---------------------------------------
 *   - The exact STATUS CODE, never merely `!== 200`: 503 when something is
 *     failing, 200 when nothing is. `status !== 200` is satisfied by a 404
 *     from an unmounted route and by a 500 from a crash.
 *   - Reachability through the COMPOSED router (routes/index.ts), the object
 *     the server actually mounts — not the health router in isolation, which
 *     would prove the handler works and nothing about whether it is reachable.
 *   - `req.log` is installed, because the real server installs it. Omitting it
 *     turns a handler throw into a 500 that reads like a considered refusal.
 *   - The server binds the explicit loopback address AND is awaited THROUGH
 *     the listening callback.
 *   - The verdicts are driven by REAL passes through `reconcileInviteSlots()`
 *     with an injected client, not by poking the status object, so the
 *     endpoint and the scheduler are proven to agree.
 *   - VACUITY: the job list is asserted non-empty and by exact name set. An
 *     aggregate that reports on nothing is a green light that means nothing.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). The verdict is the
 * exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/healthSchedulers.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import express, { type Express } from "express";

import { reconcileInviteSlots } from "../lib/inviteSlotReconciler.js";
import healthRouter from "../routes/health.js";

const PATH = "/api/healthz/schedulers";

/** The exact set the aggregate must cover. A job dropped from it is a job that
 *  goes back to being unreadable, so the set is pinned by name. */
const EXPECTED_JOBS = [
  "inviteSlotReconciler",
  "zombieTokenSweeper",
  "eventWaitlistSweeper",
  "rentBuddyRequestSweeper",
  "inviteSlotSweeper",
  "callSweepScheduler",
  "tripCrewLiveShareScheduler",
  "notificationMaintenanceScheduler",
  "dailyBriefCleanup",
  "suggestionSeenCleanup",
].sort();

// ── HTTP plumbing ────────────────────────────────────────────────────────────

interface Reply { status: number; body: any }

function get(base: string, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET" },
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
  const l: any = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
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
  // listen(0, host) resolves the host on a later tick, so address() is null
  // immediately after the call — await the listening callback.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as any;
  return `http://127.0.0.1:${addr.port}`;
}

/** A client whose only job is to answer the reconciler's RPC. */
function rpcClient(answer: { data: any; error: any }) {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async rpc(_fn: string, _args: any) { return answer; },
  } as any;
}

let base = "";
let composedBase = "";

before(async () => {
  base = await serve(healthRouter);
  const { default: composedRouter } = await import("../routes/index.js");
  composedBase = await serve(composedRouter);
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// ═══════════════════════════════════════════════════════════════════════════

describe("reachability", () => {
  it("the path is MOUNTED on the composed router the server uses", async () => {
    const r = await get(composedBase, PATH);
    assert.notEqual(r.status, 404, "404 would mean nothing claims this path in routes/index.ts");
    assert.equal(typeof r.body?.overall, "string");
  });
});

describe("the aggregate covers every job — vacuity is failure", () => {
  it("reports on a non-empty, exact set of jobs", async () => {
    const r = await get(base, PATH);
    assert.equal(r.status, 200);
    const jobs = (r.body?.jobs ?? []) as Array<{ job: string }>;
    assert.ok(jobs.length > 0, "an aggregate that reports on nothing is a green light that means nothing");
    assert.equal(jobs.length, EXPECTED_JOBS.length);
    assert.deepEqual(jobs.map((j) => j.job).sort(), EXPECTED_JOBS);
    assert.equal(r.body.jobCount, EXPECTED_JOBS.length);
  });
});

describe("never_ran is distinguished, and does NOT alarm", () => {
  it("a fresh process reports never_ran for every job that tracks a run, at 200", async () => {
    const r = await get(base, PATH);
    // 200, not 503: 'never ran' is the correct state for the first minute of a
    // process's life, and a check that flaps on every deploy gets muted.
    assert.equal(r.status, 200);
    assert.equal(r.body.overall, "never_ran");
    assert.equal(r.body.failingCount, 0);
    const byJob = new Map((r.body.jobs as any[]).map((j) => [j.job, j]));
    for (const name of ["inviteSlotReconciler", "zombieTokenSweeper", "eventWaitlistSweeper",
                        "rentBuddyRequestSweeper", "inviteSlotSweeper", "tripCrewLiveShareScheduler",
                        "notificationMaintenanceScheduler", "dailyBriefCleanup", "suggestionSeenCleanup"]) {
      assert.equal(byJob.get(name)?.status, "never_ran", `${name} has not run and must say so`);
      assert.equal(byJob.get(name)?.lastRunAt, null);
    }
  });

  it("a job that exports no run timestamp is 'unknown', not borrowed 'healthy'", async () => {
    const r = await get(base, PATH);
    const calls = (r.body.jobs as any[]).find((j) => j.job === "callSweepScheduler");
    assert.equal(
      calls.status,
      "unknown",
      "callSweepScheduler keeps no lastRunAt, so a zero failure counter cannot prove it ever ticked",
    );
    assert.equal(r.body.unknownCount, 1);
  });
});

describe("failing is distinguished, and the STATUS CODE is the verdict", () => {
  it("a real failing pass makes the endpoint answer 503", async () => {
    // Drive the scheduler for real. The RPC resolves with an error — which is
    // how supabase-js reports a failure; it does not throw.
    const out = await reconcileInviteSlots({
      client: rpcClient({ data: null, error: { message: "relation does not exist", code: "42P01" } }),
    });
    assert.ok(out.error, "the injected failure must actually have reached the scheduler");

    const r = await get(base, PATH);
    assert.equal(r.status, 503, "an operator's probe must learn 'a job is down' from the code, not the body");
    assert.equal(r.body.overall, "failing");
    assert.equal(r.body.failingCount, 1);
    const job = (r.body.jobs as any[]).find((j) => j.job === "inviteSlotReconciler");
    assert.equal(job.status, "failing");
    assert.equal(job.consecutiveFailures, 1);
    assert.equal(job.lastRunAt, null, "a failed pass is not a run");
  });

  it("repeated failure is counted, not collapsed to a boolean", async () => {
    await reconcileInviteSlots({
      client: rpcClient({ data: null, error: { message: "relation does not exist", code: "42P01" } }),
    });
    const r = await get(base, PATH);
    assert.equal(r.status, 503);
    const job = (r.body.jobs as any[]).find((j) => j.job === "inviteSlotReconciler");
    assert.equal(job.consecutiveFailures, 2);
  });
});

describe("healthy is distinguished, and recovery clears the alarm", () => {
  it("a real successful pass returns the endpoint to 200 and the job to healthy", async () => {
    const out = await reconcileInviteSlots({ client: rpcClient({ data: [], error: null }) });
    assert.equal(out.error, null);

    const r = await get(base, PATH);
    assert.equal(r.status, 200, "the failure counter resets only on a pass that genuinely succeeded");
    assert.equal(r.body.failingCount, 0);
    const job = (r.body.jobs as any[]).find((j) => j.job === "inviteSlotReconciler");
    assert.equal(job.status, "healthy");
    assert.equal(job.consecutiveFailures, 0);
    assert.ok(job.lastRunAt, "a successful pass records when it ran");
    // The other jobs still have not run — so the aggregate is never_ran, not
    // healthy. Collapsing those two would be the whole bug again.
    assert.equal(r.body.overall, "never_ran");
    assert.ok(r.body.neverRanCount > 0);
  });
});

describe("the eight previously-unreadable getters are actually wired in", () => {
  it("routes/health.ts imports every one of them", () => {
    const src = readFileSync(new URL("../routes/health.ts", import.meta.url), "utf8");
    for (const getter of [
      "getReconcileStatus",
      "getSweepStatus as getZombieTokenSweepStatus",
      "getSweepStatus as getEventWaitlistSweepStatus",
      "getSweepStatus as getBuddyRequestSweepStatus",
      "getSweeperStatus as getInviteSlotSweeperStatus",
      "callSweepFailureState",
      "getLiveShareSweepStatus",
      "getNotificationMaintenanceStatus",
    ]) {
      assert.ok(src.includes(getter), `health.ts must read ${getter} — it had no other caller in the tree`);
    }
  });
});
