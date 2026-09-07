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
 *   1. The percentage comes from `rent_buddy_fee_rules` keyed on THIS buddy's
 *      level — not from a ledger row, not from a literal.
 *   2. A level with no fee row is a 409, not a silent 22 %.
 *   3. An unreadable fee table is a 500, not a silent 22 %.
 *   4. Those two failures are distinguishable from each other.
 *
 * The third and fourth are the M10 lesson: the absence of a row must never be
 * indistinguishable from a deliberate value.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyEarningsSummaryFeeSource.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";

const USER_TOKEN = "earnings-fee-source-token";
const USER_ID = "earnings-fee-source-user";
const BUDDY_PROFILE_ID = "earnings-fee-source-profile";

/** Per-test knobs the fake service client reads. */
let feeRuleRow: any = null;
let feeRuleError: any = null;
let buddyLevel: string | null = "pro";
/** Completed bookings the buddy has. One 200.00 booking keeps the arithmetic legible. */
let bookings: any[] = [];

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

function feeRuleBuilder(): any {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: () => Promise.resolve({ data: feeRuleRow, error: feeRuleError }),
    then: (resolve: (r: any) => any) =>
      Promise.resolve({ data: feeRuleRow ? [feeRuleRow] : [], error: feeRuleError }).then(resolve),
  };
  return b;
}

function serviceClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from(table: string) {
      switch (table) {
        case "rent_buddy_profiles":
          return builder({
            id: BUDDY_PROFILE_ID,
            user_id: USER_ID,
            status: "active",
            buddy_level: buddyLevel,
            profile_views: 4, search_appearances: 9, repeat_client_count: 1,
            city_ranking: null, average_rating: 4.8, review_count: 3,
          });
        case "rent_buddy_fee_rules":
          return feeRuleBuilder();
        case "rent_buddy_bookings":
          return builder(null, bookings);
        case "rent_buddy_tips":
          return builder(null, []);
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

beforeEach(() => {
  feeRuleRow = null;
  feeRuleError = null;
  buddyLevel = "pro";
  bookings = [{
    id: "bk-1", status: "completed", total_usd: 200, deposit_usd: 60,
    cash_balance_usd: 140, cash_balance_confirmed_by_buddy: false,
    booking_date: "2026-01-01", category: "city", city: "Cebu",
    duration_h: 4, tip_usd: 0, pricing_type: "hourly",
  }];
});

const SUMMARY = "/api/rent-a-buddy/me/earnings/summary";

describe("the fee percentage comes from the schedule of record", () => {
  it("prices from the buddy's OWN level, and publishes which rate applied", async () => {
    buddyLevel = "pro";
    feeRuleRow = { buddy_level: "pro", platform_fee_percent: 15, traveler_service_fee_usd: 0, traveler_service_fee_pct: 5 };

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.buddyLevel, "pro");
    assert.equal(res.body.platformFeePercent, 15);
    assert.equal(res.body.estimatedPlatformFeeUsd, 30);   // 15 % of 200
    assert.equal(res.body.estimatedBuddyEarningsUsd, 170);
  });

  it("follows the schedule when the operator changes it — no deploy, no literal", async () => {
    buddyLevel = "new";
    feeRuleRow = { buddy_level: "new", platform_fee_percent: 25, traveler_service_fee_usd: 0, traveler_service_fee_pct: 5 };

    const res = await get(SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePercent, 25);
    assert.equal(res.body.estimatedPlatformFeeUsd, 50);
    assert.notEqual(res.body.platformFeePercent, 22, "22 was the deleted dashboard literal");
    assert.notEqual(res.body.platformFeePercent, 15, "15 was the deleted earnings-summary literal");
  });
});

describe("an unconfigured take rate is refused, not guessed", () => {
  it("409s when the buddy's level has no fee row", async () => {
    // 'standard' is settable by the admin level route and has no schedule row.
    buddyLevel = "standard";
    feeRuleRow = null;

    const res = await get(SUMMARY);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "conflict");
    assert.equal(
      res.body.estimatedPlatformFeeUsd, undefined,
      "no fee figure may be published when no fee is configured",
    );
  });

  it("500s when the fee table cannot be read", async () => {
    feeRuleError = { message: "permission denied for table rent_buddy_fee_rules" };

    const res = await get(SUMMARY);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error");
  });

  it("the two failures are distinguishable — that is the whole point", async () => {
    buddyLevel = "standard";
    feeRuleRow = null;
    const absent = await get(SUMMARY);

    feeRuleRow = null;
    feeRuleError = { message: "connection reset" };
    const unreadable = await get(SUMMARY);

    assert.notEqual(
      absent.status, unreadable.status,
      "'no such level' and 'could not read the table' must not collapse into one answer — " +
      "collapsing them is how a missing row became a deliberate 22 %",
    );
  });

  it("does not leak the schedule's table name to the client", async () => {
    feeRuleError = { message: "permission denied for table rent_buddy_fee_rules" };
    const res = await get(SUMMARY);
    assert.equal(String(res.body.message ?? "").includes("rent_buddy_fee_rules"), false);

    buddyLevel = "standard";
    feeRuleError = null;
    const conflict = await get(SUMMARY);
    assert.equal(String(conflict.body.message ?? "").includes("rent_buddy_fee_rules"), false);
  });
});
