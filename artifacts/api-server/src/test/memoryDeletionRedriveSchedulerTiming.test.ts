/**
 * Memory deletion redrive scheduler — the driver's LIFECYCLE (census H193).
 *
 * The pass is proved in memoryDeletionEvidencePurge.test.ts. This file proves
 * the loop around it: the first pass waits for its delay, a pass is followed by
 * another (it re-arms), a pass that THROWS still re-arms, and stop() ends the
 * loop — including a stop() that lands while a pass is in flight, which is the
 * re-arm-after-stop defect #627 fixed in this file's siblings.
 *
 * TIMERS ARE REAL, ONLY `Date` IS MOCKED. Mocking setTimeout has hung whole
 * suite runs in two sibling timing tests (RULES addendum 1); the scheduler takes
 * millisecond overrides instead, so real timers finish in tens of milliseconds.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startMemoryDeletionRedriveScheduler,
  stopMemoryDeletionRedriveScheduler,
} from "../lib/memoryDeletionRedriveScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

/** Counts flag reads — one per pass while the flag is off. `throwOnFrom` makes the pass itself throw. */
function stubClient(opts: { throwOnFrom?: boolean; holdMs?: number } = {}) {
  const state = { flagReads: 0 };
  const client = {
    from(_t: string) {
      state.flagReads += 1;
      if (opts.throwOnFrom) throw new Error("client exploded");
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => new Promise((r) => setTimeout(() => r({ data: { enabled: false }, error: null }), opts.holdMs ?? 0)),
      };
      return b;
    },
  } as any;
  return { client, state };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  // performance.now(), not Date.now(): Date is mocked (frozen) in this file.
  const end = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await sleep(2);
  }
}

beforeEach(() => { mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T12:00:00.000Z").getTime() }); });
afterEach(() => {
  stopMemoryDeletionRedriveScheduler();
  mock.timers.reset();
  _setTestServiceClient(null as any);
});

describe("memory deletion redrive scheduler", () => {
  it("waits for its startup delay, then keeps running — a pass is followed by another", async () => {
    const { client, state } = stubClient(); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 60, intervalMs: 5 });
    await sleep(15);
    assert.equal(state.flagReads, 0, "no pass before the startup delay");
    await until(() => state.flagReads >= 3);
  });

  it("a pass whose client fails still re-arms (the failure is a closed flag, not a dead loop)", async () => {
    const { client, state } = stubClient({ throwOnFrom: true }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 2);
  });

  it("stop() ends the loop, even when it lands while a pass is in flight", async () => {
    const { client, state } = stubClient({ holdMs: 30 }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 1); // the first pass is now waiting on its flag read
    stopMemoryDeletionRedriveScheduler();
    const frozen = state.flagReads;
    await sleep(120);
    assert.equal(state.flagReads, frozen, "no pass after stop(): the in-flight pass did not re-arm");
  });

  it("stop() then start() while a pass is in flight runs ONE loop, not the old one beside the new", async () => {
    const { client, state } = stubClient({ holdMs: 25 }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 1); // pass 1 of the OLD loop is in flight; if it re-armed, its next pass is 5 ms after it settles
    stopMemoryDeletionRedriveScheduler();
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1000, intervalMs: 1000 }); // the new loop's first pass is 1 s away
    await sleep(120); // the old pass settles inside this window
    assert.equal(state.flagReads, 1, "the old loop's in-flight pass did not re-arm itself beside the new loop");
  });

  it("starting twice installs one loop: one stop() ends it", async () => {
    const { client, state } = stubClient(); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 40, intervalMs: 40 });
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 1 });
    await sleep(20);
    assert.equal(state.flagReads, 0, "the second start was ignored: its 1 ms delay never ran");
    stopMemoryDeletionRedriveScheduler();
    await sleep(80);
    assert.equal(state.flagReads, 0);
  });
});

// ── census-highlights-memories §AV (H193): the redrive is OBSERVABLE ─────────
// Appended: the census cites this file by line. The redrive reports at
// GET /healthz/schedulers and writes its job_health row on every pass that runs,
// so it does not join lib/schedulerCoverage.ts's unobservable jobs. A flag-OFF
// tick stays one flag read and writes nothing.
import http from "node:http";
import express from "express";
import healthRouter from "../routes/health.js";
import {
  runMemoryDeletionRedriveTick,
  getMemoryDeletionRedriveStatus,
  _resetMemoryDeletionRedriveStatus,
  REDRIVE_JOB_KEY, redriveHealthDetail,
} from "../lib/memoryDeletionRedriveScheduler.js";

/** Every builder method returns the builder; awaiting it (or maybeSingle) yields the table's answer. */
function observedClient(o: {
  flag: boolean;
  letters?: { data: any; error: any };
  memory?: { data: any; error: any };
}) {
  const calls: string[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  const answer = (t: string) =>
    t === "feature_flags" ? { data: { enabled: o.flag }, error: null }
    : t === "memory_deletion_dead_letters" ? (o.letters ?? { data: [], error: null })
    : t === "memories" ? (o.memory ?? { data: null, error: null })
    : { data: null, error: null };
  const client = {
    from(t: string) {
      calls.push(t);
      const b: any = {};
      for (const m of ["select", "eq", "is", "order", "limit", "update"]) b[m] = () => b;
      b.maybeSingle = async () => answer(t);
      b.then = (res: any, rej: any) => Promise.resolve(answer(t)).then(res, rej);
      b.upsert = async (row: Record<string, unknown>, _opts: unknown) => { upserts.push(row); return { data: null, error: null }; };
      return b;
    },
  } as any;
  return { client, calls, upserts };
}

const AT = new Date("2026-10-07T12:00:00.000Z");

describe("memory deletion redrive — observable (§AV)", () => {
  beforeEach(() => { _resetMemoryDeletionRedriveStatus(); });

  it("flag OFF: one flag read, NO job_health write, and the tick is not a failure", async () => {
    const { client, calls, upserts } = observedClient({ flag: false });
    const s = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.deepEqual(calls, ["feature_flags"], "a flag-OFF tick reads the flag and nothing else");
    assert.deepEqual(upserts, []);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastAttemptAt, AT.toISOString());
    assert.equal(s.lastSuccessAt, AT.toISOString());
    assert.equal(s.lastResult?.reason, "disabled");
  });

  it("flag ON, a pass that ran: job_health gets the attempt AND the success", async () => {
    const { client, upserts } = observedClient({ flag: true, letters: { data: [], error: null } });
    const s = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.deepEqual(upserts, [{ job: REDRIVE_JOB_KEY, last_run_at: AT.toISOString(), last_success_at: AT.toISOString() }]);
    assert.equal(s.consecutiveFailures, 0);
    assert.deepEqual(s.lastFailures, []);
  });

  it("flag ON, the open letters unreadable: a FAILURE — job_health gets the attempt only, and failures count up", async () => {
    const { client, upserts } = observedClient({ flag: true, letters: { data: null, error: { code: "57014", message: "statement timeout" } } });
    const s1 = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.equal(s1.consecutiveFailures, 1);
    assert.equal(s1.lastSuccessAt, null, "a pass that could not run never reads as a success");
    assert.deepEqual(upserts, [{ job: REDRIVE_JOB_KEY, last_run_at: AT.toISOString() }], "no last_success_at on a failed pass");
    const s2 = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.equal(s2.consecutiveFailures, 2);
  });

  it("flag ON, a letter whose Memory cannot be read: a FAILURE (left open), not a quiet zero", async () => {
    const letter = { memory_id: "11111111-1111-1111-1111-111111111111", owner_id: "22222222-2222-2222-2222-222222222222", detail: "x", failed_steps: ["EVIDENCE_PURGED"] };
    const { client } = observedClient({ flag: true, letters: { data: [letter], error: null }, memory: { data: null, error: { code: "57014", message: "timeout" } } });
    const s = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.equal(s.lastResult?.unreadable, 1);
    assert.equal(s.consecutiveFailures, 1);
    assert.match(s.lastFailures.join(" "), /1 letter\(s\) could not be read or closed/);
  });

  it("VERIFY-H8 H8-4: flag ON, the letters table ABSENT (3670 unapplied): a FAILURE (not_deployed) — job_health gets the attempt only", async () => {
    const { client, upserts } = observedClient({ flag: true, letters: { data: null, error: { code: "42P01", message: 'relation "public.memory_deletion_dead_letters" does not exist' } } });
    const s = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.equal(s.lastResult?.reason, "not_deployed");
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.match(s.lastFailures.join(" "), /memory_deletion_dead_letters is absent/);
    assert.deepEqual(upserts, [{ job: REDRIVE_JOB_KEY, last_run_at: AT.toISOString() }]);
  });

  it("VERIFY-H8 H8-4: flag ON, the pass THROWS inside its read: a FAILURE (error), never 'healthy, OFF'", async () => {
    const base = observedClient({ flag: true });
    const client = { from(t: string) { if (t === "memory_deletion_dead_letters") throw new Error("client exploded"); return base.client.from(t); } };
    const s = await runMemoryDeletionRedriveTick({ client, now: AT });
    assert.equal(s.lastResult?.reason, "error");
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
  });

  it("VERIFY-H8 H8-4: a throw that escapes the pass itself is caught by the tick as a FAILURE (error), never laundered into 'disabled'", async () => {
    const { client } = observedClient({ flag: true });
    let nowReads = 0;
    // The tick reads `now` once (the attempt time); the pass reads it again after the flag, outside its own try.
    const opts = { client, get now(): Date { nowReads += 1; if (nowReads > 1) throw new Error("escaped the pass"); return AT; } };
    const s = await runMemoryDeletionRedriveTick(opts);
    assert.equal(nowReads, 2, "the pass reached its second read of now");
    assert.equal(s.lastResult?.reason, "error");
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.doesNotMatch(String(redriveHealthDetail(s)), /is OFF/);
  });

  it("no service client: a FAILURE, and nothing is written", async () => {
    const s = await runMemoryDeletionRedriveTick({ client: null, now: AT });
    assert.equal(s.lastResult?.reason, "no_client");
    assert.equal(s.consecutiveFailures, 1);
  });

  it("GET /healthz/schedulers reports it: never_ran before a tick, healthy + 'OFF' after a flag-OFF tick, failing + 503 after a failed one", async () => {
    const app = express();
    app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
    app.use("/api", healthRouter);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port as number;
    const read = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/healthz/schedulers`, { headers: { connection: "close" } });
      const body: any = await res.json();
      return { status: res.status, job: (body.jobs as any[]).find((j) => j.job === REDRIVE_JOB_KEY) };
    };
    try {
      const fresh = await read();
      assert.equal(fresh.job?.status, "never_ran");

      await runMemoryDeletionRedriveTick({ client: observedClient({ flag: false }).client, now: AT });
      const off = await read();
      assert.equal(off.status, 200);
      assert.equal(off.job?.status, "healthy");
      assert.match(String(off.job?.detail), /memory_deletion_redrive_enabled is OFF/);

      await runMemoryDeletionRedriveTick({ client: observedClient({ flag: true, letters: { data: null, error: { message: "boom" } } }).client, now: AT });
      const bad = await read();
      assert.equal(bad.status, 503, "a failing redrive is a failing endpoint");
      assert.equal(bad.job?.status, "failing");
      assert.equal(bad.job?.consecutiveFailures, 1);
      assert.match(String(bad.job?.detail), /could not be read/);
      assert.equal(getMemoryDeletionRedriveStatus().consecutiveFailures, 1);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
