/**
 * census-layover L161 — "Aggregate airport timing — may persist after
 * de-identification/aggregation" (services/layover/AirportTimingAggregate.ts,
 * migration 3790).
 *
 * node:test + node:assert. Recording fakes, no network, no database.
 *
 * What is proved here:
 *   F  the pure fold: one band per (fact, local-hour INSTANCE) with ≥ 10
 *      distinct observers (OQ-5's fail-closed k), withheld below it; a bucket is
 *      folded only once CLOSED and a still-open hour is HELD (neither folded nor
 *      deleted); percentiles read like the live model's; the window is the
 *      hour-aligned UTC cover of the local hour; closure reports, implausible
 *      or unplaceable readings are deleted without contributing.
 *   S  fix round 1 (V-732 fix 4): an hour of 15 distinct observers, split by the
 *      hourly pass at ANY tick minute, is stored as ONE band of 15 and nothing of
 *      it is deleted before that band is written.
 *   B  the page: ≤ 1 000 rows (Supabase's db-max-rows), `complete` only on a
 *      short page (999 / 1 000 / 1 001), a cut last airport keeps its cut hour,
 *      and one airport-hour larger than a page cannot stall the pass.
 *   I  de-identification: the fold passes `assertNoObserverIdentifiers`, a
 *      planted handle or row id THROWS, and the stored row type is exactly
 *      3790's identifier-free column list.
 *   P  the pass: OFF reads ONLY the flag; ON reads expired community rows only,
 *      commits per airport through the ONE transactional door, and a failed
 *      read / unreadable timezone / refused commit deletes nothing.
 *   G  the prohibition: nothing outside the writer reads the table or imports
 *      the module — no buffer, rating, ranking or maturity code — with planted
 *      violations proving the guard can fail.
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
  AIRPORT_TIMING_FOLD_BATCH_SIZE,
  PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS,
  TRAVELLER_READING_TTL_MS,
  foldAirportTimingWindow,
  localHourBucket,
  resolveAirportTimezone,
  runAirportTimingFoldPhase,
  timingAggregateRowsFor,
  type AirportTimingFold,
  type DueObservationRow,
} from "../services/layover/AirportTimingAggregate.js";
import { MIN_DISTINCT_OBSERVERS_PER_BAND, assertNoObserverIdentifiers } from "../services/layover/LayoverObservationAggregate.js";
import { TRAVELLER_SUBMITTABLE_FACT_TYPES } from "../services/layover/LayoverObservationService.js";
import { FACT_CLASS_TTL_MIN, MIN_SAMPLES_PER_BAND, buildHistoricalModel, type AirportObservation } from "../services/airport/LayoverAirportTruth.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const M3790 = readFileSync(join(SRC, "migrations", "3790_airport_timing_aggregates.sql"), "utf8");

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 07:10 Asia/Bangkok (UTC+7) = 00:10Z. Local hour 07 is 00:00Z–01:00Z. */
const BASE = Date.parse("2026-10-14T00:10:00.000Z");
const NOW = new Date("2026-10-14T02:00:00.000Z");
/** Everything ending before 01:15Z is closed at NOW (02:00Z − 45 min). */
const CLOSED = { closedBefore: NOW.getTime() - TRAVELLER_READING_TTL_MS };

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
    observed_at: new Date(BASE + minute * MIN).toISOString(),
    ...rest,
  };
}

/** `observers` distinct people in local hour 07, plus `extra` more readings by observer 1. */
function band(observers: number, extra = 0, over: Partial<DueObservationRow> = {}, values?: number[]): DueObservationRow[] {
  const rows: DueObservationRow[] = [];
  for (let k = 0; k < observers + extra; k++) {
    rows.push(obs({ observer: k < observers ? k + 1 : 1, minute: k % 40, value: values ? values[k % values.length]! : 5 + k, ...over }));
  }
  return rows;
}

describe("F — the pure fold", () => {
  it("F1 ten distinct observers in one CLOSED local hour are ONE band, at the airport's local hour, with every row listed for deletion", () => {
    const rows = band(10, 2);
    const { fold, evidence, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", CLOSED);
    assert.equal(fold.bands.length, 1);
    const b = fold.bands[0]!;
    assert.equal(b.localHour, 7, "00:10Z is 07:10 in Bangkok");
    assert.equal(b.samples, 12);
    assert.equal(b.distinctObservers, 10);
    assert.equal(fold.withheldBands, 0);
    assert.equal(fold.held, 0);
    assert.deepEqual(new Set(evidence[0]), new Set(rows.map((r) => r.id)));
    assert.deepEqual(new Set(observationIds), new Set(rows.map((r) => r.id)));
  });

  it("F2 a CLOSED hour of NINE distinct observers (however many readings) is WITHHELD — counted, never published, its rows deleted", () => {
    const rows = band(9, 30);
    const { fold, evidence, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", CLOSED);
    assert.deepEqual(fold.bands, []);
    assert.deepEqual(evidence, []);
    assert.equal(fold.withheldBands, 1);
    assert.equal(observationIds.length, 39, "nothing more can arrive in a closed hour, so nothing is gained by keeping it");
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
    const { fold } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", CLOSED);
    const live: AirportObservation[] = rows.map((r) => ({
      observationId: r.id, airportRef: "BKK", factType: "queue_report_minutes", value: Number(r.value),
      observerKind: "community", observerId: r.observer_id, observedAt: r.observed_at, sourceRef: "x",
    }));
    const model = buildHistoricalModel(live, { nowMs: BASE + 41 * MIN, factType: "queue_report_minutes", airportRef: "BKK", localHourOf: () => 7 });
    const lb = model.bands.find((x) => x.hour === 7)!;
    const b = fold.bands[0]!;
    assert.deepEqual([b.p50, b.p75, b.p90], [lb.p50, lb.p75, lb.p90]);
    assert.deepEqual([b.p50, b.p75, b.p90], [8, 12, 25]);
  });

  it("F5 one band per local hour ON ONE DAY: the window is that hour, and the same hour on two days is two bands", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10, 0), "Asia/Bangkok", CLOSED);
    assert.equal(fold.bands[0]!.windowStart, "2026-10-14T00:00:00.000Z");
    assert.equal(fold.bands[0]!.windowEnd, "2026-10-14T01:00:00.000Z");
    const twoDays = [...band(10, 0), ...band(10, 0).map((r) => ({ ...r, id: rid(), observed_at: new Date(Date.parse(r.observed_at) - 24 * HOUR).toISOString() }))];
    const two = foldAirportTimingWindow("BKK", twoDays, "Asia/Bangkok", CLOSED).fold.bands;
    assert.deepEqual(two.map((b) => [b.windowStart, b.localHour, b.distinctObservers]), [
      ["2026-10-13T00:00:00.000Z", 7, 10],
      ["2026-10-14T00:00:00.000Z", 7, 10],
    ]);
  });

  it("F6 closure reports, implausible / non-finite values and unparseable instants are deleted without contributing", () => {
    const rows = [
      ...band(10),
      obs({ fact_type: "closure_reported", value: 1, observer: 60 }),
      obs({ value: 100_000, observer: 61 }),
      obs({ value: "NaN", observer: 62 }),
      obs({ observed_at: "not a date", observer: 63 }),
    ];
    const { fold, observationIds } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", CLOSED);
    assert.equal(fold.unusable, 4);
    assert.equal(fold.bands[0]!.samples, 10);
    assert.equal(observationIds.length, 14);
  });

  it("F7 an airport whose zone cannot be established publishes nothing and still deletes every expired row", () => {
    for (const tz of [null, "Not/AZone"]) {
      const rows = band(12);
      const { fold, observationIds } = foldAirportTimingWindow("BKK", rows, tz, CLOSED);
      assert.deepEqual(fold.bands, []);
      assert.equal(fold.unusable, 12);
      assert.equal(observationIds.length, 12);
    }
  });

  it("F8 facts are separate bands, in a stable order, and no reading is claimed twice", () => {
    const rows = [...band(10, 0, { fact_type: "queue_report_minutes" }), ...band(10, 0, { fact_type: "checkpoint_timing_minutes" })];
    const { fold, evidence } = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", CLOSED);
    assert.deepEqual(fold.bands.map((b) => b.factType), ["checkpoint_timing_minutes", "queue_report_minutes"]);
    assert.equal(evidence.length, 2);
    assert.equal(new Set([...evidence[0]!, ...evidence[1]!]).size, 20);
  });

  it("F9 a row of another airport is refused rather than folded into this one", () => {
    assert.throws(() => foldAirportTimingWindow("BKK", [...band(10), obs({ airport_ref: "SIN" })], "Asia/Bangkok", CLOSED), /another airport/);
  });

  it("F10 an hour that has NOT closed is HELD: not folded, not withheld, not deleted — even with ten observers already in it", () => {
    const rows = band(12);
    const open = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", { closedBefore: Date.parse("2026-10-14T00:59:59.999Z") });
    assert.deepEqual([open.fold.bands.length, open.fold.withheldBands, open.fold.held, open.observationIds.length], [0, 0, 12, 0]);
    const justClosed = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", { closedBefore: Date.parse("2026-10-14T01:00:00.000Z") });
    assert.deepEqual([justClosed.fold.bands.length, justClosed.fold.held, justClosed.observationIds.length], [1, 0, 12], "an hour ending exactly at the bound is closed");
    const mixed = foldAirportTimingWindow("BKK", [...rows, obs({ fact_type: "closure_reported", value: 0, observer: 70 })], "Asia/Bangkok", { closedBefore: Date.parse("2026-10-14T00:30:00.000Z") });
    assert.deepEqual([mixed.fold.held, mixed.observationIds.length], [12, 1], "an unusable row of an open hour still goes: it can join no band");
  });

  it("F11 a half-hour offset (India, +5:30): the local hour is 07:00–08:00 IST, its window the two UTC hours it straddles", () => {
    const at = Date.parse("2026-10-14T01:40:00.000Z"); // 07:10 IST
    assert.deepEqual(localHourBucket("Asia/Kolkata", at), { startMs: Date.parse("2026-10-14T01:30:00.000Z"), endMs: Date.parse("2026-10-14T02:30:00.000Z"), hour: 7 });
    const rows = band(10).map((r, i) => ({ ...r, airport_ref: "DEL", observed_at: new Date(at + i * MIN).toISOString() }));
    const { fold } = foldAirportTimingWindow("DEL", rows, "Asia/Kolkata", { closedBefore: Date.parse("2026-10-14T02:30:00.000Z") });
    assert.deepEqual([fold.bands[0]!.localHour, fold.bands[0]!.windowStart, fold.bands[0]!.windowEnd], [7, "2026-10-14T01:00:00.000Z", "2026-10-14T03:00:00.000Z"]);
    assert.equal(foldAirportTimingWindow("DEL", rows, "Asia/Kolkata", { closedBefore: Date.parse("2026-10-14T02:29:00.000Z") }).fold.held, 10, "the IST hour, not the UTC one, decides closure");
  });

  it("F12 forceOldest folds the oldest bucket only when NOTHING is closed — the progress guarantee, nothing more", () => {
    const rows = [...band(10), ...band(3).map((r) => ({ ...r, id: rid(), observed_at: new Date(Date.parse(r.observed_at) + HOUR).toISOString() }))];
    const forced = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", { closedBefore: 0, forceOldest: true });
    assert.deepEqual([forced.fold.bands.length, forced.fold.held, forced.observationIds.length], [1, 3, 10]);
    const notNeeded = foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", { closedBefore: Date.parse("2026-10-14T02:00:00.000Z"), forceOldest: true });
    assert.deepEqual([notNeeded.fold.bands.length, notNeeded.fold.withheldBands, notNeeded.fold.held, notNeeded.observationIds.length], [1, 1, 0, 13], "both hours are closed: both are folded, and forcing narrows nothing");
  });
});

// ── a stateful fake of airport_fact_observations for the multi-pass cases ───

interface StoredRow extends DueObservationRow { observer_kind: string; expires_at: string }

/**
 * Honours exactly the filters the pass sends (eq, in, lte, lt), the three
 * orders, `.limit()` capped at Supabase's db-max-rows (1 000) WITHOUT an error,
 * and a commit that deletes the listed rows and records the bands.
 */
function simDb(rows: StoredRow[], opts: { flag?: boolean; profiles?: Record<string, string>; maxRows?: number } = {}) {
  const table = [...rows];
  const committed: any[] = [];
  const deleted: string[] = [];
  const reads: Array<{ limit: number; returned: number; orders: string[] }> = [];
  function from(name: string) {
    const filters: Array<(r: any) => boolean> = [];
    const orders: string[] = [];
    let limit = Infinity;
    let flagName = "";
    let profileRef = "";
    const run = async () => {
      if (name === "feature_flags") return { data: { enabled: opts.flag !== false && flagName === "airport_timing_aggregate_enabled" }, error: null };
      if (name === "airport_profiles") {
        const tz = opts.profiles?.[profileRef.toUpperCase()];
        return { data: tz ? { timezone: tz } : null, error: null };
      }
      let hit = table.filter((r) => filters.every((f) => f(r)));
      hit.sort((a, b) => {
        for (const o of orders) {
          const c = String((a as any)[o]).localeCompare(String((b as any)[o]));
          if (c !== 0) return c;
        }
        return 0;
      });
      const cap = Math.min(limit, opts.maxRows ?? 1000);
      hit = hit.slice(0, cap);
      reads.push({ limit, returned: hit.length, orders: [...orders] });
      return { data: hit.map((r) => ({ id: r.id, airport_ref: r.airport_ref, fact_type: r.fact_type, value: r.value, observer_id: r.observer_id, observed_at: r.observed_at })), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: unknown) { if (name === "feature_flags") flagName = String(v); else if (name === "airport_profiles") profileRef = String(v); else filters.push((r) => r[c] === v); return b; },
      ilike(_c: string, v: unknown) { profileRef = String(v); return b; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
      lte(c: string, v: string) { filters.push((r) => Date.parse(r[c]) <= Date.parse(v)); return b; },
      lt(c: string, v: string) { filters.push((r) => Date.parse(r[c]) < Date.parse(v)); return b; },
      order(c: string) { orders.push(c); return b; },
      limit(n: number) { limit = n; return b; },
      maybeSingle() { return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    return b;
  }
  async function rpc(_fn: string, args: any) {
    const ids = new Set<string>(args.p_observation_ids);
    const before = table.length;
    for (let i = table.length - 1; i >= 0; i--) if (ids.has(table[i]!.id)) { deleted.push(table[i]!.id); table.splice(i, 1); }
    committed.push(...args.p_aggregates);
    return { data: { status: "committed", inserted: args.p_aggregates.length, deleted: before - table.length }, error: null };
  }
  return { client: { from, rpc }, table, committed, deleted, reads };
}

/** A traveller reading as its writer stores it: expires 45 minutes after it is made. */
function stored(airport: string, observer: number, atMs: number, value = 7, fact = "queue_report_minutes"): StoredRow {
  return {
    id: rid(), airport_ref: airport, fact_type: fact, value, observer_id: handle(observer), observed_at: new Date(atMs).toISOString(),
    observer_kind: "community", expires_at: new Date(atMs + FACT_CLASS_TTL_MIN.TRAVELER_OBSERVATION * MIN).toISOString(),
  };
}

describe("S — one local hour, split by the hourly pass, is ONE band (V-732 fix 4)", () => {
  /** 15 distinct observers, one reading each, spread across 07:00–07:59 at BKK (00:00Z–01:00Z). */
  const hour = () => Array.from({ length: 15 }, (_, i) => stored("BKK", i + 1, Date.parse("2026-10-14T00:00:00.000Z") + (2 + i * 4) * MIN, 5 + i));

  for (const minute of [0, 11, 30, 44, 45, 59]) {
    it(`S1 tick at :${String(minute).padStart(2, "0")} — one band of 15 is stored, and not one of the 15 readings is deleted before it`, async () => {
      const db = simDb(hour(), { profiles: { BKK: "Asia/Bangkok" } });
      const ticks = [0, 1, 2, 3].map((h) => new Date(Date.parse("2026-10-14T00:00:00.000Z") + h * HOUR + minute * MIN));
      for (const now of ticks) {
        const r = await runAirportTimingFoldPhase({ client: db.client, now });
        assert.notEqual(r.outcome, "failed");
        const closed = now.getTime() >= Date.parse("2026-10-14T01:45:00.000Z");
        if (!closed) {
          assert.equal(db.deleted.length, 0, `at ${now.toISOString()} the hour is open: nothing of it may go`);
          assert.equal(db.committed.length, 0);
        }
      }
      assert.equal(db.committed.length, 1, "exactly one band");
      assert.deepEqual([db.committed[0].distinct_observers, db.committed[0].sample_count, db.committed[0].local_hour], [15, 15, 7]);
      assert.equal(db.deleted.length, 15, "and every reading went WITH it");
      assert.equal(db.table.length, 0);
    });
  }

  it("S2 POSITIVE CONTROL: the measured defect — two halves of 7 and 8 are each below the floor — is what closure prevents", () => {
    const rows = hour().map((r) => ({ ...r }));
    const firstHalf = rows.slice(0, 7);
    const secondHalf = rows.slice(7);
    const allClosed = { closedBefore: Date.parse("2026-10-14T01:00:00.000Z") };
    assert.equal(foldAirportTimingWindow("BKK", firstHalf, "Asia/Bangkok", allClosed).fold.bands.length, 0, "a fragment folded alone is withheld");
    assert.equal(foldAirportTimingWindow("BKK", secondHalf, "Asia/Bangkok", allClosed).fold.bands.length, 0);
    assert.equal(foldAirportTimingWindow("BKK", rows, "Asia/Bangkok", allClosed).fold.bands[0]!.distinctObservers, 15, "the whole hour is one band");
  });

  it("S3 an hour still open at the pass deletes NOTHING, though its readings have expired", async () => {
    const db = simDb(hour(), { profiles: { BKK: "Asia/Bangkok" } });
    const r = await runAirportTimingFoldPhase({ client: db.client, now: new Date("2026-10-14T01:44:59.000Z") });
    assert.deepEqual([r.outcome, r.held, r.observationsDeleted, db.deleted.length], ["folded", 15, 0, 0]);
  });
});

describe("B — the page: db-max-rows, `complete`, a cut airport, no stall", () => {
  /** n readings at airport QQA (UTC), all in closed hours, one per distinct observer. */
  const many = (n: number, airport = "BKK") => Array.from({ length: n }, (_, i) => stored(airport, i + 1, Date.parse("2026-10-13T00:00:00.000Z") + (i % 600) * 2 * MIN));
  const NOW_B = new Date("2026-10-14T12:00:00.000Z");

  it("B1 the batch is Supabase's db-max-rows, and a larger request is clamped to it", async () => {
    assert.equal(AIRPORT_TIMING_FOLD_BATCH_SIZE, 1000);
    const db = simDb(many(5), { profiles: { BKK: "Asia/Bangkok" } });
    await runAirportTimingFoldPhase({ client: db.client, now: NOW_B, batchSize: 5000 });
    assert.equal(db.reads[0]!.limit, 1000);
  });

  for (const [n, complete] of [[999, true], [1000, false], [1001, false]] as const) {
    it(`B2 ${n} due readings: read ${Math.min(n, 1000)}, complete = ${complete} — only a SHORT page proves the backlog is gone`, async () => {
      const db = simDb(many(n), { profiles: { BKK: "Asia/Bangkok" } });
      const r = await runAirportTimingFoldPhase({ client: db.client, now: NOW_B });
      assert.equal(r.read, Math.min(n, 1000));
      assert.equal(r.complete, complete);
    });
  }

  it("B3 a FULL page cuts its last airport: that airport's cut hour is held, the others fold whole", async () => {
    const aaa = Array.from({ length: 10 }, (_, i) => stored("AAA", i + 1, Date.parse("2026-10-14T00:05:00.000Z") + i * MIN));
    const zzz = Array.from({ length: 12 }, (_, i) => stored("ZZZ", i + 1, Date.parse("2026-10-14T00:05:00.000Z") + i * 4 * MIN));
    const db = simDb([...aaa, ...zzz], { profiles: { AAA: "UTC", ZZZ: "UTC" } });
    const r = await runAirportTimingFoldPhase({ client: db.client, now: NOW_B, batchSize: 15 });
    assert.equal(r.read, 15);
    assert.deepEqual(db.committed.map((c) => c.airport_ref), ["AAA"]);
    assert.ok(db.table.filter((x) => x.airport_ref === "ZZZ").length === 12, "ZZZ's hour was cut by the page: none of it goes");
    assert.equal(r.complete, false);
    const r2 = await runAirportTimingFoldPhase({ client: db.client, now: NOW_B, batchSize: 15 });
    assert.deepEqual([r2.read, r2.complete, db.committed.map((c) => c.airport_ref)], [12, true, ["AAA", "ZZZ"]], "the next page takes ZZZ's whole hour");
  });

  it("B4 one airport-hour LARGER than a page cannot stall the pass: its in-page readings fold, the rest follow", async () => {
    const big = Array.from({ length: 15 }, (_, i) => stored("BKK", i + 1, Date.parse("2026-10-14T00:02:00.000Z") + i * 3 * MIN));
    const db = simDb(big, { profiles: { BKK: "Asia/Bangkok" } });
    const r1 = await runAirportTimingFoldPhase({ client: db.client, now: NOW_B, batchSize: 12 });
    assert.deepEqual([r1.read, r1.aggregatesWritten, r1.observationsDeleted], [12, 1, 12]);
    const r2 = await runAirportTimingFoldPhase({ client: db.client, now: NOW_B, batchSize: 12 });
    assert.deepEqual([r2.read, r2.observationsDeleted, r2.complete], [3, 3, true]);
    assert.equal(db.table.length, 0);
  });

  it("B5 the read is ordered airport, then reading time, then id — the order the cut rule relies on", async () => {
    const db = simDb(many(3), { profiles: { BKK: "Asia/Bangkok" } });
    await runAirportTimingFoldPhase({ client: db.client, now: NOW_B });
    assert.deepEqual(db.reads[0]!.orders, ["airport_ref", "observed_at", "id"]);
  });
});

describe("I — de-identification by type and by assertion", () => {
  it("I1 the fold carries no handle, no row id and no instant below the hour", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10, 5), "Asia/Bangkok", CLOSED);
    const text = JSON.stringify(fold);
    assert.doesNotMatch(text, /tv1-[0-9a-f]{40}/);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    for (const b of fold.bands) {
      assert.match(b.windowStart, /T\d\d:00:00\.000Z$/);
      assert.match(b.windowEnd, /T\d\d:00:00\.000Z$/);
    }
  });

  it("I2 POSITIVE CONTROL: a handle or a row id planted anywhere in a fold THROWS, in the fold and in the row mapper", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10), "Asia/Bangkok", CLOSED);
    const withHandle = { ...fold, bands: [{ ...fold.bands[0]!, note: handle(7) }] } as unknown as AirportTimingFold;
    assert.throws(() => assertNoObserverIdentifiers(withHandle), /observer identifier/);
    assert.throws(() => timingAggregateRowsFor(withHandle), /observer identifier/);
    const withRowId = { ...fold, evidence: [rid()] } as unknown as AirportTimingFold;
    assert.throws(() => assertNoObserverIdentifiers(withRowId), /bare UUID/);
  });

  it("I3 an airport filed under its profile id (a bare UUID that belongs to an AIRPORT) is exempt by path, not by pattern", () => {
    const ref = "11111111-2222-4333-8444-555555555555";
    const rows = band(10).map((r) => ({ ...r, airport_ref: ref }));
    const { fold } = foldAirportTimingWindow(ref, rows, "Asia/Bangkok", CLOSED);
    assert.equal(timingAggregateRowsFor(fold)[0]!.airport_ref, ref);
  });

  it("I4 the stored row is EXACTLY 3790's column list less the two the database assigns", () => {
    const m = /CREATE TABLE IF NOT EXISTS public\.airport_timing_aggregates \(([\s\S]*?)\n\);/.exec(M3790);
    assert.ok(m, "3790's CREATE TABLE");
    const columns = m![1]!.split("\n").map((l) => /^\s{2}([a-z_0-9]+)\s+(?:uuid|text|smallint|integer|numeric|timestamptz)\b/.exec(l)?.[1]).filter(Boolean).sort();
    assert.deepEqual(columns, ["airport_ref", "distinct_observers", "fact_type", "folded_at", "id", "local_hour", "p50_minutes", "p75_minutes", "p90_minutes", "sample_count", "truth_version", "window_end", "window_start"]);
    const { fold } = foldAirportTimingWindow("BKK", band(10), "Asia/Bangkok", CLOSED);
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

  it("I6 a band carries exactly its nine named members — a timestamp or anything else added to it is caught here (V-732 V04)", () => {
    const { fold } = foldAirportTimingWindow("BKK", band(10), "Asia/Bangkok", CLOSED);
    assert.deepEqual(Object.keys(fold.bands[0]!).sort(), ["distinctObservers", "factType", "localHour", "p50", "p75", "p90", "samples", "windowEnd", "windowStart"]);
    assert.deepEqual(Object.keys(fold).sort(), ["airportRef", "bands", "held", "minDistinctObserversPerBand", "minSamplesPerBand", "truthVersion", "unusable", "withheldBands"]);
  });
});

// ── a recording fake client for the single-pass cases ───────────────────────

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; select?: string; limit?: number; orders: string[] };

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
    const call: Call = { table, op: "select", filters: [], orders: [] };
    calls.push(call);
    const run = async (): Promise<{ data: unknown; error: unknown }> => {
      if (table === "feature_flags") {
        if (opts.flag === "error") return { data: null, error: { code: "57014", message: "timeout" } };
        return { data: { enabled: opts.flag === true }, error: null };
      }
      if (table === "airport_fact_observations") {
        if (opts.readError) return { data: null, error: opts.readError };
        let rows = [...(opts.rows ?? [])];
        if (call.limit !== undefined) rows = rows.slice(0, call.limit);
        return { data: rows, error: null };
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
      lt(c: string, v: unknown) { call.filters.push(["lt", c, v]); return b; },
      order(c: string) { call.orders.push(c); return b; },
      limit(n: number) { call.limit = n; return b; },
      maybeSingle() { return run(); },
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

  it("P3 ON: reads only EXPIRED COMMUNITY traveller readings made one lifetime ago, ids/handles/values only, bounded", async () => {
    const f = fakeClient({ flag: true, rows: [], profiles: { BKK: "Asia/Bangkok" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW, batchSize: 7 });
    assert.equal(r.outcome, "idle");
    const read = f.calls.find((c) => c.table === "airport_fact_observations")!;
    assert.equal(read.select, "id,airport_ref,fact_type,value,observer_id,observed_at");
    assert.deepEqual(read.filters.filter((x) => x[0] === "eq"), [["eq", "observer_kind", "community"]]);
    assert.deepEqual(read.filters.find((x) => x[0] === "in"), ["in", "fact_type", [...TRAVELLER_SUBMITTABLE_FACT_TYPES]]);
    assert.deepEqual(read.filters.find((x) => x[0] === "lte"), ["lte", "expires_at", NOW.toISOString()], "only what has EXPIRED");
    assert.deepEqual(read.filters.find((x) => x[0] === "lt"), ["lt", "observed_at", new Date(NOW.getTime() - TRAVELLER_READING_TTL_MS).toISOString()]);
    assert.deepEqual(read.orders, ["airport_ref", "observed_at", "id"]);
    assert.equal(read.limit, 7);
    assert.equal(f.rpcs.length, 0, "nothing due: no commit");
  });

  it("P4 ON: one commit per airport through airport_timing_fold_commit — identifier-free aggregates, aligned evidence, every folded id, the cutoff", async () => {
    const bkk = band(10, 2);
    const sin = band(9, 0, { airport_ref: "SIN" });
    const f = fakeClient({ flag: true, rows: [...bkk, ...sin], profiles: { BKK: "Asia/Bangkok", SIN: "Asia/Singapore" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.equal(r.outcome, "folded");
    assert.equal(f.rpcs.length, 2);
    assert.ok(f.rpcs.every((x) => x.fn === "airport_timing_fold_commit"));
    const a = f.rpcs.find((x) => x.args.p_observation_ids.includes(bkk[0]!.id))!.args;
    assert.equal(a.p_cutoff, NOW.toISOString());
    assert.deepEqual(new Set(a.p_observation_ids), new Set(bkk.map((x) => x.id)));
    assert.equal(a.p_aggregates.length, 1);
    assert.equal(a.p_evidence.length, 1);
    assert.equal(a.p_aggregates[0].distinct_observers, 10);
    assert.equal(a.p_aggregates[0].sample_count, a.p_evidence[0].length);
    assert.doesNotMatch(JSON.stringify(a.p_aggregates), /tv1-|[0-9a-f]{8}-[0-9a-f]{4}-/i, "no handle and no row id in what is stored");
    const s = f.rpcs.find((x) => x.args.p_observation_ids.includes(sin[0]!.id))!.args;
    assert.deepEqual(s.p_aggregates, [], "nine observers in a closed hour: nothing published …");
    assert.equal(s.p_observation_ids.length, 9, "… and its expired rows still go");
    assert.deepEqual(
      { read: r.read, airports: r.airports, committed: r.airportsCommitted, written: r.aggregatesWritten, deleted: r.observationsDeleted, withheld: r.bandsWithheld, held: r.held, complete: r.complete },
      { read: 21, airports: 2, committed: 2, written: 1, deleted: 21, withheld: 1, held: 0, complete: true },
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

  it("P7 an airport that does not exist anywhere publishes nothing and its expired rows are deleted", async () => {
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

  it("P11 a full page is not complete; no client is refused; a throwing client never rejects", async () => {
    const f = fakeClient({ flag: true, rows: band(10, 5), profiles: { BKK: "Asia/Bangkok" } });
    assert.equal((await runAirportTimingFoldPhase({ client: f.client, now: NOW, batchSize: 15 })).complete, false);
    assert.equal((await runAirportTimingFoldPhase({ client: null, now: NOW })).outcome, "refused");
    const throwing = { from() { throw new Error("socket"); }, rpc() { throw new Error("socket"); } };
    assert.equal((await runAirportTimingFoldPhase({ client: throwing, now: NOW })).outcome, "disabled", "the flag read throws: fail-closed OFF");
  });

  it("P12 the counts are what the DATABASE answered, not what was asked for", async () => {
    const f = fakeClient({ flag: true, rows: band(10, 2), profiles: { BKK: "Asia/Bangkok" }, rpc: () => ({ data: { status: "committed", inserted: 0, deleted: 5 }, error: null }) });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: NOW });
    assert.deepEqual([r.aggregatesWritten, r.observationsDeleted], [0, 5]);
  });

  it("P13 an airport whose readings are ALL in a still-open hour is not committed at all", async () => {
    const f = fakeClient({ flag: true, rows: band(12), profiles: { BKK: "Asia/Bangkok" } });
    const r = await runAirportTimingFoldPhase({ client: f.client, now: new Date("2026-10-14T01:40:00.000Z") });
    assert.deepEqual([r.outcome, r.held, r.airportsCommitted, f.rpcs.length], ["folded", 12, 0, 0]);
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
/** `(?!\.sql)`: a file that merely NAMES the migration (a census scope list) is not a reader of the table. */
const NEEDLES = [/airport_timing_aggregates(?!\.sql)/, /airport_timing_fold_commit/, /AirportTimingAggregate(?:\.js)?["']/];

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

/** Files under services/airport/ (buffers, deadlines, ratings, ranking, maturity) that mention it at all — no allowlist. */
export function airportServiceReaders(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([rel, text]) => rel.startsWith("services/airport/") && NEEDLES.some((n) => n.test(text))).map(([rel]) => rel).sort();
}

describe("G — the aggregate feeds no buffer, rating, ranking or maturity rung", () => {
  const files = new Map(sourceFiles(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf8")]));

  it("G1 the scan is not vacuous: it reads the airport services and finds the writer", () => {
    assert.ok(files.size > 500, `only ${files.size} source files`);
    assert.ok([...files.keys()].filter((f) => f.startsWith("services/airport/")).length >= 20);
    assert.ok(NEEDLES[1]!.test(files.get("services/layover/AirportTimingAggregate.ts")!));
  });

  it("G2 nothing outside the writer, its scheduler and its two registries names the table, its door or the module", () => {
    assert.deepEqual(aggregateFeedViolations(files), []);
  });

  it("G3 no file under services/airport/ (buffers, deadlines, ratings, ranking, maturity) mentions it at all", () => {
    assert.deepEqual(airportServiceReaders(files), []);
  });

  it("G4 POSITIVE CONTROL: a ranking file that imports the module, or a buffer that reads the table, is caught by both scans", () => {
    const planted = new Map(files);
    planted.set("services/airport/LayoverRecommendationService.ts", `${files.get("services/airport/LayoverRecommendationService.ts")}\nimport { x } from "../layover/AirportTimingAggregate.js";\n`);
    planted.set("services/airport/LayoverSafetyEngine.ts", `${files.get("services/airport/LayoverSafetyEngine.ts")}\nconst q = db.from("airport_timing_aggregates");\n`);
    assert.deepEqual(aggregateFeedViolations(planted), ["services/airport/LayoverRecommendationService.ts", "services/airport/LayoverSafetyEngine.ts"]);
    assert.deepEqual(airportServiceReaders(planted), ["services/airport/LayoverRecommendationService.ts", "services/airport/LayoverSafetyEngine.ts"]);
    const route = new Map(files);
    route.set("routes/airport.ts", `${files.get("routes/airport.ts")}\nconst rows = await db.rpc("airport_timing_fold_commit", {});\n`);
    assert.deepEqual(aggregateFeedViolations(route), ["routes/airport.ts"]);
    const nameOnly = new Map(files);
    nameOnly.set("scripts/someRegistry.ts", `const files = ["artifacts/api-server/src/migrations/3790_airport_timing_aggregates.sql"];\n`);
    assert.deepEqual(aggregateFeedViolations(nameOnly), [], "a file that only NAMES the migration is not a reader");
  });

  it("G5 the writer never READS its own table: its only path to it is the commit door", () => {
    const writer = files.get("services/layover/AirportTimingAggregate.ts")!;
    assert.doesNotMatch(writer, /\.from\(\s*["']airport_timing_aggregates["']\s*\)/);
    assert.match(writer, /\.rpc\("airport_timing_fold_commit"/);
  });
});
