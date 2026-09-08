/**
 * eventWaitlistSweeper — the freed seat, and the three reads that could not say
 * they had failed.
 *
 * ── WHY THIS FILE WAS REWRITTEN ──────────────────────────────────────────────
 * The previous version drove a fake whose chain returned a fixed fixture and
 * whose `deleteError` / `updateError` knobs were WIRED BUT NEVER ASSERTED ON,
 * because the sweeper discarded those errors and the fake had no table to
 * disagree with. So "the delete failed" and "the delete succeeded" produced
 * byte-identical passes, which is precisely the defect the file was supposed to
 * be watching.
 *
 * The fake here is a real in-memory `event_waitlist`: `.eq/.in/.is/.lt/.not`
 * filter rows, DELETE removes them, UPDATE mutates them, and both return the
 * rows they ACTUALLY touched when `.select()` is chained — exactly as postgrest
 * does. That is what makes the double-promotion case below expressible at all:
 * the second pass reads whatever the first pass really left behind.
 *
 * ── WHAT IS PROVEN ───────────────────────────────────────────────────────────
 *   • the writes are ISSUED (the request counter is asserted non-zero — a
 *     PostgrestBuilder is a thenable, and an un-awaited chain issues nothing);
 *   • a failed DELETE frees NO seat and promotes NO ONE, and the expired rows
 *     are still there afterwards (was: credited as cleared, then re-promoted on
 *     every later sweep — one seat, unbounded promotions);
 *   • an unreadable QUEUE is `unreadable`, distinct from `stranded`: "nobody is
 *     waiting" and "the waitlist cannot be read" are different answers;
 *   • a failed promotion UPDATE is `failed` and nobody holds an offer;
 *   • two passes over the same table promote ONE user for ONE freed seat, and
 *     two CONCURRENT passes do too;
 *   • every count is asserted. A pass that processed zero rows fails the cases
 *     that claim it processed some.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventWaitlistSweeper.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runSweep,
  getSweepStatus,
  _resetStatus,
  OFFER_WINDOW_MS,
} from "../lib/eventWaitlistSweeper.js";

// ── The table-backed fake ─────────────────────────────────────────────────────

interface WlRow {
  event_id: string;
  user_id: string;
  position: number;
  offer_expires_at: string | null;
}

interface FakeCfg {
  /** Ops that resolve with `{data:null,error}` — the RESOLVED failure supabase-js really produces. */
  fail?: Partial<Record<"select" | "delete" | "update", boolean>>;
  /** The initial expired-offer select THROWS rather than resolving. */
  throwOnSelect?: boolean;
  /** Fail only the queue (`IS NULL`) select, not the initial expired select. */
  failQueueSelect?: boolean;
}

function makeClient(rows: WlRow[], cfg: FakeCfg = {}) {
  const counts = { select: 0, delete: 0, update: 0 };
  const client = {
    _rows: rows,
    _counts: counts,
    from(_table: string) {
      let op: "select" | "delete" | "update" = "select";
      let patch: Record<string, unknown> = {};
      let usedIsNull = false;
      let limitN: number | null = null;
      let ordered = false;
      const filters: Array<(r: WlRow) => boolean> = [];

      const b: any = {
        select() { if (op === "select") op = "select"; return b; },
        delete() { op = "delete"; return b; },
        update(p: Record<string, unknown>) { op = "update"; patch = p; return b; },
        eq(c: string, v: any) { filters.push((r) => (r as any)[c] === v); return b; },
        in(c: string, v: any[]) { filters.push((r) => v.includes((r as any)[c])); return b; },
        is(c: string, v: any) {
          if (c === "offer_expires_at" && v === null) usedIsNull = true;
          filters.push((r) => ((r as any)[c] ?? null) === v);
          return b;
        },
        not(c: string, _op: string, v: any) { filters.push((r) => ((r as any)[c] ?? null) !== v); return b; },
        lt(c: string, v: any) {
          filters.push((r) => (r as any)[c] !== null && String((r as any)[c]) < String(v));
          return b;
        },
        order() { ordered = true; return b; },
        limit(n: number) { limitN = n; return b; },
        then(onF: any, onR: any) {
          counts[op] += 1;
          const failed =
            (op === "select" && cfg.throwOnSelect) ? "throw" :
            (op === "select" && cfg.failQueueSelect && usedIsNull) ? "error" :
            (cfg.fail?.[op] && !(op === "select" && cfg.failQueueSelect)) ? "error" :
            null;
          if (failed === "throw") return Promise.reject(new Error("DB error")).then(onF, onR);
          if (failed === "error") {
            return Promise.resolve({ data: null, error: { message: `${op} failed` }, count: null }).then(onF, onR);
          }

          let hit = rows.filter((r) => filters.every((f) => f(r)));
          if (ordered) hit = [...hit].sort((a, z) => a.position - z.position);
          if (limitN !== null) hit = hit.slice(0, limitN);

          if (op === "delete") {
            for (const r of hit) {
              const i = rows.indexOf(r);
              if (i >= 0) rows.splice(i, 1);
            }
          } else if (op === "update") {
            for (const r of hit) Object.assign(r, patch);
          }
          // postgrest returns the touched rows only because `.select()` was
          // chained; the sweeper depends on that to know what it really changed.
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null, count: hit.length })
            .then(onF, onR);
        },
      };
      return b;
    },
  };
  return client;
}

const PAST   = new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

function seat(event_id: string, user_id: string, position: number, offer: string | null): WlRow {
  return { event_id, user_id, position, offer_expires_at: offer };
}

beforeEach(() => { _resetStatus(); });

// ══════════════════════════════════════════════════════════════════════════════
// Baseline behaviour
// ══════════════════════════════════════════════════════════════════════════════

describe("no client", () => {
  it("skips with reason no_client and touches nothing", async () => {
    const r = await runSweep({ client: null });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "no_client");
    assert.equal(r.scanned, 0);
    assert.equal(getSweepStatus().lastRunAt, null);
    assert.equal(getSweepStatus().consecutiveFailures, 0);
  });
});

describe("nothing has expired", () => {
  it("is a clean pass, NOT an error: reason null, scanned 0, zero writes", async () => {
    const rows = [seat("e1", "u1", 1, FUTURE), seat("e1", "u2", 2, null)];
    const c = makeClient(rows);
    const r = await runSweep({ client: c });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.deepEqual(
      { scanned: r.scanned, cleared: r.cleared, promoted: r.promoted, failed: r.failed, unreadable: r.unreadable },
      { scanned: 0, cleared: 0, promoted: 0, failed: 0, unreadable: 0 },
    );
    assert.equal(c._counts.delete, 0, "no delete may be issued");
    assert.equal(c._counts.update, 0, "no update may be issued");
    assert.equal(rows.length, 2, "no row may be touched");
    const s = getSweepStatus();
    assert.ok(s.lastRunAt !== null);
    assert.equal(s.consecutiveFailures, 0);
  });
});

describe("the ordinary case", () => {
  it("frees the seat, promotes exactly one, and the WRITE IS ISSUED", async () => {
    const rows = [seat("e1", "expired", 1, PAST), seat("e1", "next", 2, null), seat("e1", "after", 3, null)];
    const c = makeClient(rows);
    const before = Date.now();
    const r = await runSweep({ client: c });

    assert.deepEqual(
      { scanned: r.scanned, events: r.events, cleared: r.cleared, promoted: r.promoted, stranded: r.stranded, unreadable: r.unreadable, failed: r.failed },
      { scanned: 1, events: 1, cleared: 1, promoted: 1, stranded: 0, unreadable: 0, failed: 0 },
    );
    // The counter, not the log line: a PostgrestBuilder is a thenable and an
    // un-awaited chain issues no request at all.
    assert.ok(c._counts.delete >= 1, "the DELETE must actually be issued");
    assert.ok(c._counts.update >= 1, "the promotion UPDATE must actually be issued");

    // The table really moved.
    assert.equal(rows.find((x) => x.user_id === "expired"), undefined, "the expired holder is gone");
    const next = rows.find((x) => x.user_id === "next")!;
    assert.ok(next.offer_expires_at, "the next in queue holds an offer");
    const diff = new Date(next.offer_expires_at!).getTime() - before;
    assert.ok(diff >= OFFER_WINDOW_MS - 5_000 && diff <= OFFER_WINDOW_MS + 5_000,
      `offer window is ${diff}ms, expected ~${OFFER_WINDOW_MS}ms`);
    // Queue order is respected: position 3 is not jumped ahead of position 2.
    assert.equal(rows.find((x) => x.user_id === "after")!.offer_expires_at, null);

    const s = getSweepStatus();
    assert.equal(s.lastExpiredCount, 1);
    assert.equal(s.consecutiveFailures, 0);
  });

  it("promotes ALL the seats it freed, not just the first", async () => {
    const rows = [
      seat("e1", "exp-1", 1, PAST), seat("e1", "exp-2", 2, PAST),
      seat("e1", "next-1", 3, null), seat("e1", "next-2", 4, null), seat("e1", "next-3", 5, null),
    ];
    const c = makeClient(rows);
    const r = await runSweep({ client: c });
    assert.equal(r.cleared, 2);
    assert.equal(r.promoted, 2, "both freed seats promoted, not just one");
    assert.deepEqual(
      rows.filter((x) => x.offer_expires_at !== null).map((x) => x.user_id).sort(),
      ["next-1", "next-2"],
    );
    assert.equal(rows.find((x) => x.user_id === "next-3")!.offer_expires_at, null,
      "a third user must not be promoted for two seats");
  });

  it("processes several events independently in one pass", async () => {
    const rows = [
      seat("eA", "expA", 1, PAST), seat("eA", "nextA", 2, null),
      seat("eB", "expB", 1, PAST),                                  // eB queue exhausted
    ];
    const r = await runSweep({ client: makeClient(rows) });
    assert.equal(r.events, 2);
    assert.equal(r.cleared, 2);
    assert.equal(r.promoted, 1);
    assert.equal(r.stranded, 1, "eB's freed seat is stranded, and is REPORTED as stranded");
  });

  it("an exhausted queue is `stranded`, and no update is issued", async () => {
    const rows = [seat("e1", "expired", 1, PAST)];
    const c = makeClient(rows);
    const r = await runSweep({ client: c });
    assert.equal(r.cleared, 1);
    assert.equal(r.promoted, 0);
    assert.equal(r.stranded, 1);
    assert.equal(r.unreadable, 0, "an EMPTY queue is not an UNREADABLE one");
    assert.equal(c._counts.update, 0);
    assert.equal(getSweepStatus().consecutiveFailures, 0, "an empty queue is not a failure");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The three discarded errors
// ══════════════════════════════════════════════════════════════════════════════

describe("the DELETE resolves with .error", () => {
  it("frees NOTHING, promotes NO ONE, leaves the rows in place, and is counted a failure", async () => {
    // supabase-js RESOLVES on a database error. The old code dropped this
    // result entirely, credited itself with clearing the rows, and then
    // promoted a user for a seat that was never freed.
    const rows = [seat("e1", "expired", 1, PAST), seat("e1", "next", 2, null)];
    const c = makeClient(rows, { fail: { delete: true } });
    const r = await runSweep({ client: c });

    assert.equal(r.failed, 1);
    assert.equal(r.cleared, 0, "a refused DELETE frees no seat");
    assert.equal(r.promoted, 0, "and therefore entitles the pass to no promotion");
    assert.equal(c._counts.update, 0, "no promotion write may even be ISSUED");
    assert.ok(rows.find((x) => x.user_id === "expired"), "the expired row is still there");
    assert.equal(rows.find((x) => x.user_id === "next")!.offer_expires_at, null,
      "nobody may hold an offer for a seat that was never freed");
    assert.equal(getSweepStatus().lastExpiredCount, 0, "the status must not claim rows it did not clear");
    assert.equal(getSweepStatus().consecutiveFailures, 1,
      "a pass in which every event failed is a failed pass");
  });

  it("REGRESSION: a permanently refused DELETE cannot promote a new user every sweep", async () => {
    // The measured consequence of the discarded error. The expired row survives
    // with a past offer_expires_at, so each later sweep saw it again, "cleared"
    // it again, and promoted whoever was next — because the previously promoted
    // user now had a non-null offer and the IS NULL query skipped them.
    const rows = [
      seat("e1", "expired", 1, PAST),
      seat("e1", "next-1", 2, null), seat("e1", "next-2", 3, null), seat("e1", "next-3", 4, null),
    ];
    const c = makeClient(rows, { fail: { delete: true } });
    for (let i = 0; i < 3; i++) await runSweep({ client: c });
    const holders = rows.filter((x) => x.user_id.startsWith("next") && x.offer_expires_at !== null);
    assert.equal(holders.length, 0,
      `three sweeps over one un-deletable seat promoted ${holders.length} users`);
    assert.equal(getSweepStatus().consecutiveFailures, 3);
  });
});

describe("the QUEUE read resolves with .error", () => {
  it("is `unreadable`, NOT `stranded` — the seat is retried, not written off", async () => {
    // `error` was not destructured at all here, so "nobody is waiting" and "the
    // waitlist is unreadable" were the same value and the seat vanished quietly.
    const rows = [seat("e1", "expired", 1, PAST), seat("e1", "next", 2, null)];
    const c = makeClient(rows, { failQueueSelect: true });
    const r = await runSweep({ client: c });

    assert.equal(r.unreadable, 1);
    assert.equal(r.stranded, 0, "an unreadable queue must not be reported as an empty one");
    assert.equal(r.promoted, 0);
    assert.equal(c._counts.update, 0, "no promotion may be issued on an unreadable queue");
    assert.equal(r.cleared, 1, "the delete DID succeed — the seat is genuinely free");
    assert.equal(getSweepStatus().consecutiveFailures, 1,
      "an unreadable waitlist is a failure the health surface must see");
  });

  it("the healthy twin: a readable EMPTY queue is not a failure", async () => {
    // Without this, "always report unreadable" would pass the case above and
    // make every exhausted queue look like an outage.
    const rows = [seat("e1", "expired", 1, PAST)];
    const r = await runSweep({ client: makeClient(rows) });
    assert.equal(r.unreadable, 0);
    assert.equal(r.stranded, 1);
    assert.equal(getSweepStatus().consecutiveFailures, 0);
  });
});

describe("the promotion UPDATE resolves with .error", () => {
  it("is counted failed and nobody ends up holding an offer", async () => {
    const rows = [seat("e1", "expired", 1, PAST), seat("e1", "next", 2, null)];
    const c = makeClient(rows, { fail: { update: true } });
    const r = await runSweep({ client: c });
    assert.equal(r.failed, 1);
    assert.equal(r.promoted, 0, "a refused write is not a promotion");
    assert.ok(c._counts.update >= 1, "the write was issued — it is the RESULT that failed");
    assert.equal(rows.find((x) => x.user_id === "next")!.offer_expires_at, null);
    assert.equal(getSweepStatus().consecutiveFailures, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Idempotence and double-promotion
// ══════════════════════════════════════════════════════════════════════════════

describe("idempotence", () => {
  it("a second pass over the same table scans nothing and writes nothing", async () => {
    const rows = [seat("e1", "expired", 1, PAST), seat("e1", "next", 2, null), seat("e1", "after", 3, null)];
    const c = makeClient(rows);
    const first = await runSweep({ client: c });
    assert.equal(first.promoted, 1);
    const deletesAfterFirst = c._counts.delete;
    const updatesAfterFirst = c._counts.update;

    const second = await runSweep({ client: c });
    assert.equal(second.scanned, 0, "the promoted user's offer is in the FUTURE — nothing is due");
    assert.equal(second.promoted, 0);
    assert.equal(c._counts.delete, deletesAfterFirst, "no further delete issued");
    assert.equal(c._counts.update, updatesAfterFirst, "no further promotion issued");
    assert.equal(rows.find((x) => x.user_id === "after")!.offer_expires_at, null,
      "one seat, one promotion, across two passes");
  });

  it("two CONCURRENT passes over one freed seat promote exactly one user", async () => {
    // Both passes read the same expired row. The DELETE decides: the loser
    // removes zero rows, so it is entitled to zero promotions.
    const rows = [
      seat("e1", "expired", 1, PAST),
      seat("e1", "next-1", 2, null), seat("e1", "next-2", 3, null),
    ];
    const c = makeClient(rows);
    const [a, b] = await Promise.all([runSweep({ client: c }), runSweep({ client: c })]);
    assert.equal(a.cleared + b.cleared, 1, "only one pass may free the seat");
    assert.equal(a.promoted + b.promoted, 1, "one seat must yield exactly one promotion");
    assert.equal(rows.filter((x) => x.offer_expires_at !== null).length, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The top-level read
// ══════════════════════════════════════════════════════════════════════════════

describe("the expired-offer read fails", () => {
  it("throws → reason error, no writes, consecutiveFailures increments", async () => {
    const rows = [seat("e1", "expired", 1, PAST)];
    const c = makeClient(rows, { throwOnSelect: true });
    const r = await runSweep({ client: c });
    assert.equal(r.reason, "error");
    assert.equal(r.scanned, 0);
    assert.equal(c._counts.delete, 0);
    assert.equal(c._counts.update, 0);
    assert.equal(rows.length, 1, "nothing may be touched when the read failed");
    const s = getSweepStatus();
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastRunAt, null, "a failed pass must not stamp a successful run time");
  });

  it("RESOLVES with .error → also reason error, never read as 'no expired offers'", async () => {
    const rows = [seat("e1", "expired", 1, PAST)];
    const c = makeClient(rows, { fail: { select: true } });
    const r = await runSweep({ client: c });
    assert.equal(r.reason, "error");
    assert.equal(c._counts.delete, 0);
    assert.equal(getSweepStatus().consecutiveFailures, 1);
  });

  it("consecutive failures accumulate, and a healthy pass clears them", async () => {
    const bad = makeClient([seat("e1", "x", 1, PAST)], { throwOnSelect: true });
    await runSweep({ client: bad });
    await runSweep({ client: bad });
    assert.equal(getSweepStatus().consecutiveFailures, 2);
    await runSweep({ client: makeClient([]) });
    assert.equal(getSweepStatus().consecutiveFailures, 0, "a clean pass must clear the counter");
  });
});
