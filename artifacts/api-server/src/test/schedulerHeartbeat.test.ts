/**
 * lib/schedulerHeartbeat.ts — the one durable record of whether the process
 * running every background scheduler was running at all.
 *
 * WHAT IS ASSERTED
 *   - A stop is MEASURED from the persisted row, not assumed: an old beat read
 *     at boot is a "restart" gap, a late beat inside one process is a "frozen"
 *     gap, and a beat inside the alert window is neither.
 *   - The health entry keeps failing / stale / never_ran / healthy apart.
 *   - A stop is an incident only on a host declared always-on
 *     (PORTAVA_ALWAYS_ON=true): there it reaches Sentry and answers 503 through
 *     the real route for its report window, then returns to 200 by the clock
 *     alone. By default (Autoscale, which sleeps when idle by decision) the
 *     same stop is measured and named in the detail, with no Sentry issue and
 *     no 503.
 *   - A probe that lands on a resumed process beats before it reports, so the
 *     resume reads as a recorded stop and not as a dead timer.
 *   - supabase-js RESOLVES with `error`: a write that "succeeded" with an error
 *     is a failure, and the next real success clears it.
 *   - An unreadable or absent row never invents a gap.
 *   - The route waits for the boot read, but never longer than its timeout.
 *
 * Runtime: node:test + node:assert/strict. The verdict is the exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/schedulerHeartbeat.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
  GAP_ALERT_MS,
  GAP_REPORT_WINDOW_MS,
  HEARTBEAT_STALE_AFTER_MS,
  JOB_KEY,
  _resetSchedulerHeartbeat,
  getSchedulerHeartbeatStatus,
  hydrateSchedulerHeartbeat,
  runSchedulerHeartbeat,
  schedulerHeartbeatReady,
  schedulerHeartbeatReport,
  startSchedulerHeartbeat,
  stopSchedulerHeartbeat,
  stopsAreIncidents,
} from "../lib/schedulerHeartbeat.js";
import { Sentry } from "../lib/sentry.js";
import healthRouter from "../routes/health.js";

interface Upsert { row: Record<string, unknown>; opts: unknown }

function fakeClient(o: {
  row?: Record<string, unknown> | null;
  readError?: unknown;
  upsertError?: unknown;
  upserts?: Upsert[];
  readDelayMs?: number;
} = {}): any {
  return {
    from(table: string) {
      assert.equal(table, "job_health", "the heartbeat touches job_health and nothing else");
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            assert.equal(col, "job");
            assert.equal(val, JOB_KEY);
            return {
              maybeSingle: async () => {
                if (o.readDelayMs) await new Promise((r) => setTimeout(r, o.readDelayMs));
                return { data: o.row ?? null, error: o.readError ?? null };
              },
            };
          },
        }),
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          o.upserts?.push({ row, opts });
          return { error: o.upsertError ?? null };
        },
      };
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

const sentryCalls: unknown[][] = [];
const realCapture = Sentry.captureMessage;
const ALWAYS_ON = "PORTAVA_ALWAYS_ON";
const alwaysOn = () => { process.env[ALWAYS_ON] = "true"; };
beforeEach(() => {
  _resetSchedulerHeartbeat();
  delete process.env[ALWAYS_ON];
  sentryCalls.length = 0;
  (Sentry as any).captureMessage = (...args: unknown[]) => { sentryCalls.push(args); return "id"; };
});
after(() => {
  _resetSchedulerHeartbeat();
  delete process.env[ALWAYS_ON];
  (Sentry as any).captureMessage = realCapture;
});

describe("the beat itself", () => {
  it("writes one job_health row with the attempt and the success at the same instant", async () => {
    const upserts: Upsert[] = [];
    const now = new Date("2026-11-04T12:00:00.000Z");
    const s = await runSchedulerHeartbeat(fakeClient({ upserts }), now);
    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0]!.row, { job: JOB_KEY, last_run_at: now.toISOString(), last_success_at: now.toISOString() });
    assert.deepEqual(upserts[0]!.opts, { onConflict: "job" });
    assert.equal(s.lastSuccessAt, now.toISOString());
    assert.equal(s.consecutiveFailures, 0);
  });

  it("a resolved { error } is a failure, counted, and cleared only by a real success", async () => {
    const now = Date.parse("2026-11-04T12:00:00.000Z");
    await runSchedulerHeartbeat(fakeClient({ upsertError: { code: "42P01", message: "relation does not exist" } }), new Date(now));
    await runSchedulerHeartbeat(fakeClient({ upsertError: { code: "42P01", message: "relation does not exist" } }), new Date(now + 60_000));
    let s = getSchedulerHeartbeatStatus();
    assert.equal(s.consecutiveFailures, 2);
    assert.equal(s.lastSuccessAt, null, "a failed write is not a beat");
    assert.match(s.lastFailure ?? "", /42P01/);
    assert.equal(schedulerHeartbeatReport(now + 60_000).status, "failing");

    await runSchedulerHeartbeat(fakeClient(), new Date(now + 120_000));
    s = getSchedulerHeartbeatStatus();
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastSuccessAt, iso(now + 120_000));
  });

  it("PORTAVA_ALWAYS_ON accepts true or 1, and nothing else", () => {
    assert.equal(stopsAreIncidents(), false, "unset");
    for (const v of ["true", "TRUE", " 1 "]) { process.env[ALWAYS_ON] = v; assert.equal(stopsAreIncidents(), true, v); }
    for (const v of ["", "false", "0", "yes"]) { process.env[ALWAYS_ON] = v; assert.equal(stopsAreIncidents(), false, v); }
  });

  it("no service client is a failure, not a quiet skip", async () => {
    await runSchedulerHeartbeat(null, new Date("2026-11-04T12:00:00.000Z"));
    assert.equal(getSchedulerHeartbeatStatus().consecutiveFailures, 1);
    assert.match(getSchedulerHeartbeatStatus().lastFailure ?? "", /no service client/);
  });
});

describe("a stop is measured from the persisted row at boot", () => {
  it("an old beat is a restart gap; by default it is recorded without a Sentry issue", async () => {
    const boot = Date.parse("2026-11-04T12:00:00.000Z");
    const prev = boot - 6 * 60 * 60_000;
    await hydrateSchedulerHeartbeat(fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }), new Date(boot));
    assert.deepEqual(getSchedulerHeartbeatStatus().lastGap, { from: iso(prev), to: iso(boot), ms: 6 * 60 * 60_000, kind: "restart" });
    assert.equal(sentryCalls.length, 0, "a host that sleeps by decision does not page anyone for sleeping");
  });

  it("on an always-on host the same restart gap is sent to Sentry", async () => {
    alwaysOn();
    const boot = Date.parse("2026-11-04T12:00:00.000Z");
    const prev = boot - 6 * 60 * 60_000; // six hours with no instance running
    await hydrateSchedulerHeartbeat(fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }), new Date(boot));
    const s = getSchedulerHeartbeatStatus();
    assert.equal(s.hydrated, true);
    assert.equal(s.previousBeatAt, iso(prev));
    assert.deepEqual(s.lastGap, { from: iso(prev), to: iso(boot), ms: 6 * 60 * 60_000, kind: "restart" });
    assert.equal(sentryCalls.length, 1, "the stop reaches Sentry when a DSN is set");
    assert.match(String(sentryCalls[0]![0]), /stopped for 360 minute/);
  });

  it("a beat inside the alert window is an ordinary restart, not a stop", async () => {
    const boot = Date.parse("2026-11-04T12:00:00.000Z");
    const prev = boot - (GAP_ALERT_MS - 1_000);
    await hydrateSchedulerHeartbeat(fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }), new Date(boot));
    assert.equal(getSchedulerHeartbeatStatus().lastGap, null);
    assert.equal(sentryCalls.length, 0);
  });

  it("no row at all (the first boot ever) reports no gap", async () => {
    await hydrateSchedulerHeartbeat(fakeClient({ row: null }), new Date("2026-11-04T12:00:00.000Z"));
    const s = getSchedulerHeartbeatStatus();
    assert.equal(s.hydrated, true);
    assert.equal(s.previousBeatAt, null);
    assert.equal(s.lastGap, null);
  });

  it("an unreadable row does not invent a gap, and still marks the boot read done", async () => {
    await hydrateSchedulerHeartbeat(fakeClient({ readError: { message: "permission denied" } }), new Date("2026-11-04T12:00:00.000Z"));
    const s = getSchedulerHeartbeatStatus();
    assert.equal(s.hydrated, true);
    assert.equal(s.lastGap, null);
  });

  it("a row with only last_run_at (an older writer) is still read as the previous beat", async () => {
    const boot = Date.parse("2026-11-04T12:00:00.000Z");
    const prev = boot - 2 * 60 * 60_000;
    await hydrateSchedulerHeartbeat(fakeClient({ row: { last_run_at: iso(prev), last_success_at: null } }), new Date(boot));
    assert.equal(getSchedulerHeartbeatStatus().lastGap?.kind, "restart");
  });
});

describe("a late beat inside one process is a frozen event loop", () => {
  it("measures from the previous ATTEMPT, so a database outage is failing and not frozen", async () => {
    const t0 = Date.parse("2026-11-04T12:00:00.000Z");
    // The loop keeps ticking every minute while every write fails.
    for (let i = 0; i < 15; i++) {
      await runSchedulerHeartbeat(fakeClient({ upsertError: { message: "timeout" } }), new Date(t0 + i * 60_000));
    }
    await runSchedulerHeartbeat(fakeClient(), new Date(t0 + 15 * 60_000));
    assert.equal(getSchedulerHeartbeatStatus().lastGap, null, "fifteen minutes of failed writes is an outage, not a frozen loop");
  });

  it("a timer that fires twenty minutes late records a frozen gap", async () => {
    const t0 = Date.parse("2026-11-04T12:00:00.000Z");
    await runSchedulerHeartbeat(fakeClient(), new Date(t0));
    await runSchedulerHeartbeat(fakeClient(), new Date(t0 + 20 * 60_000));
    const g = getSchedulerHeartbeatStatus().lastGap;
    assert.deepEqual(g, { from: iso(t0), to: iso(t0 + 20 * 60_000), ms: 20 * 60_000, kind: "frozen" });
  });
});

describe("the /healthz/schedulers entry keeps its four states apart", () => {
  it("never_ran when the heartbeat was never started in this process", () => {
    assert.equal(schedulerHeartbeatReport().status, "never_ran");
  });

  it("by default a recent stop is healthy, with the stop and the reason in the detail", async () => {
    const prev = Date.now() - 3 * 60 * 60_000;
    startSchedulerHeartbeat({ client: fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }) });
    await schedulerHeartbeatReady();
    const r = schedulerHeartbeatReport(Date.parse(getSchedulerHeartbeatStatus().lastSuccessAt!) + 1_000);
    assert.equal(r.status, "healthy");
    assert.match(r.detail ?? "", /last stop: background jobs were stopped for 180 min \(no instance was running\)/);
    assert.match(r.detail ?? "", /PORTAVA_ALWAYS_ON is not set/);
  });

  it("on an always-on host a recent stop is stale for its report window, then healthy by the clock alone", async () => {
    alwaysOn();
    const boot = Date.now();
    const prev = boot - 3 * 60 * 60_000;
    startSchedulerHeartbeat({ client: fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }) });
    await schedulerHeartbeatReady();
    const status = getSchedulerHeartbeatStatus();
    assert.ok(status.lastSuccessAt, "the first beat lands at start");

    const soon = schedulerHeartbeatReport(Date.parse(status.lastSuccessAt!) + 1_000);
    assert.equal(soon.status, "stale", "recovered, but the probe that woke the host must learn the jobs were stopped");
    assert.match(soon.detail ?? "", /stopped for 180 min .*running again since/);

    // Beat once a minute past the window (a 30-minute jump in one process would
    // itself be a frozen loop), and the same history reads healthy.
    const first = Date.parse(status.lastSuccessAt!);
    const later = Date.parse(status.lastGap!.to) + GAP_REPORT_WINDOW_MS + 1_000;
    for (let t = first + 60_000; t <= later; t += 60_000) await runSchedulerHeartbeat(fakeClient(), new Date(t));
    assert.equal(getSchedulerHeartbeatStatus().lastGap?.kind, "restart", "regular beats add no gap of their own");
    const healed = schedulerHeartbeatReport(later);
    assert.equal(healed.status, "healthy");
    assert.match(healed.detail ?? "", /last stop: background jobs were stopped for 180 min/);
  });

  it("this process's own beat going quiet for three intervals is stale", async () => {
    startSchedulerHeartbeat({ client: fakeClient({ row: null }) });
    await schedulerHeartbeatReady();
    const t0 = Date.parse(getSchedulerHeartbeatStatus().lastSuccessAt!) + 60_000;
    await runSchedulerHeartbeat(fakeClient(), new Date(t0));
    assert.equal(schedulerHeartbeatReport(t0 + HEARTBEAT_STALE_AFTER_MS - 1_000).status, "healthy");
    assert.equal(schedulerHeartbeatReport(t0 + HEARTBEAT_STALE_AFTER_MS + 1_000).status, "stale");
  });
});

describe("the route waits for the boot read, within a bound", () => {
  it("resolves at once when the heartbeat is not started", async () => {
    const t = Date.now();
    await schedulerHeartbeatReady(5_000);
    assert.ok(Date.now() - t < 500);
  });

  it("does not hang the probe on a database that never answers", async () => {
    startSchedulerHeartbeat({ client: fakeClient({ readDelayMs: 2_000 }) });
    const t = Date.now();
    await schedulerHeartbeatReady(200);
    const waited = Date.now() - t;
    assert.ok(waited >= 150 && waited < 1_500, `waited ${waited} ms`);
  });

  it("beats before reporting when the timer is armed but overdue (a resumed process)", async () => {
    const upserts: Upsert[] = [];
    const client = fakeClient({ row: null, upserts });
    startSchedulerHeartbeat({ client });
    await schedulerHeartbeatReady();
    // The last attempt was twenty minutes ago and the armed timer has not fired
    // yet: what a suspended container looks like to the request that resumes it.
    const suspendedAt = Date.now() - 20 * 60_000;
    await runSchedulerHeartbeat(client, new Date(suspendedAt));
    const before = upserts.length;
    await schedulerHeartbeatReady();
    assert.equal(upserts.length, before + 1, "the probe's wait wrote one beat");
    const s = getSchedulerHeartbeatStatus();
    assert.equal(s.lastGap?.kind, "frozen", "the suspension is recorded, not hidden");
    assert.ok((s.lastGap?.ms ?? 0) >= 20 * 60_000);
    assert.equal(schedulerHeartbeatReport().status, "healthy", "default: disclosed");
    alwaysOn();
    assert.equal(schedulerHeartbeatReport().status, "stale", "always-on: an incident");
  });

  it("does not beat on behalf of a timer that was stopped", async () => {
    const upserts: Upsert[] = [];
    const client = fakeClient({ row: null, upserts });
    startSchedulerHeartbeat({ client });
    await schedulerHeartbeatReady();
    stopSchedulerHeartbeat();
    await runSchedulerHeartbeat(client, new Date(Date.now() - 20 * 60_000));
    const before = upserts.length;
    await schedulerHeartbeatReady();
    assert.equal(upserts.length, before, "a dead loop must read as stale, not be covered for");
    assert.equal(schedulerHeartbeatReport().status, "stale");
  });

  async function getSchedulers(): Promise<{ status: number; body: any }> {
    const app = express();
    app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }; next(); });
    app.use("/api", healthRouter);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as any).port;
      return await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/api/healthz/schedulers" }, (res) => {
          let raw = "";
          res.on("data", (c) => { raw += c; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
        }).on("error", reject);
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("by default a stop measured at boot answers 200 through the real route, and names the stop", async () => {
    const prev = Date.now() - 2 * 60 * 60_000;
    startSchedulerHeartbeat({ client: fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }) });
    const { status, body } = await getSchedulers();
    const hb = (body.jobs as any[]).find((j) => j.job === "schedulerHeartbeat");
    assert.ok(hb, "the heartbeat is reported");
    assert.equal(hb.status, "healthy");
    assert.match(hb.detail ?? "", /stopped for 120 min/);
    assert.equal(status, 200, "a host that sleeps by decision is not failing its probe for sleeping");
  });

  it("on an always-on host a stop measured at boot answers 503 through the real route", async () => {
    alwaysOn();
    const prev = Date.now() - 2 * 60 * 60_000;
    startSchedulerHeartbeat({ client: fakeClient({ row: { last_run_at: iso(prev), last_success_at: iso(prev) } }) });
    const { status, body } = await getSchedulers();
    const hb = (body.jobs as any[]).find((j) => j.job === "schedulerHeartbeat");
    assert.ok(hb, "the heartbeat is reported");
    assert.equal(hb.status, "stale");
    assert.equal(status, 503, "the exact code: a stop of every scheduler is the incident the probe exists for");
  });
});
