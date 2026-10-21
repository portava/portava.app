/**
 * census-highlights-memories (wave 5, 2026-10-17) — the place-collections
 * overdue sweep processes its backlog, per the owner's ruling.
 *
 * Run: node --import tsx/esm --test src/test/placeCollectionsBacklogSweep.test.ts
 *
 * THE RULING ("Place-collection refresh limit", 2026-10-17). The hourly refresh
 * examined only the 200 most recently stale places, so once more than 200 were
 * stale some were skipped run after run. Required: the longest-waiting first, in
 * paginated batches; busy places first without starving quiet ones; the backlog
 * continues by itself; refresh failures, backlog size and maximum waiting time
 * tracked; capacity that grows with the backlog.
 *
 * WHAT IS PROVEN HERE, on an in-memory database that answers the operators the
 * worker uses (multi-key order, keyset filters, the claim's lock `.or`, upsert on
 * a conflict key) and DRAINS through the real runCollectionsTick/processPlace,
 * so a refreshed place really leaves the overdue set:
 *   1. oldest-first: the longest-waiting places are re-queued first;
 *   2. keyset pages: a page boundary inside equal timestamps skips and repeats
 *      nothing; across runs every overdue place is re-queued once, none twice;
 *   3. a stream of busy places cannot starve a quiet one, and a quiet backlog
 *      cannot hold a busy place back; the floor(k / R) + 1 bound holds on a
 *      randomized backlog with arrivals every run;
 *   4. within capacity every overdue place is re-queued in the run that sees it;
 *   5. the budget grows with the backlog and stops at its cap;
 *   6. a place already in the queue is not re-queued and takes no slot;
 *   7. failures are counted, and one failing place does not block the rest;
 *   8. backlog, maximum wait and failures read back through the status getter,
 *      the health detail and the one structured log line per run;
 *   9. a follow-up run is armed while backlog remains, at most three in a row.
 * The column names are checked against production in
 * placeCollectionsStaleSweep.test.ts (schemaStrictSupabase).
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  runStaleSweep,
  runPlaceCollectionsSweepTick,
  staleSweepBudget,
  staleSweepFollowUpDelayMs,
  drainPassesFor,
  getPlaceCollectionsSweepStatus,
  _resetPlaceCollectionsSweepStatus,
  placeCollectionsSweepHealthDetail,
  _setTestAwardStamp,
  STALE_SWEEP_FOLLOW_UP_DELAY_MS,
  STALE_SWEEP_MAX_FOLLOW_UPS,
  STALE_SWEEP_MAX_DRAIN_PASSES,
  STALE_SWEEP_MAX_SCAN_PAGES,
} from "../lib/places/placeCollectionsWorker.js";

// ── An in-memory database ─────────────────────────────────────────────────────

type Row = Record<string, any>;
type Op = "select" | "upsert" | "update" | "delete";
interface Call {
  table: string;
  op: Op;
  filters: Array<[kind: string, column: string, value: unknown]>;
  count: boolean;
  limit: number | null;
  body: any;
}
type FailFn = (c: Call) => { message: string; code?: string } | null;

function makeDb(seed: Record<string, Row[]>, fail?: FailFn) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  // posts are only read by the code under test, so an index by place is safe.
  const postsByPlace = new Map<string, Row[]>();
  for (const p of tables.posts ?? []) {
    const list = postsByPlace.get(p.canonical_place_id) ?? [];
    list.push(p);
    postsByPlace.set(p.canonical_place_id, list);
  }
  const calls: Call[] = [];

  function from(table: string) {
    const filters: Call["filters"] = [];
    const preds: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limit: number | null = null;
    let op: Op = "select";
    let body: any = null;
    let count = false;
    let returning = false;
    let conflict = "place_id";
    const add = (kind: string, col: string, val: unknown, pred: (r: Row) => boolean) => {
      filters.push([kind, col, val]);
      preds.push(pred);
      return b;
    };
    const b: any = {
      select(_cols?: string, o?: { count?: string }) {
        if (op === "select") count = Boolean(o?.count);
        else returning = true;
        return b;
      },
      eq: (c: string, v: unknown) => add("eq", c, v, (r) => r[c] === v),
      neq: (c: string, v: unknown) => add("neq", c, v, (r) => r[c] !== v),
      gt: (c: string, v: unknown) => add("gt", c, v, (r) => r[c] != null && String(r[c]) > String(v)),
      lt: (c: string, v: unknown) => add("lt", c, v, (r) => r[c] != null && String(r[c]) < String(v)),
      in: (c: string, vs: unknown[]) => add("in", c, vs, (r) => vs.includes(r[c])),
      not: (c: string, o: string, v: unknown) =>
        o === "in"
          ? add("not.in", c, v, (r) => !String(v).replace(/[()]/g, "").split(",").includes(String(r[c])))
          : add(`not.${o}`, c, v, (r) => r[c] !== v),
      // The claim's lock guard: "locked_until.is.null,locked_until.lt.<iso>".
      or: (expr: string) => {
        const cut = /locked_until\.lt\.([^,]+)/.exec(expr)?.[1] ?? "";
        return add("or", "locked_until", expr, (r) => r.locked_until == null || String(r.locked_until) < cut);
      },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push({ col: c, asc: o?.ascending !== false }); return b; },
      limit: (n: number) => { limit = n; return b; },
      upsert: (rows: Row | Row[], o?: { onConflict?: string }) => {
        op = "upsert"; body = Array.isArray(rows) ? rows : [rows]; conflict = o?.onConflict ?? "place_id"; return b;
      },
      update: (patch: Row) => { op = "update"; body = patch; return b; },
      delete: () => { op = "delete"; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(exec).then(res, rej),
    };
    function exec() {
      const call: Call = { table, op, filters, count, limit, body };
      calls.push(call);
      const err = fail?.(call);
      if (err) return { data: null, error: err, count: null };
      const store = (tables[table] ??= []);
      const match = (r: Row) => preds.every((p) => p(r));
      if (op === "upsert") {
        const keys = conflict.split(",");
        for (const row of body as Row[]) {
          const i = store.findIndex((r) => keys.every((k) => r[k] === row[k]));
          if (i >= 0) store[i] = { ...store[i], ...row };
          else store.push({ ...row });
        }
        return { data: null, error: null, count: null };
      }
      if (op === "update") {
        const hit = store.filter(match);
        for (const r of hit) Object.assign(r, body);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null, count: null };
      }
      if (op === "delete") {
        tables[table] = store.filter((r) => !match(r));
        return { data: null, error: null, count: null };
      }
      let source = store;
      if (table === "posts") {
        const byPlace = filters.find(([k, c]) => k === "eq" && c === "canonical_place_id");
        if (byPlace) source = postsByPlace.get(String(byPlace[2])) ?? [];
      }
      let out = source.filter(match);
      if (orders.length > 0) {
        out = [...out].sort((a, z) => {
          for (const o of orders) {
            const av = String(a[o.col] ?? ""), zv = String(z[o.col] ?? "");
            if (av !== zv) return (av < zv ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
      }
      const total = out.length;
      if (limit !== null) out = out.slice(0, limit);
      return { data: out.map((r) => ({ ...r })), error: null, count: count ? total : null };
    }
    return b;
  }
  return { from, tables, calls };
}
type Db = ReturnType<typeof makeDb>;

// ── A world ───────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const STALE = 6 * HOUR;
// processPlace stamps place_best_of.updated_at from the wall clock, so the
// sweep is handed a `now` near it: a refreshed place is then fresh, not overdue.
const NOW = Date.now();

const id = (i: number) => `p${String(i).padStart(5, "0")}`;
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);
/** A place_best_of row whose collections have been overdue for `waitMin` minutes at `at`. */
const overdue = (placeId: string, waitMin: number, at = NOW): Row => ({
  place_id: placeId,
  updated_at: new Date(at - STALE - waitMin * MIN).toISOString(),
});
const fresh = (placeId: string): Row => ({ place_id: placeId, updated_at: new Date(NOW - HOUR).toISOString() });
/** More than POST_COUNT_THRESHOLD (20) active posts: a busy place. */
const busyPosts = (placeId: string): Row[] =>
  range(21).map((i) => ({ id: `${placeId}-post-${i}`, canonical_place_id: placeId, status: "active" }));

/** Ids the sweep handed to the queue at `at` (the tick never upserts the queue; only the sweep does). */
function requeuedAt(db: Db, at: number): string[] {
  const iso = new Date(at).toISOString();
  return db.calls
    .filter((c) => c.table === "place_cache_invalidation_queue" && c.op === "upsert")
    .flatMap((c) => c.body as Row[])
    .filter((r) => r.queued_at === iso)
    .map((r) => r.place_id as string);
}

function overdueCount(db: Db, at: number): number {
  const cutoff = new Date(at - STALE).toISOString();
  return (db.tables.place_best_of ?? []).filter((r) => r.updated_at < cutoff).length;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  _resetPlaceCollectionsSweepStatus();
  _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
});
afterEach(() => {
  mock.restoreAll();
  _setTestAwardStamp(null);
});

// ── 1. Oldest first ───────────────────────────────────────────────────────────

describe("oldest-first: the longest-waiting overdue places are re-queued first", () => {
  it("700 overdue, budget 600: the 600 that waited longest go, the newest waits; a fresh place is never examined", async () => {
    const db = makeDb({
      place_best_of: [...range(700).map((i) => overdue(id(i), 700 - i)), fresh("fresh-1")],
      posts: [],
      place_cache_invalidation_queue: [],
    });
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.backlog, 700);
    assert.equal(r.requeued, 600);
    assert.deepEqual(r.selected.map((s) => s.place_id), range(600).map(id), "the 600 oldest, oldest first");
    assert.deepEqual(new Set(r.selected.slice(0, 300).map((s) => s.lane)), new Set(["aging"]));
    const queued = db.tables.place_cache_invalidation_queue.map((q) => q.place_id);
    assert.ok(!queued.includes(id(699)), "the newest overdue place waits for the next run");
    assert.ok(!queued.includes("fresh-1"));
    assert.ok(db.tables.place_cache_invalidation_queue.every((q) => q.status === "pending"));
  });
});

// ── 2. Keyset pages ───────────────────────────────────────────────────────────

describe("keyset pagination on (updated_at, place_id), never OFFSET", () => {
  it("a page boundary inside 250 equal timestamps neither skips nor repeats a place", async () => {
    const tie = new Date(NOW - STALE - 100 * MIN).toISOString();
    const rows: Row[] = [
      ...range(50).map((i) => overdue(id(i), 500 - i)),                 // older, distinct
      ...range(250, 50).map((i) => ({ place_id: id(i), updated_at: tie })), // one instant, pages 1–3
      ...range(50, 300).map((i) => overdue(id(i), 60 - (i - 300))),     // newer, distinct
    ];
    // Insertion order must not be what makes the walk come out right.
    const shuffled = [...rows].sort((a, z) => (a.place_id < z.place_id ? 1 : -1));
    const db = makeDb({ place_best_of: shuffled, posts: [], place_cache_invalidation_queue: [] });
    const r = await runStaleSweep(db, { now: NOW });
    const ids = r.selected.map((s) => s.place_id);
    assert.equal(new Set(ids).size, ids.length, "no place twice");
    assert.deepEqual(ids, range(350).map(id), "every overdue place, in key order");
    assert.equal(r.pagesRead, 4, "100 + 100 + 100 + 50");
    assert.equal(r.backlogRemains, false);
    // Keyset, not OFFSET: every page after the first is bounded by the last row seen.
    const pageReads = db.calls.filter((c) => c.table === "place_best_of" && c.op === "select" && !c.count);
    assert.ok(pageReads.slice(1).every((c) => c.filters.some(([k, col]) => (k === "gt" || k === "eq") && col === "updated_at")));
  });

  it("across runs, a backlog of 1 500 is walked to its end: every place re-queued once, none twice, oldest first", async () => {
    const db = makeDb({
      place_best_of: [...range(1500).map((i) => overdue(id(i), 1500 - i)), fresh("fresh-1")],
      posts: [],
      place_cache_invalidation_queue: [],
    });
    const runs: string[][] = [];
    const remains: boolean[] = [];
    for (let run = 0; run < 3; run++) {
      const at = NOW + run * 15 * MIN;
      const s = await runPlaceCollectionsSweepTick({ client: db, now: at });
      runs.push(requeuedAt(db, at));
      remains.push(s.lastResult!.sweep.backlogRemains);
      assert.equal(s.lastResult!.drain.errors, 0);
    }
    assert.deepEqual(runs.map((r) => r.length), [600, 600, 300]);
    assert.deepEqual(runs[0], range(600).map(id));
    assert.deepEqual(runs[1], range(600, 600).map(id));
    assert.deepEqual(runs[2], range(300, 1200).map(id));
    const all = runs.flat();
    assert.equal(new Set(all).size, 1500, "no place twice");
    assert.deepEqual(remains, [true, true, false]);
    assert.equal(overdueCount(db, NOW + 30 * MIN), 0, "the drain refreshed every one of them");
  });
});

// ── 3. Traffic without starvation ─────────────────────────────────────────────

describe("busy places first, without starving quiet ones", () => {
  it("700 new busy places every run cannot starve 400 quiet ones: all are re-queued within floor(399 / 300) + 1 = 2 runs", async () => {
    const quiet = range(400).map((i) => overdue(id(i), 5000 - i));
    const busy = range(700, 400).map((i) => overdue(id(i), 3000 - i));
    const seedPosts = busy.flatMap((r) => busyPosts(r.place_id));
    // Arrivals are seeded now and appear only when their time comes: each run's
    // 700 newcomers become overdue just before that run.
    const arrivals: Row[][] = range(3).map((run) => range(700, 2000 + run * 700).map((i) => ({
      place_id: id(i),
      updated_at: new Date(NOW + run * 15 * MIN + 60 * MIN).toISOString(), // not yet overdue
    })));
    const db = makeDb({
      place_best_of: [...quiet, ...busy, ...arrivals.flat()],
      posts: [...seedPosts, ...arrivals.flat().flatMap((r) => busyPosts(r.place_id))],
      place_cache_invalidation_queue: [],
    });
    const quietIds = new Set(quiet.map((r) => r.place_id));
    const firstRun = new Map<string, number>();
    let busyInRun1 = 0;
    for (let run = 0; run < 3; run++) {
      const at = NOW + run * 15 * MIN;
      // This run's arrivals turn overdue: newer than everything already waiting.
      for (const a of arrivals[run]) {
        const row = db.tables.place_best_of.find((r) => r.place_id === a.place_id)!;
        row.updated_at = new Date(at - STALE - 1 * MIN).toISOString();
      }
      const s = await runPlaceCollectionsSweepTick({ client: db, now: at });
      if (run === 0) busyInRun1 = s.lastResult!.sweep.selected.traffic;
      for (const p of requeuedAt(db, at)) if (!firstRun.has(p)) firstRun.set(p, run + 1);
    }
    assert.equal(busyInRun1, 300, "the traffic lane spent its share on busy places");
    for (const q of quietIds) {
      const run = firstRun.get(q);
      assert.ok(run !== undefined && run <= 2, `quiet ${q} re-queued in run ${run ?? "never"}`);
    }
  });

  it("a busy place 900 deep behind quiet ones is re-queued in the run that reaches it, by the traffic lane", async () => {
    const db = makeDb({
      place_best_of: [...range(900).map((i) => overdue(id(i), 2000 - i)), overdue("busy-1", 10)],
      posts: busyPosts("busy-1"),
      place_cache_invalidation_queue: [],
    });
    const r = await runStaleSweep(db, { now: NOW });
    const busy = r.selected.find((s) => s.place_id === "busy-1");
    assert.ok(busy, "re-queued in this run, ahead of 300 older quiet places");
    assert.equal(busy.lane, "traffic");
    assert.equal(r.requeued, 600);
    assert.ok(!r.selected.some((s) => s.place_id === id(899)), "the oldest quiet places beyond the budget wait instead");
  });

  it("a busy place 1 500 deep, beyond the scan window, is re-queued by run floor(1500 / 300) + 1 = 6 at the latest (here: run 2)", async () => {
    const db = makeDb({
      place_best_of: [...range(1500).map((i) => overdue(id(i), 3000 - i)), overdue("busy-1", 10)],
      posts: busyPosts("busy-1"),
      place_cache_invalidation_queue: [],
    });
    let when = 0;
    for (let run = 0; run < 6 && when === 0; run++) {
      const at = NOW + run * 15 * MIN;
      await runPlaceCollectionsSweepTick({ client: db, now: at });
      if (requeuedAt(db, at).includes("busy-1")) when = run + 1;
    }
    assert.ok(when >= 1 && when <= 6, `re-queued in run ${when}`);
    assert.equal(when, 2, `the scan window (${STALE_SWEEP_MAX_SCAN_PAGES} pages) reaches it once 600 older places are done`);
  });

  it("the bound holds on a randomized backlog with arrivals every run: a place k eligible places deep goes within floor(k / 300) + 1 runs", async () => {
    const rand = rng(20261017);
    const initial = range(2000).map((i) => overdue(id(i), 4000 - i));
    const busyIds = initial.filter(() => rand() < 0.3).map((r) => r.place_id);
    const arrivals: Row[][] = range(8).map((run) => range(300, 10_000 + run * 300).map((i) => ({
      place_id: id(i), updated_at: new Date(NOW + 10 * HOUR).toISOString(),
    })));
    const arrivalBusy = arrivals.flat().filter(() => rand() < 0.5).map((r) => r.place_id);
    const db = makeDb({
      place_best_of: [...initial, ...arrivals.flat()],
      posts: [...busyIds, ...arrivalBusy].flatMap(busyPosts),
      place_cache_invalidation_queue: [],
    });
    const firstRun = new Map<string, number>();
    for (let run = 0; run < 8; run++) {
      const at = NOW + run * 15 * MIN;
      for (const a of arrivals[run]) {
        db.tables.place_best_of.find((r) => r.place_id === a.place_id)!.updated_at =
          new Date(at - STALE - 1 * MIN).toISOString();
      }
      await runPlaceCollectionsSweepTick({ client: db, now: at });
      for (const p of requeuedAt(db, at)) if (!firstRun.has(p)) firstRun.set(p, run + 1);
    }
    initial.forEach((r, k) => {
      const run = firstRun.get(r.place_id);
      assert.ok(run !== undefined && run <= Math.floor(k / 300) + 1, `${r.place_id} (k=${k}) re-queued in run ${run ?? "never"}`);
    });
  });
});

// ── 4. Within capacity ────────────────────────────────────────────────────────

describe("within capacity no place waits a second run", () => {
  it("450 overdue, a third of them busy, budget 500: all 450 are re-queued in one run", async () => {
    const rows = range(450).map((i) => overdue(id(i), 1000 - i));
    const busy = rows.filter((_, i) => i % 3 === 0).map((r) => r.place_id);
    const db = makeDb({ place_best_of: rows, posts: busy.flatMap(busyPosts), place_cache_invalidation_queue: [] });
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.budget.places, 500);
    assert.equal(r.requeued, 450);
    assert.deepEqual(new Set(r.selected.map((s) => s.place_id)), new Set(rows.map((x) => x.place_id)));
    const lanes = { aging: 0, traffic: 0, fill: 0 };
    for (const s of r.selected) lanes[s.lane]++;
    assert.equal(lanes.aging, 250);
    assert.equal(lanes.traffic, busy.filter((p) => Number(p.slice(1)) >= 250).length);
    assert.equal(lanes.fill, 450 - 250 - lanes.traffic);
    assert.equal(r.backlogRemains, false);
  });
});

// ── 5. Budget ─────────────────────────────────────────────────────────────────

describe("the budget grows with the backlog and is bounded both ways", () => {
  it("pages = clamp(ceil(backlog / 100), 2, 6); scan = min(12, 2 × pages); aging = half", () => {
    const cases: Array<[number | null, number]> = [
      [null, 2], [-5, 2], [0, 2], [1, 2], [200, 2], [201, 3], [350, 4], [600, 6], [601, 6], [1_000_000, 6],
    ];
    for (const [backlog, pages] of cases) {
      const b = staleSweepBudget(backlog);
      assert.equal(b.pages, pages, `backlog ${backlog}`);
      assert.equal(b.places, pages * 100);
      assert.equal(b.scanPages, Math.min(12, 2 * pages));
      assert.equal(b.agingSlots, pages * 50);
    }
  });

  it("a backlog of 10 000 is read at most 12 pages deep and re-queues at most 600", async () => {
    const db = makeDb({
      place_best_of: range(10_000).map((i) => overdue(id(i), 20_000 - i)),
      posts: [],
      place_cache_invalidation_queue: [],
    });
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.backlog, 10_000);
    assert.ok(r.pagesRead <= 12, `read ${r.pagesRead} pages`);
    assert.equal(r.requeued, 600);
    assert.equal(r.backlogRemains, true);
  });

  it("the drain is bounded too: 2 × ceil(requeued / 20) + 1 passes, never more than 61", () => {
    assert.equal(drainPassesFor(0), 0);
    assert.equal(drainPassesFor(5), 3);
    assert.equal(drainPassesFor(600), 61);
    assert.equal(drainPassesFor(1_000_000), 61);
    assert.equal(STALE_SWEEP_MAX_DRAIN_PASSES, 61);
  });
});

// ── 6. In flight ──────────────────────────────────────────────────────────────

describe("a place the queue already holds is waiting on the drain, not on the sweep", () => {
  it("pending and processing places are counted in flight, keep their queue row untouched, and take no slot", async () => {
    const lockedUntil = new Date(NOW + 5 * MIN).toISOString();
    const db = makeDb({
      place_best_of: range(10).map((i) => overdue(id(i), 100 - i)),
      posts: [],
      place_cache_invalidation_queue: [
        { place_id: id(0), status: "pending", queued_at: "2026-10-17T01:00:00.000Z", locked_until: null, locked_by: null },
        { place_id: id(1), status: "processing", queued_at: "2026-10-17T02:00:00.000Z", locked_until: lockedUntil, locked_by: "w" },
        { place_id: id(2), status: "done", queued_at: "2026-10-16T00:00:00.000Z", locked_until: null, locked_by: null },
      ],
    });
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.inFlight, 2);
    assert.equal(r.requeued, 8);
    assert.deepEqual(r.selected.map((s) => s.place_id), range(8, 2).map(id));
    const q = (p: string) => db.tables.place_cache_invalidation_queue.find((x) => x.place_id === p)!;
    assert.equal(q(id(0)).queued_at, "2026-10-17T01:00:00.000Z", "a pending row keeps its place in line");
    assert.equal(q(id(1)).status, "processing", "a processing row is not reset (its mark-done would fail)");
    assert.equal(q(id(1)).queued_at, "2026-10-17T02:00:00.000Z");
    assert.equal(q(id(2)).status, "pending", "a done row whose collections are overdue again is re-queued");
    assert.equal(r.maxWaitMs, 100 * MIN, "an in-flight place still counts toward the longest wait");
  });
});

// ── 7. Failures ───────────────────────────────────────────────────────────────

describe("failures are counted, and one failing place does not block the rest", () => {
  it("unreadable activity: counted, ranked with the quiet places (never promoted on a guess), the run goes on", async () => {
    const db = makeDb(
      { place_best_of: range(700).map((i) => overdue(id(i), 1000 - i)), posts: [], place_cache_invalidation_queue: [] },
      (c) => (c.table === "posts" && c.filters.some(([k, col, v]) => k === "eq" && col === "canonical_place_id" && v === id(400))
        ? { code: "57014", message: "canceling statement due to statement timeout" } : null),
    );
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.failures.activityUnreadable, 1);
    assert.equal(r.requeued, 600);
    assert.equal(r.selected.find((s) => s.place_id === id(400))?.lane, "fill");
  });

  it("a place whose refresh throws is counted and the drain refreshes the others", async () => {
    const db = makeDb(
      { place_best_of: range(5).map((i) => overdue(id(i), 50 - i)), posts: [], place_cache_invalidation_queue: [] },
      // processPlace's posts read (limit 5 000) fails for one place only.
      (c) => (c.table === "posts" && c.limit === 5000 && c.filters.some(([, col, v]) => col === "canonical_place_id" && v === id(2))
        ? { message: "posts unavailable" } : null),
    );
    const s = await runPlaceCollectionsSweepTick({ client: db, now: NOW });
    assert.equal(s.lastResult!.drain.errors, 1);
    assert.equal(s.lastResult!.drain.processed, 4);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.refreshFailuresTotal, 1);
    assert.ok(s.lastFailures.some((f) => f.includes("1 refresh failure(s)")));
    const cutoff = new Date(NOW - STALE).toISOString();
    const stillOverdue = db.tables.place_best_of.filter((r) => r.updated_at < cutoff).map((r) => r.place_id);
    assert.deepEqual(stillOverdue, [id(2)], "the other four were refreshed");
    assert.equal(db.tables.place_cache_invalidation_queue.find((q) => q.place_id === id(2))!.status, "processing",
      "left for the stale-lock sweeper to re-queue");
  });

  it("an unreadable page of queue state skips that page — nothing is re-queued blind — and the walk goes on", async () => {
    const db = makeDb(
      { place_best_of: range(150).map((i) => overdue(id(i), 500 - i)), posts: [], place_cache_invalidation_queue: [] },
      (c) => (c.table === "place_cache_invalidation_queue" && c.op === "select" &&
        c.filters.some(([k, , v]) => k === "in" && (v as string[]).includes(id(0)))
        ? { message: "queue unavailable" } : null),
    );
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.failures.queueStateUnreadable, 1);
    assert.deepEqual(r.selected.map((s) => s.place_id), range(50, 100).map(id));
    assert.equal(r.backlogRemains, true);
  });

  it("a refused re-queue is counted, nothing is drained, and the run reads as failing", async () => {
    const db = makeDb(
      { place_best_of: range(3).map((i) => overdue(id(i), 30 - i)), posts: [], place_cache_invalidation_queue: [] },
      (c) => (c.table === "place_cache_invalidation_queue" && c.op === "upsert" ? { message: "permission denied" } : null),
    );
    const s = await runPlaceCollectionsSweepTick({ client: db, now: NOW });
    assert.equal(s.lastResult!.sweep.requeued, 0);
    assert.equal(s.lastResult!.sweep.failures.requeueFailed, 3);
    assert.equal(s.lastResult!.drain.passes, 0);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastResult!.sweep.backlogRemains, true);
  });

  it("an unreadable backlog count falls back to the floor budget and still walks", async () => {
    const db = makeDb(
      { place_best_of: range(300).map((i) => overdue(id(i), 500 - i)), posts: [], place_cache_invalidation_queue: [] },
      (c) => (c.table === "place_best_of" && c.count ? { message: "count timed out" } : null),
    );
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.backlog, null);
    assert.equal(r.failures.backlogUnreadable, 1);
    assert.equal(r.budget.places, 200);
    assert.equal(r.requeued, 200);
    assert.equal(r.backlogRemains, true);
  });
});

// ── 8. Metrics ────────────────────────────────────────────────────────────────

describe("backlog, maximum wait and failures are tracked and reported", () => {
  it("a clean run: status, health detail and one structured log line", async () => {
    const db = makeDb({
      place_best_of: [overdue(id(0), 90), ...range(4, 1).map((i) => overdue(id(i), 10 - i)), fresh("f1"), fresh("f2")],
      posts: [],
      place_cache_invalidation_queue: [],
    });
    const logs: string[] = [];
    mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
    const s = await runPlaceCollectionsSweepTick({ client: db, now: NOW });
    assert.equal(s.lastResult!.sweep.backlog, 5);
    assert.equal(s.lastResult!.sweep.maxWaitMs, 90 * MIN);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastSuccessAt, new Date(NOW).toISOString());
    assert.deepEqual(s.lastFailures, []);
    const detail = placeCollectionsSweepHealthDetail(s) ?? "";
    for (const part of ["backlog 5", "max wait 1h 30m", "re-queued 5", "0 refresh failure(s)"]) {
      assert.ok(detail.includes(part), `${part} in: ${detail}`);
    }
    const lines = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((l) => l?.event === "place_collections.stale_sweep_complete");
    assert.equal(lines.length, 1, "one line per run");
    assert.equal(lines[0].backlog, 5);
    assert.equal(lines[0].max_wait_ms, 90 * MIN);
    assert.equal(lines[0].refresh_failures, 0);
    assert.equal(getPlaceCollectionsSweepStatus().lastResult!.sweep.requeued, 5);
  });

  it("failures accumulate across failing runs and a clean run resets the streak", async () => {
    const failing = makeDb(
      { place_best_of: [overdue(id(0), 5)], posts: [], place_cache_invalidation_queue: [] },
      (c) => (c.table === "place_best_of" && c.op === "select" && !c.count ? { message: "down" } : null),
    );
    await runPlaceCollectionsSweepTick({ client: failing, now: NOW });
    const s2 = await runPlaceCollectionsSweepTick({ client: failing, now: NOW + MIN });
    assert.equal(s2.consecutiveFailures, 2);
    assert.ok(s2.lastFailures.some((f) => f.includes("overdue page could not be read")));
    assert.equal(s2.lastSuccessAt, null);
    const clean = makeDb({ place_best_of: [overdue(id(0), 5)], posts: [], place_cache_invalidation_queue: [] });
    const s3 = await runPlaceCollectionsSweepTick({ client: clean, now: NOW + 2 * MIN });
    assert.equal(s3.consecutiveFailures, 0);
    assert.equal(s3.lastSuccessAt, new Date(NOW + 2 * MIN).toISOString());
  });

  it("an empty backlog is a measured zero wait, not an unknown one", async () => {
    const db = makeDb({ place_best_of: [fresh("f1")], posts: [], place_cache_invalidation_queue: [] });
    const r = await runStaleSweep(db, { now: NOW });
    assert.equal(r.backlog, 0);
    assert.equal(r.maxWaitMs, 0);
    assert.equal(r.backlogRemains, false);
  });

  it("no service client is a failed run, not a clean one", async () => {
    const s = await runPlaceCollectionsSweepTick({ client: null, now: NOW });
    assert.equal(s.consecutiveFailures, 1);
    assert.ok(s.lastFailures[0].includes("no service client"));
  });
});

// ── 9. Follow-up ──────────────────────────────────────────────────────────────

describe("the backlog continues by itself, boundedly", () => {
  it("backlog left arms a run 15 minutes later, at most three in a row; a clear backlog arms none", () => {
    assert.equal(STALE_SWEEP_FOLLOW_UP_DELAY_MS, 15 * MIN);
    assert.equal(STALE_SWEEP_MAX_FOLLOW_UPS, 3);
    for (let n = 0; n < STALE_SWEEP_MAX_FOLLOW_UPS; n++) assert.equal(staleSweepFollowUpDelayMs(true, n), 15 * MIN);
    assert.equal(staleSweepFollowUpDelayMs(true, STALE_SWEEP_MAX_FOLLOW_UPS), null);
    assert.equal(staleSweepFollowUpDelayMs(false, 0), null);
  });
});
