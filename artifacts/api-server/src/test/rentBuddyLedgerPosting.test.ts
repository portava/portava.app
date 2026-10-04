/**
 * lib/rentBuddyLedgerPosting.ts — the API's one door to the Rent-a-Buddy money
 * record — and the two routes that exist only because of it:
 *
 *   GET   /rent-a-buddy/buddies/:buddyId/commission     the rate shown before checkout
 *   POST / PATCH /rent-a-buddy/admin/launch-controls    the per-market, per-product override
 *   POST  /rent-a-buddy/bookings/:bookingId/addons      add-ons, as ONE ledger event
 *   POST  /rent-a-buddy/requests/:requestId/offers      an offer's terms are the database's
 *
 * Payments PAY-T12 (requirement rows PAY-018, PAY-055, PAY-010) and the owner
 * rulings of 2026-10-04: a 10 % commission on the pre-tax service price, shown
 * before checkout, configurable by product and market; no commission on tips;
 * no deposit in the first release.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ──────────────────────────────────────────
 * The SQL functions are executed, against PostgreSQL, by
 * src/test/db/rentBuddyLedgerPosting.db.test.ts (suite X drives THIS module
 * against the real functions). This file is about the JavaScript on its own:
 *
 *   1. how an answer is CLASSIFIED — and in particular that "the function is
 *      not there" has a name and never becomes a fallback;
 *   2. that the module holds no arithmetic and no settlement poster;
 *   3. that no route reaches a money function except through it;
 *   4. the commission quote and the override routes, on stored state;
 *   5. add-ons and offer terms, on stored state.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyLedgerPosting.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import * as posting from "../lib/rentBuddyLedgerPosting.js";
import {
  BOOKING_QUOTE_RPC,
  CASH_CONFIRMATION_RPC,
  LEDGER_POSTING_RPC,
  LEDGER_REFUSED,
  LEDGER_TOTALS_RPC,
  LEDGER_UNAVAILABLE,
  LEDGER_WRITE_FAILED,
  PAYOUT_TRANSITION_RPC,
  RESERVED_TIP_EVENT_KEY,
  callMoneyRpc,
  depositColumns,
  isPositiveMoneyAmount,
  ledgerRefusalHttpStatus,
  postBookingAddons,
  postBookingLedgerEvent,
  postBookingTip,
  quoteBooking,
  quotePricedBooking,
  readBuddyLedgerTotals,
  sendBookingQuoteFailure,
  sendLedgerRefusal,
  sendMoneyRpcFailure,
  transitionPayout,
} from "../lib/rentBuddyLedgerPosting.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import { parsePlatformFeeOverride } from "../lib/rentBuddyLaunchControls.js";
import marketplaceRouter, { LEDGER_NOT_SETTLED_WARNING, toLedgerEntryView } from "../routes/rentABuddyMarketplace.js";
import { emptyLedgerDb, fakeLedgerRpc, functionNotFound, type FakeLedgerDb } from "./helpers/fakeRentBuddyLedgerRpc.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// ═════════════════════════════════════════════════════════════════════════════
// 1. Classification
// ═════════════════════════════════════════════════════════════════════════════

describe("callMoneyRpc — every way a money call can not-happen has a name", () => {
  const ARGS = { p_booking_id: "b" };

  it("no client, or a client with no rpc(): `ledger_unavailable`, and no call is made", async () => {
    for (const client of [null, undefined, {}, { rpc: "not a function" }, { from: () => { throw new Error("touched"); } }]) {
      const r = await callMoneyRpc(client, LEDGER_POSTING_RPC, ARGS);
      assert.deepEqual(
        { status: (r as any).status, error: (r as any).error, rpc: (r as any).rpc },
        { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: LEDGER_POSTING_RPC },
      );
    }
  });

  const MISSING: Array<[string, any]> = [
    ["PostgREST PGRST202", { code: "PGRST202", message: "Could not find the function public.rb_post_booking_ledger(p_args, p_booking_id) in the schema cache" }],
    ["PostgreSQL 42883", { code: "42883", message: "function public.rb_post_booking_ledger(uuid, text) does not exist" }],
    ["the PostgREST message with no code", { message: "Could not find the function public.rb_post_booking_ledger" }],
    ["the PostgreSQL message with no code", { message: "function rb_post_booking_ledger(uuid, unknown) does not exist" }],
  ];
  for (const [name, error] of MISSING) {
    it(`${name} → unavailable / ledger_unavailable`, async () => {
      const r = await callMoneyRpc({ rpc: async () => ({ data: null, error }) }, LEDGER_POSTING_RPC, ARGS);
      assert.deepEqual([(r as any).status, (r as any).error], ["unavailable", LEDGER_UNAVAILABLE]);
    });
  }

  const FAILED: Array<[string, any]> = [
    ["a serialization failure", { code: "40001", message: "could not serialize access" }],
    ["a permission error", { code: "42501", message: "permission denied for function rb_post_booking_ledger" }],
    ["the function's own RAISE", { code: "22023", message: "rb_resolve_platform_fee_percent: fee_config_invalid — …" }],
    ["an error with no code and an unrelated message", { message: "upstream connect error" }],
    ["a relation that does not exist (NOT a missing function)", { code: "42P01", message: 'relation "rent_buddy_earnings_entries" does not exist' }],
  ];
  for (const [name, error] of FAILED) {
    it(`${name} → failed / ledger_write_failed`, async () => {
      const r = await callMoneyRpc({ rpc: async () => ({ data: null, error }) }, LEDGER_POSTING_RPC, ARGS);
      assert.deepEqual([(r as any).status, (r as any).error], ["failed", LEDGER_WRITE_FAILED]);
    });
  }

  it("a client that THROWS is `failed` — caught, not propagated, and not a cue for a second attempt", async () => {
    let calls = 0;
    const r = await callMoneyRpc({ rpc: async () => { calls++; throw new Error("socket hang up"); } }, LEDGER_POSTING_RPC, ARGS);
    assert.deepEqual([(r as any).status, (r as any).error, calls], ["failed", LEDGER_WRITE_FAILED, 1]);
  });

  it("an answer is passed through untouched", async () => {
    const data = { ok: true, anything: [1, 2, 3] };
    const seen: any[] = [];
    const r = await callMoneyRpc({ rpc: async (fn: string, a: any) => { seen.push([fn, a]); return { data, error: null }; } }, LEDGER_TOTALS_RPC, ARGS);
    assert.deepEqual(r, { ok: true, data });
    assert.deepEqual(seen, [[LEDGER_TOTALS_RPC, ARGS]]);
  });
});

describe("postBookingLedgerEvent — refusals, replays and what is read back", () => {
  it("refuses with no booking id, without calling", async () => {
    let calls = 0;
    const r = await postBookingLedgerEvent({ rpc: async () => { calls++; return { data: null, error: null }; } }, "", "booking_created");
    assert.deepEqual([r.status, (r as any).refusal, calls], ["refused", "booking_required", 0]);
  });

  it("sends exactly the four named parameters the SQL function declares", async () => {
    const seen: any[] = [];
    await postBookingLedgerEvent({ rpc: async (fn: string, a: any) => { seen.push([fn, a]); return { data: { ok: true, summary: {} }, error: null }; } }, "bk", "reversal", { args: { cause: "x" } });
    assert.deepEqual(seen, [[LEDGER_POSTING_RPC, { p_booking_id: "bk", p_event: "reversal", p_event_key: null, p_args: { cause: "x" } }]]);
  });

  it("`ok: false` is a refusal carrying the database's own name for it", async () => {
    const r = await postBookingLedgerEvent(
      { rpc: async () => ({ data: { ok: false, refusal: "booking_not_ledgerable", detail: "cancelled" }, error: null }) }, "bk", "booking_created",
    );
    assert.deepEqual(r, { status: "refused", refusal: "booking_not_ledgerable", detail: "cancelled" });
  });

  it("an empty or non-object answer is `failed` — never read as success", async () => {
    for (const data of [null, undefined, [], "ok", 1, true]) {
      const r = await postBookingLedgerEvent({ rpc: async () => ({ data, error: null }) }, "bk", "booking_created");
      assert.equal(r.status, "failed", `data=${JSON.stringify(data)}`);
    }
  });

  it("reads the summary back as the database computed it — numeric strings become numbers, nothing is recomputed", async () => {
    const r = await postBookingLedgerEvent({
      rpc: async () => ({
        // PostgREST may hand a jsonb function's value as the object or as a
        // one-element array, and numerics as strings.
        data: [{
          ok: true, event: "booking_created", replayed: false, entries_appended: "4", fee_percent: "10", fee_source: "owner_default",
          summary: {
            booking_id: "bk", total_booking_usd: "123.45", tip_usd: "0", platform_fee_percent: 10, platform_fee_amount: "12.35",
            traveler_service_fee_amount: "0", buddy_gross_amount: "123.45", buddy_net_estimated_amount: "111.10",
            in_app_amount_collected: "0", is_estimated: true,
          },
        }],
        error: null,
      }),
    }, "bk", "booking_created");
    assert.deepEqual(r, {
      status: "posted", event: "booking_created", replayed: false, entriesAppended: 4, feePercent: 10, feeSource: "owner_default",
      summary: {
        bookingId: "bk", totalBookingUsd: 123.45, tipUsd: 0, platformFeePercent: 10, platformFeeAmount: 12.35,
        travelerServiceFeeAmount: 0, buddyGrossAmount: 123.45, buddyNetEstimatedAmount: 111.1,
        inAppAmountCollected: 0, isEstimated: true,
      },
      addonsAdded: null, booking: null,
    });
  });

  it("`is_estimated` is false ONLY for an explicit false — a missing flag is still an estimate", async () => {
    for (const [flag, expected] of [[false, false], [true, true], [undefined, true], [null, true], ["false", true]] as const) {
      const r = await postBookingLedgerEvent(
        { rpc: async () => ({ data: { ok: true, summary: { booking_id: "bk", is_estimated: flag } }, error: null }) }, "bk", "booking_created",
      );
      assert.equal(r.status === "posted" && r.summary?.isEstimated, expected, `is_estimated=${String(flag)}`);
    }
  });

  it("a tip passes the amount through AS GIVEN — converting to minor units is the database's job", async () => {
    const seen: any[] = [];
    await postBookingTip(
      { rpc: async (_fn: string, a: any) => { seen.push(a); return { data: { ok: true, summary: {} }, error: null }; } },
      { bookingId: "bk", travelerId: "t", amountUsd: 12.345, eventKey: "k" },
    );
    assert.deepEqual(seen, [{ p_booking_id: "bk", p_event: "tip", p_event_key: "k", p_args: { traveler_id: "t", amount_usd: 12.345, note: null } }]);
  });
});

describe("the three readers and the transition — a malformed answer is a failure, not a default", () => {
  it("readBuddyLedgerTotals: no answer → failed; an absent function → unavailable; never zeros", async () => {
    const none = await readBuddyLedgerTotals({ rpc: async () => ({ data: null, error: null }) }, "u");
    assert.deepEqual([none.status, (none as any).error], ["failed", LEDGER_WRITE_FAILED]);
    const absent = await readBuddyLedgerTotals({ rpc: async (fn: string) => functionNotFound(fn) }, "u");
    assert.deepEqual([absent.status, (absent as any).error, (absent as any).rpc], ["unavailable", LEDGER_UNAVAILABLE, LEDGER_TOTALS_RPC]);
  });

  it("readBuddyLedgerTotals: `isEstimated` defaults to TRUE", async () => {
    const r = await readBuddyLedgerTotals({ rpc: async () => ({ data: { completedCount: "2", tipsTotalUsd: "3.50" }, error: null }) }, "u");
    assert.equal(r.status, "ok");
    assert.deepEqual(r.status === "ok" && [r.totals.completedCount, r.totals.tipsTotalUsd, r.totals.isEstimated, r.totals.inAppAmountCollectedUsd], [2, 3.5, true, 0]);
  });

  it("quoteBooking: an answer with no percentage, or an unknown source, is `failed` — never a guessed 10", async () => {
    for (const data of [null, [], { ok: true }, { ok: true, fee_percent: null, fee_source: "fee_schedule" }, { ok: true, fee_percent: 10, fee_source: "somewhere_else" }, { ok: true, fee_percent: "abc", fee_source: "owner_default" }]) {
      const r = await quoteBooking({ rpc: async () => ({ data, error: null }) }, { buddyProfileId: "bp" });
      assert.equal(r.status, "failed", JSON.stringify(data));
    }
    // Neither `ok` nor a NAMED refusal is malformed: a failure, not a permanent 4xx.
    for (const data of [{}, [{}], { ok: false }, { ok: false, refusal: "" }, { ok: "yes" }]) {
      const r = await quoteBooking({ rpc: async () => ({ data, error: null }) }, { buddyProfileId: "bp" });
      assert.equal(r.status, "failed", JSON.stringify(data));
    }
    const ok = await quoteBooking({ rpc: async () => ({ data: { ok: true, fee_percent: 0, fee_source: "launch_control", priced: false, deposit_enabled: false }, error: null }) }, { buddyProfileId: "bp" });
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.status === "ok" && [ok.quote.feePercent, ok.quote.feeSource, ok.quote.priced, ok.quote.totalUsd, ok.quote.depositEnabled], [0, "launch_control", false, null, false],
      "0 % is a rate, not a missing one; a rate-only quote carries no amount");
  });

  it("quoteBooking sends the buddy and NO market: the six parameters the SQL function declares", async () => {
    const seen: any[] = [];
    await quoteBooking({ rpc: async (fn: string, a: any) => { seen.push([fn, a]); return { data: { ok: false, refusal: "buddy_not_found", detail: "x" }, error: null }; } },
      { buddyProfileId: "bp", category: "city", unitPriceUsd: 20, quantity: 2, paymentMode: "deposit_plus_cash", depositPercent: 30 });
    assert.deepEqual(seen, [[BOOKING_QUOTE_RPC, {
      p_buddy_profile_id: "bp", p_category: "city", p_unit_price_usd: 20, p_quantity: 2, p_payment_mode: "deposit_plus_cash", p_deposit_percent: 30,
    }]]);
  });

  it("quoteBooking: `ok: false` is a refusal carrying the database's own name for it", async () => {
    const r = await quoteBooking({ rpc: async () => ({ data: { ok: false, refusal: "invalid_total", detail: "unit price -1 × quantity 1" }, error: null }) }, { buddyProfileId: "bp", unitPriceUsd: -1 });
    assert.deepEqual(r, { status: "refused", refusal: "invalid_total", detail: "unit price -1 × quantity 1" });
  });

  it("quoteBooking: a PRICED answer that is missing a money figure is `failed` — creation must not store a null total", async () => {
    const full = { ok: true, fee_percent: 10, fee_source: "owner_default", priced: true, total_usd: "40.00", fee_usd: "4.00", buddy_net_usd: "36.00", payment_mode: "full_in_app", deposit_enabled: false, deposit_percent: 0, deposit_usd: "0.00", cash_balance_usd: "0.00" };
    for (const missing of ["total_usd", "fee_usd", "deposit_usd", "cash_balance_usd"]) {
      const r = await quoteBooking({ rpc: async () => ({ data: { ...full, [missing]: null }, error: null }) }, { buddyProfileId: "bp", unitPriceUsd: 40 });
      assert.equal(r.status, "failed", missing);
    }
    const ok = await quoteBooking({ rpc: async () => ({ data: [full], error: null }) }, { buddyProfileId: "bp", unitPriceUsd: 40 });
    assert.deepEqual(ok.status === "ok" && [ok.quote.totalUsd, ok.quote.feeUsd, ok.quote.buddyNetUsd, ok.quote.depositUsd], [40, 4, 36, 0],
      "numeric strings are read as numbers; nothing is recomputed");
  });

  it("quotePricedBooking: a price or a quantity that is not a finite number is REFUSED here, without calling — JSON would send it as null, i.e. `rate only`", async () => {
    let calls = 0;
    const c = { rpc: async () => { calls++; return { data: null, error: null }; } };
    for (const [unitPriceUsd, quantity] of [[Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [20, Number.NaN], [20, Number.NEGATIVE_INFINITY], ["20" as any, 1], [undefined as any, 1]]) {
      const r = await quotePricedBooking(c, { buddyProfileId: "bp", unitPriceUsd, quantity });
      assert.deepEqual([r.status, (r as any).refusal], ["refused", "invalid_total"], `${String(unitPriceUsd)} × ${String(quantity)}`);
    }
    assert.equal(calls, 0);
  });

  it("quotePricedBooking: a rate-only answer to a priced question is `failed`", async () => {
    const r = await quotePricedBooking({ rpc: async () => ({ data: { ok: true, fee_percent: 10, fee_source: "owner_default", priced: false, deposit_enabled: false }, error: null }) }, { buddyProfileId: "bp", unitPriceUsd: 40 });
    assert.equal(r.status, "failed");
  });

  it("postBookingAddons: sends the traveller, the ids, the allowed statuses and the POLICY — no price, no sum", async () => {
    const seen: any[] = [];
    const r = await postBookingAddons(
      { rpc: async (_fn: string, a: any) => { seen.push(a); return { data: { ok: true, event: "addons", replayed: false, entries_appended: 4, addons_added: 2, booking: { total_usd: "150.00", addons_total_usd: "50.00", deposit_usd: "0", cash_balance_usd: "150.00", payment_mode: "deposit_plus_cash", added_usd: "50.00" }, summary: {} }, error: null }; } },
      { bookingId: "bk", travelerId: "t", addonIds: ["a1", "a2"], allowedStatuses: ["pending", "requested"], paymentMode: "deposit_plus_cash", depositPercent: 40, depositRule: "new_traveler", depositReason: "First-time traveler" },
    );
    assert.deepEqual(seen, [{ p_booking_id: "bk", p_event: "addons", p_event_key: null, p_args: {
      traveler_id: "t", addon_ids: ["a1", "a2"], allowed_statuses: ["pending", "requested"],
      payment_mode: "deposit_plus_cash", deposit_percent: 40, deposit_rule: "new_traveler", deposit_reason: "First-time traveler",
    } }]);
    assert.deepEqual(r, { status: "attached", addonsAdded: 2, replayed: false, entriesAppended: 4,
      booking: { totalUsd: 150, addonsTotalUsd: 50, depositUsd: 0, cashBalanceUsd: 150, paymentMode: "deposit_plus_cash", addedUsd: 50 } });
  });

  it("postBookingAddons: an `ok` answer WITHOUT the booking's new terms is `failed` — never a total of 0", async () => {
    const r = await postBookingAddons({ rpc: async () => ({ data: { ok: true, event: "addons", summary: {} }, error: null }) }, { bookingId: "bk", travelerId: "t", addonIds: ["a1"], allowedStatuses: ["pending"] });
    assert.deepEqual([r.status, (r as any).error], ["failed", LEDGER_WRITE_FAILED]);
  });

  it("transitionPayout: maps a refusal with the status the payout IS in; an empty answer is `failed`", async () => {
    const refused = await transitionPayout(
      { rpc: async () => ({ data: { ok: false, refusal: "conflict", detail: "Payout is released", current_status: "released" }, error: null }) },
      { payoutId: "p", action: "release", adminId: "a", reason: "r" },
    );
    assert.deepEqual(refused, { status: "refused", refusal: "conflict", detail: "Payout is released", currentStatus: "released" });
    const empty = await transitionPayout({ rpc: async () => ({ data: null, error: null }) }, { payoutId: "p", action: "hold", adminId: "a", reason: "r" });
    assert.equal(empty.status, "failed");
  });

  it("sendMoneyRpcFailure: 503, the named error, retryable — and not the database's detail", () => {
    const out: any = {};
    const res = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    sendMoneyRpcFailure(res, { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: BOOKING_QUOTE_RPC, detail: "secret schema text" }, "Try again.");
    assert.deepEqual(out, { status: 503, body: { error: "ledger_unavailable", retryable: true, rpc: BOOKING_QUOTE_RPC, message: "Try again." } });
  });
});

// ── A refusal is not an outage ───────────────────────────────────────────────

describe("a PERMANENT refusal is a 4xx with retryable:false — never a 503 a client retries for ever", () => {
  const capture = () => {
    const out: any = {};
    const res = { status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    return { res, out };
  };

  it("every named refusal maps to a 4xx", () => {
    const EXPECTED: Record<string, number> = {
      booking_not_found: 404, buddy_not_found: 404, not_traveler: 403,
      idempotency_key_reused: 409, booking_not_ledgerable: 409, booking_reversed: 409, booking_not_open: 409, booking_not_completed: 409,
      invalid_total: 422, invalid_amount: 422, invalid_arguments: 422, invalid_payment_mode: 422,
      event_key_required: 422, event_key_reserved: 422, no_valid_addons: 422, unknown_event: 422, "something-new": 422,
    };
    for (const [refusal, status] of Object.entries(EXPECTED)) {
      assert.equal(ledgerRefusalHttpStatus(refusal), status, refusal);
      assert.ok(status >= 400 && status < 500);
    }
  });

  it("sendLedgerRefusal: the named error, the database's refusal, retryable:false, and no detail", () => {
    const { res, out } = capture();
    sendLedgerRefusal(res, "buddy_not_found", "It cannot be done.");
    assert.deepEqual(out, { status: 404, body: { error: LEDGER_REFUSED, refusal: "buddy_not_found", retryable: false, message: "It cannot be done." } });
  });

  it("sendBookingQuoteFailure: a refusal is 4xx/false, an outage is 503/true, and each says nothing was created or charged", () => {
    const a = capture();
    sendBookingQuoteFailure(a.res, { status: "refused", refusal: "invalid_total", detail: "secret" });
    assert.deepEqual([a.out.status, a.out.body.error, a.out.body.refusal, a.out.body.retryable], [422, "ledger_refused", "invalid_total", false]);
    assert.match(a.out.body.message, /booking could not be priced.*not created.*Nothing was charged/);
    const b = capture();
    sendBookingQuoteFailure(b.res, { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: BOOKING_QUOTE_RPC, detail: "secret" }, "offer");
    assert.deepEqual([b.out.status, b.out.body.error, b.out.body.retryable], [503, "ledger_unavailable", true]);
    assert.match(b.out.body.message, /offer could not be priced/);
    assert.equal(JSON.stringify([a.out, b.out]).includes("secret"), false);
  });

  it("isPositiveMoneyAmount: a positive, finite number below 10^8 — and nothing else", () => {
    for (const ok of [0.01, 1, 200, 99_999_999.99]) assert.equal(isPositiveMoneyAmount(ok), true, String(ok));
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 100_000_000, 1e300, "5", null, undefined, {}, [5], true]) {
      assert.equal(isPositiveMoneyAmount(bad), false, String(bad));
    }
  });

  it("the reserved tip key is the one the SQL function carries a legacy tip under", () => {
    assert.equal(RESERVED_TIP_EVENT_KEY, "carried-over");
    const sql = readFileSync(join(SRC, "migrations/3824_rent_buddy_ledger_posting.sql"), "utf8");
    assert.ok(sql.includes("format('booking:%s:tip:carried-over', p_booking_id)"), "3824 no longer carries a legacy tip under this key");
    assert.ok(sql.includes("IF lower(v_key) = 'carried-over' THEN"), "3824 no longer refuses the reserved key");
  });

  it("depositColumns: OFF ⇒ 0 and `no_deposit`, whatever the policy said; ON ⇒ the quote's percentage and the policy's rule", () => {
    const base = { feePercent: 10, feeSource: "owner_default" as const, totalUsd: 40, feeUsd: 4, paymentMode: "deposit_plus_cash", depositPercent: 40, depositUsd: 16, cashBalanceUsd: 24 };
    const off = depositColumns({ ...base, depositEnabled: false, depositPercent: 0, depositUsd: 0, cashBalanceUsd: 40 }, { rule: "new_traveler", reason: "First-time traveler — 40% deposit" });
    assert.equal(off.deposit_percent, 0);
    assert.equal(off.deposit_rule_applied, "no_deposit");
    assert.match(off.deposit_reason ?? "", /No deposit is taken/);
    const on = depositColumns({ ...base, depositEnabled: true }, { rule: "new_traveler", reason: "First-time traveler — 40% deposit" });
    assert.deepEqual(on, { deposit_percent: 40, deposit_rule_applied: "new_traveler", deposit_reason: "First-time traveler — 40% deposit" });
  });
});

// ── The reader of the summary row ────────────────────────────────────────────

describe("toLedgerEntryView — what a buddy is shown for one ledger row", () => {
  const ROW = {
    id: "led-1", booking_id: "bk-1", pricing_type: "hourly", total_booking_usd: 100, addons_usd: 0, tip_usd: 0,
    platform_fee_percent: 10, platform_fee_amount: 10, traveler_service_fee_amount: 0, buddy_gross_amount: 100,
    buddy_net_estimated_amount: 90, deposit_amount: 100, in_app_amount_collected: 0, cash_balance_due: 0,
    cash_balance_confirmed: false, is_estimated: true, note: null, created_at: "2026-10-01T00:00:00Z",
  };

  // M6 / PAY-010 — the history of this assertion is the history of the defect.
  // FIRST it asserted `warning === undefined` for `is_estimated: false`, pinning
  // a branch that could never be taken: the only writer hard-coded
  // `is_estimated: true` and nothing cleared it. THEN it asserted the warning
  // was unconditional, which was the honest name for that state. Migration 3824
  // added the writer, so the branch is real, and the database test (S5) is the
  // one that PRODUCES `is_estimated = false`, through a scripted settlement.
  it("anything that is not an explicit `false` is still an estimate — a missing or null flag never reads as settled", () => {
    for (const v of [true, undefined, null, "false", 0, 1, ""]) {
      const view = toLedgerEntryView({ ...ROW, is_estimated: v });
      assert.equal(view.isEstimated, true, `is_estimated=${String(v)}`);
      assert.equal(view.warning, LEDGER_NOT_SETTLED_WARNING, `is_estimated=${String(v)}`);
    }
    const settled = toLedgerEntryView({ ...ROW, is_estimated: false });
    assert.deepEqual([settled.isEstimated, settled.warning], [false, null]);
  });

  it("says when a row no longer earns — a reversed booking — without exposing the free-text note", () => {
    assert.equal(toLedgerEntryView(ROW).reversed, false);
    assert.equal(toLedgerEntryView({ ...ROW, note: "anything an admin typed" }).reversed, false, "an arbitrary note is not a reversal");
    const reversed = toLedgerEntryView({
      ...ROW, total_booking_usd: 0, platform_fee_amount: 0, buddy_net_estimated_amount: 0,
      note: `${posting.LEDGER_REVERSED_NOTE_PREFIX}: booking cancelled_by_traveler.`,
    });
    assert.equal(reversed.reversed, true);
    assert.equal("note" in reversed, false, "the note column itself is still not part of the view");
  });

  it("reports what was COLLECTED separately from the booking's in-app term, and invents neither", () => {
    const v = toLedgerEntryView(ROW);
    assert.equal(v.inAppAmountCollected, 0, "the fold of settlement entries — nothing is collected");
    assert.equal(v.depositAmount, 100, "the booking's payment-mode term is passed through as stored, and is not a collection");
    assert.equal(toLedgerEntryView({ ...ROW, platform_fee_percent: undefined }).platformFeePercent, null,
      "a row with no recorded rate says so; the client must not be handed a default");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 + 3. Structure, read as text
// ═════════════════════════════════════════════════════════════════════════════

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "generated" || name === "test" || name === "migrations") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("the module moves no money and computes none", () => {
  const code = stripComments(readFileSync(join(SRC, "lib/rentBuddyLedgerPosting.ts"), "utf8"));

  it("exports NO way to post a settlement — the one event that records money arriving", () => {
    const names = Object.keys(posting);
    assert.deepEqual(names.filter((n) => /settle|capture|charge|payout(?!_)|refund/i.test(n) && n !== "transitionPayout" && n !== "PAYOUT_TRANSITION_RPC"), [],
      "a settlement poster belongs to the payment state machine (PAY-T09), with a provider behind it");
    assert.equal(/["'`]settlement["'`]/.test(code), false,
      "the string 'settlement' appears in the posting module's code — a route could be handed it");
  });

  it("no route or lib file passes the settlement event to the posting function", () => {
    const hits = walk(SRC)
      .filter((f) => /postBookingLedgerEvent\([^)]*["'`]settlement["'`]/s.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    assert.deepEqual(hits, []);
  });

  it("holds no arithmetic: no multiplication, division, rounding or subtraction of money (PAY-055)", () => {
    // Regex literals are the one place a `/` or `*` legitimately appears.
    const noRegex = code.replace(/\/(?![*/])(?:\\.|[^/\n\\])+\/[gimsuy]*/g, " ");
    for (const [what, re] of [
      ["Math.*", /\bMath\./],
      ["toFixed", /\.toFixed\(/],
      ["a multiplication", /[\w)\]]\s*\*\s*[\w(]/],
      ["a division", /[\w)\]]\s*\/\s*[\w(]/],
      ["parseFloat", /\bparseFloat\(/],
      ["a subtraction", /[\w)\]]\s+-\s+[\w(]/],
    ] as const) {
      assert.equal(re.test(noRegex), false, `lib/rentBuddyLedgerPosting.ts contains ${what}`);
    }
  });

  it("touches no table: every statement is an rpc()", () => {
    assert.equal(/\.from\(/.test(code), false);
    assert.equal((code.match(/client\.rpc\(/g) ?? []).length, 1, "exactly one place calls rpc(): callMoneyRpc");
  });
});

describe("no route reaches a money function except through the one door", () => {
  const MONEY_FUNCTIONS = [LEDGER_POSTING_RPC, LEDGER_TOTALS_RPC, BOOKING_QUOTE_RPC, PAYOUT_TRANSITION_RPC, CASH_CONFIRMATION_RPC];
  const files = walk(SRC);

  it("scans the routes and libs, so the scan is not vacuous", () => {
    assert.ok(files.length > 100, `found ${files.length} files`);
    assert.ok(files.some((f) => f.endsWith("routes/rentABuddyMarketplace.ts")));
  });

  for (const fn of MONEY_FUNCTIONS) {
    it(`"${fn}" is named as a string in lib/rentBuddyLedgerPosting.ts and nowhere else`, () => {
      const hits = files
        .filter((f) => new RegExp(`["'\`]${fn}["'\`]`).test(stripComments(readFileSync(f, "utf8"))))
        .map((f) => relative(SRC, f));
      assert.deepEqual(hits, ["lib/rentBuddyLedgerPosting.ts"],
        `${fn} is called by name outside the posting module — that call has its own error handling, and its own chance of a fallback`);
    });
  }

  it("the bare resolver and the internal helpers are called by NO route or lib: the quote is the one reader", () => {
    // rb_resolve_platform_fee_percent takes a country and a city as ARGUMENTS.
    // A JavaScript caller choosing them is how the quote and the posting came
    // to price for two different markets.
    for (const fn of ["rb_resolve_platform_fee_percent", "rb_booking_market", "rb_platform_fee_minor", "rb_booking_payment_terms"]) {
      const hits = files
        .filter((f) => new RegExp(`["'\`]${fn}["'\`]`).test(stripComments(readFileSync(f, "utf8"))))
        .map((f) => relative(SRC, f));
      assert.deepEqual(hits, [], `${fn} is called by name from JavaScript`);
    }
  });

  it("2330's rb_accumulate_booking_tip is called by nothing — it writes no ledger entry (PAY-014)", () => {
    const hits = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes("rb_accumulate_booking_tip")).map((f) => relative(SRC, f));
    assert.deepEqual(hits, []);
  });

  it("no route WRITES the summary, the entries or the tips table itself", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const t of ["rent_buddy_earnings_ledger", "rent_buddy_earnings_entries", "rent_buddy_tips"]) {
        const re = new RegExp(`\\.from\\(\\s*["']${t}["']\\s*\\)\\s*\\.(insert|upsert|update|delete)\\(`);
        if (re.test(src)) offenders.push(`${relative(SRC, f)} → ${t}`);
      }
    }
    assert.deepEqual(offenders, [],
      "a JavaScript write to a ledger table is a second writer beside rb_post_booking_ledger");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The commission quote and the override, on stored state
// ═════════════════════════════════════════════════════════════════════════════

const USER_TOKEN = "lp-user-token";
const ADMIN_TOKEN = "lp-admin-token";
const USER_ID = "lp-user-1";
const ADMIN_ID = "lp-admin-1";
const BUDDY_PROF = "lp-buddy-profile-1";
const BUDDY_USER = "lp-buddy-user";
const BUDDY_TOKEN = "lp-buddy-token";

interface World {
  db: FakeLedgerDb;
  flags: Record<string, boolean>;
  buddy: any | null;
  buddyReadError: any;
  launchControls: Record<string, any>;
  absent: string[];
  rpcCalls: Array<{ fn: string; args: any }>;
  accessLogs: any[];
  /** rent_buddy_requests by id. */
  requests: Record<string, any>;
  /** rent_buddy_offers, in insert order. */
  offers: any[];
  /** Table writes the routes issued themselves: [table, op]. */
  tableWrites: Array<[string, string]>;
  /** Set to make every rb_post_booking_ledger call error. */
  postingError: any;
}
let w: World;

function client(): any {
  function table(t: string) {
    const eqs: Array<[string, any]> = [];
    let op: "select" | "update" | "insert" = "select";
    let payload: any = null;
    let single = false;
    const eq = (c: string) => eqs.find(([k]) => k === c)?.[1];
    const b: any = {
      select() { return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      is(c: string, v: any) { eqs.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { single = true; return b; },
      single() { single = true; return b; },
      then(res: any, rej: any) { return Promise.resolve(b._resolve()).then(res, rej); },
      _resolve() {
        if (op === "insert") {
          w.tableWrites.push([t, "insert"]);
          if (t === "rent_buddy_admin_access_logs") w.accessLogs.push(payload);
          if (t === "rent_buddy_offers") {
            const row = { id: `offer-${w.offers.length + 1}`, ...payload };
            w.offers.push(row);
            return { data: single ? row : [row], error: null };
          }
          return { data: null, error: null };
        }
        if (op === "update") {
          w.tableWrites.push([t, "update"]);
          if (t === "rent_buddy_launch_controls") {
            const row = w.launchControls[eq("id")];
            if (row) Object.assign(row, payload);
          }
          return { data: null, error: null };
        }
        if (t === "rent_buddy_bookings") {
          let rows = Object.values(w.db.bookings);
          for (const [c, v] of eqs) rows = rows.filter((r: any) => r[c] === v);
          return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
        }
        if (t === "rent_buddy_requests") {
          const row = w.requests[eq("id")] ?? null;
          const hit = row && (eq("status") === undefined || row.status === eq("status")) ? row : null;
          return single ? { data: hit, error: null } : { data: hit ? [hit] : [], error: null };
        }
        if (t === "feature_flags") {
          const flag = eq("flag");
          const row = flag in w.flags ? { flag, enabled: w.flags[flag] } : null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        if (t === "profiles") {
          const id = eq("id");
          const row = { id, role: id === ADMIN_ID ? "admin" : "user", account_status: "active" };
          return single ? { data: row, error: null } : { data: [row], error: null };
        }
        if (t === "rent_buddy_profiles") {
          if (w.buddyReadError) return { data: null, error: w.buddyReadError };
          const row = w.buddy && (eq("id") === w.buddy.id || (eq("user_id") !== undefined && eq("user_id") === w.buddy.user_id)) ? w.buddy : null;
          return single ? { data: row, error: null } : { data: row ? [row] : [], error: null };
        }
        return single ? { data: null, error: null } : { data: [], error: null };
      },
    };
    return b;
  }
  return {
    from: (t: string) => table(t),
    rpc: async (fn: string, args: any) => {
      w.rpcCalls.push({ fn, args });
      if (w.postingError && fn === LEDGER_POSTING_RPC) return { data: null, error: w.postingError };
      // The override rows the resolver reads are the launch controls as stored.
      w.db.feeOverrides = Object.values(w.launchControls)
        .filter((r: any) => r.platform_fee_percent !== null && r.platform_fee_percent !== undefined)
        .map((r: any) => ({ country_code: r.country_code ?? null, city: r.city ?? null, category: r.category ?? null, platform_fee_percent: r.platform_fee_percent }));
      return fakeLedgerRpc(w.db, { absent: w.absent })(fn, args);
    },
    auth: {
      getUser: async (token: string) => {
        const id = token === USER_TOKEN ? USER_ID : token === ADMIN_TOKEN ? ADMIN_ID : token === BUDDY_TOKEN ? BUDDY_USER : null;
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

let server: http.Server;
let base: string;

function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, token = USER_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
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

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", marketplaceRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve, reject) => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close((err) => (err ? reject(err) : resolve()));
}));

beforeEach(() => {
  w = {
    // The buddy as the SQL functions see it (rb_booking_market): the profile row.
    db: emptyLedgerDb({ buddyProfiles: { [BUDDY_PROF]: { user_id: BUDDY_USER, buddy_level: "rising", country: "PH", city: "Cebu" } } }),
    flags: { rent_buddy_enabled: true },
    buddy: { id: BUDDY_PROF, user_id: BUDDY_USER, buddy_level: "rising", city: "Cebu", country: "PH", status: "active" },
    buddyReadError: null,
    launchControls: {
      "lc-ph": { id: "lc-ph", country_code: "PH", city: null, category: null, enabled: true, platform_fee_percent: null },
      "lc-ph-nightlife": { id: "lc-ph-nightlife", country_code: "PH", city: null, category: "nightlife", enabled: true, platform_fee_percent: null },
    },
    absent: [],
    rpcCalls: [],
    accessLogs: [],
    requests: {},
    offers: [],
    tableWrites: [],
    postingError: null,
  };
  const c = client();
  _setTestClient(c, true);
  _setTestServiceClient(c);
});

const QUOTE = `/api/rent-a-buddy/buddies/${BUDDY_PROF}/commission`;

describe("GET /rent-a-buddy/buddies/:buddyId/commission — the rate shown before checkout", () => {
  it("with nothing configured: the owner's 10 %, named as the default, on the pre-tax service price, from the buddy's earnings", async () => {
    const r = await call("GET", QUOTE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      platformFeePercent: 10,
      feeSource: "owner_default",
      basis: "pre_tax_service_price",
      deductedFrom: "buddy_earnings",
      tipCommissionPercent: 0,
      depositRequired: false,
      chargedInApp: false,
    });
  });

  it("the stored schedule row for the buddy's level applies while it exists — it is not overridden by the 10", async () => {
    w.db.feeRules = { new: 25, rising: 22, pro: 15, elite: 12, city_ambassador: 12 };   // the stored schedule
    const r = await call("GET", QUOTE);
    assert.deepEqual([r.body.platformFeePercent, r.body.feeSource], [22, "fee_schedule"]);
  });

  it("asks the database for the BUDDY, and sends NO market — not the client's, and not one of its own", async () => {
    await call("GET", `${QUOTE}?category=nightlife&countryCode=XX&city=Elsewhere&buddyLevel=elite`);
    const q = w.rpcCalls.filter((c) => c.fn === BOOKING_QUOTE_RPC);
    assert.equal(q.length, 1);
    assert.deepEqual(q[0]!.args, {
      p_buddy_profile_id: BUDDY_PROF, p_category: "nightlife", p_unit_price_usd: null, p_quantity: 1, p_payment_mode: null, p_deposit_percent: null,
    });
  });

  it("the quote is the SAME function the ledger prices with: a booking made now is ledgered at the quoted rate", async () => {
    w.db.feeRules = { rising: 22 };
    w.launchControls["lc-ph-nightlife"].platform_fee_percent = 9;
    const quoted = await call("GET", `${QUOTE}?category=nightlife`);
    assert.deepEqual([quoted.body.platformFeePercent, quoted.body.feeSource], [9, "launch_control"]);

    w.db.bookings["bk"] = { id: "bk", buddy_id: BUDDY_PROF, traveler_id: USER_ID, status: "requested", total_usd: 200, country_code: "PH", city: "Cebu", category: "nightlife" };
    const posted = await client().rpc(LEDGER_POSTING_RPC, { p_booking_id: "bk", p_event: "booking_created", p_event_key: null, p_args: {} });
    assert.equal(posted.data.fee_percent, quoted.body.platformFeePercent);
    assert.equal(w.db.ledger["bk"].platform_fee_amount, 18);
  });

  // THE TEST THAT FAILS IF THE SHOWN AND THE POSTED AMOUNT DIFFER (independent
  // verification of PR #603). The canonical route stores the request's `city`
  // on the booking; the posting used to resolve the commission for THAT city
  // while checkout resolved it for the buddy's profile city.
  it("ONE MARKET: for a booking whose own city and country are NOT the buddy's, the rate and the AMOUNT posted equal the rate and the amount quoted", async () => {
    w.db.feeRules = { rising: 22 };
    // Overrides exist for the place the REQUEST named (3 %) and for the buddy's own city (7 %).
    w.launchControls["lc-elsewhere"] = { id: "lc-elsewhere", country_code: "XX", city: "Elsewhere", category: null, enabled: true, platform_fee_percent: 3 };
    w.launchControls["lc-cebu"] = { id: "lc-cebu", country_code: "PH", city: "Cebu", category: null, enabled: true, platform_fee_percent: 7 };

    const shown = await call("GET", `${QUOTE}?category=city&city=Elsewhere&countryCode=XX`);
    assert.deepEqual([shown.body.platformFeePercent, shown.body.feeSource], [7, "launch_control"]);
    // What creation is told the booking costs and what the commission on it is:
    const priced = await quotePricedBooking(client(), { buddyProfileId: BUDDY_PROF, category: "city", unitPriceUsd: 33.33, quantity: 3 });
    assert.equal(priced.status, "ok");
    const quote = priced.status === "ok" ? priced.quote : null;
    assert.deepEqual([quote!.feePercent, quote!.totalUsd, quote!.feeUsd], [7, 99.99, 7]);

    // The booking as the canonical route stores it: the REQUEST's city and country.
    w.db.bookings["bk"] = { id: "bk", buddy_id: BUDDY_PROF, traveler_id: USER_ID, status: "requested", total_usd: quote!.totalUsd, country_code: "XX", city: "Elsewhere", category: "city" };
    const posted = await client().rpc(LEDGER_POSTING_RPC, { p_booking_id: "bk", p_event: "booking_created", p_event_key: null, p_args: {} });
    assert.equal(posted.data.ok, true, JSON.stringify(posted.data));
    assert.equal(posted.data.fee_percent, shown.body.platformFeePercent, "the rate posted is not the rate shown at checkout");
    assert.equal(w.db.ledger["bk"].platform_fee_percent, quote!.feePercent);
    assert.equal(w.db.ledger["bk"].platform_fee_amount, quote!.feeUsd, "the commission posted is not the commission quoted");
    assert.equal(w.db.ledger["bk"].total_booking_usd, quote!.totalUsd, "the gross posted is not the price quoted");
  });

  it("says whether a deposit applies from the ONE switch — off by default", async () => {
    assert.equal((await call("GET", QUOTE)).body.depositRequired, false);
    w.db.depositEnabled = true;
    assert.equal((await call("GET", QUOTE)).body.depositRequired, true);
  });

  it("a buddy the database cannot place is a 4xx `ledger_refused`, retryable:false — not a 503", async () => {
    w.db.buddyProfiles = {};
    const r = await call("GET", QUOTE);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual([r.body.error, r.body.refusal, r.body.retryable, r.body.platformFeePercent], ["ledger_refused", "buddy_not_found", false, undefined]);
  });

  it("a rate that cannot be read is a named 503 — the screen is given no percentage to show", async () => {
    w.absent = [BOOKING_QUOTE_RPC];
    const r = await call("GET", QUOTE);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.deepEqual([r.body.error, r.body.retryable, r.body.platformFeePercent], ["ledger_unavailable", true, undefined]);
  });

  it("an unknown or inactive buddy is a 404, a failed profile read is a 5xx — neither is quoted the default", async () => {
    w.buddy = { ...w.buddy, status: "suspended" };
    assert.equal((await call("GET", QUOTE)).status, 404);
    w.buddy = null;
    assert.equal((await call("GET", QUOTE)).status, 404);
    w.buddyReadError = { message: "connection reset" };
    const failed = await call("GET", QUOTE);
    assert.ok(failed.status >= 500, JSON.stringify(failed));
    assert.equal(failed.body.platformFeePercent, undefined);
    assert.deepEqual(w.rpcCalls, []);
  });

  it("is behind the master switch and requires a signed-in user", async () => {
    w.flags.rent_buddy_enabled = false;
    const off = await call("GET", QUOTE);
    assert.deepEqual([off.status, off.body.error], [403, "feature_disabled"]);
    w.flags.rent_buddy_enabled = true;
    assert.equal((await call("GET", QUOTE, undefined, "no-such-token")).status, 401);
  });
});

describe("the per-market, per-product override (admin launch controls)", () => {
  it("parsePlatformFeeOverride: absent / null / a whole 0..100 / everything else", () => {
    assert.deepEqual(parsePlatformFeeOverride(undefined), { provided: false, value: null, invalid: false });
    assert.deepEqual(parsePlatformFeeOverride(null), { provided: true, value: null, invalid: false });
    for (const ok of [0, 10, 100]) assert.deepEqual(parsePlatformFeeOverride(ok), { provided: true, value: ok, invalid: false });
    for (const bad of [-1, 101, 10.5, "10", Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      assert.equal(parsePlatformFeeOverride(bad).invalid, true, `${JSON.stringify(bad)} was accepted`);
    }
  });

  it("PATCH sets it, and the next quote for that market follows — configuration, not a deploy", async () => {
    const before_ = await call("GET", QUOTE);
    assert.equal(before_.body.feeSource, "owner_default");

    const patched = await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-ph", { platformFeePercent: 8 }, ADMIN_TOKEN);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(w.launchControls["lc-ph"].platform_fee_percent, 8, "the stored row");

    const after_ = await call("GET", QUOTE);
    assert.deepEqual([after_.body.platformFeePercent, after_.body.feeSource], [8, "launch_control"]);
  });

  it("PATCH null clears it; a PATCH that does not mention it leaves it alone", async () => {
    w.launchControls["lc-ph"].platform_fee_percent = 8;
    await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-ph", { notes: "unrelated" }, ADMIN_TOKEN);
    assert.equal(w.launchControls["lc-ph"].platform_fee_percent, 8);

    await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-ph", { platformFeePercent: null }, ADMIN_TOKEN);
    assert.equal(w.launchControls["lc-ph"].platform_fee_percent, null);
    assert.equal((await call("GET", QUOTE)).body.feeSource, "owner_default");
  });

  it("an invalid value is a 400 on PATCH and on POST, and nothing is stored or logged", async () => {
    for (const bad of [101, -1, 12.5, "12"]) {
      const patch = await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-ph", { platformFeePercent: bad, enabled: false }, ADMIN_TOKEN);
      assert.equal(patch.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(patch.body)}`);
      const post = await call("POST", "/api/rent-a-buddy/admin/launch-controls", { countryCode: "PH", platformFeePercent: bad }, ADMIN_TOKEN);
      assert.equal(post.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(post.body)}`);
    }
    assert.equal(w.launchControls["lc-ph"].platform_fee_percent, null);
    assert.equal(w.launchControls["lc-ph"].enabled, true, "the rest of a refused PATCH must not be applied either");
    assert.deepEqual(w.accessLogs, []);
  });

  it("only an admin may set it", async () => {
    const r = await call("PATCH", "/api/rent-a-buddy/admin/launch-controls/lc-ph", { platformFeePercent: 0 }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(w.launchControls["lc-ph"].platform_fee_percent, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Add-ons are ONE ledger event; an offer's terms are the database's
// ═════════════════════════════════════════════════════════════════════════════

const BOOKING = "0b0b0b0b-0000-4000-8000-000000000001";
const ADDON_A = "a0a0a0a0-0000-4000-8000-00000000000a";
const ADDON_B = "a0a0a0a0-0000-4000-8000-00000000000b";
const ADDON_OFF = "a0a0a0a0-0000-4000-8000-00000000000c";
const ADDONS = `/api/rent-a-buddy/bookings/${BOOKING}/addons`;

function seedAddonWorld(over: Record<string, unknown> = {}) {
  w.db.bookings[BOOKING] = {
    id: BOOKING, buddy_id: BUDDY_PROF, traveler_id: USER_ID, status: "requested", total_usd: 100, addons_total_usd: 0,
    deposit_usd: 0, cash_balance_usd: 0, payment_mode: "full_in_app", category: "city", city: "Elsewhere", pricing_type: "hourly", ...over,
  };
  w.db.addons = {
    [ADDON_A]: { id: ADDON_A, title: "Airport pickup", price_usd: 50, is_active: true },
    [ADDON_B]: { id: ADDON_B, title: "Photo set", price_usd: 0.1, is_active: true },
    [ADDON_OFF]: { id: ADDON_OFF, title: "Retired", price_usd: 999, is_active: false },
  };
  // The deposit POLICY (calculateDeposit) keeps a booking full-in-app when the
  // buddy does not take a cash balance — so these cases are about the money, not
  // about the policy re-choosing the payment mode.
  w.buddy = { ...w.buddy, cash_balance_accepted: false };
}
const foldOf = (reason: string, account: string) => w.db.entries
  .filter((e) => e.booking_id === BOOKING && e.account === account && (e.entry_reason === reason))
  .reduce((n, e) => n + e.amount_minor, 0);
const ledgerBooking = () => client().rpc(LEDGER_POSTING_RPC, { p_booking_id: BOOKING, p_event: "booking_created", p_event_key: null, p_args: {} });

describe("POST /rent-a-buddy/bookings/:bookingId/addons — add-ons are priced INTO the ledger", () => {
  // The defect (independent verification of PR #603): total 100 → 150, the
  // re-post was a replay, gross stayed 100 — commission and the buddy's
  // earnings excluded every add-on.
  it("100 + a 50 add-on: the booking is 150 and the ledger's fold is 150 — gross, commission and net all include the add-on", async () => {
    seedAddonWorld();
    await ledgerBooking();
    assert.equal(w.db.ledger[BOOKING].total_booking_usd, 100);
    w.rpcCalls = []; w.tableWrites = [];

    const r = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, newTotal: 150, depositUsd: 0, cashBalanceDue: 0, addonsAdded: 1 });

    const b = w.db.bookings[BOOKING];
    assert.deepEqual([b.total_usd, b.addons_total_usd], [150, 50]);
    const l = w.db.ledger[BOOKING];
    assert.equal(l.total_booking_usd, 150, "the ledger's gross did not follow the booking's total");
    assert.equal(l.platform_fee_amount, 15, "the commission applies to the pre-tax service price INCLUDING add-ons: 10 % of 150");
    assert.equal(l.buddy_net_estimated_amount, 135);
    assert.equal(foldOf("booking_gross", "buddy_payable"), 15000);
    assert.equal(foldOf("platform_fee", "platform_revenue"), 1500);
    assert.equal(w.db.entries.filter((e) => e.booking_id === BOOKING).reduce((n, e) => n + e.amount_minor, 0), 0, "the entries no longer balance");

    // The ROUTE wrote no money table and summed nothing: one function call.
    assert.deepEqual(w.rpcCalls.filter((c) => c.fn === LEDGER_POSTING_RPC).map((c) => c.args.p_event), ["addons"]);
    assert.deepEqual(w.tableWrites.filter(([t]) => ["rent_buddy_bookings", "rent_buddy_booking_addons", "rent_buddy_earnings_ledger", "rent_buddy_earnings_entries"].includes(t)), []);
    assert.deepEqual(w.db.bookingAddons, [{ booking_id: BOOKING, addon_id: ADDON_A, title: "Airport pickup", price_usd: 50 }]);
  });

  it("a retry, or a double-tap, attaches and charges NOTHING twice (idempotent by state)", async () => {
    seedAddonWorld();
    await ledgerBooking();
    const [a, b] = await Promise.all([call("POST", ADDONS, { addonIds: [ADDON_A] }), call("POST", ADDONS, { addonIds: [ADDON_A] })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const again = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual(again.body, { ok: true, alreadyAttached: true, totalUsd: 150, depositUsd: 0, cashBalanceUsd: 0 });
    assert.equal([a.body, b.body].filter((x) => x.alreadyAttached).length, 1, "exactly one of two concurrent attaches did the attaching");
    assert.equal(w.db.bookings[BOOKING].total_usd, 150, "an add-on was priced in twice");
    assert.equal(w.db.bookingAddons!.length, 1);
    assert.equal(w.db.ledger[BOOKING].total_booking_usd, 150);
    assert.equal(w.db.ledger[BOOKING].platform_fee_amount, 15);
  });

  it("a second, different add-on is a second adjustment; the fee is round(total × rate), not a sum of roundings", async () => {
    seedAddonWorld({ total_usd: 33.33 });
    w.db.feeRules = { rising: 15 };
    await ledgerBooking();                                    // 15 % of 33.33 = 5.00 (4.9995)
    await call("POST", ADDONS, { addonIds: [ADDON_B] });      // + 0.10 → 33.43 → 5.01 (5.0145)
    await call("POST", ADDONS, { addonIds: [ADDON_A, ADDON_B] }); // + 50 → 83.43 → 12.51 (12.5145)
    const l = w.db.ledger[BOOKING];
    assert.deepEqual([w.db.bookings[BOOKING].total_usd, l.total_booking_usd, l.platform_fee_amount, l.buddy_net_estimated_amount], [83.43, 83.43, 12.51, 70.92]);
    assert.equal(l.platform_fee_percent, 15);
  });

  it("the booking keeps the RATE it was ledgered at, whatever the configuration is when the add-on arrives", async () => {
    seedAddonWorld();
    w.db.feeRules = { rising: 20 };
    await ledgerBooking();                                    // 20 % of 100
    w.db.feeRules = { rising: 5 };                            // the operator changes the schedule
    await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual([w.db.ledger[BOOKING].platform_fee_percent, w.db.ledger[BOOKING].platform_fee_amount], [20, 30]);
  });

  it("a booking that was never ledgered is ledgered NOW, at its new total", async () => {
    seedAddonWorld();
    const r = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([w.db.ledger[BOOKING].total_booking_usd, w.db.ledger[BOOKING].platform_fee_amount], [150, 15]);
  });

  it("no deposit is computed while the switch is off: a deposit_plus_cash booking's cash balance is the whole new total", async () => {
    seedAddonWorld({ payment_mode: "deposit_plus_cash", cash_balance_usd: 100 });
    w.buddy = { ...w.buddy, disable_deposit_cash: false, cash_balance_accepted: true };
    await ledgerBooking();
    const r = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual([r.body.newTotal, r.body.depositUsd, r.body.cashBalanceDue], [150, 0, 150]);
    const b = w.db.bookings[BOOKING];
    assert.deepEqual([b.deposit_usd, b.cash_balance_usd, b.deposit_percent, b.deposit_rule_applied], [0, 150, 0, "no_deposit"]);
  });

  it("the route sends POLICY and ids — never a price, a sum or a total", async () => {
    seedAddonWorld();
    await call("POST", ADDONS, { addonIds: [ADDON_A], newTotal: 1, totalUsd: 1, priceUsd: 1 });
    const sent = w.rpcCalls.find((c) => c.fn === LEDGER_POSTING_RPC && c.args.p_event === "addons")!.args.p_args;
    assert.deepEqual(Object.keys(sent).sort(), ["addon_ids", "allowed_statuses", "deposit_percent", "deposit_reason", "deposit_rule", "payment_mode", "traveler_id"]);
    assert.equal(sent.traveler_id, USER_ID, "the AUTHENTICATED user, not one from the body");
    assert.equal(w.db.bookings[BOOKING].total_usd, 150);
  });

  it("refusals keep the statuses this route has always had, and change nothing", async () => {
    seedAddonWorld();
    await ledgerBooking();
    const before_ = JSON.stringify([w.db.bookings[BOOKING], w.db.entries, w.db.bookingAddons]);
    const cases: Array<[any, number, string]> = [
      [{ addonIds: [] }, 400, "invalid_payload"],
      [{}, 400, "invalid_payload"],
      [{ addonIds: [ADDON_OFF] }, 400, "invalid_payload"],                       // inactive
      [{ addonIds: ["a0a0a0a0-0000-4000-8000-0000000000ff"] }, 400, "invalid_payload"],   // unknown
      [{ addonIds: ["not-a-uuid"] }, 400, "invalid_payload"],                    // was a 503 from a failed cast
    ];
    for (const [body, status, error] of cases) {
      const r = await call("POST", ADDONS, body);
      assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify([body, r.body]));
    }
    w.db.bookings[BOOKING].status = "in_progress";
    assert.equal((await call("POST", ADDONS, { addonIds: [ADDON_A] })).status, 400);
    w.db.bookings[BOOKING].status = "requested";
    w.db.bookings[BOOKING].traveler_id = "someone-else";
    assert.equal((await call("POST", ADDONS, { addonIds: [ADDON_A] })).status, 403);
    w.db.bookings[BOOKING].traveler_id = USER_ID;
    assert.equal(JSON.stringify([w.db.bookings[BOOKING], w.db.entries, w.db.bookingAddons]), before_);
  });

  it("with 3824 not applied, or the call failing: 503 by NAME, and nothing is attached or priced a second way", async () => {
    seedAddonWorld();
    w.absent = [LEDGER_POSTING_RPC];
    const absent = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual([absent.status, absent.body.error, absent.body.retryable], [503, "ledger_unavailable", true]);
    w.absent = [];
    w.postingError = { code: "40001", message: "could not serialize access" };
    const failed = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual([failed.status, failed.body.error], [503, "ledger_write_failed"]);
    assert.match(failed.body.message, /Nothing was changed or charged/);
    assert.equal(w.db.bookings[BOOKING].total_usd, 100);
    assert.deepEqual(w.db.bookingAddons, []);
    assert.deepEqual(w.tableWrites.filter(([t]) => t.startsWith("rent_buddy_booking")), []);
  });

  it("a permanent refusal (the booking has no payee) is a 4xx `ledger_refused`, retryable:false", async () => {
    seedAddonWorld();
    w.db.buddyProfiles = {};
    const r = await call("POST", ADDONS, { addonIds: [ADDON_A] });
    assert.deepEqual([r.status, r.body.error, r.body.refusal, r.body.retryable], [404, "ledger_refused", "buddy_not_found", false]);
  });
});

describe("POST /rent-a-buddy/requests/:requestId/offers — an offer's deposit is not the client's to name", () => {
  const REQUEST = "lp-request-1";
  const OFFERS = `/api/rent-a-buddy/requests/${REQUEST}/offers`;
  beforeEach(() => {
    w.requests[REQUEST] = { id: REQUEST, status: "open", traveler_id: USER_ID, city: "Elsewhere", category: "city" };
  });

  it("stores NO deposit, whatever the client sends; a deposit_plus_cash offer's cash balance is the whole price", async () => {
    const r = await call("POST", OFFERS, { proposedPriceUsd: 80, depositAmountUsd: 55, cashBalanceDue: 1, paymentMode: "deposit_plus_cash" }, BUDDY_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([w.offers[0].proposed_price_usd, w.offers[0].deposit_amount_usd, w.offers[0].cash_balance_usd, w.offers[0].payment_mode], [80, 0, 80, "deposit_plus_cash"]);
    assert.deepEqual([r.body.offer.depositAmountUsd, r.body.offer.cashBalanceUsd], [0, 80]);
    const q = w.rpcCalls.filter((c) => c.fn === BOOKING_QUOTE_RPC);
    assert.equal(q.length, 1);
    assert.deepEqual([q[0]!.args.p_buddy_profile_id, q[0]!.args.p_unit_price_usd, q[0]!.args.p_quantity], [BUDDY_PROF, 80, 1]);
  });

  it("full_in_app: no deposit and no cash balance", async () => {
    await call("POST", OFFERS, { proposedPriceUsd: 80 }, BUDDY_TOKEN);
    assert.deepEqual([w.offers[0].deposit_amount_usd, w.offers[0].cash_balance_usd, w.offers[0].payment_mode], [0, 0, "full_in_app"]);
  });

  it("with the owner's switch ON the split is the DATABASE's, in whole cents — still not the client's", async () => {
    w.db.depositEnabled = true;
    await call("POST", OFFERS, { proposedPriceUsd: 33.33, depositAmountUsd: 1, cashBalanceDue: 1, paymentMode: "deposit_plus_cash" }, BUDDY_TOKEN);
    assert.deepEqual([w.offers[0].deposit_amount_usd, w.offers[0].cash_balance_usd], [10, 23.33], "30 % of 33.33 is 9.999 → 10.00; the rest is cash");
  });

  it("a price that is not a price is a 4xx, and no offer is stored", async () => {
    for (const proposedPriceUsd of [-5, "abc", 100_000_000, "Infinity"]) {
      const r = await call("POST", OFFERS, { proposedPriceUsd }, BUDDY_TOKEN);
      assert.ok(r.status >= 400 && r.status < 500, `${String(proposedPriceUsd)} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.retryable ?? false, false);
    }
    const mode = await call("POST", OFFERS, { proposedPriceUsd: 80, paymentMode: "barter" }, BUDDY_TOKEN);
    assert.deepEqual([mode.status, mode.body.refusal], [422, "invalid_payment_mode"]);
    assert.deepEqual(w.offers, []);
  });

  it("with 3824 not applied the offer is refused by NAME (503), not stored with a client-computed split", async () => {
    w.absent = [BOOKING_QUOTE_RPC];
    const r = await call("POST", OFFERS, { proposedPriceUsd: 80, depositAmountUsd: 55 }, BUDDY_TOKEN);
    assert.deepEqual([r.status, r.body.error, r.body.retryable], [503, "ledger_unavailable", true]);
    assert.match(r.body.message, /offer could not be priced/);
    assert.deepEqual(w.offers, []);
  });
});
