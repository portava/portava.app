/**
 * census-layover L261 hardening (lane L-DATA follow-up to #667, verifier V-LD):
 *   1. a session whose compaction FAILED on an earlier page is retried once the
 *      sweep cursor wraps (verifier mutant V4 — cursor never wraps — must die);
 *   2. the per-session cap is enforced for sessions with NO over-age record
 *      (3624's "max 20 per session" is now true for every session);
 *   3. the phase is observable: /healthz/schedulers status + job_health row.
 *
 * Run: node --import tsx/esm --test src/test/layoverSnapshotCompactionHardening.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import { DECISION_PERSISTENCE_FLAG, persistDecision } from "../services/layover/LayoverDecisionStore.js";
import {
  SNAPSHOT_COMPACTION_FLAG,
  SNAPSHOT_RETENTION_POLICY,
  COMPACTION_SWEEP_ROW_LIMIT,
  runSnapshotCompactionSweep,
  _resetSnapshotCompactionCursor,
} from "../services/layover/LayoverDecisionService.js";
import {
  SNAPSHOT_COMPACTION_JOB_KEY,
  runLayoverSnapshotCompactionPhase,
  getLayoverSnapshotCompactionStatus,
  snapshotCompactionHealthDetail,
  _resetLayoverSnapshotCompactionStatus,
} from "../lib/layoverAuditRetentionScheduler.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const OLD = NOW - (SNAPSHOT_RETENTION_POLICY.retentionDays + 10) * DAY;
const INTL = { flightType: "international" as const, immigrationRequired: true };

const airport: FeasibilityAirport = {
  id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};
function session(id: string): FeasibilitySession {
  return {
    id, arrivalTime: new Date(NOW).toISOString(), departureTime: new Date(NOW + 9 * HOUR).toISOString(),
    boardingTime: null, checkedBags: false, wantsToLeave: true, ...INTL,
  };
}
const ON = () => [
  { flag: DECISION_PERSISTENCE_FLAG, enabled: true },
  { flag: SNAPSHOT_COMPACTION_FLAG, enabled: true },
];

/** Store one record; `version` stands in for 3623's trigger, which the double does not model. */
async function stored(t: Record<string, any[]>, nowMs: number, id: string, version?: number): Promise<string> {
  const out = await persistDecision(makeLayoverDb(t) as any, "user-1", id, certifySessionFeasibility(airport, session(id), { nowMs, liveConditions: null }));
  assert.equal(out.ok, true);
  const snap = out.ok ? out.snapshotId : "";
  if (version !== undefined) t.layover_certified_computations.find((r) => r.snapshot_id === snap)!.snapshot_version = version;
  return snap;
}

describe("L261 — a failed session is retried after the cursor wraps (V4)", () => {
  beforeEach(() => _resetSnapshotCompactionCursor());

  it("fails on the first full page, the cursor moves past it, wraps on a short page, and the session is compacted on the retry", async () => {
    const t: Record<string, any[]> = { feature_flags: ON() };
    // The failing session owns the OLDEST row, so it is on the first page.
    const dropMe = await stored(t, OLD - DAY, "flaky");
    await stored(t, NOW - HOUR, "flaky");
    // Fill the rest of the first page and spill onto a short second one.
    for (let i = 0; i < COMPACTION_SWEEP_ROW_LIMIT + 5; i++) await stored(t, OLD + i * 1000, `stale-${i}`);

    let failFlaky = true;
    const base = makeLayoverDb(t) as any;
    const db = {
      ...base,
      from(name: string) {
        const b = base.from(name);
        if (name !== "layover_time_budgets" || !failFlaky) return b;
        const del = b.delete.bind(b);
        b.delete = () => { const q = del(); const eq = q.eq.bind(q); q.eq = (c: string, v: any) => (c === "session_id" && v === "flaky" ? Object.assign(Promise.resolve({ data: null, error: { message: "down" } }), { in: () => Promise.resolve({ data: null, error: { message: "down" } }) }) : eq(c, v)); return q; };
        return b;
      },
    };

    const first = await runSnapshotCompactionSweep(db, new Date(NOW));     // full page: flaky refused
    assert.equal(first.outcome, "failed");
    assert.ok(t.layover_certified_computations.some((r) => r.snapshot_id === dropMe));
    failFlaky = false;
    const second = await runSnapshotCompactionSweep(db, new Date(NOW));    // short page: wraps
    assert.ok(t.layover_certified_computations.some((r) => r.snapshot_id === dropMe), "flaky is not on the second page");
    const third = await runSnapshotCompactionSweep(db, new Date(NOW));     // back at the start: retried
    assert.notEqual(third.outcome, "failed");
    assert.ok(!t.layover_certified_computations.some((r) => r.snapshot_id === dropMe), "the failed session was never retried after the wrap");
    void second;
  });
});

describe("L261 — the per-session cap reaches sessions with no over-age record", () => {
  beforeEach(() => _resetSnapshotCompactionCursor());

  it("a session over the cap, every record young, is compacted to the cap", async () => {
    const t: Record<string, any[]> = { feature_flags: ON() };
    const cap = SNAPSHOT_RETENTION_POLICY.maxPerSession;
    for (let v = 1; v <= cap + 3; v++) await stored(t, NOW - (cap + 10 - v) * HOUR, "busy", v);
    const out = await runSnapshotCompactionSweep(makeLayoverDb(t) as any, new Date(NOW));
    assert.equal(out.dropped, 3);
    const kept = t.layover_certified_computations.filter((r) => r.session_id === "busy");
    assert.equal(kept.length, cap);
    assert.deepEqual(kept.map((r) => r.snapshot_version).sort((a, b) => a - b)[0], 4, "the three OLDEST left");
  });

  it("a session at the cap is not touched", async () => {
    const t: Record<string, any[]> = { feature_flags: ON() };
    const cap = SNAPSHOT_RETENTION_POLICY.maxPerSession;
    for (let v = 1; v <= cap; v++) await stored(t, NOW - (cap + 10 - v) * HOUR, "full", v);
    const out = await runSnapshotCompactionSweep(makeLayoverDb(t) as any, new Date(NOW));
    assert.equal(out.outcome, "idle");
    assert.equal(t.layover_certified_computations.length, cap);
  });
});

describe("L261 — the phase is observable (/healthz/schedulers + job_health)", () => {
  beforeEach(() => { _resetSnapshotCompactionCursor(); _resetLayoverSnapshotCompactionStatus(); });

  it("OFF: healthy-by-success, detail says disabled, and NO job_health row is written", async () => {
    const t: Record<string, any[]> = { feature_flags: [], job_health: [] };
    const s = await runLayoverSnapshotCompactionPhase(makeLayoverDb(t) as any, new Date(NOW));
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastSuccessAt, new Date(NOW).toISOString());
    assert.match(snapshotCompactionHealthDetail(s)!, /disabled/);
    assert.equal(t.job_health.length, 0);
  });

  it("ON and swept: success recorded in memory AND in job_health", async () => {
    const t: Record<string, any[]> = { feature_flags: ON(), job_health: [] };
    await stored(t, OLD, "s1");
    await stored(t, NOW - HOUR, "s1");
    const s = await runLayoverSnapshotCompactionPhase(makeLayoverDb(t) as any, new Date(NOW));
    assert.equal(s.lastResult?.outcome, "swept");
    assert.equal(s.lastResult?.dropped, 1);
    assert.equal(t.job_health.length, 1);
    assert.equal(t.job_health[0].job, SNAPSHOT_COMPACTION_JOB_KEY);
    assert.equal(t.job_health[0].last_success_at, new Date(NOW).toISOString());
  });

  it("ON and failing: counted, and job_health records the attempt WITHOUT a success", async () => {
    const t: Record<string, any[]> = { feature_flags: ON(), job_health: [] };
    await stored(t, OLD, "s1");
    const db = makeLayoverDb(t, { failures: { "layover_certified_computations:select": { message: "down" } } }) as any;
    const s = await runLayoverSnapshotCompactionPhase(db, new Date(NOW));
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.equal(t.job_health[0].last_run_at, new Date(NOW).toISOString());
    assert.ok(!("last_success_at" in t.job_health[0]));
    assert.equal(getLayoverSnapshotCompactionStatus().consecutiveFailures, 1);
  });

  it("no service client is a failure, never a quiet success", async () => {
    const s = await runLayoverSnapshotCompactionPhase(null, new Date(NOW));
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
  });
});
