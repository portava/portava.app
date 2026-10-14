/**
 * census-layover L161 — "Aggregate airport timing — may persist after
 * de-identification/aggregation" (services/layover/AirportTimingAggregate.ts,
 * migration 3790).
 *
 * node:test + node:assert. A recording fake client, no network, no database.
 *
 * What is proved here:
 *   F  the pure fold: one band per (fact, local hour) with ≥ 10 distinct
 *      observers (OQ-5's fail-closed k), withheld below it, percentiles that
 *      read like the live model's, an hour-aligned window, and every due row —
 *      folded or not — listed for deletion; closure reports, implausible or
 *      unplaceable readings are deleted without contributing.
 *   I  de-identification: the fold passes `assertNoObserverIdentifiers`, a
 *      planted handle or row id in it THROWS, and the stored row type is exactly
 *      3790's identifier-free column list.
 *   P  the pass: OFF reads ONLY the flag (no observation read, no write, no
 *      delete); ON reads expired community rows only, commits per airport
 *      through the ONE transactional door, never sends a handle into an
 *      aggregate, and a failed read / unreadable timezone / refused commit
 *      deletes nothing.
 *   G  the prohibition: nothing outside the writer reads the table or imports
 *      the module — no buffer, rating, ranking or maturity code — with a
 *      planted violation proving the guard can fail.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/airportTimingAggregate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIRPORT_TIMING_FACT_TYPES,
  PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS,
  foldAirportTimingWindow,
  resolveAirportTimezone,
  runAirportTimingFoldPhase,
  timingAggregateRowsFor,
  type AirportTimingFold,
  type DueObservationRow,
} from "../services/layover/AirportTimingAggregate.js";
import { MIN_DISTINCT_OBSERVERS_PER_BAND, assertNoObserverIdentifiers } from "../services/layover/LayoverObservationAggregate.js";
import { TRAVELLER_SUBMITTABLE_FACT_TYPES } from "../services/layover/LayoverObservationService.js";
import { MIN_SAMPLES_PER_BAND, buildHistoricalModel, type AirportObservation } from "../services/airport/LayoverAirportTruth.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const M3790 = readFileSync(join(SRC, "migrations", "3790_airport_timing_aggregates.sql"), "utf8");

/** 07:10 Asia/Bangkok (UTC+7) = 00:10Z. */
const BASE = Date.parse("2026-10-14T00:10:00.000Z");
const NOW = new Date("2026-10-14T02:00:00.000Z");

let seq = 0;
const rid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const handle = (n: number) => `tv1-${n.toString(16).padStart(40, "0")}`;

function obs(over: Partial<DueObservationRow> & { observer?: number; minute?: number } = {}): DueObservationRow {
  const { observer = 1, minute = 0, ...rest } = over;
  return {
    id: rid(),
    airport_ref: "BKK",
    fact_type: "queue_report_minutes",
    value: 10,
    observer_id: handle(observer),
    observed_at: new Date(BASE + minute * 60_000).toISOString(),
    ...rest,
  };
}

/** `observers` distinct people in one local hour, plus `extra` more readings by observer 1. */
function band(observers: number, extra = 0, over: Partial<DueObservationRow> = {}, values?: number[]): DueObservationRow[] {
  const rows: DueObservationRow[] = [];
  for (let k = 0; k < observers + extra; k++) {
    rows.push(obs({ observer: k < observers ? k + 1 : 1, minute: k % 40, value: values ? values[k % values.length]! : 5 + k, ...over }));
  }
  return rows;
}

describe("F — the pure fold", () => {
  it("F1 ten distinct observers in one local hour are ONE band, at the airport's local hour, with every row listed for deletion", () => {
    const rows = band(10, 2);
    const { fold, evidence, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    assert.equal(fold.bands.length, 1);
    const b = fold.bands[0]!;
    assert.equal(b.localHour, 7, "00:10Z is 07:10 in Bangkok");
    assert.equal(b.samples, 12);
    assert.equal(b.distinctObservers, 10);
    assert.equal(fold.withheldBands, 0);
    assert.deepEqual(new Set(evidence[0]), new Set(rows.map((r) => r.id)));
    assert.deepEqual(observationIds, rows.map((r) => r.id));
  });

  it("F2 NINE distinct observers (however many readings) are WITHHELD — counted, never published, still deleted", () => {
    const rows = band(9, 30);
    const { fold, evidence, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    assert.deepEqual(fold.bands, []);
    assert.deepEqual(evidence, []);
    assert.equal(fold.withheldBands, 1);
    assert.equal(observationIds.length, 39, "a withheld band's raw rows are deleted at expiry too — no grace by another name");
  });

  it("F3 the floor is OQ-5's fail-closed k = 10, stricter than the live aggregate's 3, and the database holds the same number", () => {
    assert.equal(PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS, 10);
    assert.ok(PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS > MIN_DISTINCT_OBSERVERS_PER_BAND);
    assert.ok(PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS >= MIN_SAMPLES_PER_BAND);
    const check = /CONSTRAINT airport_timing_aggregates_k_floor CHECK \(distinct_observers >= (\d+)\)/.exec(M3790);
    assert.equal(Number(check?.[1]), PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS, "3790's CHECK");
    const fn = /IF v_d < (\d+) THEN/.exec(M3790);
    assert.equal(Number(fn?.[1]), PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS, "3790's function re-count");
  });

  it("F4 percentiles are the live model's nearest-rank percentiles over the same readings", () => {
    const values = [3, 9, 4, 12, 7, 25, 6, 8, 15, 5, 11, 30];
    const rows = band(12, 0, {}, values);
    const { fold } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    const live: AirportObservation[] = rows.map((r) => ({
      observationId: r.id, airportRef: "BKK", factType: "queue_report_minutes", value: Number(r.value),
      observerKind: "community", observerId: r.observer_id, observedAt: r.observed_at, sourceRef: "x",
    }));
    const model = buildHistoricalModel(live, { nowMs: BASE + 41 * 60_000, factType: "queue_report_minutes", airportRef: "BKK", localHourOf: () => 7 });
    const lb = model.bands.find((x) => x.hour === 7)!;
    const b = fold.bands[0]!;
    assert.deepEqual([b.p50, b.p75, b.p90], [lb.p50, lb.p75, lb.p90]);
    assert.deepEqual([b.p50, b.p75, b.p90], [8, 12, 25]);
  });

  it("F5 the window is hour-aligned: floor-hour of the earliest reading to floor-hour of the latest + 1 h, nothing finer", () => {
    const rows = [...band(10, 0), obs({ observer: 50, minute: 115 })]; // 02:05Z is 09:05 local: another hour, its own (withheld) group
    const { fold } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    assert.equal(fold.bands[0]!.windowStart, "2026-10-14T00:00:00.000Z");
    assert.equal(fold.bands[0]!.windowEnd, "2026-10-14T01:00:00.000Z");
    assert.equal(fold.withheldBands, 1);
    const spread = band(10, 0).map((r, i) => ({ ...r, observed_at: new Date(BASE + i * 24 * 3_600_000).toISOString() }));
    const across = foldAirportTimingWindow("BKK", spread, "Asia/Bangkok").fold.bands[0]!;
    assert.equal(across.windowStart, "2026-10-14T00:00:00.000Z");
    assert.equal(across.windowEnd, "2026-10-23T01:00:00.000Z", "a backlog spanning days is one band per local hour, its window spanning them");
  });

  it("F6 closure reports, implausible / non-finite values and unparseable instants are deleted without contributing", () => {
    const rows = [
      ...band(10),
      obs({ fact_type: "closure_reported", value: 1, observer: 60 }),
      obs({ value: 100_000, observer: 61 }),
      obs({ value: "NaN", observer: 62 }),
      obs({ observed_at: "not a date", observer: 63 }),
    ];
    const { fold, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    assert.equal(fold.unusable, 4);
    assert.equal(fold.bands[0]!.samples, 10);
    assert.equal(observationIds.length, 14);
  });

  it("F7 an airport whose zone cannot be established publishes nothing and still deletes every expired row", () => {
    for (const tz of [null, "Not/AZone"]) {
      const rows = band(12);
      const { fold, observationIds } = foldAirportTimingWindow("BKK", rows, tz);
      assert.deepEqual(fold.bands, []);
      assert.equal(fold.unusable, 12);
      assert.equal(observationIds.length, 12);
    }
  });

  it("F8 facts and hours are separate bands, in a stable order", () => {
    const rows = [...band(10, 0, { fact_type: "queue_report_minutes" }), ...band(10, 0, { fact_type: "checkpoint_timing_minutes" })];
    const { fold, evidence } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok");
    assert.deepEqual(fold.bands.map((b) => b.factType), ["checkpoint_timing_minutes", "queue_report_minutes"]);
    assert.equal(evidence.length, 2);
    assert.equal(new Set([...evidence[0]!, ...evidence[1]!]).size, 20, "no reading is claimed twice");
  });

  it("F9 a row of another airport is refused rather than folded into this one", () => {
    assert.throws(() => foldAirportTimingWindow("BKK", [...band(10), obs({ airport_ref: "SIN" })], "Asia/Bangkok"), /another airport/);
  });
});

describe("I — de-identification by type and by assertion", () => {
  it("I1 the fold carries no handle, no row id and no instant below the hour", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10, 5), "Asia/Bangkok");
    const text = JSON.stringify(fold);
    assert.doesNotMatch(text, /tv1-[0-9a-f]{40}/);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const b of fold.bands) {
      assert.match(b.windowStart, /T\d\d:00:00\.000Z$/);
      assert.match(b.windowEnd, /T\d\d:00:00\.000Z$/);
    }
  });

  it("I2 POSITIVE CONTROL: a handle or a row id planted anywhere in a fold THROWS, in the fold and in the row mapper", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10), "Asia/Bangkok");
    const withHandle = { ...fold, bands: [{ ...fold.bands[0]!, note: handle(7) }] } as unknown as AirportTimingFold;
    assert.throws(() => assertNoObserverIdentifiers(withHandle), /observer identifier/);
    assert.throws(() => timingAggregateRowsFor(withHandle), /observer identifier/);
    const withRowId = { ...fold, evidence: [rid()] } as unknown as AirportTimingFold;
    assert.throws(() => assertNoObserverIdentifiers(withRowId), /bare UUID/);
  });

  it("I3 an airport filed under its profile id (a bare UUID that belongs to an AIRPORT) is exempt by path, not by pattern", () => {
    const ref = "11111111-2222-4333-8444-555555555555";
    const rows = band(10).map((r) => ({ ...r, airport_ref: ref }));
    const { fold } = foldAirportTimingWindow(ref, rows, "Asia/Bangkok");
    assert.equal(timingAggregateRowsFor(fold)[0]!.airport_ref, ref);
  });

  it("I4 the stored row is EXACTLY 3790's column list less the two the database assigns", () => {
    const m = /CREATE TABLE IF NOT EXISTS public\.airport_timing_aggregates \(([\s\S]*?)\n\);/.exec(M3790);
    assert.ok(m, "3790's CREATE TABLE");
    const columns = m![1]!.split("\n").map((l) => /^\s{2}([a-z_0-9]+)\s+(?:uuid|text|smallint|integer|numeric|timestamptz)\b/.exec(l)?.[1]).filter(Boolean).sort();
    assert.deepEqual(columns, ["airport_ref", "distinct_observers", "fact_type", "folded_at", "id", "local_hour", "p50_minutes", "p75_minutes", "p90_minutes", "sample_count", "truth_version", "window_end", "window_start"]);
    const { fold } = foldAirportTimingWindow("BKK", band(10), "Asia/Bangkok");
    const row = timingAggregateRowsFor(fold)[0]!;
    assert.deepEqual(Object.keys(row).sort(), columns.filter((c) => c !== "id" && c !== "folded_at"));
    const post = /IF cols IS DISTINCT FROM ARRAY\[([\s\S]*?)\]::TEXT\[\]/.exec(M3790);
    assert.deepEqual([...post![1]!.matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]).sort(), columns, "3790's postcondition pins the same set");
  });

  it("I5 the timing facts are the traveller-submittable set minus the one state fact, and exactly 3790's CHECK", () => {
    assert.deepEqual([...AIRPORT_TIMING_FACT_TYPES].sort(), TRAVELLER_SUBMITTABLE_FACT_TYPES.filter((t) => t !== "closure_reported").sort());
    const check = /fact_type\s+text\s+NOT NULL CHECK \(fact_type IN \(([^)]*)\)\)/.exec(M3790);
    assert.deepEqual([...check![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort(), [...AIRPORT_TIMING_FACT_TYPES].sort());
  });
});

// ── a recording fake client ──────────────────────────────────────────────────

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; select?: string; limit?: number; order?: string };

function fakeClient(opts: {
  flag?: boolean | "error";
  rows?: DueObservationRow[];
  readError?: { code: string; message: string };
  profiles?: Record<string, string | null | "error">;
  rpc?: (args: any) => { data: unknown; error: unknown };
} = {}) {
  const calls: Call[] = [];
  const rpcs: Array<{ fn: string; args: any }> = [];
  function from(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const run = async (): Promise<{ data: unknown; error: unknown }> => {
      if (table === "feature_flags") {
        if (opts.flag === "error") return { data: null, error: { code: "57014", message: "timeout" } };
        return { data: { enabled: opts.flag === true }, error: null };
      }
      if (table === "airport_fact_observations") {
        if (opts.readError) return { data: null, error: opts.readError };
        const cutoff = call.filters.find((f) => f[0] === "lte")?.[2] as string;
        let rows = (opts.rows ?? []).filter((r) => (r as any).__expires === undefined || (r as any).__expires <= cutoff);
        if (call.limit !== undefined) rows = rows.slice(0, call.limit);
        return { data: rows.map(({ __expires, ...r }: any) => r), error: null };
      }
      if (table === "airport_profiles") {
        const ref = String(call.filters.find((f) => f[1] === "id" || f[1] === "iata_code")?.[2]);
        const p = opts.profiles?.[ref.toUpperCase()] ?? opts.profiles?.[ref];
        if (p === "error") return { data: null, error: { code: "08006", message: "down" } };
        return { data: p === undefined ? null : { timezone: p }, error: null };
      }
      throw new Error(`unexpected table ${table}`);
    };
    const b: any = {
      select(c: string) { call.select = c; return b; },
      eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return b; },
      ilike(c: string, v: unknown) { call.filters.push(["ilike", c, v]); return b; },
      in(c: string, v: unknown) { call.filters.push(["in", c, v]); return b; },
      lte(c: string, v: unknown) { call.filters.push(["lte", c, v]); return b; },
      order(c: string) { call.order = c; return b; },
      limit(n: number) { call.limit = n; return b; },
      maybeSingle() { return run(); },
      insert() { call.op = "insert"; return b; },
      update() { call.op = "update"; return b; },
      delete() { call.op = "delete"; return b; },
      upsert() { call.op = "upsert"; return b; },
      then(f: any, r: any) { return run().then(f, r); },
    };
    return b;
  }
  async function rpc(fn: string, args: any) {
    rpcs.push({ fn, args });
    if (opts.rpc) return opts.rpc(args);
    return { data: { status: "committed", inserted: args.p_aggregates.length, deleted: args.p_observation_ids.length }, error: null };
  }
  return { client: { from, rpc }, calls, rpcs };
}

describe("P — the pass", () => {
  it("P1 OFF (the seed): ONLY the flag is read — no observation read, no commit, nothing written or deleted", async () => {
    const f = fakeClient({ flag: false, rows: band(10) });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.equal(r.outcome, "disabled");
    assert.deepEqual(f.calls.map((c) => c.table), ["feature_flags"]);
    assert.equal(f.rpcs.length, 0);
  });

  it("P2 an UNREADABLE flag is OFF: nothing else is touched", async () => {
    const f = fakeClient({ flag: "error", rows: band(10) });
    assert.equal((await runAirportTimingFoldPhase({ client: f.client, now: NOW })).outcome, "disabled");
    assert.deepEqual(f.calls.map((c) => c.table), ["feature_flags"]);
    assert.equal(f.rpcs.length, 0);
  });

  it("P3 ON: reads only EXPIRED COMMUNITY traveller rows, ids/handles/values only, oldest expiry first, bounded", async () => {
    const f = fakeClient({ flag: true, rows: [], profiles: { BKK: "Asia/Bangkok" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW, batchSize: 7 });
    assert.equal(r.outcome, "idle");
    const read = f.calls.find((c) => c.table === "airport_fact_observations")!;
    assert.equal(read.select, "id,airport_ref,fact_type,value,observer_id,observed_at");
    assert.deepEqual(read.filters.filter((x) => x[0] === "eq"), [["eq", "observer_kind", "community"]]);
    assert.deepEqual(read.filters.find((x) => x[0] === "in"), ["in", "fact_type", [...TRAVELLER_SUBMITTABLE_FACT_TYPES]]);
    assert.deepEqual(read.filters.find((x) => x[0] === "lte"), ["lte", "expires_at", NOW.toISOString()], "the cutoff is NOW: raw deleted at expiry, no grace (OQ-5)");
    assert.equal(read.order, "expires_at");
    assert.equal(read.limit, 7);
    assert.equal(f.rpcs.length, 0, "nothing due: no commit");
  });

  it("P4 ON: one commit per airport through airport_timing_fold_commit — identifier-free aggregates, aligned evidence, every due id, the cutoff", async () => {
    const bkk = band(10, 2);
    const sin = band(9, 0, { airport_ref: "SIN" });
    const f = fakeClient({ flag: true, rows: [...bkk, ...sin], profiles: { BKK: "Asia/Bangkok", SIN: "Asia/Singapore" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.equal(r.outcome, "folded");
    assert.equal(f.rpcs.length, 2);
    assert.ok(f.rpcs.every((x) => x.fn === "airport_timing_fold_commit"));
    const a = f.rpcs.find((x) => x.args.p_observation_ids.includes(bkk[0]!.id))!.args;
    assert.equal(a.p_cutoff, NOW.toISOString());
    assert.deepEqual(a.p_observation_ids, bkk.map((x) => x.id));
    assert.equal(a.p_aggregates.length, 1);
    assert.equal(a.p_evidence.length, 1);
    assert.equal(a.p_aggregates[0].distinct_observers, 10);
    assert.equal(a.p_aggregates[0].sample_count, a.p_evidence[0].length);
    assert.doesNotMatch(JSON.stringify(a.p_aggregates), /tv1-|[0-9a-f]{8}-[0-9a-f]{4}-/i, "no handle and no row id in what is stored");
    const s = f.rpcs.find((x) => x.args.p_observation_ids.includes(sin[0]!.id))!.args;
    assert.deepEqual(s.p_aggregates, [], "nine observers: nothing published …");
    assert.equal(s.p_observation_ids.length, 9, "… and the expired rows still go");
    assert.deepEqual(
      { read: r.read, airports: r.airports, committed: r.airportsCommitted, written: r.aggregatesWritten, deleted: r.observationsDeleted, withheld: r.bandsWithheld, complete: r.complete },
      { read: 21, airports: 2, committed: 2, written: 1, deleted: 21, withheld: 1, complete: true },
    );
  });

  it("P5 a failed observation read is FAILED and commits nothing — never 'nothing due'", async () => {
    const f = fakeClient({ flag: true, readError: { code: "57014", message: "timeout" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.deepEqual([r.outcome, r.reason, r.observationsDeleted], ["failed", "read_failed", 0]);
    assert.equal(f.rpcs.length, 0);
  });

  it("P6 an airport whose timezone is UNREADABLE is skipped whole (no commit, nothing deleted); the others still fold", async () => {
    const f = fakeClient({ flag: true, rows: [...band(10), ...band(10, 0, { airport_ref: "QQQ" })], profiles: { BKK: "Asia/Bangkok", QQQ: "error" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.deepEqual([r.outcome, r.reason, r.airportsFailed, r.airportsCommitted, r.complete], ["partial", "airport_failed", 1, 1, false]);
    assert.equal(f.rpcs.length, 1);
    assert.equal(f.rpcs[0]!.args.p_observation_ids.length, 10, "only BKK's ten rows are committed; QQQ's stay for the next pass");
  });

  it("P7 an airport that does not exist anywhere publishes nothing and its expired rows are deleted (not kept as a grace)", async () => {
    const f = fakeClient({ flag: true, rows: band(12, 0, { airport_ref: "QQX" }), profiles: {} });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.equal(r.outcome, "folded");
    assert.deepEqual(f.rpcs[0]!.args.p_aggregates, []);
    assert.equal(f.rpcs[0]!.args.p_observation_ids.length, 12);
    assert.equal(r.unusable, 12);
  });

  it("P8 the static dataset answers an airport the profile table does not hold; a profile with no zone is not read as UTC", async () => {
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: {} }).client as any, "BKK"), { ok: true, timezone: "Asia/Bangkok" });
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: { QQZ: null } }).client as any, "QQZ"), { ok: true, timezone: null });
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: { QQZ: "error" } }).client as any, "QQZ"), { ok: false });
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: { BKK: "error" } }).client as any, "BKK"), { ok: true, timezone: "Asia/Bangkok" });
    const id = "11111111-2222-4333-8444-555555555555";
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: { [id]: "Asia/Tokyo" } }).client as any, id), { ok: true, timezone: "Asia/Tokyo" });
    assert.deepEqual(await resolveAirportTimezone(fakeClient({ profiles: { [id]: "error" } }).client as any, id), { ok: false });
  });

  it("P9 a commit the database REFUSES counts nothing as written or deleted (it was one transaction)", async () => {
    const f = fakeClient({ flag: true, rows: band(10), profiles: { BKK: "Asia/Bangkok" }, rpc: () => ({ data: null, error: { code: "40001", message: "still due" } }) });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.deepEqual([r.outcome, r.aggregatesWritten, r.observationsDeleted, r.airportsFailed], ["failed", 0, 0, 1]);
    const odd = fakeClient({ flag: true, rows: band(10), profiles: { BKK: "Asia/Bangkok" }, rpc: () => ({ data: { status: "who knows" }, error: null }) });
    assert.equal((await runAirportTimingFoldPhase({ client: odd.client, now: NOW })).outcome, "failed", "an answer that is not 'committed' is not a commit");
  });

  it("P10 the database's own flag check answering 'disabled' stops the pass: nothing counted as written", async () => {
    const f = fakeClient({ flag: true, rows: [...band(10), ...band(10, 0, { airport_ref: "SIN" })], profiles: { BKK: "Asia/Bangkok", SIN: "Asia/Singapore" }, rpc: () => ({ data: { status: "disabled", inserted: 0, deleted: 0 }, error: null }) });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.deepEqual([r.outcome, r.aggregatesWritten, r.observationsDeleted], ["disabled", 0, 0]);
    assert.equal(f.rpcs.length, 1, "it does not ask again for every airport");
  });

  it("P11 a full batch is not complete; no client is refused; a throwing client never rejects", async () => {
    const f = fakeClient({ flag: true, rows: band(10, 5), profiles: { BKK: "Asia/Bangkok" } });
    assert.equal((await runAirportTimingFoldPhase({ client: f.client, now: NOW, batchSize: 15 })).complete, false);
    assert.equal((await runAirportTimingFoldPhase({ client: null, now: NOW })).outcome, "refused");
    const throwing = { from() { throw new Error("socket"); }, rpc() { throw new Error("socket"); } };
    assert.equal((await runAirportTimingFoldPhase({ client: throwing, now: NOW })).outcome, "disabled", "the flag read throws: fail-closed OFF");
  });
});

// ── G: nothing feeds on the aggregate ────────────────────────────────────────

/** The ONLY non-test files that may name the table or import the module. */
const ALLOWED: Record<string, string> = {
  "services/layover/AirportTimingAggregate.ts": "the writer",
  "lib/layoverOperationalRetentionScheduler.ts": "the scheduler that runs the writer",
  "lib/deletionDispositions.ts": "its deletion fate (RETAINED_WITH_REASON)",
  "scripts/checkProductionDrift.ts": "its unapplied entry",
};
const NEEDLES = [/airport_timing_aggregates/, /airport_timing_fold_commit/, /AirportTimingAggregate(?:\.js)?["']/];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "test" || e === "__tests__" || e === "node_modules" || e === "migrations") continue;
      sourceFiles(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Every non-test file outside ALLOWED that names the table, the commit door or the module. */
export function aggregateFeedViolations(files: ReadonlyMap<string, string>): string[] {
  const bad: string[] = [];
  for (const [rel, text] of files) {
    if (ALLOWED[rel]) continue;
    if (NEEDLES.some((n) => n.test(text))) bad.push(rel);
  }
  return bad.sort();
}

describe("G — the aggregate feeds no buffer, rating, ranking or maturity rung", () => {
  const files = new Map(sourceFiles(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf8")]));

  it("G1 the scan is not vacuous: it reads the airport services and finds the writer", () => {
    assert.ok(files.size > 500, `only ${files.size} source files`);
    assert.ok([...files.keys()].filter((f) => f.startsWith("services/airport/")).length >= 20);
    assert.ok(NEEDLES[0]!.test(files.get("services/layover/AirportTimingAggregate.ts")!) || NEEDLES[1]!.test(files.get("services/layover/AirportTimingAggregate.ts")!));
  });

  it("G2 nothing outside the writer, its scheduler and its two registries names the table, its door or the module", () => {
    assert.deepEqual(aggregateFeedViolations(files), []);
  });

  it("G3 no file under services/airport/ (buffers, deadlines, ratings, ranking, maturity) mentions it at all", () => {
    for (const [rel, text] of files) {
      if (!rel.startsWith("services/airport/")) continue;
      assert.ok(!NEEDLES.some((n) => n.test(text)), `${rel} reads the stored timing aggregate`);
    }
  });

  it("G4 POSITIVE CONTROL: a ranking file that imports the module, or a buffer that reads the table, is caught", () => {
    const planted = new Map(files);
    planted.set("services/airport/LayoverRecommendationService.ts", `${files.get("services/airport/LayoverRecommendationService.ts")}\nimport { x } from "../layover/AirportTimingAggregate.js";\n`);
    planted.set("services/airport/LayoverSafetyEngine.ts", `${files.get("services/airport/LayoverSafetyEngine.ts")}\nconst q = db.from("airport_timing_aggregates");\n`);
    assert.deepEqual(aggregateFeedViolations(planted), ["services/airport/LayoverRecommendationService.ts", "services/airport/LayoverSafetyEngine.ts"]);
  });

  it("G5 the writer never READS its own table: its only path to it is the commit door", () => {
    const writer = files.get("services/layover/AirportTimingAggregate.ts")!;
    assert.doesNotMatch(writer, /\.from\(\s*["']airport_timing_aggregates["']\s*\)/);
    assert.match(writer, /\.rpc\("airport_timing_fold_commit"/);
  });
});
