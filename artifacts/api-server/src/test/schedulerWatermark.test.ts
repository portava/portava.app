/**
 * schedulerWatermark — the span a scheduler scans, and the two rules that keep
 * it honest.
 *
 * The defect being guarded: a job that selects work with `now - N` and keeps no
 * record of where it got to cannot see rows that fell inside a gap longer than
 * N. On Replit autoscale a gap longer than an hour is an ordinary quiet night,
 * so for several jobs that loss was continuous rather than exceptional.
 *
 * Run: node --import tsx/esm --test src/test/schedulerWatermark.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { scanWindow, readWatermark, commitWatermark } from "../lib/schedulerWatermark.js";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

describe("scanWindow — the span", () => {
  it("with no stored mark, behaves exactly like the old fixed lookback", () => {
    // Introducing a watermark must not change a first run or a fresh database.
    const w = scanWindow({
      watermark: null, now: new Date(T0), defaultLookbackMs: HOUR, maxCatchupMs: 7 * DAY,
    });
    assert.equal(w.since.getTime(), T0 - HOUR);
    assert.equal(w.through.getTime(), T0);
    assert.equal(w.capped, false);
  });

  it("THE FIX: a mark from before a 54-hour gap makes the next scan cover the gap, not the last hour", () => {
    // This is the whole point. The old shape would scan T0-1h and never look at
    // the 53 hours before that again.
    const markedAt = T0 - 54 * HOUR;
    const w = scanWindow({
      watermark: new Date(markedAt), now: new Date(T0), defaultLookbackMs: HOUR, maxCatchupMs: 7 * DAY,
    });
    assert.equal(w.since.getTime(), markedAt,
      "scan starts where the last successful pass ended, not now minus the lookback");
    assert.ok(w.through.getTime() - w.since.getTime() > 53 * HOUR,
      "the span covers the gap");
    assert.equal(w.capped, false, "7 days of allowance is not exceeded by 54 hours");
  });

  it("the cap bounds the first scan after a very long gap, and SAYS it did", () => {
    const w = scanWindow({
      watermark: new Date(T0 - 30 * DAY), now: new Date(T0), defaultLookbackMs: HOUR, maxCatchupMs: 2 * DAY,
    });
    assert.equal(w.since.getTime(), T0 - 2 * DAY, "span is clamped to the allowance");
    assert.equal(w.capped, true,
      "capped must be visible — a pass that did not cover the whole gap is not a clean pass");
  });

  it("a mark exactly at the cap boundary is not reported as capped", () => {
    const w = scanWindow({
      watermark: new Date(T0 - 2 * DAY), now: new Date(T0), defaultLookbackMs: HOUR, maxCatchupMs: 2 * DAY,
    });
    assert.equal(w.capped, false);
    assert.equal(w.since.getTime(), T0 - 2 * DAY);
  });

  it("a mark in the FUTURE falls back to the lookback instead of scanning an inverted span", () => {
    // A corrupt row or a clock that went backwards. Scanning an inverted range
    // would match nothing and then be reported as a successful pass over it.
    const w = scanWindow({
      watermark: new Date(T0 + 5 * HOUR), now: new Date(T0), defaultLookbackMs: HOUR, maxCatchupMs: 7 * DAY,
    });
    assert.equal(w.since.getTime(), T0 - HOUR);
    assert.ok(w.since.getTime() < w.through.getTime(), "span is never inverted");
  });
});

// ── DB doubles ───────────────────────────────────────────────────────────────

function dbReturning(row: any, opts: { error?: { message: string }; throws?: boolean } = {}) {
  const upserts: any[] = [];
  const client = {
    from() {
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() {
          if (opts.throws) throw new Error("connection reset");
          if (opts.error) return { data: null, error: opts.error };
          return { data: row, error: null };
        },
        upsert(payload: any) { upserts.push(payload); return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, upserts };
}

describe("readWatermark — an unreadable mark is a refusal, not an absence", () => {
  it("no row yet reads as ok:true with at:null — scan from the default lookback", async () => {
    const { client } = dbReturning(null);
    assert.deepEqual(await readWatermark(client, "j"), { at: null, ok: true });
  });

  it("a DB error reads as ok:FALSE — the caller must not treat it as a fresh install", async () => {
    // supabase-js RESOLVES on a database error, so this is precisely the case a
    // `const { data } = await …` would turn into "no watermark".
    const { client } = dbReturning(null, { error: { message: "permission denied" } });
    const r = await readWatermark(client, "j");
    assert.equal(r.ok, false);
    assert.equal(r.at, null);
  });

  it("a thrown error reads as ok:false", async () => {
    const { client } = dbReturning(null, { throws: true });
    assert.equal((await readWatermark(client, "j")).ok, false);
  });

  it("an unparseable timestamp reads as ok:false rather than Invalid Date", async () => {
    const { client } = dbReturning({ processed_through: "not-a-date" });
    const r = await readWatermark(client, "j");
    assert.equal(r.ok, false, "a mark that cannot be parsed cannot establish how far work got");
    assert.equal(r.at, null);
  });

  it("a stored mark is returned", async () => {
    const iso = new Date(T0 - 3 * HOUR).toISOString();
    const { client } = dbReturning({ processed_through: iso });
    const r = await readWatermark(client, "j");
    assert.equal(r.ok, true);
    assert.equal(r.at!.getTime(), T0 - 3 * HOUR);
  });
});

describe("commitWatermark — advance only on proven ground", () => {
  it("REFUSES to write when the current mark cannot be read, and issues no upsert", async () => {
    // Cannot establish that writing would be an advance, so it must not write.
    const { client, upserts } = dbReturning(null, { error: { message: "timeout" } });
    assert.equal(await commitWatermark(client, "j", new Date(T0)), false);
    assert.equal(upserts.length, 0, "no write may be attempted on unreadable ground");
  });

  it("writes when there is no mark yet", async () => {
    const { client, upserts } = dbReturning(null);
    assert.equal(await commitWatermark(client, "j", new Date(T0)), true);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].job, "j");
    assert.equal(upserts[0].processed_through, new Date(T0).toISOString());
  });

  it("advances a mark forward", async () => {
    const { client, upserts } = dbReturning({ processed_through: new Date(T0 - HOUR).toISOString() });
    assert.equal(await commitWatermark(client, "j", new Date(T0)), true);
    assert.equal(upserts.length, 1);
  });

  it("never moves a mark BACKWARDS — an out-of-order commit cannot undo progress", async () => {
    const { client, upserts } = dbReturning({ processed_through: new Date(T0).toISOString() });
    assert.equal(await commitWatermark(client, "j", new Date(T0 - 6 * HOUR)), true,
      "already past the requested instant, so the mark is satisfied");
    assert.equal(upserts.length, 0, "no regressing write is issued");
  });

  it("an invalid instant is refused outright", async () => {
    const { client, upserts } = dbReturning(null);
    assert.equal(await commitWatermark(client, "j", new Date("nope")), false);
    assert.equal(upserts.length, 0);
  });
});
