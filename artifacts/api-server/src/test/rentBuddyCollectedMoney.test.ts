/**
 * rentBuddyCollectedMoney.test.ts
 *
 * M5 / docs/architecture/09_Payment_Architecture.md §1.3.1 — *"It records money
 * as collected that was never collected."*
 *
 * The defect was filed against the earnings-ledger WRITER and the writer was
 * repaired: `lib/rentBuddyEarningsLedger.ts` writes `in_app_amount_collected`
 * as 0, derived from append-only entries that cannot assert a settlement.
 * FOUR AGGREGATES over the same bookings were not repaired in that change, so
 * the ledger row said nothing had been collected while every dashboard built
 * from the same table said a deposit had:
 *
 *   S1  GET /rent-a-buddy/me/earnings/summary        (buddy's own money screen)
 *         completed.depositCollected, completed.inAppAmountCollected
 *   S2  GET /rent-a-buddy/dashboard/earnings/summary (breakdown)
 *         totalInAppUsd, monthlyBreakdown[].inApp — in BOTH its paths:
 *         foldEarningsRows and the rb_buddy_earnings_summary RPC
 *   S3  migrations/… rb_buddy_earnings_summary()     (the SQL twin of S2)
 *   S4  GET /…/admin/marketplace/analytics           (operator screen)
 *         bookings.byCity[city].inApp, revenue.deposit
 *
 * ── WHY THE FIXTURES ARE FULL-IN-APP, AND WHY TWO ARE MIXED ─────────────────
 * Every surface is driven over at least one `payment_mode: 'full_in_app'`
 * booking, for which `deposit_usd` IS `total_usd` (routes/rentABuddy.ts prices
 * it that way). A `deposit_plus_cash`-only fixture would let a 30 %-of-total
 * answer pass for a correct one; a full-in-app booking makes the pre-fix code
 * claim the ENTIRE booking value was charged, which is the number these tests
 * pin to 0. S2a and S4 add a `deposit_plus_cash` booking on top, so the two
 * payment modes' pre-fix contributions are distinguishable in the expected
 * numbers (1050 = 600 + 300 + 150; 760 = 700 + 60) and a fix that zeroed only
 * one mode's arm could not pass. Each surface is given a DISTINCT total, so a
 * number copied from the wrong surface fails too.
 *
 * ── HOW EACH CASE IS KEPT FROM BEING VACUOUS ────────────────────────────────
 * .agents/memory/prove-the-test-fails-before-trusting-it.md. "Assert 0" is the
 * easiest assertion in the world to satisfy by accident — an absent field, a
 * refused request and a correct answer all read as falsy — so every case here
 * asserts THREE things together:
 *
 *   1. the collected field is exactly 0,
 *   2. the SCHEDULED field carries the full booking value, which proves the
 *      rows were really read and summed rather than lost, and
 *   3. the net/total estimate is UNCHANGED, which proves the zero did not
 *      arrive by breaking the arithmetic.
 *
 * Without (2) and (3), `completed: undefined` from a 500 would pass (1).
 *
 * MEASURED AGAINST THE PRE-FIX TREE (origin/main f71cfb85f) BEFORE BEING
 * TRUSTED — 11 of these 19 cases failed, with these answers:
 *
 *   S1  completed.inAppAmountCollected        900  (expected 0)
 *   S1  warning                               "All figures are estimates. Cash
 *                                             balance is tracked but not
 *                                             charged. Payout system not
 *                                             connected." — no clause about the
 *                                             charge
 *   S1  vs the ledger writer's own rows       900 against 0
 *   S2a foldEarningsRows().totalInAppUsd     1050  (expected 0)
 *   S2a monthlyBreakdown[0].inApp            1050  (expected 0)
 *   S2c route, pagination path                900  (expected 0)
 *   S2c route, legacy-RPC path                900  (expected 0)
 *   S3  last definition of the SQL function   2330's, building totalInAppUsd
 *                                             from t.total_in_app
 *   S4  byCity.Cebu.inApp                     760  (expected 0)
 *   S4  revenue.depositCollected              absent
 *
 * The 8 that passed before the fix are deliberate and are NOT falsifiers:
 * `collectedInAppUsd`, the three `withNothingCollected` cases and 2330's
 * frozen bytes are new-module or invariant checks; "a negative net is
 * impossible" and "both paths answer identically" guard against the WRONG fix
 * (they would go red if the zero were threaded into the net, or into only one
 * of the two paths), and a guard against a wrong repair is expected to be green
 * before the repair exists.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyCollectedMoney.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter, { foldEarningsRows } from "../routes/rentABuddy.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { collectedInAppUsd, scheduledInAppUsd, withNothingCollected } from "../lib/rentBuddyCollectedMoney.js";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";
import { emptyLedgerDb, fakeLedgerRpc, type FakeLedgerDb } from "./helpers/fakeRentBuddyLedgerRpc.js";

process.env.TZ = "UTC";

const USER_TOKEN = "collected-money-token";
const USER_ID = "collected-money-user";
const BUDDY_PROFILE_ID = "collected-money-profile";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── HTTP plumbing ────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function request(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve_, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve_({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/** A builder that answers one fixed row / list for tables a case does not drive. */
function stub(single: any, list: any[] = []): any {
  const b: any = {
    select: () => b, eq: () => b, neq: () => b, in: () => b, is: () => b,
    gte: () => b, lte: () => b, gt: () => b, lt: () => b,
    order: () => b, limit: () => b, range: () => b,
    single: () => Promise.resolve({ data: single, error: null }),
    maybeSingle: () => Promise.resolve({ data: single, error: null }),
    then: (res: (r: any) => any) => Promise.resolve({ data: list, error: null }).then(res),
  };
  return b;
}

/** A `.range()`-honouring table, so the exhaustive pagers terminate. */
function pagedTable(rows: () => any[]): any {
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const b: any = {
    select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
    range(f: number, t: number) { from = f; to = t; return b; },
    then(res: any, rej: any) {
      const all = rows();
      return Promise.resolve({ data: all.slice(from, Math.min(to + 1, all.length)), error: null })
        .then(res, rej);
    },
  };
  return b;
}

function userClient(role: string | null = null): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) =>
      table === "profiles"
        ? stub({ id: USER_ID, account_status: "active", ...(role ? { role } : {}) })
        : stub(null, []),
  };
}

const FEE_ROW = {
  buddy_level: "new", platform_fee_percent: 20,
  traveler_service_fee_usd: 0, traveler_service_fee_pct: 0,
};

/**
 * One completed `full_in_app` booking. `deposit_usd === total_usd` is not a
 * quirk of the fixture — it is what the booking route writes for this payment
 * mode, and it is the reason the pre-fix aggregates claimed a whole booking.
 */
function fullInAppBooking(id: string, totalUsd: number, extra: Record<string, any> = {}) {
  return {
    id, status: "completed", payment_mode: "full_in_app",
    total_usd: totalUsd, deposit_usd: totalUsd, cash_balance_usd: 0,
    cash_balance_confirmed_by_buddy: false,
    completed_at: "2026-03-15T10:00:00+00:00", booking_date: "2026-03-15",
    category: "city", city: "Cebu", duration_h: 2, tip_usd: 0, pricing_type: "hourly",
    ...extra,
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", marketplaceRouter);
  await new Promise<void>((resolve_) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve_);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve_, reject) =>
  server.close((err) => (err ? reject(err) : resolve_()))
));

// ═════════════════════════════════════════════════════════════════════════════
// The module that owns the answer
// ═════════════════════════════════════════════════════════════════════════════

describe("the collected figure has exactly one producer", () => {
  it("answers 0 for every scheduled amount, including a whole booking", () => {
    for (const scheduled of [0, 0.01, 30, 500, 1_000_000]) {
      assert.equal(
        collectedInAppUsd(scheduled), 0,
        `a scheduled ${scheduled} is not a collected ${scheduled}: pay-deposit / pay-full are 503s`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — the buddy's own earnings dashboard
// ═════════════════════════════════════════════════════════════════════════════

const MARKETPLACE_SUMMARY = "/api/rent-a-buddy/me/earnings/summary";

/** $500 and $400, both full-in-app: a $900 pre-fix "collected" claim. */
const S1_BOOKINGS = [
  fullInAppBooking("s1-a", 500),
  fullInAppBooking("s1-b", 400),
];

/**
 * The ledger behind S1 — ADDED WHEN THIS FILE MET MIGRATION 3824 (PR #603).
 *
 * When these cases were written the summary route summed booking rows in
 * JavaScript and the ledger writer upserted a row from JavaScript, so a client
 * that answered `from()` was the whole world. 3824 moved both into SQL: the
 * route reads `rb_buddy_ledger_totals` (the fold of the ledger entries) and the
 * writer is `rb_post_booking_ledger`. A client with no `rpc` now gets the
 * route's REFUSAL (503), which would satisfy none of the assertions below — so
 * the fixture, and only the fixture, grew an `rpc`.
 *
 * It is helpers/fakeRentBuddyLedgerRpc.ts, the in-memory model of those
 * functions, over the SAME bookings at the SAME 20 % rate. Every assertion in
 * S1 is the one #610 wrote, with the same numbers. The functions themselves are
 * executed against PostgreSQL — after 3530 and 3824 are both applied — by
 * src/test/db/rentBuddyLedgerPosting.db.test.ts, group N.
 */
function s1Ledger(bookings: any[]): FakeLedgerDb {
  const db = emptyLedgerDb({
    buddyProfiles: { [BUDDY_PROFILE_ID]: { user_id: USER_ID, buddy_level: "new" } },
    feeRules: { [FEE_ROW.buddy_level]: FEE_ROW.platform_fee_percent },
  });
  for (const b of bookings) db.bookings[b.id] = { ...b, buddy_id: BUDDY_PROFILE_ID, traveler_id: "traveller-1" };
  return db;
}

function marketplaceClient(bookings: any[], ledger: FakeLedgerDb = s1Ledger(bookings)): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    rpc: (fn: string, args: any) => fakeLedgerRpc(ledger)(fn, args),
    from(table: string) {
      switch (table) {
        case "feature_flags":
          return stub({ flag: "rent_buddy_enabled", enabled: true });
        case "rent_buddy_profiles":
          return stub({
            id: BUDDY_PROFILE_ID, user_id: USER_ID, status: "active", buddy_level: "new",
            profile_views: 0, search_appearances: 0, repeat_client_count: 0,
            city_ranking: null, average_rating: null, review_count: 0,
          });
        case "rent_buddy_fee_rules":
          return stub(FEE_ROW);
        case "rent_buddy_bookings":
          return pagedTable(() => bookings);
        case "rent_buddy_tips":
          return pagedTable(() => []);
        case "trust_profiles":
          return stub({ overall_score: 70, public_level: "trusted" });
        default:
          return stub(null, []);
      }
    },
  };
}

describe("S1 — GET /me/earnings/summary reports nothing collected", () => {
  beforeEach(async () => {
    _setTestClient(userClient(), true);
    // The two bookings are LEDGERED, by the real writer, before the route is
    // asked about them — as every booking is since 3824 (creation posts its
    // ledger or is refused). An unledgered booking would be counted and priced
    // by nothing, and (3) below would read 0, not 180 / 720.
    const ledger = s1Ledger(S1_BOOKINGS);
    const client = marketplaceClient(S1_BOOKINGS, ledger);
    for (const booking of S1_BOOKINGS) {
      const posted = await createEarningsLedgerEntry(client, ledger.bookings[booking.id], BUDDY_PROFILE_ID);
      assert.equal(posted.status, "written", JSON.stringify(posted));
    }
    _setTestServiceClient(client);
  });

  it("inAppAmountCollected is 0, not the $900 of full-in-app bookings", async () => {
    const res = await request(MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // (1) the claim is gone
    assert.equal(res.body.completed.inAppAmountCollected, 0);
    assert.equal(res.body.completed.depositCollected, 0);
    assert.notEqual(
      res.body.completed.inAppAmountCollected, 900,
      "900 is the pre-fix answer: sum(deposit_usd), which for full_in_app is the whole booking total",
    );

    // (2) the rows really were read — a 500 or an empty page would also have
    // produced the zeros above, and must not be mistaken for the repair
    assert.equal(res.body.completed.count, 2);
    assert.equal(res.body.completed.depositScheduled, 900);
    assert.equal(res.body.completed.totalUsd, 900);

    // (3) the estimate the buddy acts on is unchanged by the zero
    assert.equal(res.body.estimatedPlatformFeeUsd, round2(900 * 0.2));
    assert.equal(res.body.estimatedBuddyEarningsUsd, round2(900 * 0.8));
  });

  it("the warning says nothing was collected, not only that payouts are off", async () => {
    const res = await request(MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.isEstimated, true);
    assert.match(
      res.body.warning, /no payment has been collected/i,
      "the pre-fix warning named the cash balance and the payout system and was " +
      "silent about the charge — which is how it could sit above a non-zero " +
      "'Deposit collected'",
    );
    // The clauses that were already true are still there: this widened the
    // warning rather than replacing it.
    assert.match(res.body.warning, /estimates/i);
    assert.match(res.body.warning, /payout system not connected/i);
  });

  it("agrees with the ledger rows the WRITER produces for the same bookings", async () => {
    // THE INVARIANT THIS WHOLE CHANGE IS ABOUT, asserted across both surfaces
    // with real code on each side rather than two hand-written fixtures.
    // `createEarningsLedgerEntry` is driven over the same two bookings and its
    // upserted rows are summed; the aggregate is asked the same question. The
    // numbers disagreed before this change: 0 against 900.
    //
    // (PR #603) The writer no longer upserts from JavaScript: it is ONE call to
    // rb_post_booking_ledger, which writes the row in the database. So the rows
    // are read from the ledger that call wrote into, instead of from a recorder
    // of `upsert` payloads. Same writer function, same bookings, same columns,
    // same expected numbers.
    const ledger = s1Ledger(S1_BOOKINGS);
    const client = marketplaceClient(S1_BOOKINGS, ledger);

    for (const booking of S1_BOOKINGS) {
      const result = await createEarningsLedgerEntry(
        client, ledger.bookings[booking.id], BUDDY_PROFILE_ID,
      );
      assert.equal(result.status, "written", JSON.stringify(result));
    }

    const ledgerRows = S1_BOOKINGS.map((b) => ledger.ledger[b.id]).filter(Boolean);
    assert.equal(ledgerRows.length, 2, "both bookings must have produced a ledger row");
    _setTestServiceClient(client);

    const ledgerCollected = ledgerRows.reduce((n, r) => n + Number(r.in_app_amount_collected), 0);
    const ledgerScheduled = ledgerRows.reduce((n, r) => n + Number(r.deposit_amount), 0);
    assert.equal(ledgerCollected, 0, "the writer's own answer");
    assert.equal(ledgerScheduled, 900, "and it still records what the deposits ARE");

    const res = await request(MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      res.body.completed.inAppAmountCollected, ledgerCollected,
      "the dashboard and the ledger must not disagree about the same bookings",
    );
    assert.equal(res.body.completed.depositScheduled, ledgerScheduled);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — the breakdown summary, in BOTH of its paths
// ═════════════════════════════════════════════════════════════════════════════

describe("S2a — foldEarningsRows (the pagination path)", () => {
  // $600 + $300 full-in-app, and one $500 deposit_plus_cash booking so the
  // fixture is not uniform: scheduled 600 + 300 + 150 = 1050.
  const ROWS = [
    fullInAppBooking("s2-a", 600),
    fullInAppBooking("s2-b", 300),
    { id: "s2-c", status: "completed", payment_mode: "deposit_plus_cash",
      total_usd: 500, deposit_usd: 150, cash_balance_usd: 350,
      completed_at: "2026-03-20T10:00:00+00:00", booking_date: "2026-03-20" },
  ];

  it("totalInAppUsd is 0 while the scheduled total and the net are untouched", () => {
    const summary = foldEarningsRows(ROWS, 0.2, new Date("2026-06-01T00:00:00Z"));

    assert.equal(summary.totalInAppUsd, 0);
    assert.notEqual(
      summary.totalInAppUsd, 1050,
      "1050 is the pre-fix answer: the deposit sum, published as money in app",
    );

    assert.equal(summary.totalInAppScheduledUsd, 1050, "the rows were summed, not dropped");
    assert.equal(summary.totalCashConfirmedUsd, 350);
    assert.equal(round2(summary.totalPlatformFeesUsd), round2(1400 * 0.2));
    assert.equal(
      round2(summary.totalNetUsd), round2(1050 + 350 - 1400 * 0.2),
      "the net is what the buddy is OWED and must not move; deriving it from the " +
      "collected zero would publish a NEGATIVE balance for a full_in_app booking",
    );
  });

  it("every month reports 0 collected and the month's own scheduled amount", () => {
    const summary = foldEarningsRows(ROWS, 0.2, new Date("2026-06-01T00:00:00Z"));
    assert.equal(summary.monthlyBreakdown.length, 1, "all three bookings are in 2026-03");

    const [march] = summary.monthlyBreakdown;
    assert.equal(march.inApp, 0);
    assert.notEqual(march.inApp, 1050, "the per-month field carried the same false claim");
    assert.equal(march.inAppScheduled, 1050);
    assert.equal(march.cash, 350);
    assert.equal(march.bookingCount, 3);
    assert.equal(round2(march.totalUsd), round2(1400 - 1400 * 0.2), "gross - fee, unchanged");
  });

  it("a negative net is impossible for a pure full-in-app buddy", () => {
    // The specific wrong answer this repair had to avoid producing. Every
    // booking is full-in-app, so cash is 0: a net of `collected + cash - fees`
    // would be -120 and the buddy would be told they OWE Portava money.
    const summary = foldEarningsRows(
      [fullInAppBooking("only", 600)], 0.2, new Date("2026-06-01T00:00:00Z"),
    );
    assert.equal(summary.totalCashConfirmedUsd, 0);
    assert.equal(summary.totalNetUsd, 480);
    assert.ok(summary.totalNetUsd > 0, "a net derived from the collected zero would be -120");
  });

  // ── Added with migration 3824 (PR #603) ────────────────────────────────────
  // The case above is green for a booking that STORES its whole price as
  // `deposit_usd`. 3824 stops storing that: under the owner's ruling of
  // 2026-10-04 no deposit is taken, so a new booking carries `deposit_usd = 0`
  // in either mode, and a full-in-app one carries `cash_balance_usd = 0` too.
  // Reading the scheduled amount from `deposit_usd` would then give
  // `0 + 0 - 120` — the same negative balance, by a different road, with the
  // case above still passing. MEASURED before the fold was changed: -120.
  it("a negative net is impossible for a full-in-app booking stored with NO deposit either", () => {
    const summary = foldEarningsRows(
      [fullInAppBooking("no-deposit", 600, { deposit_usd: 0 })], 0.2, new Date("2026-06-01T00:00:00Z"),
    );
    assert.equal(summary.totalInAppUsd, 0, "still nothing collected");
    assert.equal(summary.totalInAppScheduledUsd, 600, "the whole price is due in app: that is what full_in_app means");
    assert.equal(summary.totalCashConfirmedUsd, 0);
    assert.equal(summary.totalNetUsd, 480);
    assert.notEqual(summary.totalNetUsd, -120, "-120 is what `deposit_usd + cash - fees` gives for this row");
    assert.equal(summary.monthlyBreakdown[0].inApp, 0);
    assert.equal(summary.monthlyBreakdown[0].inAppScheduled, 600);
    assert.equal(round2(summary.monthlyBreakdown[0].totalUsd), 480);
  });

  it("a deposit-plus-cash booking stored with no deposit is ALL cash: scheduled 0, net unchanged", () => {
    const summary = foldEarningsRows([
      { id: "dpc", status: "completed", payment_mode: "deposit_plus_cash",
        total_usd: 500, deposit_usd: 0, cash_balance_usd: 500,
        completed_at: "2026-03-20T10:00:00+00:00", booking_date: "2026-03-20" },
    ], 0.2, new Date("2026-06-01T00:00:00Z"));
    assert.deepEqual(
      [summary.totalInAppUsd, summary.totalInAppScheduledUsd, summary.totalCashConfirmedUsd, summary.totalNetUsd],
      [0, 0, 500, 400]);
  });

  it("for every booking written BEFORE 3824 the scheduled amount is the number it always was", () => {
    // The mode-based reading must not move any existing figure: a full-in-app
    // row stored deposit = total, a deposit-plus-cash row stored its share, and
    // a row with no payment mode at all falls back to its stored deposit.
    assert.equal(scheduledInAppUsd(fullInAppBooking("old", 600)), 600);
    assert.equal(scheduledInAppUsd({ payment_mode: "deposit_plus_cash", total_usd: 500, deposit_usd: 150 }), 150);
    assert.equal(scheduledInAppUsd({ payment_mode: null, total_usd: 500, deposit_usd: 150 }), 150);
    assert.equal(scheduledInAppUsd({ total_usd: 500 }), 0);
    // …and the three-row fixture above still sums to the 1050 it always did.
    assert.equal(ROWS.reduce((n, r) => n + scheduledInAppUsd(r), 0), 1050);
  });
});

describe("S2b — withNothingCollected (the RPC path, before 3530 is applied)", () => {
  /**
   * The exact jsonb 2330's function returns: the state of EVERY database until
   * 3530 is pressed. The route must not forward it.
   */
  const LEGACY_2330_RESULT = {
    totalInAppUsd: 900,
    totalCashConfirmedUsd: 0,
    totalPlatformFeesUsd: 180,
    totalDisputedUsd: 0,
    totalPendingUsd: 0,
    totalNetUsd: 720,
    yearlyNetUsd: 720,
    monthlyBreakdown: [
      { month: "2026-03", totalUsd: 720, bookingCount: 2, inApp: 900, cash: 0, fees: 180 },
    ],
  };

  it("re-states a legacy aggregate instead of trusting it", () => {
    const out = withNothingCollected(LEGACY_2330_RESULT);

    assert.equal(out.totalInAppUsd, 0);
    assert.equal(out.totalInAppScheduledUsd, 900, "the legacy value is kept under the honest name");
    assert.equal(out.monthlyBreakdown[0].inApp, 0);
    assert.equal(out.monthlyBreakdown[0].inAppScheduled, 900);

    // Nothing else is touched: this is a renaming, not a recomputation.
    assert.equal(out.totalNetUsd, 720);
    assert.equal(out.yearlyNetUsd, 720);
    assert.equal(out.totalPlatformFeesUsd, 180);
    assert.equal(out.monthlyBreakdown[0].totalUsd, 720);
    assert.equal(out.monthlyBreakdown[0].bookingCount, 2);
  });

  it("is idempotent, so a 3530-era result survives the same pass unchanged", () => {
    const fromNewFunction = {
      ...LEGACY_2330_RESULT,
      totalInAppUsd: 0,
      totalInAppScheduledUsd: 900,
      monthlyBreakdown: [{ month: "2026-03", totalUsd: 720, bookingCount: 2, inApp: 0, inAppScheduled: 900, cash: 0, fees: 180 }],
    };
    const once = withNothingCollected(fromNewFunction);
    assert.equal(once.totalInAppScheduledUsd, 900, "the scheduled value must not be overwritten by the zero");
    assert.equal(once.totalInAppUsd, 0);
    assert.deepEqual(withNothingCollected(once), once);
  });

  it("an aggregate with no months at all does not throw", () => {
    const empty = withNothingCollected({ totalNetUsd: 0, monthlyBreakdown: [] });
    assert.equal(empty.totalInAppUsd, 0);
    assert.equal(empty.totalInAppScheduledUsd, 0);
    assert.deepEqual(empty.monthlyBreakdown, []);
  });
});

const DASHBOARD = "/api/rent-a-buddy/dashboard/earnings/summary";

function dashboardClient(bookings: any[], rpc: ((fn: string, args: any) => any) | null): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    rpc: async (fn: string, args: any) =>
      rpc ? rpc(fn, args) : { data: null, error: { message: "Could not find the function public." + fn } },
    from(table: string) {
      switch (table) {
        case "feature_flags":
          return stub({ flag: "rent_buddy_enabled", enabled: true });
        case "rent_buddy_profiles":
          return stub({ id: BUDDY_PROFILE_ID, buddy_level: "new" });
        case "rent_buddy_fee_rules":
          return stub(FEE_ROW);
        case "rent_buddy_bookings":
          return pagedTable(() => bookings);
        default:
          return stub(null, []);
      }
    },
  };
}

describe("S2c — GET /dashboard/earnings/summary, over the wire", () => {
  const BOOKINGS = [fullInAppBooking("s2c-a", 500), fullInAppBooking("s2c-b", 400)];

  beforeEach(() => _setTestClient(userClient(), true));

  it("the pagination path publishes 0 collected and 900 scheduled", async () => {
    _setTestServiceClient(dashboardClient(BOOKINGS, null));
    const res = await request(DASHBOARD);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totalInAppUsd, 0);
    assert.equal(res.body.totalInAppScheduledUsd, 900);
    assert.equal(res.body.totalNetUsd, round2(900 - 900 * 0.2));
    assert.equal(res.body.isEstimated, true);
    assert.match(res.body.warning, /no payment has been collected/i);
  });

  it("a database still holding 2330's function cannot make the route lie", async () => {
    // THE CASE A MIGRATION-ONLY FIX WOULD MISS. Migrations here are applied by
    // hand after CI; between the commit and the press, this is what every
    // database answers.
    _setTestServiceClient(dashboardClient(BOOKINGS, () => ({
      data: {
        totalInAppUsd: 900, totalCashConfirmedUsd: 0, totalPlatformFeesUsd: 180,
        totalDisputedUsd: 0, totalPendingUsd: 0, totalNetUsd: 720, yearlyNetUsd: 720,
        monthlyBreakdown: [{ month: "2026-03", totalUsd: 720, bookingCount: 2, inApp: 900, cash: 0, fees: 180 }],
      },
      error: null,
    })));

    const res = await request(DASHBOARD);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totalInAppUsd, 0, "the route re-states the aggregate rather than forwarding it");
    assert.equal(res.body.totalInAppScheduledUsd, 900);
    assert.equal(res.body.monthlyBreakdown[0].inApp, 0);
    assert.equal(res.body.monthlyBreakdown[0].inAppScheduled, 900);
    assert.equal(res.body.totalNetUsd, 720, "the DB's own net is still published unchanged");
    assert.match(res.body.warning, /no payment has been collected/i);
  });

  it("both paths answer the collected question identically", async () => {
    _setTestServiceClient(dashboardClient(BOOKINGS, null));
    const paginated = await request(DASHBOARD);

    _setTestServiceClient(dashboardClient(BOOKINGS, () => ({
      data: {
        totalInAppUsd: 900, totalCashConfirmedUsd: 0, totalPlatformFeesUsd: 180,
        totalDisputedUsd: 0, totalPendingUsd: 0, totalNetUsd: 720, yearlyNetUsd: 720,
        monthlyBreakdown: [{ month: "2026-03", totalUsd: 720, bookingCount: 2, inApp: 900, cash: 0, fees: 180 }],
      },
      error: null,
    })));
    const aggregated = await request(DASHBOARD);

    assert.equal(paginated.body.totalInAppUsd, aggregated.body.totalInAppUsd);
    assert.equal(paginated.body.totalInAppScheduledUsd, aggregated.body.totalInAppScheduledUsd);
    assert.equal(paginated.body.warning, aggregated.body.warning);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 — the SQL aggregate
// ═════════════════════════════════════════════════════════════════════════════

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * The LAST migration in the canonical chain that defines
 * rb_buddy_earnings_summary — which is the body a database ends up with after
 * the chain is applied in order.
 *
 * Reading the chain rather than naming 3530 is deliberate: a later file that
 * CREATE OR REPLACEs the function back to a collecting definition would be
 * invisible to a test pinned to 3530, and replacing a function body is exactly
 * how this defect would come back.
 */
function lastDefinitionOfEarningsSummary(): { file: string; sql: string } {
  const defs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }))
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.rb_buddy_earnings_summary/.test(f.sql));

  assert.ok(defs.length > 0, "no migration defines rb_buddy_earnings_summary");
  return defs[defs.length - 1];
}

/**
 * assert.match on a 20 KB migration prints the whole file as `actual`, which
 * buries the finding. These report the file name and the pattern instead.
 */
function assertSql(sql: string, file: string, re: RegExp, why: string) {
  assert.ok(re.test(sql), `${file}: ${why}\n  expected to match: ${re}`);
}
function assertNotSql(sql: string, file: string, re: RegExp, why: string) {
  assert.ok(!re.test(sql), `${file}: ${why}\n  must NOT match: ${re}`);
}

describe("S3 — rb_buddy_earnings_summary's installed body claims no collection", () => {
  it("builds totalInAppUsd from a literal 0, never from deposit_usd", () => {
    const { file, sql } = lastDefinitionOfEarningsSummary();

    assertSql(sql, file, /'totalInAppUsd',\s*0::numeric/,
      "must report the collected total as a literal 0");
    assertNotSql(sql, file, /'totalInAppUsd',\s*t\.total_in_app\b/,
      "still builds totalInAppUsd from the deposit sum — this is 2330's definition");
    assertSql(sql, file, /'monthlyBreakdown'[\s\S]*'inApp',\s*0::numeric/,
      "must report each month's collected amount as 0 too");
  });

  it("keeps the deposit sum, under a name that does not claim it was taken", () => {
    const { file, sql } = lastDefinitionOfEarningsSummary();

    assertSql(sql, file, /'totalInAppScheduledUsd',\s*t\.total_in_app_scheduled/,
      "the deposit sum must still be published, under the scheduled name");
    assertSql(sql, file, /'inAppScheduled',\s*m\.in_app_scheduled/,
      "and per month too");
    // The net is the one figure that must still be derived from the scheduled
    // amount. A body that dropped it would publish a negative balance.
    assertSql(sql, file, /'totalNetUsd',\s*t\.total_in_app_scheduled \+ t\.total_cash - t\.total_fees/,
      "totalNetUsd must keep deriving from the scheduled amount");
  });

  it("the replacement keeps 2330's security properties", () => {
    const { file, sql } = lastDefinitionOfEarningsSummary();
    assertSql(sql, file, /SECURITY DEFINER/, "a money aggregate must not run as the caller");
    assertSql(sql, file, /SET search_path TO 'public'/, "search_path must stay pinned");
    assertSql(sql, file, /REVOKE ALL ON FUNCTION public\.rb_buddy_earnings_summary\(uuid, numeric\) FROM PUBLIC;/,
      "a newly created function is EXECUTE-to-PUBLIC by default");
    assertSql(sql, file, /GRANT EXECUTE ON FUNCTION public\.rb_buddy_earnings_summary\(uuid, numeric\) TO service_role;/,
      "service_role must keep being able to call it");
  });

  // ── Added with migration 3824 (PR #603) ────────────────────────────────────
  // 3824 sorts after 3530 and re-states the function, so the four cases around
  // this one now read 3824's body — which is what they were written to catch: a
  // later file replacing the definition. These pin what 3824 is ALLOWED to
  // differ in, and that 3530 itself was not edited to make room.
  it("the last definition reads the in-app share from the payment MODE, from a qualified table, with pg_temp last", () => {
    const { file, sql } = lastDefinitionOfEarningsSummary();
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.rb_buddy_earnings_summary");
    const body = sql.slice(start, sql.indexOf("\n$$;", start));

    // 3824 stores deposit_usd = 0 while no deposit is taken; a scheduled amount
    // read from deposit_usd alone makes totalNetUsd negative for full_in_app.
    assertSql(body, file, /CASE WHEN b\.payment_mode::text = 'full_in_app'\s+THEN COALESCE\(b\.total_usd, 0\)::numeric\s+ELSE COALESCE\(b\.deposit_usd, 0\)::numeric\s+END\s+AS in_app_scheduled/,
      "the in-app share must be the whole price for full_in_app and the stored deposit otherwise");
    assertSql(body, file, /FROM public\.rent_buddy_bookings b/, "the table must be schema-qualified");
    assertSql(body, file, /SET search_path TO 'public', pg_temp\n/,
      "pg_temp must be spelled out LAST: with `public` alone it is searched first for relations");
    // The assertions above this case test the whole FILE. These repeat the
    // three that matter on the function's own text, so that some other
    // function in the same file cannot satisfy them on its behalf.
    assertSql(body, file, /SECURITY DEFINER/, "this function, not a neighbour, must be SECURITY DEFINER");
    assertSql(body, file, /'totalInAppUsd',\s*0::numeric/, "this function's collected total must be a literal 0");
    assertSql(body, file, /'totalNetUsd',\s*t\.total_in_app_scheduled \+ t\.total_cash - t\.total_fees/,
      "this function's net must keep deriving from the scheduled amount");
  });

  it("3530's own definition was not edited to make room, and it is exactly what 3824's rollback restores", () => {
    const m3530 = readFileSync(join(MIGRATIONS_DIR, "3530_rb_earnings_summary_nothing_collected.sql"), "utf8");
    const rollback = readFileSync(
      resolve(MIGRATIONS_DIR, "../../../../db/rollback/2026-10-04-3824-rent-buddy-ledger-posting-rollback.sql"), "utf8");
    const def = /CREATE OR REPLACE FUNCTION public\.rb_buddy_earnings_summary\([\s\S]*?\n\$\$;\n/;
    const in3530: string = def.exec(m3530)?.[0] ?? "";
    const inRollback: string = def.exec(rollback)?.[0] ?? "";
    assert.ok(in3530 !== "" && inRollback !== "", "the function must be defined in 3530 and restored by 3824's rollback");

    assertSql(in3530, "3530", /COALESCE\(b\.deposit_usd, 0\)::numeric\s+AS in_app_scheduled/,
      "3530 reads deposit_usd, as merged; the mode-based reading belongs to 3824");
    assertNotSql(in3530, "3530", /payment_mode/, "3530's function must not have been edited to carry 3824's change");
    assertSql(in3530, "3530", /SET search_path TO 'public'\n/, "3530's pin is the one it was merged with");
    assert.equal(inRollback, in3530, "3824's rollback must restore 3530's definition exactly, not a retyped copy");
  });

  it("2330's own bytes are untouched — an applied migration is a frozen artifact", () => {
    // docs/migrations.md: apply-migrations hashes the file and refuses when disk
    // and ledger disagree, comments included. The repair had to be a NEW file
    // for that reason, and this asserts nobody later "tidied" 2330 instead.
    const file = "2330_rent_buddy_money_atomicity.sql";
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    assertSql(sql, file, /'totalInAppUsd',\s*t\.total_in_app,/,
      "2330 must still contain its original defect; it is a record of what ran");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S4 — the operator screen
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_ANALYTICS = "/api/rent-a-buddy/admin/marketplace/analytics";

describe("S4 — GET /admin/marketplace/analytics reports booked value, not cash", () => {
  // $700 full-in-app in Cebu (pre-fix inApp: 700) plus a deposit_plus_cash
  // booking, so the two modes' pre-fix contributions are distinguishable.
  const BOOKINGS = [
    fullInAppBooking("s4-a", 700, { created_at: "2026-03-15T10:00:00+00:00" }),
    { id: "s4-b", status: "completed", payment_mode: "deposit_plus_cash", city: "Cebu",
      category: "city", total_usd: 200, deposit_usd: 60, cash_balance_usd: 140,
      created_at: "2026-03-16T10:00:00+00:00", buddy_id: BUDDY_PROFILE_ID },
  ];

  /**
   * The analytics route reads six tables and nothing else; `requireAdmin` takes
   * the role off the CALLER's client, not this one, so no `auth` is needed here.
   */
  function adminServiceClient(): any {
    return {
      from: (table: string) =>
        table === "rent_buddy_bookings" ? stub(null, BOOKINGS) : stub(null, []),
    };
  }

  beforeEach(() => {
    _setTestClient(userClient("admin"), true);
    _setTestServiceClient(adminServiceClient());
  });

  it("byCity[].inApp is 0, not the full value of the full-in-app bookings", async () => {
    const res = await request(ADMIN_ANALYTICS);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const cebu = res.body.bookings.byCity.Cebu;
    assert.ok(cebu, `no Cebu row: ${JSON.stringify(res.body.bookings?.byCity)}`);

    assert.equal(cebu.inApp, 0);
    assert.notEqual(
      cebu.inApp, 760,
      "760 is the pre-fix answer: 700 (the whole full_in_app booking) + 60 (the other deposit)",
    );

    // The rows were read and attributed: this is not a zero from an empty read.
    assert.equal(cebu.bookings, 2);
    assert.equal(cebu.inAppScheduled, 760);
    assert.equal(cebu.revenue, 900);
    assert.equal(cebu.cash, 140);
  });

  it("revenue publishes an explicit collected 0 beside the booked deposit", async () => {
    const res = await request(ADMIN_ANALYTICS);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.revenue.depositCollected, 0);
    assert.equal(res.body.revenue.deposit, 760, "the booked deposit sum is still reported");
    assert.equal(res.body.revenue.total, 900);
    assert.equal(res.body.isEstimated, true);
    assert.match(res.body.warning, /no payment has been collected/i);
    assert.match(res.body.warning, /booked value/i);
  });
});
