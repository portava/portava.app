/**
 * rentBuddyMoneyAtomicity.test.ts
 *
 * The ATOMICITY cluster of the Stage 1B money repairs
 * (docs/architecture/12_Claude_Code_Implementation.md §4) — four places where
 * the rent-a-buddy money record could be silently destroyed or silently wrong:
 *
 *   M8  a second tip OVERWROTE the first (rent_buddy_tips is UNIQUE on
 *       booking_id and the upsert replaced rather than accumulated)
 *   M13 cash confirmation read the booking and wrote it in a separate
 *       statement, so two simultaneous confirmations raced — and the confirmed
 *       amount was unbounded (docs/rent-buddy-audit.md:397)
 *   M3  both payout transitions were a bare .update({status}).eq("id", id) with
 *       no predicate on the CURRENT status, so releasing an already-released
 *       payout succeeded silently and overwrote released_by/released_at
 *   M7  earnings were summed in JavaScript over an UNPAGINATED select, so
 *       PostgREST's row cap silently truncated a buddy's total
 *
 * WHY EACH CONCURRENCY TEST ALSO ASSERTS THE OLD SHAPE FAILS.
 * .agents/memory/prove-the-test-fails-before-trusting-it.md: a concurrency test
 * that passes against both the broken and the fixed implementation proves
 * nothing. Every "…lands exactly N" case below is paired with a control that
 * drives the PRE-FIX shape through the SAME harness and asserts it comes out
 * wrong. If a future edit reverts the repair, the control starts passing where
 * the real case starts failing — the pair cannot both be green.
 *
 * The fake `rpc()` models the ONE property the SQL functions actually provide:
 * the read and the write are not separated by an await, so no other in-flight
 * call can interleave between them. That is exactly what the booking's row lock
 * in `rb_post_booking_ledger`, `FOR NO KEY UPDATE` around the confirm, and
 * `FOR UPDATE` around a payout transition buy in the real database. The model
 * is helpers/fakeRentBuddyLedgerRpc.ts; the functions themselves are executed
 * by src/test/db/rentBuddyLedgerPosting.db.test.ts (T4 and P4 are the
 * concurrency cases against PostgreSQL).
 *
 * ── WHAT PAYMENTS PAY-014 / PAY-018 / PAY-075 CHANGED HERE ───────────────────
 *   M8  a tip is LEDGER ENTRIES now (migration 3824): one balanced pair and no
 *       commission entry, with the tips row and both tip_usd copies re-derived
 *       from the fold. The accumulation cases assert the entries as well.
 *   --  THE FALLBACK TESTS ARE INVERTED. This file used to assert that with no
 *       `.rpc` a tip "accumulates on the fallback path too" and a cash
 *       confirmation is "bounded on the fallback path too". The fallback was a
 *       read-modify-write of a money figure from the API process — the thing
 *       `09` §3 refusal 2 forbids. It is gone, so both cases now assert the
 *       opposite: the write is REFUSED with a named error and the client is
 *       asked for NOTHING ELSE — no read, no update, no upsert.
 *   M3  hold / release go through `rb_admin_payout_transition`, which writes
 *       the audit row in the transition's own transaction. The compare-and-swap
 *       cases are unchanged in what they assert; new cases assert that a failed
 *       audit insert leaves the status where it was, that a reason is required,
 *       and that an absent function is a refusal rather than a bare UPDATE.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyMoneyAtomicity.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";
import {
  accumulateBookingTip,
  confirmBookingCash,
  fetchAllBuddyEarningsRows,
  foldEarningsRows,
} from "../routes/rentABuddy.js";
import {
  emptyLedgerDb,
  fakeConfirmBookingCash,
  fakeLedgerRpc,
  functionNotFound,
  type FakeLedgerDb,
} from "./helpers/fakeRentBuddyLedgerRpc.js";

process.env.TZ = "UTC";

const BOOKING_ID   = "ma-booking-1";
const TRAVELER_ID  = "ma-traveler-1";
const BUDDY_PROF   = "ma-buddy-profile-1";
const BUDDY_USER   = "ma-buddy-user-1";
const OUTSIDER_ID  = "ma-outsider-1";

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Yield to the microtask/macrotask queue so parallel calls really interleave. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── An in-memory database with single-statement semantics ─────────────────────

type FakeDb = FakeLedgerDb;

function seedDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return emptyLedgerDb({
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id: BUDDY_PROF,
        status: "completed",
        total_usd: 100,
        cash_balance_usd: 35,
        cash_balance_confirmed_by_traveler: null,
        cash_balance_confirmed_by_buddy: null,
        dispute_window_expires_at: null,
        tip_usd: null,
      },
    },
    buddyProfiles: { [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER } },
    ...overrides,
  });
}

/** Everything a client was asked for through `.from()` — a fallback's fingerprints. */
interface TableOp { table: string; op: string }

/**
 * A client whose `.rpc()` is the model of migration 3824's functions and 2330's
 * cash confirmation.
 *
 * The critical property under test: after the initial `await tick()` (which
 * stands in for the round trip), the read-decide-write runs SYNCHRONOUSLY, so
 * two overlapping calls cannot interleave inside it. That is the guarantee the
 * SQL function gives under its row lock, and the guarantee the pre-fix
 * TypeScript did not have.
 *
 * `.from()` THROWS: a helper that reaches for a table has left the one door.
 */
function makeRpcClient(db: FakeDb, opts: { absent?: string[]; calls?: Array<{ fn: string; args: any }> } = {}) {
  return {
    rpc: fakeLedgerRpc(db, {
      tick,
      absent: opts.absent,
      calls: opts.calls,
      otherwise: (fn, args) => (fn === "rb_confirm_booking_cash" ? fakeConfirmBookingCash(db, args) : functionNotFound(fn)),
    }),
    from: () => { throw new Error("this client only serves rpc()"); },
  } as any;
}

/**
 * A client with NO `.rpc` — an un-applied migration, or a partial test fake —
 * that would happily serve the read-modify-write the helpers used to fall back
 * to, and records every table operation it is asked for. The helpers must ask
 * for none.
 */
function makeNoRpcClient(db: FakeDb) {
  const ops: TableOp[] = [];
  function table(t: string) {
    const filters: Array<[string, any]> = [];
    let op: "select" | "update" | "upsert" = "select";
    let payload: any = null;
    let single = false;

    const b: any = {
      select() { op = "select"; ops.push({ table: t, op: "select" }); return b; },
      update(p: any) { op = "update"; payload = p; ops.push({ table: t, op: "update" }); return b; },
      upsert(p: any) { op = "upsert"; payload = p; ops.push({ table: t, op: "upsert" }); return b; },
      eq(col: string, val: any) { filters.push([col, val]); return b; },
      in() { return b; },
      order() { return b; },
      range() { return b; },
      maybeSingle() { single = true; return b; },
      single() { single = true; return b; },
      then(resolve: any, reject: any) { return Promise.resolve(b._resolve()).then(resolve, reject); },
      _resolve() {
        const idOf = (col: string) => filters.find(([c]) => c === col)?.[1];
        if (op === "upsert" && t === "rent_buddy_tips") {
          const bid = payload.booking_id;
          db.tips[bid] = { id: db.tips[bid]?.id ?? `tip-${bid}`, ...payload };
          return { data: null, error: null };
        }
        if (op === "update") {
          if (t === "rent_buddy_bookings") { const row = db.bookings[idOf("id")]; if (row) Object.assign(row, payload); }
          if (t === "rent_buddy_earnings_ledger") { const row = db.ledger[idOf("booking_id")]; if (row) Object.assign(row, payload); }
          return { data: null, error: null };
        }
        const row =
          t === "rent_buddy_tips" ? db.tips[idOf("booking_id")] ?? null
          : t === "rent_buddy_bookings" ? db.bookings[idOf("id")] ?? null
          : t === "rent_buddy_profiles" ? db.buddyProfiles[idOf("id")] ?? null
          : null;
        return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
      },
    };
    return b;
  }
  return { client: { from: (t: string) => { ops.push({ table: t, op: "from" }); return table(t); } } as any, ops };
}

const tipEntries = (db: FakeDb) => db.entries.filter((e) => e.booking_id === BOOKING_ID && e.entry_reason === "tip");
const feeEntries = (db: FakeDb) => db.entries.filter((e) => e.booking_id === BOOKING_ID && e.entry_reason === "platform_fee");

// ═════════════════════════════════════════════════════════════════════════════
// M8 — a second tip must ADD, never replace
// ═════════════════════════════════════════════════════════════════════════════

describe("M8 — tips accumulate atomically, as ledger entries", () => {
  it("25 parallel tips of $1 (25 distinct tips) land exactly $25 on one tips row", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 1, null, `tip-${i}`)),
    );

    assert.equal(results.filter((r) => r.status === "applied").length, 25, "every call must report success");
    assert.equal(Object.keys(db.tips).length, 1, "booking_id is UNIQUE — there is exactly one tips row");
    assert.equal(db.tips[BOOKING_ID].amount_usd, 25, "the tips row must hold the SUM, not the last tip");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, 25, "the booking's denormalised copy must match");
    assert.equal(db.ledger[BOOKING_ID].tip_usd, 25, "the ledger's denormalised copy must match");
    assert.equal(
      Math.max(...results.map((r) => (r.status === "applied" ? r.totalTipUsd : -1))), 25,
      "the last caller must see the full total",
    );

    // PAY-014 — each tip is ENTRIES: one balanced pair, and the copies above are
    // the fold of them.
    const tips = tipEntries(db);
    assert.equal(tips.length, 50, "25 tips are 25 pairs");
    assert.equal(tips.reduce((n, e) => n + e.amount_minor, 0), 0, "every tip pair balances");
    assert.equal(
      tips.filter((e) => e.account === "buddy_payable").reduce((n, e) => n + e.amount_minor, 0), 2500,
      "the buddy's side of the tip entries is the 25.00 the three copies carry",
    );
  });

  it("books NO commission on a tip — the fee entries are the booking's own and nothing more (owner ruling 2026-10-04)", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);
    // The booking is ledgered first (10 % of 100.00), as it is at creation.
    await client.rpc("rb_post_booking_ledger", { p_booking_id: BOOKING_ID, p_event: "booking_created", p_event_key: null, p_args: {} });
    const feeBefore = feeEntries(db).map((e) => e.amount_minor);
    assert.deepEqual([...feeBefore].sort((x, y) => x - y), [-1000, 1000]);

    const r = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 40, "thank you", "tip-a");
    assert.equal(r.status, "applied");
    assert.deepEqual(feeEntries(db).map((e) => e.amount_minor), feeBefore, "a tip added a platform_fee entry");
    assert.equal(db.ledger[BOOKING_ID].platform_fee_amount, 10, "the commission is still 10 % of the 100.00 service price");
    assert.equal(db.ledger[BOOKING_ID].buddy_net_estimated_amount, 130, "100 − 10 commission + the whole 40 tip");
  });

  it("the SAME tip sent 25 times lands once — a retry is a replay, not a second tip (`09` §7.1)", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 5, null, "one-tip")),
    );
    assert.ok(results.every((r) => r.status === "applied"), JSON.stringify(results));
    assert.equal(results.filter((r) => r.status === "applied" && r.replayed === false).length, 1, "exactly one call may land the tip");
    assert.equal(db.tips[BOOKING_ID].amount_usd, 5);
    assert.equal(tipEntries(db).length, 2);
  });

  it("the same key with a DIFFERENT amount is refused, and changes nothing", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);
    await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 5, null, "k");
    const r = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 50, null, "k");
    assert.deepEqual([r.status, (r as any).refusal], ["refused", "idempotency_key_reused"]);
    assert.equal(db.tips[BOOKING_ID].amount_usd, 5);
  });

  it("CONTROL: the replacing upsert this repairs loses 24 of the 25", async () => {
    // The pre-fix write, verbatim in shape: upsert amount_usd = the single tip,
    // conflict target booking_id. Same harness, same 25 parallel calls.
    const db = seedDb();
    const legacyUpsert = async (amountUsd: number) => {
      await tick();
      db.tips[BOOKING_ID] = { id: "tip-legacy", booking_id: BOOKING_ID, amount_usd: amountUsd };
    };
    await Promise.all(Array.from({ length: 25 }, () => legacyUpsert(1)));

    assert.equal(db.tips[BOOKING_ID].amount_usd, 1,
      "the pre-fix shape keeps only the last tip — this is the defect M8 names, and the case above must not be able to pass with it");
  });

  // ── INVERTED (PAY-018) ─────────────────────────────────────────────────────
  // This case was "two sequential tips accumulate on the fallback path too (no
  // rpc available)", and asserted the non-atomic read-modify-write landed 25.
  // That fallback is the defect now. With no function a tip is REFUSED, by
  // name, and the client is asked for nothing.
  it("with NO rpc the tip is refused as `ledger_unavailable` — and nothing is read, updated or upserted", async () => {
    const db = seedDb();
    const { client, ops } = makeNoRpcClient(db);

    const first = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 5, null, "t1");
    const second = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 20, null, "t2");

    for (const r of [first, second]) {
      assert.equal(r.status, "unavailable");
      assert.equal((r as any).error, "ledger_unavailable");
      assert.equal((r as any).rpc, "rb_post_booking_ledger");
    }
    assert.deepEqual(ops, [], "the helper fell back to a table operation");
    assert.deepEqual(db.tips, {}, "a tip was written without the function");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, null);
    assert.equal(db.entries.length, 0);
  });

  it("with the function ABSENT (3824 not applied) the tip is refused the same way; an erroring call is `ledger_write_failed`", async () => {
    const db = seedDb();
    const calls: Array<{ fn: string; args: any }> = [];
    const absent = await accumulateBookingTip(
      makeRpcClient(db, { absent: ["rb_post_booking_ledger"], calls }), BOOKING_ID, TRAVELER_ID, 5, null, "t1",
    );
    assert.deepEqual([absent.status, (absent as any).error], ["unavailable", "ledger_unavailable"]);
    assert.deepEqual(calls.map((c) => c.fn), ["rb_post_booking_ledger"],
      "2330's rb_accumulate_booking_tip must not be tried as a second way — it writes no entry (PAY-014)");

    const erroring = { rpc: async () => ({ data: null, error: { code: "40001", message: "could not serialize access" } }), from: () => { throw new Error("no tables"); } };
    const failed = await accumulateBookingTip(erroring, BOOKING_ID, TRAVELER_ID, 5, null, "t1");
    assert.deepEqual([failed.status, (failed as any).error], ["failed", "ledger_write_failed"]);
    assert.deepEqual(db.tips, {});
  });

  it("refuses a tip from someone who is not the traveller on the booking", async () => {
    const db = seedDb();
    const r = await accumulateBookingTip(makeRpcClient(db), BOOKING_ID, OUTSIDER_ID, 10, null, "t1");
    assert.deepEqual([r.status, (r as any).refusal], ["refused", "not_traveler"]);
    assert.deepEqual(db.tips, {}, "nothing may be written for a non-traveller");
    assert.equal(db.entries.length, 0);
  });

  it("refuses a tip on a booking that is not completed", async () => {
    const db = seedDb();
    db.bookings[BOOKING_ID].status = "in_progress";
    const r = await accumulateBookingTip(makeRpcClient(db), BOOKING_ID, TRAVELER_ID, 10, null, "t1");
    assert.deepEqual([r.status, (r as any).refusal], ["refused", "booking_not_completed"]);
    assert.equal(db.entries.length, 0);
  });

  it("refuses a non-positive amount, or a tip with no key, without making a call", async () => {
    const db = seedDb();
    const calls: Array<{ fn: string; args: any }> = [];
    const client = makeRpcClient(db, { calls });
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, amount, null, "t1");
      assert.deepEqual([r.status, (r as any).refusal], ["refused", "invalid_amount"], `amount ${amount}`);
    }
    const noKey = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 5, null, "");
    assert.deepEqual([noKey.status, (noKey as any).refusal], ["refused", "event_key_required"]);
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tips, {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M13 — cash confirmation is one locked write, and the amount is bounded
// ═════════════════════════════════════════════════════════════════════════════

describe("M13 — cash confirmation is atomic and bounded", () => {
  it("simultaneous traveller and buddy confirmations both survive", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);

    const [t, b] = await Promise.all([
      confirmBookingCash(client, BOOKING_ID, TRAVELER_ID, true),
      confirmBookingCash(client, BOOKING_ID, BUDDY_USER, true),
    ]);

    assert.equal(t.outcome, "confirmed");
    assert.equal(b.outcome, "confirmed");
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_traveler, true);
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, true,
      "neither confirmation may be overwritten by the other");
    // At least one of the two callers must be able to SEE the completed pair,
    // because that is what the route branches on to emit the trust event.
    assert.ok(
      (t.travelerConfirmed === true && t.buddyConfirmed === true) ||
      (b.travelerConfirmed === true && b.buddyConfirmed === true),
      "the later caller must observe both flags set",
    );
  });

  it("CONTROL: the pre-fix read-then-write loses one of the two confirmations", async () => {
    // The pre-fix route, verbatim in shape: read the whole booking, decide the
    // patch, then write it in a SEPARATE statement.
    const db = seedDb();
    const legacyConfirm = async (actorId: string) => {
      const row = { ...db.bookings[BOOKING_ID] };       // read
      await tick();                                     // …the gap the race lives in
      const patch: any = {};
      if (row.traveler_id === actorId) patch.cash_balance_confirmed_by_traveler = true;
      if (db.buddyProfiles[row.buddy_id].user_id === actorId) patch.cash_balance_confirmed_by_buddy = true;
      db.bookings[BOOKING_ID] = { ...row, ...patch };   // write, reinstating the stale copy
    };
    await Promise.all([legacyConfirm(TRAVELER_ID), legacyConfirm(BUDDY_USER)]);

    const both = db.bookings[BOOKING_ID].cash_balance_confirmed_by_traveler === true
      && db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy === true;
    assert.equal(both, false,
      "the pre-fix shape loses one confirmation — the case above must not be able to pass with it");
  });

  it("refuses a confirmation claiming more cash than the booking says is owed", async () => {
    const db = seedDb();                       // cash_balance_usd = 35
    const r = await confirmBookingCash(makeRpcClient(db), BOOKING_ID, BUDDY_USER, true, 500);

    assert.equal(r.outcome, "amount_exceeds_due");
    assert.equal(r.cashDueUsd, 35);
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, null,
      "an inflated claim must be refused, not clamped and not partially recorded");
  });

  it("accepts a claim at or below the balance owed", async () => {
    const db = seedDb();
    assert.equal((await confirmBookingCash(makeRpcClient(db), BOOKING_ID, BUDDY_USER, true, 35)).outcome, "confirmed");

    const db2 = seedDb();
    assert.equal((await confirmBookingCash(makeRpcClient(db2), BOOKING_ID, BUDDY_USER, true, 10)).outcome, "confirmed");
  });

  // ── INVERTED (PAY-018) ─────────────────────────────────────────────────────
  // This case was "bounds the amount on the fallback path too": with no rpc the
  // helper read the booking and wrote it back from here, and the test asserted
  // that path also refused an inflated amount. The path itself was the defect —
  // the lost-update shape the function exists to remove. It is gone.
  it("with NO rpc the confirmation is refused as `ledger_unavailable` — nothing is read and nothing is written", async () => {
    const db = seedDb();
    const { client, ops } = makeNoRpcClient(db);

    const inflated = await confirmBookingCash(client, BOOKING_ID, BUDDY_USER, true, 500);
    const honest = await confirmBookingCash(client, BOOKING_ID, BUDDY_USER, true, 35);

    for (const r of [inflated, honest]) {
      assert.equal(r.outcome, "unavailable");
      assert.equal(r.atomic, false);
      assert.equal(r.failure?.error, "ledger_unavailable");
      assert.equal(r.failure?.rpc, "rb_confirm_booking_cash");
    }
    assert.deepEqual(ops, [], "the helper fell back to reading or writing the booking itself");
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, null);
  });

  it("with the function ABSENT or erroring the confirmation is refused by name, and the flags do not move", async () => {
    const db = seedDb();
    const absent = await confirmBookingCash(makeRpcClient(db, { absent: [] }), BOOKING_ID, BUDDY_USER, true);
    assert.equal(absent.outcome, "confirmed", "sanity: the model confirms when the function is there");

    const db2 = seedDb();
    const missing = await confirmBookingCash(
      { rpc: async (fn: string) => functionNotFound(fn), from: () => { throw new Error("no tables"); } },
      BOOKING_ID, BUDDY_USER, true,
    );
    assert.deepEqual([missing.outcome, missing.failure?.error], ["unavailable", "ledger_unavailable"]);

    const errored = await confirmBookingCash(
      { rpc: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }), from: () => { throw new Error("no tables"); } },
      BOOKING_ID, BUDDY_USER, true,
    );
    assert.deepEqual([errored.outcome, errored.failure?.error], ["unavailable", "ledger_write_failed"]);

    const silent = await confirmBookingCash(
      { rpc: async () => ({ data: [], error: null }), from: () => { throw new Error("no tables"); } },
      BOOKING_ID, BUDDY_USER, true,
    );
    assert.deepEqual([silent.outcome, silent.failure?.error], ["unavailable", "ledger_write_failed"]);
    assert.equal(db2.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, null);
  });

  it("reports not_found and not_party rather than writing", async () => {
    const db = seedDb();
    assert.equal((await confirmBookingCash(makeRpcClient(db), "no-such-booking", TRAVELER_ID, true)).outcome, "not_found");
    assert.equal((await confirmBookingCash(makeRpcClient(db), BOOKING_ID, OUTSIDER_ID, true)).outcome, "not_party");
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_traveler, null);
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, null);
  });

  it("a decline is recorded, and a decline is never amount-bounded", async () => {
    const db = seedDb();
    const r = await confirmBookingCash(makeRpcClient(db), BOOKING_ID, TRAVELER_ID, false, 9999);
    assert.equal(r.outcome, "confirmed", "refusing to confirm is itself a recordable answer");
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_traveler, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M7 — the earnings total may not be silently truncated
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A client that behaves like PostgREST with a max-rows cap: it honours
 * `.range(from, to)` but never returns more than `cap` rows in one response.
 * That is precisely the behaviour that made the pre-fix single select short.
 */
function makeCappedBookingsClient(rows: any[], cap = 1000) {
  function table() {
    let from = 0;
    let to = Number.MAX_SAFE_INTEGER;
    const b: any = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      order() { return b; },
      range(f: number, t: number) { from = f; to = t; return b; },
      then(resolve: any, reject: any) { return Promise.resolve(b._resolve()).then(resolve, reject); },
      _resolve() {
        const requested = rows.slice(from, Math.min(to + 1, rows.length));
        return { data: requested.slice(0, cap), error: null };
      },
    };
    return b;
  }
  return { from: () => table() } as any;
}

function makeEarningsRows(count: number, month = "2026-03") {
  return Array.from({ length: count }, (_, i) => ({
    id: `bk-${String(i).padStart(6, "0")}`,
    total_usd: 100,
    deposit_usd: 30,
    cash_balance_usd: 70,
    payment_mode: "deposit_plus_cash",
    status: "completed",
    completed_at: `${month}-15T10:00:00+00:00`,
    booking_date: `${month}-15`,
    category: "city",
  }));
}

describe("M7 — earnings aggregation is exhaustive", () => {
  it("reads every booking past the row cap, not just the first page", async () => {
    const rows = makeEarningsRows(1201);
    const fetched = await fetchAllBuddyEarningsRows(makeCappedBookingsClient(rows, 1000), BUDDY_PROF);

    assert.ok(fetched, "the read must succeed");
    assert.equal(fetched!.length, 1201, "every earnings-bearing booking must be read");
    assert.equal(new Set(fetched!.map((r) => r.id)).size, 1201, "no row may be counted twice");
  });

  it("the total over 1201 bookings is exact", async () => {
    const rows = makeEarningsRows(1201);
    const fetched = await fetchAllBuddyEarningsRows(makeCappedBookingsClient(rows, 1000), BUDDY_PROF);
    const summary = foldEarningsRows(fetched!, 0.15, new Date("2026-06-01T00:00:00Z"));

    assert.equal(summary.totalInAppUsd, 1201 * 30);
    assert.equal(summary.totalCashConfirmedUsd, 1201 * 70);
    assert.equal(round2(summary.totalPlatformFeesUsd), round2(1201 * 15));
    assert.equal(round2(summary.totalNetUsd), round2(1201 * 30 + 1201 * 70 - 1201 * 15));
    assert.equal(summary.monthlyBreakdown.length, 1);
    assert.equal(summary.monthlyBreakdown[0].bookingCount, 1201);
  });

  it("CONTROL: the pre-fix unpaginated select stops at the cap and under-reports", async () => {
    const rows = makeEarningsRows(1201);
    const capped: any = await makeCappedBookingsClient(rows, 1000).from().select().eq().in();
    const truncated = foldEarningsRows(capped.data, 0.15, new Date("2026-06-01T00:00:00Z"));

    assert.equal(capped.data.length, 1000, "PostgREST returns a short array and no error");
    assert.ok(truncated.totalInAppUsd < 1201 * 30,
      "the pre-fix shape under-reports the buddy's earnings — silently, which is the defect");
  });

  it("returns null (never a confident zero) when the read fails", async () => {
    const failing = { from: () => ({
      select: () => failingBuilder, eq: () => failingBuilder, in: () => failingBuilder,
      order: () => failingBuilder, range: () => failingBuilder,
      then: (res: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res),
    }) } as any;
    const failingBuilder: any = failing.from();

    assert.equal(await fetchAllBuddyEarningsRows(failing, BUDDY_PROF), null);
  });

  it("keeps the pre-fix arithmetic exactly: disputed bookings are excluded from net but counted", () => {
    const summary = foldEarningsRows([
      { id: "a", total_usd: 100, deposit_usd: 30, cash_balance_usd: 70, status: "completed", completed_at: "2026-03-15T00:00:00+00:00", booking_date: "2026-03-15" },
      { id: "b", total_usd: 200, deposit_usd: 60, cash_balance_usd: 140, status: "disputed",  completed_at: "2026-03-20T00:00:00+00:00", booking_date: "2026-03-20" },
      { id: "c", total_usd: 100, deposit_usd: 100, cash_balance_usd: 0,  status: "completed", completed_at: null, booking_date: "2026-02-01" },
    ], 0.15, new Date("2026-06-01T00:00:00Z"));

    assert.equal(summary.totalInAppUsd, 130);            // 30 + 100; the disputed 60 is excluded
    assert.equal(summary.totalCashConfirmedUsd, 70);
    assert.equal(summary.totalPlatformFeesUsd, 30);      // 15 + 15; the disputed booking's fee is excluded
    assert.equal(summary.totalDisputedUsd, 200);
    assert.equal(summary.totalPendingUsd, 0);
    assert.equal(summary.totalNetUsd, 170);              // 130 + 70 - 30
    assert.deepEqual(summary.monthlyBreakdown.map((m) => m.month), ["2026-03", "2026-02"]);
    assert.equal(summary.monthlyBreakdown[0].bookingCount, 2, "a disputed booking still counts toward its month");
    assert.equal(summary.monthlyBreakdown[0].totalUsd, 85);   // only the completed one: 100 - 15
    assert.equal(summary.yearlyNetUsd, 170);                  // 85 + 85, both in 2026
  });

  it("falls back to booking_date when completed_at is null, matching the old slice(0,7)", () => {
    const summary = foldEarningsRows(
      [{ id: "a", total_usd: 100, deposit_usd: 100, cash_balance_usd: 0, status: "completed", completed_at: null, booking_date: "2025-11-09" }],
      0.15,
      new Date("2026-06-01T00:00:00Z"),
    );
    assert.deepEqual(summary.monthlyBreakdown.map((m) => m.month), ["2025-11"]);
    assert.equal(summary.yearlyNetUsd, 0, "2025 earnings do not count toward the 2026 yearly total");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M3 / PAY-075 — payout transitions are compare-and-swap, and audited in the
// same transaction or not applied
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_TOKEN  = "ma-admin-token";
const ADMIN2_TOKEN = "ma-admin2-token";
const USER_TOKEN   = "ma-user-token";
const ADMIN_ID     = "ma-admin-1";
const ADMIN2_ID    = "ma-admin-2";
const PLAIN_ID     = "ma-plain-1";
// rent_buddy_payouts.id is a uuid; the route answers 404 for anything else.
const PAYOUT_ID    = "aaaa0000-0000-4000-8000-000000000001";
const PAYOUT2_ID   = "aaaa0000-0000-4000-8000-000000000002";
const NO_PAYOUT_ID = "aaaa0000-0000-4000-8000-00000000dead";

const PAYOUT_TOKENS: Record<string, string> = {
  [ADMIN_TOKEN]: ADMIN_ID,
  [ADMIN2_TOKEN]: ADMIN2_ID,
  [USER_TOKEN]: PLAIN_ID,
};

/** The world the payout routes see. `payouts` and `adminActions` are the stored state. */
let payoutDb: FakeLedgerDb = emptyLedgerDb();
/** What the routes asked the transition function for. */
let payoutCalls: Array<{ fn: string; args: any }> = [];
/** Every table WRITE the routes issued themselves. Must stay empty: PAY-075. */
let directWrites: Array<{ table: string; op: string }> = [];
let transitionAbsent = false;
let failAudit = false;
let payoutListError: any = null;

let server: http.Server;
let base: string;

function request(method: "GET" | "POST", path: string, body?: unknown, token = ADMIN_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const post = (path: string, body?: unknown, token = ADMIN_TOKEN) => request("POST", path, body, token);
const get = (path: string, token = ADMIN_TOKEN) => request("GET", path, undefined, token);

function makePayoutClient() {
  function table(t: string) {
    const eqs: Array<[string, any]> = [];
    let op: "select" | "update" | "insert" = "select";
    let single = false;
    let range: [number, number] | null = null;

    const b: any = {
      select() { return b; },
      update() { op = "update"; directWrites.push({ table: t, op: "update" }); return b; },
      insert() { op = "insert"; directWrites.push({ table: t, op: "insert" }); return b; },
      eq(col: string, val: any) { eqs.push([col, val]); return b; },
      neq() { return b; },
      order() { return b; },
      range(f: number, to: number) { range = [f, to]; return b; },
      maybeSingle() { single = true; return b; },
      single() { single = true; return b; },
      then(resolve: any, reject: any) { return Promise.resolve(b._resolve()).then(resolve, reject); },

      async _resolve() {
        const idOf = (col: string) => eqs.find(([c]) => c === col)?.[1];
        if (op !== "select") return { data: [], error: null };

        if (t === "profiles") {
          const id = idOf("id");
          const role = payoutDb.admins.has(id) ? "admin" : "user";
          return single ? { data: { id, role }, error: null } : { data: [{ id, role }], error: null };
        }
        if (t === "rent_buddy_payouts") {
          if (payoutListError) return { data: null, error: payoutListError, count: null };
          let rows = Object.values(payoutDb.payouts).map((r: any) => ({ ...r }));
          for (const [col, val] of eqs) rows = rows.filter((r: any) => r[col] === val);
          rows.sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at)));
          const count = rows.length;
          if (range) rows = rows.slice(range[0], range[1] + 1);
          return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count };
        }
        if (t === "feature_flags") {
          const flag = eqs.find(([c]) => c === "flag")?.[1] ?? null;
          const row = flag ? { flag, enabled: true } : null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }

  return {
    from: (t: string) => table(t),
    // The transition function, modelled. `tick` stands in for the round trip so
    // two in-flight requests really overlap; the read-decide-write after it is
    // synchronous, as it is under the payout's row lock.
    rpc: (fn: string, args: any) =>
      fakeLedgerRpc(payoutDb, {
        tick,
        calls: payoutCalls,
        absent: transitionAbsent ? ["rb_admin_payout_transition"] : [],
        failPayoutAudit: () => failAudit,
      })(fn, args),
    auth: {
      getUser: async (token: string) => {
        const id = PAYOUT_TOKENS[token];
        if (!id) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id } }, error: null };
      },
    },
  } as any;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddySpecRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  payoutDb = emptyLedgerDb({
    payouts: {
      [PAYOUT_ID]: {
        id: PAYOUT_ID, booking_id: BOOKING_ID, buddy_id: BUDDY_PROF,
        amount_usd: 120, status: "pending",
        hold_reason: null, held_by: null, held_at: null,
        released_by: null, released_at: null, notes: null,
        created_at: "2026-10-01T00:00:00Z",
      },
      [PAYOUT2_ID]: {
        id: PAYOUT2_ID, booking_id: "ma-booking-2", buddy_id: BUDDY_PROF,
        amount_usd: 45, status: "on_hold",
        hold_reason: "seeded", held_by: ADMIN2_ID, held_at: "2026-10-02T00:00:00Z",
        released_by: null, released_at: null, notes: null,
        created_at: "2026-10-02T00:00:00Z",
      },
    },
    admins: new Set([ADMIN_ID, ADMIN2_ID]),
  });
  payoutCalls = [];
  directWrites = [];
  transitionAbsent = false;
  failAudit = false;
  payoutListError = null;
  const client = makePayoutClient();
  _setTestClient(client, true);
  _setTestServiceClient(client);
});

/** The one payout under test, as stored. */
const stored = () => payoutDb.payouts[PAYOUT_ID];

describe("M3 — payout hold/release are compare-and-swap", () => {
  const HOLD = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/hold`;
  const RELEASE = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/release`;

  it("holds a payout that is not yet held", async () => {
    const r = await post(HOLD, { reason: "fraud signal" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stored().status, "on_hold");
    assert.equal(stored().held_by, ADMIN_ID);
    assert.equal(payoutDb.adminActions.length, 1);
    assert.deepEqual([r.body.fromStatus, r.body.toStatus], ["pending", "on_hold"]);
  });

  it("refuses to re-hold an already-held payout with 409, and does not touch held_by", async () => {
    await post(HOLD, { reason: "first" });
    const r = await post(HOLD, { reason: "second" }, ADMIN2_TOKEN);

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "on_hold");
    assert.equal(stored().held_by, ADMIN_ID,
      "the audit trail must keep the admin who actually applied the hold");
    assert.equal(stored().hold_reason, "first");
    assert.equal(payoutDb.adminActions.length, 1, "a refused transition writes no admin action");
  });

  it("releases a held payout, and refuses to release it twice", async () => {
    await post(HOLD, { reason: "review" });
    const first = await post(RELEASE, { notes: "cleared" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(stored().status, "released");
    assert.equal(stored().released_by, ADMIN_ID);
    const releasedAt = stored().released_at;

    const second = await post(RELEASE, { notes: "again" }, ADMIN2_TOKEN);
    assert.equal(second.status, 409, "releasing an already-released payout is the silent success M3 names");
    assert.equal(second.body.currentStatus, "released");
    assert.equal(stored().released_by, ADMIN_ID,
      "the second release must not overwrite who authorised the first");
    assert.equal(stored().released_at, releasedAt);
    assert.equal(payoutDb.adminActions.filter((a) => a.action === "payout_released").length, 1);
  });

  it("refuses to release a payout that was never held", async () => {
    const r = await post(RELEASE, { notes: "straight to released" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "pending");
    assert.equal(stored().status, "pending");
  });

  it("refuses to hold a released payout", async () => {
    await post(HOLD, { reason: "review" });
    await post(RELEASE, { reason: "cleared" });
    const r = await post(HOLD, { reason: "too late" });
    assert.equal(r.status, 409);
    assert.equal(stored().status, "released");
  });

  it("still returns 404 for a payout that does not exist — a malformed id and a well-formed unknown one alike", async () => {
    const malformed = await post("/api/rent-a-buddy/admin/payouts/no-such-payout/hold", {});
    assert.equal(malformed.status, 404, JSON.stringify(malformed.body));
    assert.deepEqual(payoutCalls, [], "a non-uuid id cannot name a payout; the function is not asked");

    const unknown = await post(`/api/rent-a-buddy/admin/payouts/${NO_PAYOUT_ID}/hold`, { reason: "x" });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(payoutDb.adminActions.length, 0);
  });

  it("still refuses a non-admin", async () => {
    const r = await post(HOLD, { reason: "let me" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(stored().status, "pending");
    assert.deepEqual(payoutCalls, [], "the transition function must not be reached by a non-admin");
  });

  it("two simultaneous releases: exactly one 200, one 409, one audit row", async () => {
    await post(HOLD, { reason: "review" });
    payoutDb.adminActions.length = 0;

    const [a, b] = await Promise.all([
      post(RELEASE, { notes: "admin one" }, ADMIN_TOKEN),
      post(RELEASE, { notes: "admin two" }, ADMIN2_TOKEN),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409],
      "the compare-and-swap must let exactly one release through; two 200s is the pre-fix behaviour");
    assert.equal(stored().status, "released");
    assert.equal(payoutDb.adminActions.filter((x) => x.action === "payout_released").length, 1,
      "only the transition that actually happened may be audited");

    // released_by must name the admin whose request returned 200 — before the
    // fix the LOSER's identity could land on the row.
    const winner = a.status === 200 ? ADMIN_ID : ADMIN2_ID;
    assert.equal(stored().released_by, winner);
    assert.equal(payoutDb.adminActions[0].admin_id, winner, "the audit row must name the winner too");
  });

  it("two simultaneous holds: exactly one 200, one 409", async () => {
    const [a, b] = await Promise.all([
      post(HOLD, { reason: "one" }, ADMIN_TOKEN),
      post(HOLD, { reason: "two" }, ADMIN2_TOKEN),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(stored().status, "on_hold");
    assert.equal(payoutDb.adminActions.filter((x) => x.action === "payout_held").length, 1);
  });
});

describe("PAY-075 — the transition and its audit row commit together or not at all", () => {
  const HOLD = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/hold`;
  const RELEASE = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/release`;

  it("the audit row says WHO, WHAT, WHY and from which status to which", async () => {
    const r = await post(HOLD, { reason: "  chargeback risk on the traveller's card  " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(payoutDb.adminActions.length, 1);
    const a = payoutDb.adminActions[0];
    assert.deepEqual(
      { admin_id: a.admin_id, target_type: a.target_type, target_id: a.target_id, action: a.action, notes: a.notes },
      { admin_id: ADMIN_ID, target_type: "payout", target_id: PAYOUT_ID, action: "payout_held", notes: "chargeback risk on the traveller's card" },
    );
    assert.deepEqual([a.details.from_status, a.details.to_status], ["pending", "on_hold"]);
    assert.equal(r.body.auditId, a.id, "the response names the audit row it wrote");
    assert.equal(stored().hold_reason, "chargeback risk on the traveller's card");
  });

  it("A FAILING AUDIT INSERT LEAVES THE STATUS UNCHANGED — 503, named, nothing half-done", async () => {
    failAudit = true;
    const before_ = JSON.stringify(stored());
    const r = await post(HOLD, { reason: "fraud signal" });

    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "ledger_write_failed");
    assert.equal(r.body.retryable, true);
    assert.equal(JSON.stringify(stored()), before_, "the payout moved although its audit row could not be written");
    assert.equal(payoutDb.adminActions.length, 0);

    // …and once the audit table is writable again the same request succeeds.
    failAudit = false;
    const again = await post(HOLD, { reason: "fraud signal" });
    assert.equal(again.status, 200);
    assert.equal(stored().status, "on_hold");
    assert.equal(payoutDb.adminActions.length, 1);
  });

  it("the same holds for a release", async () => {
    await post(HOLD, { reason: "review" });
    failAudit = true;
    const r = await post(RELEASE, { reason: "cleared" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(stored().status, "on_hold");
    assert.equal(stored().released_by, null);
    assert.equal(payoutDb.adminActions.filter((a) => a.action === "payout_released").length, 0);
  });

  it("the route itself writes NO table: not the payout, not the audit row", async () => {
    await post(HOLD, { reason: "review" });
    await post(RELEASE, { reason: "cleared" });
    failAudit = true;
    await post(`/api/rent-a-buddy/admin/payouts/${PAYOUT2_ID}/release`, { reason: "x" });
    assert.deepEqual(directWrites, [],
      "an UPDATE or INSERT issued from the route is a second statement — the audit row it belongs with is in another transaction");
    assert.ok(payoutCalls.length >= 3);
    assert.ok(payoutCalls.every((c) => c.fn === "rb_admin_payout_transition"));
  });

  it("with the function ABSENT the transition is refused as `ledger_unavailable` — never retried as a bare UPDATE", async () => {
    transitionAbsent = true;
    const r = await post(HOLD, { reason: "fraud signal" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "ledger_unavailable");
    assert.equal(r.body.rpc, "rb_admin_payout_transition");
    assert.equal(stored().status, "pending");
    assert.equal(payoutDb.adminActions.length, 0);
    assert.deepEqual(directWrites, []);
  });

  it("a reason is REQUIRED for both transitions: 400, nothing changed, nothing audited, the function not asked", async () => {
    for (const body of [undefined, {}, { reason: "" }, { reason: "   " }, { reason: 42 }, { reason: "x".repeat(1001) }]) {
      const r = await post(HOLD, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "reason_required");
    }
    const release = await post(`/api/rent-a-buddy/admin/payouts/${PAYOUT2_ID}/release`, {});
    assert.equal(release.status, 400);
    assert.equal(release.body.error, "reason_required");

    assert.deepEqual(payoutCalls, []);
    assert.equal(stored().status, "pending");
    assert.equal(payoutDb.payouts[PAYOUT2_ID].status, "on_hold");
    assert.equal(payoutDb.adminActions.length, 0);
  });

  it("a release's reason may arrive as `notes` (the field's old name) and is stored and audited", async () => {
    const r = await post(`/api/rent-a-buddy/admin/payouts/${PAYOUT2_ID}/release`, { notes: "identity re-checked" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(payoutDb.payouts[PAYOUT2_ID].notes, "identity re-checked");
    assert.equal(payoutDb.adminActions[0].notes, "identity re-checked");
    assert.equal(payoutDb.adminActions[0].admin_id, ADMIN_ID);
  });

  it("the function is handed the AUTHENTICATED admin's id, never one from the request body", async () => {
    await post(HOLD, { reason: "review", adminId: ADMIN2_ID, p_admin_id: ADMIN2_ID, held_by: ADMIN2_ID });
    assert.equal(payoutCalls.length, 1);
    assert.deepEqual(payoutCalls[0]!.args, {
      p_payout_id: PAYOUT_ID, p_action: "hold", p_admin_id: ADMIN_ID, p_reason: "review",
    });
    assert.equal(stored().held_by, ADMIN_ID);
  });
});

describe("GET /rent-a-buddy/admin/payouts — the queue, by state", () => {
  const LIST = "/api/rent-a-buddy/admin/payouts";

  it("lists every payout, newest first, and says it moves no money", async () => {
    const r = await get(LIST);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.payouts.map((p: any) => p.id), [PAYOUT2_ID, PAYOUT_ID]);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.status, "all");
    assert.equal(r.body.movesMoney, false);
  });

  it("filters to one state, and the total is that state's", async () => {
    const held = await get(`${LIST}?status=on_hold`);
    assert.deepEqual(held.body.payouts.map((p: any) => p.id), [PAYOUT2_ID]);
    assert.deepEqual([held.body.total, held.body.status], [1, "on_hold"]);

    const released = await get(`${LIST}?status=released`);
    assert.deepEqual([released.status, released.body.payouts, released.body.total], [200, [], 0]);

    // The list follows a transition: stored state, read back through the route.
    await post(`${LIST}/${PAYOUT2_ID}/release`, { reason: "cleared" });
    const after_ = await get(`${LIST}?status=released`);
    assert.deepEqual(after_.body.payouts.map((p: any) => [p.id, p.status, p.released_by]), [[PAYOUT2_ID, "released", ADMIN_ID]]);
    assert.equal((await get(`${LIST}?status=on_hold`)).body.total, 0);
  });

  it("a failed read is a 5xx — never an empty queue", async () => {
    payoutListError = { message: "connection reset" };
    const r = await get(LIST);
    assert.ok(r.status >= 500, JSON.stringify(r));
    assert.equal(r.body.payouts, undefined, "an unreadable queue must not be presented as an empty one");
  });

  it("refuses a non-admin and an unauthenticated caller", async () => {
    assert.equal((await get(LIST, USER_TOKEN)).status, 403);
    assert.equal((await get(LIST, "no-such-token")).status, 401);
  });
});
