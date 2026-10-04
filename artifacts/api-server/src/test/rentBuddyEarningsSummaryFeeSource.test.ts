/**
 * GET /api/rent-a-buddy/me/earnings/summary — the take rate a buddy is shown.
 *
 * ── THE DEFECT (M1) ─────────────────────────────────────────────────────────
 * The handler computed its fee estimate as
 *
 *     const ledgerEntry = ledger[0];
 *     const defaultFeePercent = 22;
 *     const feePercent = ledgerEntry?.platform_fee_percent ?? defaultFeePercent;
 *
 * — an ARBITRARY ledger row's rate applied to every completed booking, and a
 * hard-coded 22 % whenever the ledger was empty. Meanwhile the ledger writer
 * used the per-level schedule and `routes/rentABuddy.ts` hard-coded 0.15. A
 * `new` buddy was quoted 15 % on one screen, ledgered at 25 %, and dashboarded
 * at 22 % on this one. `08` §2.3.
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *   1. The percentage comes from CONFIGURATION, resolved by the database
 *      (`rb_resolve_platform_fee_percent`, migration 3824) for THIS buddy's
 *      level and market — not from a ledger row, not from a literal — and the
 *      response says which configuration it came from (`platformFeeSource`).
 *   2. The fee AMOUNT is the fold of the buddy's ledger entries
 *      (`rb_buddy_ledger_totals`). It is not `percent × total` computed here: a
 *      booking priced at an earlier rate keeps the fee it was ledgered with.
 *   3. A level with no fee row is the owner's default of 10 %, and SAYS it is
 *      the default (`platformFeeSource: "owner_default"`).
 *   4. A commission or a total that cannot be read is a 503 with a named error
 *      and NO fee figure — never a silent default.
 *
 * ── WHAT CHANGED IN (3), AND WHY IT IS NOT THE OLD DEFECT COMING BACK ───────
 * This file used to assert that a level with no fee row was a 409 ("an
 * unconfigured take rate is refused, not guessed"). The lesson it encoded (M10)
 * is that the absence of a row must never be INDISTINGUISHABLE from a deliberate
 * value: the old code answered 22 % for both.
 *
 * On 2026-10-04 the owner ruled a 10 % commission "as a starting value",
 * configurable by product and market. So "no row" now has a ruled answer, and
 * the M10 lesson is kept the other way round: the answer carries its SOURCE.
 * `owner_default` is distinguishable from `fee_schedule` (an operator's row for
 * the level) and from `launch_control` (a market / product override), in the
 * response and in the ledger posting's own result. The two FAILURES — the
 * function is missing, the function errored — are still distinguishable from
 * each other and from every success.
 *
 * The stored schedule (25 / 22 / 15 / 12 / 12 by level) is NOT changed by this
 * work: while those rows exist they apply. That the stored values differ from
 * the ruled 10 % is reported to the owner, not resolved here.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyEarningsSummaryFeeSource.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import marketplaceRouter, { EARNINGS_NOT_COLLECTED_WARNING } from "../routes/rentABuddyMarketplace.js";
import { emptyLedgerDb, fakeLedgerRpc, type FakeLedgerDb } from "./helpers/fakeRentBuddyLedgerRpc.js";

const USER_TOKEN = "earnings-fee-source-token";
const USER_ID = "earnings-fee-source-user";
const BUDDY_PROFILE_ID = "earnings-fee-source-profile";

/**
 * The world behind the fake service client. The two SQL functions the handler
 * calls are the model in helpers/fakeRentBuddyLedgerRpc.ts, over this object;
 * the functions themselves are executed by
 * src/test/db/rentBuddyLedgerPosting.db.test.ts (L1, L2, C6).
 */
let db: FakeLedgerDb;
let buddyLevel: string | null = "pro";
/** Functions to answer as absent ("3824 is not applied"). */
let absent: string[] = [];
/** A function to answer with an error instead. */
let erroring: string | null = null;

function builder(single: any, list: any[] = []): any {
  const b: any = {
    select: () => b,
    eq: () => b,
    neq: () => b,
    in: () => b,
    is: () => b,
    gte: () => b, lte: () => b, gt: () => b, lt: () => b,
    order: () => b, limit: () => b, range: () => b,
    single: () => Promise.resolve({ data: single, error: null }),
    maybeSingle: () => Promise.resolve({ data: single, error: null }),
    then: (resolve: (r: any) => any) => Promise.resolve({ data: list, error: null }).then(resolve),
  };
  return b;
}

/** Tables the handler must NOT read any more: the fee schedule and the tips. */
let forbiddenReads: string[] = [];

function serviceClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    rpc: (fn: string, args: any) => {
      if (erroring === fn) {
        return Promise.resolve({ data: null, error: { code: "XX000", message: `internal error in ${fn} reading rent_buddy_fee_rules` } });
      }
      return fakeLedgerRpc(db, { absent })(fn, args);
    },
    from(table: string) {
      switch (table) {
        case "rent_buddy_profiles":
          return builder({
            id: BUDDY_PROFILE_ID,
            user_id: USER_ID,
            status: "active",
            buddy_level: buddyLevel,
            country: "Testland", city: "Cebu",
            profile_views: 4, search_appearances: 9, repeat_client_count: 1,
            city_ranking: null, average_rating: 4.8, review_count: 3,
          });
        case "rent_buddy_fee_rules":
        case "rent_buddy_tips":
        case "rent_buddy_earnings_ledger":
        case "rent_buddy_earnings_entries":
          forbiddenReads.push(table);
          return builder(null, []);
        case "rent_buddy_bookings":
          return builder(null, Object.values(db.bookings));
        case "trust_profiles":
          return builder({ overall_score: 70, public_level: "trusted" });
        case "feature_flags":
          return builder({ flag: "rent_buddy_enabled", enabled: true });
        default:
          return builder(null, []);
      }
    },
  };
}

function authClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) =>
      table === "profiles" ? builder({ id: USER_ID, account_status: "active" }) : builder(null, []),
  };
}

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
        headers: { authorization: `Bearer ${USER_TOKEN}` },
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
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", marketplaceRouter);
  _setTestClient(authClient(), true);
  _setTestServiceClient(serviceClient());
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve()))
));

const post = (bookingId: string, event: string, key: string | null = null, args: any = {}) =>
  fakeLedgerRpc(db)("rb_post_booking_ledger", { p_booking_id: bookingId, p_event: event, p_event_key: key, p_args: args });

/** A completed booking of this buddy's, as the bookings table would hold it. */
function completedBooking(id: string, totalUsd: number, over: Record<string, unknown> = {}) {
  db.bookings[id] = {
    id, buddy_id: BUDDY_PROFILE_ID, traveler_id: "traveller-1", status: "completed", total_usd: totalUsd,
    deposit_usd: 60, cash_balance_usd: totalUsd - 60, cash_balance_confirmed_by_buddy: false,
    booking_date: "2026-01-01", category: "city", city: "Cebu", country_code: "Testland",
    duration_h: 4, tip_usd: 0, pricing_type: "hourly", ...over,
  };
}

beforeEach(() => {
  buddyLevel = "pro";
  absent = [];
  erroring = null;
  forbiddenReads = [];
  db = emptyLedgerDb({
    buddyProfiles: { [BUDDY_PROFILE_ID]: { user_id: USER_ID, buddy_level: "pro", country: "Testland" } },
  });
});

/** Give the buddy a level, in the profile the route reads AND the one the ledger prices from. */
function setLevel(level: string) {
  buddyLevel = level;
  db.buddyProfiles[BUDDY_PROFILE_ID].buddy_level = level;
}

const SUMMARY = "/api/rent-a-buddy/me/earnings/summary";

describe("the fee percentage comes from configuration, and says which", () => {
  it("prices from the buddy's OWN level's schedule row, and publishes which rate applied", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15, new: 25 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.buddyLevel, "pro");
    assert.equal(res.body.platformFeePercent, 15);
    assert.equal(res.body.platformFeeSource, "fee_schedule");
    assert.equal(res.body.estimatedPlatformFeeUsd, 30);   // 15 % of 200, as LEDGERED
    assert.equal(res.body.estimatedBuddyEarningsUsd, 170);
  });

  it("follows the schedule when the operator changes it — no deploy, no literal", async () => {
    setLevel("new");
    db.feeRules = { new: 25 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePercent, 25);
    assert.equal(res.body.estimatedPlatformFeeUsd, 50);
    assert.notEqual(res.body.platformFeePercent, 22, "22 was the deleted dashboard literal");
    assert.notEqual(res.body.platformFeePercent, 15, "15 was the deleted earnings-summary literal");
  });

  it("a market override beats the level's row, and is named as the source", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15 };
    db.feeOverrides = [{ country_code: "Testland", city: null, category: null, platform_fee_percent: 8 }];

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.platformFeePercent, res.body.platformFeeSource], [8, "launch_control"]);
  });

  it("a level with NO fee row is the owner's default of 10 — and says it is the default", async () => {
    // 'standard' is settable by the admin level route and has no schedule row.
    setLevel("standard");
    db.feeRules = { pro: 15 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePercent, 10);
    assert.equal(res.body.platformFeeSource, "owner_default",
      "the absence of a row must never be indistinguishable from a configured rate (M10)");
    assert.equal(res.body.estimatedPlatformFeeUsd, 20);
    assert.equal(res.body.estimatedBuddyEarningsUsd, 180);
  });

  it("never reads the fee schedule, the tips or the ledger tables from JavaScript", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");
    await get(SUMMARY);
    assert.deepEqual(forbiddenReads, [],
      "the handler read a money table itself — the fold and the commission belong to the two SQL functions");
  });
});

describe("the fee AMOUNT is the fold of what was ledgered, not percent × total", () => {
  it("a booking ledgered at an earlier rate keeps its fee when the schedule changes (M1)", async () => {
    // M1 was "an ARBITRARY ledger row's rate applied to every completed
    // booking". The mirror-image defect would be TODAY's rate applied to every
    // completed booking. Neither: each booking carries the fee it was priced at.
    setLevel("pro");
    db.feeRules = { pro: 25 };
    completedBooking("bk-old", 200);
    await post("bk-old", "booking_created");      // ledgered at 25 → 50.00

    db.feeRules = { pro: 15 };                    // the operator lowers the rate
    completedBooking("bk-new", 100);
    await post("bk-new", "booking_created");      // ledgered at 15 → 15.00

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePercent, 15, "the rate quoted is the one that applies to the NEXT booking");
    assert.equal(res.body.estimatedPlatformFeeUsd, 65, "50 + 15 as ledgered — not 15 % of 300 (45) and not 25 % of 300 (75)");
    assert.equal(res.body.estimatedBuddyEarningsUsd, 235);
    assert.equal(res.body.completed.totalUsd, 300);
  });

  it("a completed booking with no ledger is COUNTED and contributes no money — it is not priced on the fly", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");
    completedBooking("bk-unledgered", 500);       // no posting

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.completed.count, 2);
    assert.equal(res.body.completed.unledgeredCount, 1);
    assert.equal(res.body.estimatedPlatformFeeUsd, 30, "the unledgered 500 was priced at a rate nobody recorded for it");
    assert.equal(res.body.estimatedBuddyEarningsUsd, 170);
  });

  it("no commission on tips: a tip raises the tips total and leaves the fee alone (owner ruling 2026-10-04)", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15 };
    completedBooking("bk-1", 200);
    await post("bk-1", "booking_created");
    const tipped = await post("bk-1", "tip", "tip-1", { traveler_id: "traveller-1", amount_usd: 20, note: null });
    assert.equal(tipped.data.ok, true, JSON.stringify(tipped.data));

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.tips, { total: 20, count: 1 });
    assert.equal(res.body.tipCommissionPercent, 0);
    assert.equal(res.body.estimatedPlatformFeeUsd, 30);
    assert.equal(res.body.estimatedBuddyEarningsUsd, 170, "service earnings; the tip is reported beside them, whole");
  });

  it("reports NOTHING as collected — not the sum of deposit_usd (PAY-009)", async () => {
    setLevel("pro");
    db.feeRules = { pro: 15 };
    completedBooking("bk-1", 200, { deposit_usd: 200, cash_balance_usd: 0 });   // full_in_app: the worst case
    await post("bk-1", "booking_created");

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.completed.inAppAmountCollected, 0);
    assert.equal(res.body.completed.depositCollected, 0,
      "the deprecated alias must carry what was collected, never the booking's deposit term");
    assert.equal(res.body.isEstimated, true);
    assert.equal(res.body.warning, EARNINGS_NOT_COLLECTED_WARNING);
    assert.match(res.body.warning, /Nothing has been collected/);
    assert.match(res.body.warning, /no deposit is taken/);
  });
});

describe("a commission or a total that cannot be read is refused, not guessed", () => {
  it("503 ledger_unavailable when the totals function is absent — and no money figure at all", async () => {
    absent = ["rb_buddy_ledger_totals"];
    completedBooking("bk-1", 200);
    const res = await get(SUMMARY);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "ledger_unavailable");
    assert.equal(res.body.retryable, true);
    for (const k of ["estimatedPlatformFeeUsd", "estimatedBuddyEarningsUsd", "platformFeePercent", "completed", "tips"]) {
      assert.equal(res.body[k], undefined, `${k} was published although nothing could be read`);
    }
  });

  it("503 ledger_unavailable when the commission function is absent", async () => {
    absent = ["rb_resolve_platform_fee_percent"];
    const res = await get(SUMMARY);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "ledger_unavailable");
    assert.equal(res.body.platformFeePercent, undefined, "no rate may be published when none could be resolved");
  });

  it("503 ledger_write_failed when a function errors", async () => {
    erroring = "rb_resolve_platform_fee_percent";
    const res = await get(SUMMARY);
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "ledger_write_failed");
    assert.equal(res.body.platformFeePercent, undefined);
  });

  it("the two failures are distinguishable — and neither looks like the default", async () => {
    absent = ["rb_resolve_platform_fee_percent"];
    const missing = await get(SUMMARY);
    absent = [];
    erroring = "rb_resolve_platform_fee_percent";
    const errored = await get(SUMMARY);
    erroring = null;
    setLevel("standard");
    const defaulted = await get(SUMMARY);

    assert.notEqual(missing.body.error, errored.body.error,
      "'the function is not there' and 'the function failed' must not collapse into one answer");
    assert.equal(defaulted.status, 200);
    assert.equal(defaulted.body.platformFeeSource, "owner_default");
    assert.notEqual(missing.status, defaulted.status,
      "collapsing a failure into the default is how a missing row became a deliberate 22 %");
  });

  it("does not leak the schedule's table name or the database's detail to the client", async () => {
    erroring = "rb_resolve_platform_fee_percent";
    const res = await get(SUMMARY);
    assert.equal(JSON.stringify(res.body).includes("rent_buddy_fee_rules"), false);
    assert.equal("detail" in res.body, false);

    erroring = "rb_buddy_ledger_totals";
    const totals = await get(SUMMARY);
    assert.equal(totals.status, 503);
    assert.equal(JSON.stringify(totals.body).includes("rent_buddy_fee_rules"), false);
  });
});
