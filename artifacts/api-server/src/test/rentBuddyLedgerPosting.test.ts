/**
 * lib/rentBuddyLedgerPosting.ts — the API's one door to the Rent-a-Buddy money
 * record — and the two routes that exist only because of it:
 *
 *   GET   /rent-a-buddy/buddies/:buddyId/commission     the rate shown before checkout
 *   POST / PATCH /rent-a-buddy/admin/launch-controls    the per-market, per-product override
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
 *   4. the commission quote and the override routes, on stored state.
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
  CASH_CONFIRMATION_RPC,
  LEDGER_POSTING_RPC,
  LEDGER_TOTALS_RPC,
  LEDGER_UNAVAILABLE,
  LEDGER_WRITE_FAILED,
  PAYOUT_TRANSITION_RPC,
  PLATFORM_FEE_RPC,
  callMoneyRpc,
  postBookingLedgerEvent,
  postBookingTip,
  readBuddyLedgerTotals,
  resolvePlatformFeePercent,
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

  it("resolvePlatformFeePercent: a row with no percentage, or an unknown source, is `failed` — never a guessed 10", async () => {
    for (const data of [[], [{}], [{ fee_percent: null, fee_source: "fee_schedule" }], [{ fee_percent: 10, fee_source: "somewhere_else" }], [{ fee_percent: "abc", fee_source: "owner_default" }]]) {
      const r = await resolvePlatformFeePercent({ rpc: async () => ({ data, error: null }) }, { buddyLevel: "new" });
      assert.equal(r.status, "failed", JSON.stringify(data));
    }
    const ok = await resolvePlatformFeePercent({ rpc: async () => ({ data: [{ fee_percent: 0, fee_source: "launch_control" }], error: null }) }, {});
    assert.deepEqual(ok, { status: "ok", feePercent: 0, feeSource: "launch_control" }, "0 % is a rate, not a missing one");
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
    sendMoneyRpcFailure(res, { status: "unavailable", error: LEDGER_UNAVAILABLE, rpc: PLATFORM_FEE_RPC, detail: "secret schema text" }, "Try again.");
    assert.deepEqual(out, { status: 503, body: { error: "ledger_unavailable", retryable: true, rpc: PLATFORM_FEE_RPC, message: "Try again." } });
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
  const MONEY_FUNCTIONS = [LEDGER_POSTING_RPC, LEDGER_TOTALS_RPC, PLATFORM_FEE_RPC, PAYOUT_TRANSITION_RPC, CASH_CONFIRMATION_RPC];
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

interface World {
  db: FakeLedgerDb;
  flags: Record<string, boolean>;
  buddy: any | null;
  buddyReadError: any;
  launchControls: Record<string, any>;
  absent: string[];
  rpcCalls: Array<{ fn: string; args: any }>;
  accessLogs: any[];
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
          if (t === "rent_buddy_admin_access_logs") w.accessLogs.push(payload);
          return { data: null, error: null };
        }
        if (op === "update") {
          if (t === "rent_buddy_launch_controls") {
            const row = w.launchControls[eq("id")];
            if (row) Object.assign(row, payload);
          }
          return { data: null, error: null };
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
          const row = w.buddy && eq("id") === w.buddy.id ? w.buddy : null;
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
      // The override rows the resolver reads are the launch controls as stored.
      w.db.feeOverrides = Object.values(w.launchControls)
        .filter((r: any) => r.platform_fee_percent !== null && r.platform_fee_percent !== undefined)
        .map((r: any) => ({ country_code: r.country_code ?? null, city: r.city ?? null, category: r.category ?? null, platform_fee_percent: r.platform_fee_percent }));
      return fakeLedgerRpc(w.db, { absent: w.absent })(fn, args);
    },
    auth: {
      getUser: async (token: string) => {
        const id = token === USER_TOKEN ? USER_ID : token === ADMIN_TOKEN ? ADMIN_ID : null;
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
    db: emptyLedgerDb(),
    flags: { rent_buddy_enabled: true },
    buddy: { id: BUDDY_PROF, buddy_level: "rising", city: "Cebu", country: "PH", status: "active" },
    buddyReadError: null,
    launchControls: {
      "lc-ph": { id: "lc-ph", country_code: "PH", city: null, category: null, enabled: true, platform_fee_percent: null },
      "lc-ph-nightlife": { id: "lc-ph-nightlife", country_code: "PH", city: null, category: "nightlife", enabled: true, platform_fee_percent: null },
    },
    absent: [],
    rpcCalls: [],
    accessLogs: [],
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

  it("asks the database, for the BUDDY's market — never one the client sends", async () => {
    await call("GET", `${QUOTE}?category=nightlife&countryCode=XX&city=Elsewhere&buddyLevel=elite`);
    const q = w.rpcCalls.filter((c) => c.fn === PLATFORM_FEE_RPC);
    assert.equal(q.length, 1);
    assert.deepEqual(q[0]!.args, { p_buddy_level: "rising", p_country_code: "PH", p_city: "Cebu", p_category: "nightlife" });
  });

  it("the quote is the SAME function the ledger prices with: a booking made now is ledgered at the quoted rate", async () => {
    w.db.feeRules = { rising: 22 };
    w.launchControls["lc-ph-nightlife"].platform_fee_percent = 9;
    const quoted = await call("GET", `${QUOTE}?category=nightlife`);
    assert.deepEqual([quoted.body.platformFeePercent, quoted.body.feeSource], [9, "launch_control"]);

    w.db.buddyProfiles[BUDDY_PROF] = { user_id: "lp-buddy-user", buddy_level: "rising", country: "PH" };
    w.db.bookings["bk"] = { id: "bk", buddy_id: BUDDY_PROF, traveler_id: USER_ID, status: "requested", total_usd: 200, country_code: "PH", city: "Cebu", category: "nightlife" };
    const posted = await client().rpc(LEDGER_POSTING_RPC, { p_booking_id: "bk", p_event: "booking_created", p_event_key: null, p_args: {} });
    assert.equal(posted.data.fee_percent, quoted.body.platformFeePercent);
    assert.equal(w.db.ledger["bk"].platform_fee_amount, 18);
  });

  it("a rate that cannot be read is a named 503 — the screen is given no percentage to show", async () => {
    w.absent = [PLATFORM_FEE_RPC];
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
