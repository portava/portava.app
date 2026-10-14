/**
 * census-layover L159 — "Operational checkpoints — short-lived operational +
 * bounded diagnostics" — and the tick that also runs L161's fold
 * (lib/layoverOperationalRetentionScheduler.ts, flags 3789 / 3790).
 *
 * node:test + node:assert. A table-backed recording fake, no network.
 *
 *   E  the expiry phase: OFF (the seed) reads ONLY its flag and touches neither
 *      table; ON deletes `layover_checkpoints` and `layover_presence` rows whose
 *      expires_at has passed (the instant itself included — the readers already
 *      hide it) and nothing else; a row renewed between read and delete stays;
 *      a missing table (42P01 / PGRST205) is ABSENT, not a failure and not
 *      "nothing due"; any other error is a failure that deletes nothing; it
 *      reads keys only and logs counts only.
 *   T  the tick: both phases run independently and never reject; a phase that
 *      RAN writes job_health (attempt always, success only on success); a
 *      DISABLED phase writes nothing durable; failures count up and reset.
 *   H  the /healthz/schedulers detail lines say OFF, counts and failures.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverOperationalRetention.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATIONAL_EXPIRY_JOB_KEY,
  TIMING_AGGREGATE_JOB_KEY,
  _resetLayoverOperationalRetentionStatus,
  airportTimingAggregateHealthDetail,
  getAirportTimingAggregateStatus,
  getLayoverOperationalExpiryStatus,
  operationalExpiryHealthDetail,
  runLayoverOperationalExpiryPhase,
  runLayoverOperationalRetentionTick,
} from "../lib/layoverOperationalRetentionScheduler.js";
import { logger } from "../lib/logger.js";

type Row = Record<string, any>;
const NOW = new Date("2026-10-14T12:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

interface FakeOpts {
  flags?: Record<string, boolean | "error">;
  tables?: Record<string, Row[]>;
  /** table -> error answered on the READ */
  readError?: Record<string, { code: string; message: string }>;
  /** table -> error answered on the DELETE */
  deleteError?: Record<string, { code: string; message: string }>;
  /** run between a table's read and its delete (a concurrent writer) */
  beforeDelete?: (table: string, rows: Row[]) => void;
  /** answer for the fold's commit */
  rpc?: (args: any) => { data: unknown; error: unknown };
}

function fakeDb(opts: FakeOpts = {}) {
  const tables = opts.tables ?? {};
  const touched: Array<{ table: string; op: string; select?: string }> = [];
  const jobHealth: Row[] = [];
  const rpcs: any[] = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let cols = "";
    let limitN: number | null = null;
    let payload: Row | null = null;
    const run = async () => {
      touched.push({ table, op, select: cols });
      if (table === "feature_flags") {
        const name = (filters as any).flag;
        const v = opts.flags?.[name];
        if (v === "error") return { data: null, error: { code: "57014", message: "timeout" } };
        return { data: v === undefined ? null : { enabled: v }, error: null };
      }
      if (table === "job_health") {
        if (op !== "upsert") throw new Error("job_health is only upserted");
        jobHealth.push(payload!);
        return { data: null, error: null };
      }
      if (op === "select" && opts.readError?.[table]) return { data: null, error: opts.readError[table] };
      if (op === "delete" && opts.deleteError?.[table]) return { data: null, error: opts.deleteError[table] };
      const all = tables[table] ?? [];
      if (op === "delete") opts.beforeDelete?.(table, all);
      let hit = all.filter((r) => filters.every((f) => f(r)));
      if (op === "select") {
        hit = [...hit].sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));
        if (limitN !== null) hit = hit.slice(0, limitN);
        return { data: hit.map((r) => Object.fromEntries(cols.split(",").map((c) => [c, r[c]]))), error: null };
      }
      for (const r of hit) all.splice(all.indexOf(r), 1);
      return { data: hit.map((r) => Object.fromEntries(cols.split(",").map((c) => [c, r[c]]))), error: null };
    };
    const b: any = {
      select(c: string) { cols = c; return b; },
      eq(c: string, v: unknown) { if (table === "feature_flags" && c === "flag") (filters as any).flag = v; else filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
      lte(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) <= v); return b; },
      lt(c: string, v: string) { filters.push((r) => r[c] != null && String(r[c]) < v); return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      ilike(c: string, v: unknown) { filters.push((r) => String(r[c]).toLowerCase() === String(v).toLowerCase()); return b; },
      maybeSingle() { return run().then((x: any) => (Array.isArray(x.data) ? { data: x.data[0] ?? null, error: x.error } : x)); },
      delete() { op = "delete"; return b; },
      upsert(row: Row) { op = "upsert"; payload = row; return b; },
      then(f: any, r: any) { return run().then(f, r); },
    };
    return b;
  }
  async function rpc(fn: string, args: any) {
    rpcs.push({ fn, args });
    return opts.rpc ? opts.rpc(args) : { data: { status: "committed", inserted: args.p_aggregates.length, deleted: args.p_observation_ids.length }, error: null };
  }
  return { client: { from, rpc }, touched, jobHealth, rpcs, tables };
}

const ON = { layover_operational_expiry_sweep_enabled: true } as const;
const cp = (id: string, expiresInMin: number): Row => ({ id, session_id: `s-${id}`, checkpoint_type: "LANDSIDE_EXIT", expires_at: iso(expiresInMin) });
const pr = (session: string, expiresInMin: number): Row => ({ session_id: session, user_id: `u-${session}`, intents: ["food"], expires_at: iso(expiresInMin) });

describe("E — the L159 expiry phase", () => {
  it("E1 OFF (the seed): ONLY the flag is read; neither table is read or deleted from", async () => {
    const db = fakeDb({ flags: {}, tables: { layover_checkpoints: [cp("a", -60)], layover_presence: [pr("s1", -60)] } });
    const r = await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
    assert.deepEqual([r.outcome, r.deleted, r.tables], ["disabled", 0, []]);
    assert.deepEqual(db.touched.map((t) => t.table), ["feature_flags"]);
    assert.equal(db.tables.layover_checkpoints!.length, 1);
    assert.equal(db.tables.layover_presence!.length, 1);
  });

  it("E2 an UNREADABLE flag is OFF (fail-closed): nothing else is touched", async () => {
    const db = fakeDb({ flags: { layover_operational_expiry_sweep_enabled: "error" }, tables: { layover_checkpoints: [cp("a", -60)] } });
    assert.equal((await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW })).outcome, "disabled");
    assert.deepEqual(db.touched.map((t) => t.table), ["feature_flags"]);
  });

  it("E3 ON: expired checkpoints and presence go — the expiry instant itself included — and nothing unexpired does", async () => {
    const db = fakeDb({
      flags: ON,
      tables: {
        layover_checkpoints: [cp("past", -1), cp("at", 0), cp("future", 1)],
        layover_presence: [pr("p-past", -600), pr("p-future", 30)],
      },
    });
    const r = await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
    assert.equal(r.outcome, "swept");
    assert.equal(r.deleted, 3);
    assert.deepEqual(r.tables.map((t) => [t.table, t.outcome, t.deleted, t.complete]), [["layover_checkpoints", "swept", 2, true], ["layover_presence", "swept", 1, true]]);
    assert.deepEqual(db.tables.layover_checkpoints!.map((x) => x.id), ["future"]);
    assert.deepEqual(db.tables.layover_presence!.map((x) => x.session_id), ["p-future"]);
  });

  it("E4 it reads and returns KEYS only — never a row's contents", async () => {
    const db = fakeDb({ flags: ON, tables: { layover_checkpoints: [cp("a", -5)], layover_presence: [pr("s", -5)] } });
    await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
    const sel = db.touched.filter((t) => t.table !== "feature_flags").map((t) => `${t.table}:${t.op}:${t.select}`);
    assert.deepEqual(sel, ["layover_checkpoints:select:id", "layover_checkpoints:delete:id", "layover_presence:select:session_id", "layover_presence:delete:session_id"]);
  });

  it("E5 a presence row RENEWED between the read and the delete is not taken (the delete re-checks expiry)", async () => {
    const db = fakeDb({
      flags: ON,
      tables: { layover_presence: [pr("renewed", -5), pr("gone", -5)] },
      beforeDelete: (table, rows) => { if (table === "layover_presence") rows.find((x) => x.session_id === "renewed")!.expires_at = iso(120); },
    });
    const r = await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
    assert.equal(r.tables.find((t) => t.table === "layover_presence")!.deleted, 1, "the count is what the database confirmed");
    assert.deepEqual(db.tables.layover_presence!.map((x) => x.session_id), ["renewed"]);
  });

  it("E6 a MISSING table (2992 / 3900 unapplied: 42P01, PGRST205) is ABSENT — reported, not a failure, nothing attempted", async () => {
    const db = fakeDb({
      flags: ON,
      readError: {
        layover_checkpoints: { code: "42P01", message: 'relation "layover_checkpoints" does not exist' },
        layover_presence: { code: "PGRST205", message: "Could not find the table 'public.layover_presence' in the schema cache" },
      },
    });
    const r = await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
    assert.equal(r.outcome, "idle");
    assert.deepEqual(r.tables.map((t) => [t.table, t.outcome, t.reason]), [["layover_checkpoints", "absent", null], ["layover_presence", "absent", null]]);
    assert.equal(db.touched.filter((t) => t.op === "delete").length, 0);
  });

  it("E7 any OTHER read error is FAILED (never 'nothing due', never 'absent'); a refused delete is FAILED and the rows stay", async () => {
    const col = fakeDb({ flags: ON, readError: { layover_checkpoints: { code: "42703", message: "column expires_at does not exist" } } });
    const a = await runLayoverOperationalExpiryPhase({ client: col.client, now: NOW });
    assert.equal(a.outcome, "failed");
    assert.deepEqual([a.tables[0]!.outcome, a.tables[0]!.reason], ["failed", "read_failed"]);
    const del = fakeDb({ flags: ON, tables: { layover_checkpoints: [cp("a", -5)] }, deleteError: { layover_checkpoints: { code: "42501", message: "denied" } } });
    const b = await runLayoverOperationalExpiryPhase({ client: del.client, now: NOW });
    assert.deepEqual([b.outcome, b.tables[0]!.reason, b.deleted], ["failed", "delete_failed", 0]);
    assert.equal(del.tables.layover_checkpoints!.length, 1);
  });

  it("E8 nothing due is IDLE; a full batch is not complete; no client is refused", async () => {
    const idle = fakeDb({ flags: ON, tables: { layover_checkpoints: [cp("f", 5)], layover_presence: [] } });
    assert.equal((await runLayoverOperationalExpiryPhase({ client: idle.client, now: NOW })).outcome, "idle");
    const full = fakeDb({ flags: ON, tables: { layover_checkpoints: [cp("a", -3), cp("b", -2), cp("c", -1)], layover_presence: [] } });
    const r = await runLayoverOperationalExpiryPhase({ client: full.client, now: NOW, batchSize: 2 });
    assert.deepEqual([r.tables[0]!.deleted, r.tables[0]!.complete], [2, false]);
    assert.equal((await runLayoverOperationalExpiryPhase({ client: null, now: NOW })).outcome, "refused");
  });

  it("E9 the pass logs COUNTS only — no id, session or row content", async () => {
    const info = mock.method(logger, "info");
    try {
      const db = fakeDb({ flags: ON, tables: { layover_checkpoints: [cp("cp-secret", -5)], layover_presence: [pr("sess-secret", -5)] } });
      await runLayoverOperationalExpiryPhase({ client: db.client, now: NOW });
      const text = JSON.stringify(info.mock.calls.map((c) => c.arguments));
      assert.match(text, /layover operational expiry pass/);
      assert.doesNotMatch(text, /cp-secret|sess-secret|u-sess|LANDSIDE_EXIT|food/);
    } finally {
      info.mock.restore();
    }
  });
});

describe("T — the tick", () => {
  beforeEach(() => _resetLayoverOperationalRetentionStatus());
  afterEach(() => _resetLayoverOperationalRetentionStatus());

  it("T1 both flags OFF (the seed): each phase reads one flag, nothing is written durably, both read healthy", async () => {
    const db = fakeDb({ flags: {}, tables: { layover_checkpoints: [cp("a", -5)] } });
    const t = await runLayoverOperationalRetentionTick({ client: db.client, now: NOW });
    assert.deepEqual([t.expiry.outcome, t.timing.outcome], ["disabled", "disabled"]);
    assert.deepEqual(db.touched.map((x) => x.table), ["feature_flags", "feature_flags"]);
    assert.deepEqual(db.jobHealth, []);
    assert.equal(db.rpcs.length, 0);
    for (const s of [getLayoverOperationalExpiryStatus(), getAirportTimingAggregateStatus()]) {
      assert.equal(s.consecutiveFailures, 0);
      assert.equal(s.lastSuccessAt, NOW.toISOString());
    }
  });

  it("T2 a phase that RAN writes its job_health row with last_success_at; a failing one writes the attempt only", async () => {
    const db = fakeDb({
      flags: { ...ON, airport_timing_aggregate_enabled: true },
      tables: { layover_checkpoints: [cp("a", -5)], layover_presence: [] },
      readError: { airport_fact_observations: { code: "57014", message: "timeout" } },
    });
    const t = await runLayoverOperationalRetentionTick({ client: db.client, now: NOW });
    assert.deepEqual([t.expiry.outcome, t.timing.outcome], ["swept", "failed"]);
    assert.deepEqual(db.jobHealth, [
      { job: OPERATIONAL_EXPIRY_JOB_KEY, last_run_at: NOW.toISOString(), last_success_at: NOW.toISOString() },
      { job: TIMING_AGGREGATE_JOB_KEY, last_run_at: NOW.toISOString() },
    ]);
    assert.equal(getAirportTimingAggregateStatus().consecutiveFailures, 1);
    assert.equal(getAirportTimingAggregateStatus().lastSuccessAt, null);
    assert.equal(getLayoverOperationalExpiryStatus().consecutiveFailures, 0);
  });

  it("T3 failures count up across ticks and a success resets them; one phase failing never stops the other", async () => {
    const bad = fakeDb({ flags: ON, readError: { layover_checkpoints: { code: "57014", message: "timeout" } } });
    await runLayoverOperationalRetentionTick({ client: bad.client, now: NOW });
    await runLayoverOperationalRetentionTick({ client: bad.client, now: NOW });
    assert.equal(getLayoverOperationalExpiryStatus().consecutiveFailures, 2);
    assert.equal(getAirportTimingAggregateStatus().consecutiveFailures, 0, "the fold phase ran (OFF) and is healthy");
    const good = fakeDb({ flags: ON, tables: { layover_checkpoints: [], layover_presence: [] } });
    await runLayoverOperationalRetentionTick({ client: good.client, now: NOW });
    assert.equal(getLayoverOperationalExpiryStatus().consecutiveFailures, 0);
  });

  it("T4 the tick never rejects: a client that throws everywhere, and no client at all", async () => {
    const throwing = { from() { throw new Error("socket"); }, rpc() { throw new Error("socket"); } };
    const t = await runLayoverOperationalRetentionTick({ client: throwing, now: NOW });
    assert.deepEqual([t.expiry.outcome, t.timing.outcome], ["disabled", "disabled"], "the flag reads throw: fail-closed OFF");
    const none = await runLayoverOperationalRetentionTick({ client: null, now: NOW });
    assert.deepEqual([none.expiry.outcome, none.timing.outcome], ["refused", "refused"]);
    assert.equal(getLayoverOperationalExpiryStatus().consecutiveFailures, 1, "no service client is a misconfiguration, counted");
  });

  it("T5 with the fold ON, the tick commits expired observations through the one transactional door", async () => {
    const rows = Array.from({ length: 10 }, (_, k) => ({
      id: `00000000-0000-4000-8000-${(k + 1).toString(16).padStart(12, "0")}`, airport_ref: "BKK", fact_type: "queue_report_minutes",
      value: 5 + k, observer_kind: "community", observer_id: `tv1-${(k + 1).toString(16).padStart(40, "0")}`,
      observed_at: iso(-100), expires_at: iso(-55),
    }));
    const db = fakeDb({ flags: { airport_timing_aggregate_enabled: true }, tables: { airport_fact_observations: rows, airport_profiles: [{ iata_code: "BKK", timezone: "Asia/Bangkok" }] } });
    const t = await runLayoverOperationalRetentionTick({ client: db.client, now: NOW });
    assert.equal(t.timing.outcome, "folded");
    assert.equal(db.rpcs.length, 1);
    assert.equal(db.rpcs[0].fn, "airport_timing_fold_commit");
    assert.equal(db.rpcs[0].args.p_aggregates.length, 1);
    assert.deepEqual(db.jobHealth.map((j) => j.job), [TIMING_AGGREGATE_JOB_KEY]);
  });
});

describe("H — the health detail lines", () => {
  it("H1 OFF, never-ran, counts and failures each read as what they are", () => {
    assert.equal(operationalExpiryHealthDetail({ lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null }), undefined);
    assert.match(operationalExpiryHealthDetail({ lastAttemptAt: "x", lastSuccessAt: "x", consecutiveFailures: 0, lastResult: { outcome: "disabled", reason: null, tables: [], deleted: 0 } })!, /disabled \(layover_operational_expiry_sweep_enabled is OFF\)/);
    const swept = operationalExpiryHealthDetail({
      lastAttemptAt: "x", lastSuccessAt: "x", consecutiveFailures: 0,
      lastResult: { outcome: "swept", reason: null, deleted: 3, tables: [
        { table: "layover_checkpoints", outcome: "swept", reason: null, deleted: 3, complete: false },
        { table: "layover_presence", outcome: "absent", reason: null, deleted: 0, complete: true },
      ] },
    })!;
    assert.match(swept, /layover_checkpoints swept, 3 deleted, backlog remains/);
    assert.match(swept, /layover_presence absent, 0 deleted/);
    assert.match(airportTimingAggregateHealthDetail({ lastAttemptAt: "x", lastSuccessAt: "x", consecutiveFailures: 0, lastResult: {
      outcome: "disabled", reason: null, read: 0, airports: 0, airportsCommitted: 0, airportsFailed: 0, aggregatesWritten: 0, observationsDeleted: 0, bandsWithheld: 0, unusable: 0, held: 0, complete: true,
    } })!, /disabled \(airport_timing_aggregate_enabled is OFF\)/);
    assert.match(airportTimingAggregateHealthDetail({ lastAttemptAt: "x", lastSuccessAt: null, consecutiveFailures: 1, lastResult: {
      outcome: "partial", reason: "airport_failed", read: 30, airports: 3, airportsCommitted: 2, airportsFailed: 1, aggregatesWritten: 2, observationsDeleted: 20, bandsWithheld: 1, unusable: 4, held: 5, complete: false,
    } })!, /partial \(airport_failed\), 30 due observation\(s\), 2 band\(s\) written, 20 observation\(s\) deleted, 1 band\(s\) withheld below the floor, 4 unusable, 5 held for an hour still open, 1 airport\(s\) failed, backlog remains/);
  });
});
