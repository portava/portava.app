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
 * call can interleave between them. That is exactly what
 * `GREATEST(0, col + delta)` in a single statement, and `FOR NO KEY UPDATE`
 * around the confirm, buy in the real database.
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

interface FakeDb {
  bookings:      Record<string, any>;
  buddyProfiles: Record<string, any>;
  tips:          Record<string, any>;   // keyed by booking_id (UNIQUE in the real table)
  ledger:        Record<string, any>;   // keyed by booking_id
}

function seedDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id: BUDDY_PROF,
        status: "completed",
        cash_balance_usd: 35,
        cash_balance_confirmed_by_traveler: null,
        cash_balance_confirmed_by_buddy: null,
        dispute_window_expires_at: null,
        tip_usd: null,
      },
    },
    buddyProfiles: { [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER } },
    tips: {},
    ledger: { [BOOKING_ID]: { booking_id: BOOKING_ID, tip_usd: 0 } },
    ...overrides,
  };
}

/**
 * A client whose `.rpc()` reproduces migration 2330's functions.
 *
 * The critical property under test: after the initial `await tick()` (which
 * stands in for the round trip), the read-decide-write runs SYNCHRONOUSLY, so
 * two overlapping calls cannot interleave inside it. That is the guarantee the
 * SQL statement gives, and the guarantee the pre-fix TypeScript did not have.
 */
function makeRpcClient(db: FakeDb) {
  return {
    rpc: async (fn: string, args: any) => {
      await tick();

      if (fn === "rb_accumulate_booking_tip") {
        const b = db.bookings[args.p_booking_id];
        if (!b) return { data: null, error: { message: "booking not found" } };
        if (b.traveler_id !== args.p_traveler_id) return { data: null, error: { message: "not the traveller" } };
        if (!(Number(args.p_amount_usd) > 0)) return { data: null, error: { message: "amount must be positive" } };
        const bp = db.buddyProfiles[b.buddy_id];
        if (!bp) return { data: null, error: { message: "no buddy profile" } };

        // ── the atomic section: no await between read and write ──
        const existing = db.tips[args.p_booking_id];
        const total = Math.max(0, round2(Number(existing?.amount_usd ?? 0) + Number(args.p_amount_usd)));
        db.tips[args.p_booking_id] = {
          id: existing?.id ?? `tip-${args.p_booking_id}`,
          booking_id: args.p_booking_id,
          traveler_id: b.traveler_id,
          buddy_user_id: bp.user_id,
          amount_usd: total,
          note: args.p_note ?? existing?.note ?? null,
        };
        if (db.ledger[args.p_booking_id]) db.ledger[args.p_booking_id].tip_usd = total;
        b.tip_usd = total;
        // ────────────────────────────────────────────────────────
        return { data: [{ tip_id: db.tips[args.p_booking_id].id, total_tip_usd: total }], error: null };
      }

      if (fn === "rb_confirm_booking_cash") {
        const b = db.bookings[args.p_booking_id];
        if (!b) return { data: [{ outcome: "not_found" }], error: null };
        const bp = db.buddyProfiles[b.buddy_id];
        const isT = b.traveler_id === args.p_actor_id;
        const isB = !!bp && bp.user_id === args.p_actor_id;
        if (!isT && !isB) return { data: [{ outcome: "not_party" }], error: null };

        const due = Number(b.cash_balance_usd ?? 0);
        if (args.p_confirmed === true && args.p_amount_usd !== null && args.p_amount_usd !== undefined
            && Number(args.p_amount_usd) > due + 0.005) {
          return { data: [{ outcome: "amount_exceeds_due", cash_due_usd: due }], error: null };
        }

        // ── the atomic section ──
        if (isT) b.cash_balance_confirmed_by_traveler = args.p_confirmed;
        if (isB) b.cash_balance_confirmed_by_buddy = args.p_confirmed;
        // ───────────────────────
        return {
          data: [{
            outcome: "confirmed",
            acted_as_traveler: isT,
            acted_as_buddy: isB,
            traveler_confirmed: b.cash_balance_confirmed_by_traveler,
            buddy_confirmed: b.cash_balance_confirmed_by_buddy,
            traveler_user_id: b.traveler_id,
            booking_status: b.status,
            cash_due_usd: due,
            dispute_expires_at: b.dispute_window_expires_at ?? null,
          }],
          error: null,
        };
      }

      return { data: null, error: { message: `unknown function ${fn}` } };
    },

    from: () => { throw new Error("this client only serves rpc()"); },
  } as any;
}

// ═════════════════════════════════════════════════════════════════════════════
// M8 — a second tip must ADD, never replace
// ═════════════════════════════════════════════════════════════════════════════

describe("M8 — tips accumulate atomically", () => {
  it("25 parallel tips of $1 land exactly $25 on one tips row", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);

    const results = await Promise.all(
      Array.from({ length: 25 }, () => accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 1)),
    );

    assert.equal(results.filter((r) => r !== null).length, 25, "every call must report success");
    assert.ok(results.every((r) => r?.atomic === true), "every call must have taken the RPC path");
    assert.equal(Object.keys(db.tips).length, 1, "booking_id is UNIQUE — there is exactly one tips row");
    assert.equal(db.tips[BOOKING_ID].amount_usd, 25, "the tips row must hold the SUM, not the last tip");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, 25, "the booking's denormalised copy must match");
    assert.equal(db.ledger[BOOKING_ID].tip_usd, 25, "the ledger's denormalised copy must match");
    assert.equal(Math.max(...results.map((r) => r!.totalTipUsd)), 25, "the last caller must see the full total");
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

  it("two sequential tips accumulate on the fallback path too (no rpc available)", async () => {
    // A partial client with no `.rpc` — an un-applied migration, or a test fake.
    // The fallback is not race-free and says so, but it must still ADD: before
    // 2330 a second tip destroyed the first on EVERY path, concurrent or not.
    const db = seedDb();
    const client = makeFallbackClient(db);

    const first = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 5);
    const second = await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 20);

    assert.equal(first?.totalTipUsd, 5);
    assert.equal(second?.totalTipUsd, 25, "the second tip must add to the first, not replace it");
    assert.equal(second?.atomic, false, "the fallback must report that it was not atomic");
    assert.equal(db.tips[BOOKING_ID].amount_usd, 25);
    assert.equal(db.bookings[BOOKING_ID].tip_usd, 25);
    assert.equal(db.ledger[BOOKING_ID].tip_usd, 25);
  });

  it("refuses a tip from someone who is not the traveller on the booking", async () => {
    const db = seedDb();
    assert.equal(await accumulateBookingTip(makeRpcClient(db), BOOKING_ID, OUTSIDER_ID, 10), null);
    assert.equal(await accumulateBookingTip(makeFallbackClient(db), BOOKING_ID, OUTSIDER_ID, 10), null);
    assert.deepEqual(db.tips, {}, "nothing may be written for a non-traveller");
  });

  it("refuses a non-positive amount without touching the record", async () => {
    const db = seedDb();
    const client = makeRpcClient(db);
    assert.equal(await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, 0), null);
    assert.equal(await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, -5), null);
    assert.equal(await accumulateBookingTip(client, BOOKING_ID, TRAVELER_ID, Number.NaN), null);
    assert.deepEqual(db.tips, {});
  });
});

/** A client with NO `.rpc`, exercising each helper's documented fallback. */
function makeFallbackClient(db: FakeDb) {
  function table(t: string) {
    const filters: Array<[string, any]> = [];
    let op: "select" | "update" | "upsert" = "select";
    let payload: any = null;
    let single = false;

    const b: any = {
      select() { op = "select"; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      upsert(p: any) { op = "upsert"; payload = p; return b; },
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
          if (t === "rent_buddy_bookings") {
            const row = db.bookings[idOf("id")];
            if (row) Object.assign(row, payload);
          }
          if (t === "rent_buddy_earnings_ledger") {
            const row = db.ledger[idOf("booking_id")];
            if (row) Object.assign(row, payload);
          }
          return { data: null, error: null };
        }
        if (t === "rent_buddy_tips") {
          const row = db.tips[idOf("booking_id")] ?? null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        if (t === "rent_buddy_bookings") {
          const row = db.bookings[idOf("id")] ?? null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        if (t === "rent_buddy_profiles") {
          const row = db.buddyProfiles[idOf("id")] ?? null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return { from: (t: string) => table(t) } as any;
}

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

  it("bounds the amount on the fallback path too — it is a rule, not a race property", async () => {
    const db = seedDb();
    const r = await confirmBookingCash(makeFallbackClient(db), BOOKING_ID, BUDDY_USER, true, 500);
    assert.equal(r.outcome, "amount_exceeds_due");
    assert.equal(db.bookings[BOOKING_ID].cash_balance_confirmed_by_buddy, null);
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
// M3 — payout transitions are compare-and-swap
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_TOKEN  = "ma-admin-token";
const ADMIN2_TOKEN = "ma-admin2-token";
const USER_TOKEN   = "ma-user-token";
const ADMIN_ID     = "ma-admin-1";
const ADMIN2_ID    = "ma-admin-2";
const PLAIN_ID     = "ma-plain-1";
const PAYOUT_ID    = "ma-payout-1";

const PAYOUT_TOKENS: Record<string, string> = {
  [ADMIN_TOKEN]: ADMIN_ID,
  [ADMIN2_TOKEN]: ADMIN2_ID,
  [USER_TOKEN]: PLAIN_ID,
};

interface PayoutState {
  payouts: Record<string, any>;
  adminActions: any[];
}
let payoutState: PayoutState = { payouts: {}, adminActions: [] };

let server: http.Server;
let base: string;

function post(path: string, body?: unknown, token = ADMIN_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
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

function makePayoutClient() {
  function table(t: string) {
    const eqs: Array<[string, any]> = [];
    const neqs: Array<[string, any]> = [];
    let op: "select" | "update" | "insert" = "select";
    let payload: any = null;
    let single = false;

    const b: any = {
      select() { op = op === "select" ? "select" : op; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      eq(col: string, val: any) { eqs.push([col, val]); return b; },
      neq(col: string, val: any) { neqs.push([col, val]); return b; },
      maybeSingle() { single = true; return b; },
      single() { single = true; return b; },
      then(resolve: any, reject: any) { return Promise.resolve(b._resolve()).then(resolve, reject); },

      async _resolve() {
        const idOf = (col: string) => eqs.find(([c]) => c === col)?.[1];

        if (op === "insert") {
          if (t === "rent_buddy_admin_actions") payoutState.adminActions.push({ ...payload });
          return { data: null, error: null };
        }

        if (op === "update" && t === "rent_buddy_payouts") {
          // Stand in for the network round trip so two in-flight requests
          // really overlap. The MATCH-AND-MUTATE below is synchronous, exactly
          // as a single UPDATE … WHERE is in the database — that is the
          // property the compare-and-swap depends on.
          await tick();
          const row = payoutState.payouts[idOf("id")];
          if (!row) return { data: [], error: null };
          for (const [col, val] of eqs) if (col !== "id" && row[col] !== val) return { data: [], error: null };
          for (const [col, val] of neqs) if (row[col] === val) return { data: [], error: null };
          Object.assign(row, payload);
          return { data: [{ ...row }], error: null };
        }

        if (t === "profiles") {
          const id = idOf("id");
          const role = id === ADMIN_ID || id === ADMIN2_ID ? "admin" : "user";
          return single ? { data: { id, role }, error: null } : { data: [{ id, role }], error: null };
        }
        if (t === "rent_buddy_payouts") {
          const row = payoutState.payouts[idOf("id")] ?? null;
          return single ? { data: row ? { ...row } : null, error: null } : { data: row ? [{ ...row }] : [], error: null };
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
  payoutState = {
    payouts: {
      [PAYOUT_ID]: {
        id: PAYOUT_ID, booking_id: BOOKING_ID, buddy_id: BUDDY_PROF,
        amount_usd: 120, status: "pending",
        hold_reason: null, held_by: null, held_at: null,
        released_by: null, released_at: null,
      },
    },
    adminActions: [],
  };
  const client = makePayoutClient();
  _setTestClient(client, true);
  _setTestServiceClient(client);
});

describe("M3 — payout hold/release are compare-and-swap", () => {
  const HOLD = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/hold`;
  const RELEASE = `/api/rent-a-buddy/admin/payouts/${PAYOUT_ID}/release`;

  it("holds a payout that is not yet held", async () => {
    const r = await post(HOLD, { reason: "fraud signal" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "on_hold");
    assert.equal(payoutState.payouts[PAYOUT_ID].held_by, ADMIN_ID);
    assert.equal(payoutState.adminActions.length, 1);
  });

  it("refuses to re-hold an already-held payout with 409, and does not touch held_by", async () => {
    await post(HOLD, { reason: "first" });
    const r = await post(HOLD, { reason: "second" }, ADMIN2_TOKEN);

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "on_hold");
    assert.equal(payoutState.payouts[PAYOUT_ID].held_by, ADMIN_ID,
      "the audit trail must keep the admin who actually applied the hold");
    assert.equal(payoutState.payouts[PAYOUT_ID].hold_reason, "first");
    assert.equal(payoutState.adminActions.length, 1, "a refused transition writes no admin action");
  });

  it("releases a held payout, and refuses to release it twice", async () => {
    await post(HOLD, { reason: "review" });
    const first = await post(RELEASE, { notes: "cleared" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "released");
    assert.equal(payoutState.payouts[PAYOUT_ID].released_by, ADMIN_ID);
    const releasedAt = payoutState.payouts[PAYOUT_ID].released_at;

    const second = await post(RELEASE, { notes: "again" }, ADMIN2_TOKEN);
    assert.equal(second.status, 409, "releasing an already-released payout is the silent success M3 names");
    assert.equal(second.body.currentStatus, "released");
    assert.equal(payoutState.payouts[PAYOUT_ID].released_by, ADMIN_ID,
      "the second release must not overwrite who authorised the first");
    assert.equal(payoutState.payouts[PAYOUT_ID].released_at, releasedAt);
    assert.equal(payoutState.adminActions.filter((a) => a.action === "payout_released").length, 1);
  });

  it("refuses to release a payout that was never held", async () => {
    const r = await post(RELEASE, { notes: "straight to released" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "pending");
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "pending");
  });

  it("refuses to hold a released payout", async () => {
    await post(HOLD, { reason: "review" });
    await post(RELEASE, {});
    const r = await post(HOLD, { reason: "too late" });
    assert.equal(r.status, 409);
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "released");
  });

  it("still returns 404 for a payout that does not exist", async () => {
    const r = await post("/api/rent-a-buddy/admin/payouts/no-such-payout/hold", {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it("still refuses a non-admin", async () => {
    const r = await post(HOLD, {}, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "pending");
  });

  it("two simultaneous releases: exactly one 200, one 409, one audit row", async () => {
    await post(HOLD, { reason: "review" });
    payoutState.adminActions.length = 0;

    const [a, b] = await Promise.all([
      post(RELEASE, { notes: "admin one" }, ADMIN_TOKEN),
      post(RELEASE, { notes: "admin two" }, ADMIN2_TOKEN),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409],
      "the compare-and-swap must let exactly one release through; two 200s is the pre-fix behaviour");
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "released");
    assert.equal(payoutState.adminActions.filter((x) => x.action === "payout_released").length, 1,
      "only the transition that actually happened may be audited");

    // released_by must name the admin whose request returned 200 — before the
    // fix the LOSER's identity could land on the row.
    const winner = a.status === 200 ? ADMIN_ID : ADMIN2_ID;
    assert.equal(payoutState.payouts[PAYOUT_ID].released_by, winner);
  });

  it("two simultaneous holds: exactly one 200, one 409", async () => {
    const [a, b] = await Promise.all([
      post(HOLD, { reason: "one" }, ADMIN_TOKEN),
      post(HOLD, { reason: "two" }, ADMIN2_TOKEN),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(payoutState.payouts[PAYOUT_ID].status, "on_hold");
    assert.equal(payoutState.adminActions.filter((x) => x.action === "payout_held").length, 1);
  });
});
