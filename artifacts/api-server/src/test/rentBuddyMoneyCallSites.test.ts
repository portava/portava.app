/**
 * rentBuddyMoneyCallSites.test.ts
 *
 * The three Stage 1B money repairs that live in a ROUTE rather than in a
 * primitive (docs/architecture/12_Claude_Code_Implementation.md §4). Each of
 * the primitives already exists and is unit-tested; what was missing was the
 * call site actually using it, which is the difference between a correct
 * helper and a correct answer on a buddy's screen.
 *
 *   M1  GET /rent-a-buddy/dashboard/earnings/summary applied a level-blind
 *       0.15 to every buddy. The production schedule is
 *       new 25 / rising 22 / pro 15 / elite 12 / city_ambassador 12, so a `pro`
 *       buddy saw a correct number BY COINCIDENCE and everyone else saw a wrong
 *       one. The rate now comes from resolveFeeSchedule, and its two failure
 *       states refuse instead of falling through to a number.
 *
 *   M8  POST /rent-a-buddy/bookings/:id/tip performed three unrelated writes:
 *       an upsert on conflict target `booking_id` (rent_buddy_tips is UNIQUE on
 *       it, so a second tip REPLACED the first) plus two best-effort UPDATEs
 *       carrying the single amount rather than the running total. It now makes
 *       ONE call to accumulateBookingTip, and a tip that cannot be applied
 *       FAILS THE REQUEST — a silently dropped money write reported as
 *       `{ ok: true }` is the whole defect.
 *
 *       Payments PAY-014 / PAY-018 (migration 3824): that one call now posts
 *       ledger ENTRIES through rb_post_booking_ledger, and it has no fallback.
 *       The "non-atomic fallback path" half of this suite is therefore inverted
 *       — with the function absent the tip is a 503 `ledger_unavailable` and
 *       the route issues no table write — and cases are added for the event
 *       key and for "no commission on tips".
 *
 *   M7  GET /rent-a-buddy/me/earnings/summary summed an unpaginated select of
 *       bookings AND an unpaginated select of tips in JavaScript, and turned a
 *       failed read into `[]` — so a buddy past PostgREST's row cap was shown a
 *       silently short total, and an outage was shown a confident $0.
 *
 *       Payments PAY-055 / PAY-009: the money is folded in SQL now
 *       (rb_buddy_ledger_totals), where no row cap exists, so the JavaScript
 *       sum this suite guarded is gone. What is asserted is that the figures
 *       are the database's, that the LIST read the screen still makes is
 *       exhaustive, and that a fold that cannot be read is a named 503.
 *
 * ── HOW EACH CASE IS KEPT FROM BEING VACUOUS ────────────────────────────────
 * .agents/memory/prove-the-test-fails-before-trusting-it.md. Every assertion
 * here is chosen so that the PRE-FIX code produces a different, specific,
 * checkable answer — not merely "some error":
 *
 *   • M1 drives a `new` (25 %) and an `elite` (12 %) buddy, never a `pro` one,
 *     because 15 % is the deleted literal and a `pro` buddy cannot tell the two
 *     implementations apart. It also asserts on the ARGUMENT handed to the SQL
 *     aggregate, which is where a percent/fraction mix-up would hide.
 *   • M8 tips twice and asserts the stored total is 25, not 20; the pre-fix
 *     upsert leaves 20 in all three places.
 *   • M7 serves 1201 rows through a client that caps every response at 1000,
 *     which is exactly what made the pre-fix select short.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyMoneyCallSites.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { emptyLedgerDb, fakeLedgerRpc, type FakeLedgerDb } from "./helpers/fakeRentBuddyLedgerRpc.js";

process.env.TZ = "UTC";

const USER_TOKEN = "money-call-sites-token";
const USER_ID = "money-call-sites-user";
const BUDDY_PROFILE_ID = "money-call-sites-profile";
const BOOKING_ID = "money-call-sites-booking";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── HTTP plumbing ────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method,
        headers: {
          authorization: `Bearer ${USER_TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...headers,
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

/** A builder that answers one fixed row / list, for tables nothing here exercises. */
function stub(single: any, list: any[] = []): any {
  const b: any = {
    select: () => b, eq: () => b, neq: () => b, in: () => b, is: () => b,
    gte: () => b, lte: () => b, gt: () => b, lt: () => b,
    order: () => b, limit: () => b, range: () => b,
    single: () => Promise.resolve({ data: single, error: null }),
    maybeSingle: () => Promise.resolve({ data: single, error: null }),
    insert: () => Promise.resolve({ data: null, error: null }),
    then: (resolve: (r: any) => any) => Promise.resolve({ data: list, error: null }).then(resolve),
  };
  return b;
}

function authClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) =>
      table === "profiles" ? stub({ id: USER_ID, account_status: "active" }) : stub(null, []),
  };
}

/**
 * A client honouring `.range()` but never returning more than `cap` rows in one
 * response — PostgREST's max-rows behaviour, which is silent: no error, no
 * header the caller reads, just a shorter array.
 */
function pagedTable(rows: () => any[], error: () => any, cap = 1000): any {
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const b: any = {
    select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
    range(f: number, t: number) { from = f; to = t; return b; },
    then(resolve: any, reject: any) {
      const err = error();
      const all = rows();
      const page = err ? null : all.slice(from, Math.min(to + 1, all.length)).slice(0, cap);
      return Promise.resolve({ data: page, error: err }).then(resolve, reject);
    },
  };
  return b;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRouter);
  app.use("/api", marketplaceRouter);
  _setTestClient(authClient(), true);
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => new Promise<void>((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve()))
));

// ═════════════════════════════════════════════════════════════════════════════
// M1 — GET /rent-a-buddy/dashboard/earnings/summary prices from the schedule
// ═════════════════════════════════════════════════════════════════════════════

const DASHBOARD = "/api/rent-a-buddy/dashboard/earnings/summary";

/** Per-test knobs for the dashboard fake. */
let dashLevel: string | null = "new";
let dashFeeRow: any = null;
let dashFeeError: any = null;
let dashBookings: any[] = [];
let dashBookingsError: any = null;
/** null → the RPC is unavailable (migration 2330 is written but not applied). */
let dashRpc: ((fn: string, args: any) => { data: any; error: any }) | null = null;
let dashRpcCalls: Array<{ fn: string; args: any }> = [];
/** What the handler asked rent_buddy_profiles for. */
let dashProfileColumns = "";

function dashboardClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    rpc: async (fn: string, args: any) => {
      dashRpcCalls.push({ fn, args });
      return dashRpc
        ? dashRpc(fn, args)
        // What PostgREST answers when the function does not exist, which is the
        // state of every database today: 2330 is written and not applied.
        : { data: null, error: { message: "Could not find the function public." + fn } };
    },
    from(table: string) {
      switch (table) {
        case "feature_flags":
          return stub({ flag: "rent_buddy_enabled", enabled: true });
        case "rent_buddy_profiles": {
          const b: any = {
            select(cols: string) { dashProfileColumns = cols; return b; },
            eq: () => b,
            maybeSingle: () =>
              Promise.resolve({ data: { id: BUDDY_PROFILE_ID, buddy_level: dashLevel }, error: null }),
          };
          return b;
        }
        case "rent_buddy_fee_rules": {
          const b: any = {
            select: () => b, eq: () => b,
            maybeSingle: () => Promise.resolve({ data: dashFeeRow, error: dashFeeError }),
          };
          return b;
        }
        case "rent_buddy_bookings":
          return pagedTable(() => dashBookings, () => dashBookingsError);
        default:
          return stub(null, []);
      }
    },
  };
}

function feeRow(level: string, pct: number) {
  return { buddy_level: level, platform_fee_percent: pct, traveler_service_fee_usd: 0, traveler_service_fee_pct: 5 };
}

/** One $200 booking keeps the arithmetic legible: fee = 200 × rate. */
function oneCompletedBooking() {
  return [{
    id: "bk-1", total_usd: 200, deposit_usd: 60, cash_balance_usd: 140,
    payment_mode: "deposit_plus_cash", status: "completed",
    completed_at: "2026-03-15T10:00:00+00:00", booking_date: "2026-03-15", category: "city",
  }];
}

describe("M1 — the dashboard earnings summary uses the buddy's OWN take rate", () => {
  beforeEach(() => {
    _setTestServiceClient(dashboardClient());
    dashLevel = "new";
    dashFeeRow = feeRow("new", 25);
    dashFeeError = null;
    dashBookings = oneCompletedBooking();
    dashBookingsError = null;
    dashRpc = null;
    dashRpcCalls = [];
    dashProfileColumns = "";
  });

  it("a `new` buddy is charged 25 %, not the deleted 15 % literal", async () => {
    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePct, 25);
    assert.equal(res.body.buddyLevel, "new");
    assert.equal(res.body.totalPlatformFeesUsd, 50, "25 % of 200");
    assert.equal(res.body.totalNetUsd, 60 + 140 - 50);
    assert.notEqual(
      res.body.totalPlatformFeesUsd, 30,
      "30 is 15 % of 200 — the level-blind literal this repair deletes",
    );
  });

  it("an `elite` buddy is charged 12 %: the rate follows the LEVEL", async () => {
    dashLevel = "elite";
    dashFeeRow = feeRow("elite", 12);

    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.platformFeePct, 12);
    assert.equal(res.body.totalPlatformFeesUsd, 24);
    assert.notEqual(res.body.platformFeePct, 15, "15 was the earnings-summary literal");
    assert.notEqual(res.body.platformFeePct, 22, "22 was the two deleted 22 % literals");
  });

  it("asks the profile for buddy_level — the input the old code never read", async () => {
    await request("GET", DASHBOARD);
    assert.match(
      dashProfileColumns, /buddy_level/,
      "a route that never selects buddy_level cannot price by level, whatever it computes",
    );
  });

  it("hands the SQL aggregate a FRACTION, and publishes a PERCENTAGE", async () => {
    // The one place a 25 %/0.25 mix-up would hide: rb_buddy_earnings_summary
    // takes p_platform_fee_pct as a fraction (2330:306), the response field
    // `platformFeePct` has always been 0–100.
    dashRpc = () => ({
      data: { totalInAppUsd: 60, totalCashConfirmedUsd: 140, totalPlatformFeesUsd: 50, totalNetUsd: 150 },
      error: null,
    });

    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const call = dashRpcCalls.find((c) => c.fn === "rb_buddy_earnings_summary");
    assert.ok(call, "the DB-side aggregate is still the preferred path");
    assert.equal(call!.args.p_platform_fee_pct, 0.25, "0.25, not 25 — the SQL multiplies by it directly");
    assert.equal(res.body.platformFeePct, 25, "the client is told a percentage");
    assert.equal(res.body.buddyLevel, "new", "and WHICH schedule row priced it");
  });

  it("the SQL path and the pagination path quote the same rate", async () => {
    dashLevel = "elite";
    dashFeeRow = feeRow("elite", 12);
    const paginated = await request("GET", DASHBOARD);

    dashRpc = () => ({ data: { totalNetUsd: 176, totalPlatformFeesUsd: 24 }, error: null });
    const aggregated = await request("GET", DASHBOARD);

    assert.equal(paginated.body.platformFeePct, aggregated.body.platformFeePct);
    assert.equal(paginated.body.totalPlatformFeesUsd, aggregated.body.totalPlatformFeesUsd);
  });
});

describe("M1 — an unconfigured take rate is refused, never guessed", () => {
  beforeEach(() => {
    _setTestServiceClient(dashboardClient());
    dashLevel = "new";
    dashFeeRow = feeRow("new", 25);
    dashFeeError = null;
    dashBookings = oneCompletedBooking();
    dashBookingsError = null;
    dashRpc = null;
    dashRpcCalls = [];
  });

  it("409s when the buddy's level has no fee row", async () => {
    // 'standard' is settable by PATCH /rent-a-buddy/admin/buddies/:id/level and
    // has never had a schedule row (`08` §2.5).
    dashLevel = "standard";
    dashFeeRow = null;

    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "conflict");
    assert.equal(res.body.platformFeePct, undefined, "no rate may be published when none is configured");
    assert.equal(res.body.totalNetUsd, undefined, "and no total derived from one");
  });

  it("500s when the fee table cannot be read at all", async () => {
    dashFeeError = { message: "permission denied for table rent_buddy_fee_rules" };

    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error");
    assert.equal(res.body.platformFeePct, undefined);
  });

  it("the two failures are distinguishable, and neither leaks the table name", async () => {
    dashLevel = "standard";
    dashFeeRow = null;
    const absent = await request("GET", DASHBOARD);

    dashFeeError = { message: "permission denied for table rent_buddy_fee_rules" };
    const unreadable = await request("GET", DASHBOARD);

    assert.notEqual(
      absent.status, unreadable.status,
      "collapsing 'no such level' into 'could not read' is how a missing row became a deliberate rate",
    );
    for (const r of [absent, unreadable]) {
      assert.equal(String(r.body.message ?? "").includes("rent_buddy_fee_rules"), false);
    }
  });

  it("refuses BEFORE it totals anything: no bookings are read when there is no rate", async () => {
    dashLevel = "standard";
    dashFeeRow = null;
    dashBookingsError = { message: "this read must never happen" };

    const res = await request("GET", DASHBOARD);
    assert.equal(res.status, 409, "the refusal is the fee schedule's, not the booking read's");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M8 — POST /rent-a-buddy/bookings/:id/tip accumulates, and can fail
// ═════════════════════════════════════════════════════════════════════════════

const TIP_PATH = `/api/rent-a-buddy/bookings/${BOOKING_ID}/tip`;

/** The buddy profile the BOOKING points at — the true payee. */
const REAL_BUDDY_PROFILE = "money-call-sites-buddy-profile";
const REAL_BUDDY_USER = "money-call-sites-buddy-user";
/** What the joined `buddy:rent_buddy_profiles(user_id, …)` claims. */
const JOINED_BUDDY_USER = "money-call-sites-joined-user";

/** Every table WRITE the tip route issued itself. Must stay empty. */
let tipTableWrites: Array<{ table: string; op: string }> = [];
let tipRpcCalls: Array<{ fn: string; args: any }> = [];

function seedTipDb(): FakeLedgerDb {
  return emptyLedgerDb({
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID, traveler_id: USER_ID, buddy_id: REAL_BUDDY_PROFILE,
        status: "completed", city: "Cebu", category: "city", tip_usd: null, total_usd: 100,
      },
    },
    buddyProfiles: { [REAL_BUDDY_PROFILE]: { id: REAL_BUDDY_PROFILE, user_id: REAL_BUDDY_USER, buddy_level: "new" } },
  });
}

/**
 * The service client the tip route sees. Tables are READ-ONLY as far as the
 * route is concerned: every upsert / update / insert on a money table is
 * recorded in `tipTableWrites`, which each case asserts is empty. `rpc` is the
 * model of rb_post_booking_ledger unless `opts.rpc` says otherwise.
 */
function tipClient(
  db: FakeLedgerDb,
  opts: { absent?: boolean; rpcError?: any } = {},
): any {
  const MONEY_TABLES = ["rent_buddy_tips", "rent_buddy_earnings_ledger", "rent_buddy_earnings_entries", "rent_buddy_bookings"];
  const client: any = {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from(table: string) {
      let cols = "";
      const eqs: Array<[string, any]> = [];
      const eqVal = (c: string) => eqs.find(([k]) => k === c)?.[1];
      const write = (op: string) => {
        if (MONEY_TABLES.includes(table)) tipTableWrites.push({ table, op });
        return Promise.resolve({ data: null, error: null });
      };

      const b: any = {
        select(c = "") { cols = c; return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        insert: () => write("insert"),
        upsert: () => write("upsert"),
        update: () => ({ eq: () => write("update") }),
        maybeSingle() {
          switch (table) {
            case "feature_flags":
              return Promise.resolve({ data: { flag: "rent_buddy_enabled", enabled: true }, error: null });
            case "rent_buddy_bookings": {
              const row = db.bookings[eqVal("id")] ?? null;
              if (!row) return Promise.resolve({ data: null, error: null });
              // The route's own read joins the buddy profile. The join
              // deliberately reports a DIFFERENT user from the one the booking
              // really points at.
              return Promise.resolve({
                data: cols.includes("buddy:")
                  ? { ...row, buddy: { user_id: JOINED_BUDDY_USER, city: row.city, buddy_level: "new" } }
                  : row,
                error: null,
              });
            }
            default:
              return Promise.resolve({ data: null, error: null });
          }
        },
      };
      return b;
    },
  };

  client.rpc = async (fn: string, args: any) => {
    tipRpcCalls.push({ fn, args });
    if (opts.rpcError) return { data: null, error: opts.rpcError };
    return fakeLedgerRpc(db, { absent: opts.absent ? ["rb_post_booking_ledger"] : [] })(fn, args);
  };

  return client;
}

const tipEntriesOf = (db: FakeLedgerDb) => db.entries.filter((e) => e.booking_id === BOOKING_ID && e.entry_reason === "tip");

describe("M8 — a second tip is ADDED, never substituted", () => {
  beforeEach(() => { tipTableWrites = []; tipRpcCalls = []; });

  it("$5 then $20 leaves $25 on the booking — in the entries and in every copy", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));

    const first = await request("POST", TIP_PATH, { amountUsd: 5 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.totalTipUsd, 5);

    const second = await request("POST", TIP_PATH, { amountUsd: 20 });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    assert.equal(
      db.tips[BOOKING_ID].amount_usd, 25,
      "the pre-fix upsert on conflict target booking_id left 20 here — the $5 was destroyed, " +
      "and there is no other copy of it anywhere",
    );
    assert.equal(second.body.totalTipUsd, 25, "the response reports the RUNNING TOTAL");
    assert.equal(second.body.atomic, true, "there is no non-atomic path any more");
    assert.equal(second.body.replayed, false);

    assert.equal(db.ledger[BOOKING_ID].tip_usd, 25,
      "the ledger's tip_usd used to be UPDATEd with the single amount");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, 25,
      "and so did the booking's — three copies that could disagree");

    // PAY-014 — and now a fourth place, which is the source of the other three.
    const entries = tipEntriesOf(db);
    assert.equal(entries.length, 4, "two tips are two balanced pairs");
    assert.equal(entries.reduce((n, e) => n + e.amount_minor, 0), 0);
    assert.equal(entries.filter((e) => e.account === "buddy_payable").reduce((n, e) => n + e.amount_minor, 0), 2500);
  });

  it("the ROUTE writes no money table itself — one function call per tip, and nothing beside it", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    await request("POST", TIP_PATH, { amountUsd: 5 });
    await request("POST", TIP_PATH, { amountUsd: 20 });

    assert.deepEqual(tipTableWrites, [],
      "an upsert or UPDATE from the route is a second statement outside the tip's transaction");
    assert.deepEqual(tipRpcCalls.map((c) => c.fn), ["rb_post_booking_ledger", "rb_post_booking_ledger"]);
    assert.deepEqual(
      tipRpcCalls.map((c) => [c.args.p_event, c.args.p_args.traveler_id, c.args.p_args.amount_usd]),
      [["tip", USER_ID, 5], ["tip", USER_ID, 20]],
    );
  });

  it("the payee is derived from the booking, not taken from the caller's join", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));

    await request("POST", TIP_PATH, { amountUsd: 10 });

    assert.equal(
      db.tips[BOOKING_ID].buddy_user_id, REAL_BUDDY_USER,
      "the route used to write bk.buddy.user_id straight from its own joined select; " +
      "the tips row names who is owed money, so it is resolved from the booking",
    );
    assert.notEqual(db.tips[BOOKING_ID].buddy_user_id, JOINED_BUDDY_USER);
    assert.equal(JSON.stringify(tipRpcCalls).includes(JOINED_BUDDY_USER), false, "no payee is passed to the function at all");
    assert.ok(tipEntriesOf(db).filter((e) => e.account === "buddy_payable").every((e) => e.beneficiary_user_id === REAL_BUDDY_USER));
  });

  it("NO COMMISSION ON A TIP: the fee stays the booking's own (owner ruling 2026-10-04)", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    await fakeLedgerRpc(db)("rb_post_booking_ledger", { p_booking_id: BOOKING_ID, p_event: "booking_created", p_event_key: null, p_args: {} });
    const feeBefore = JSON.stringify(db.entries.filter((e) => e.entry_reason === "platform_fee"));
    assert.equal(db.ledger[BOOKING_ID].platform_fee_amount, 10);

    const res = await request("POST", TIP_PATH, { amountUsd: 50 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(JSON.stringify(db.entries.filter((e) => e.entry_reason === "platform_fee")), feeBefore, "the tip added a fee entry");
    assert.equal(db.ledger[BOOKING_ID].platform_fee_amount, 10);
    assert.equal(db.ledger[BOOKING_ID].buddy_net_estimated_amount, 140, "100 − 10 + the whole 50");
  });
});

describe("M8 — a retried tip is the SAME tip (`09` §7.1)", () => {
  beforeEach(() => { tipTableWrites = []; tipRpcCalls = []; });

  it("the same Idempotency-Key twice records one tip and says the second was a replay", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));

    const first = await request("POST", TIP_PATH, { amountUsd: 5 }, { "Idempotency-Key": "tip-abc-1" });
    const retry = await request("POST", TIP_PATH, { amountUsd: 5 }, { "Idempotency-Key": "tip-abc-1" });
    assert.deepEqual([first.status, retry.status], [200, 200], JSON.stringify([first.body, retry.body]));
    assert.deepEqual([first.body.replayed, retry.body.replayed], [false, true]);
    assert.equal(retry.body.totalTipUsd, 5);
    assert.equal(db.tips[BOOKING_ID].amount_usd, 5, "the retry was recorded as a second tip");
    assert.equal(tipEntriesOf(db).length, 2);
  });

  it("the key may arrive in the body, and is the key the function is given", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    await request("POST", TIP_PATH, { amountUsd: 5, idempotencyKey: "body-key-9" });
    await request("POST", TIP_PATH, { amountUsd: 5, idempotencyKey: "body-key-9" });
    assert.deepEqual(tipRpcCalls.map((c) => c.args.p_event_key), ["body-key-9", "body-key-9"]);
    assert.equal(db.tips[BOOKING_ID].amount_usd, 5);
  });

  it("the same key with a DIFFERENT amount is a 409, and the first tip stands", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    await request("POST", TIP_PATH, { amountUsd: 5 }, { "Idempotency-Key": "tip-abc-2" });
    const res = await request("POST", TIP_PATH, { amountUsd: 20 }, { "Idempotency-Key": "tip-abc-2" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "idempotency_key_reused");
    assert.equal(db.tips[BOOKING_ID].amount_usd, 5);
  });

  it("a malformed key is refused — never silently replaced by a minted one", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    for (const bad of ["has spaces", "x".repeat(121), "semi;colon"]) {
      const res = await request("POST", TIP_PATH, { amountUsd: 5, idempotencyKey: bad });
      assert.equal(res.status, 400, `${bad} → ${JSON.stringify(res.body)}`);
    }
    const nonString = await request("POST", TIP_PATH, { amountUsd: 5, idempotencyKey: 12345 });
    assert.equal(nonString.status, 400);
    assert.deepEqual(tipRpcCalls, []);
    assert.deepEqual(db.tips, {});
  });

  it("with NO key each request is its own tip, under a key minted per request", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    await request("POST", TIP_PATH, { amountUsd: 5 });
    await request("POST", TIP_PATH, { amountUsd: 5 });
    const keys = tipRpcCalls.map((c) => c.args.p_event_key);
    assert.equal(new Set(keys).size, 2);
    assert.ok(keys.every((k) => typeof k === "string" && k.length >= 16));
    assert.equal(db.tips[BOOKING_ID].amount_usd, 10);
  });
});

describe("M8 — a tip that cannot be applied FAILS THE REQUEST", () => {
  beforeEach(() => { tipTableWrites = []; tipRpcCalls = []; });

  // INVERTED (PAY-018). This case was `the non-atomic fallback path: $5 then $20
  // leaves $25`: with the function absent the route read the tips row, added in
  // JavaScript and wrote three tables. That path is the defect now.
  it("with the posting function ABSENT the tip is a 503 `ledger_unavailable` — and the route writes nothing a second way", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { absent: true }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "ledger_unavailable");
    assert.equal(res.body.retryable, true);
    assert.equal(res.body.ok, undefined, "no success envelope on a money write that did not land");
    assert.match(res.body.message, /Nothing was charged/);

    assert.deepEqual(tipTableWrites, [], "the route fell back to writing the tips row / ledger / booking itself");
    assert.deepEqual(tipRpcCalls.map((c) => c.fn), ["rb_post_booking_ledger"],
      "2330's rb_accumulate_booking_tip must not be tried instead: it writes no ledger entry");
    assert.deepEqual(db.tips, {}, "and nothing was written");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, null);
    assert.equal(db.entries.length, 0);
  });

  it("a failed posting is a 503 `ledger_write_failed` and leaves the record untouched", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { rpcError: { code: "40P01", message: "deadlock detected" } }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.error, "ledger_write_failed");
    assert.equal(res.body.ok, undefined);
    assert.deepEqual(db.tips, {});
    assert.deepEqual(tipTableWrites, [], "no half-applied tip");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, null);
  });

  it("does not leak the database's message to the traveller", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { rpcError: { code: "40P01", message: "deadlock detected" } }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(JSON.stringify(res.body).includes("deadlock"), false);
  });

  it("still rejects a tip on someone else's booking", async () => {
    const db = seedTipDb();
    db.bookings[BOOKING_ID].traveler_id = "somebody-else";
    _setTestServiceClient(tipClient(db));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(db.tips, {});
    assert.equal(db.entries.length, 0);
  });

  it("still rejects a tip on a booking that is not completed, and a non-positive amount", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db));
    for (const amountUsd of [0, -5, "abc"]) {
      const res = await request("POST", TIP_PATH, { amountUsd });
      assert.equal(res.status, 400, `${amountUsd} → ${JSON.stringify(res.body)}`);
    }
    db.bookings[BOOKING_ID].status = "in_progress";
    const early = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(early.status, 400, JSON.stringify(early.body));
    assert.deepEqual(db.tips, {});
    assert.deepEqual(tipRpcCalls, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M7 — GET /rent-a-buddy/me/earnings/summary: the money is the database's fold,
// the lists are read exhaustively, and a fold that cannot be read is a failure
// ═════════════════════════════════════════════════════════════════════════════

const MARKETPLACE_SUMMARY = "/api/rent-a-buddy/me/earnings/summary";

let mktDb: FakeLedgerDb = emptyLedgerDb();
let mktBookingsError: any = null;
let mktAbsent: string[] = [];
let mktRpcError: Record<string, any> = {};
/** Money tables the handler read through `.from()` — it must read none. */
let mktMoneyReads: string[] = [];

function marketplaceClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    rpc: async (fn: string, args: any) => {
      if (mktRpcError[fn]) return { data: null, error: mktRpcError[fn] };
      return fakeLedgerRpc(mktDb, { absent: mktAbsent })(fn, args);
    },
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
        case "rent_buddy_tips":
        case "rent_buddy_earnings_ledger":
        case "rent_buddy_earnings_entries":
          mktMoneyReads.push(table);
          return stub(null, []);
        case "rent_buddy_bookings":
          return pagedTable(() => Object.values(mktDb.bookings), () => mktBookingsError);
        case "trust_profiles":
          return stub({ overall_score: 70, public_level: "trusted" });
        default:
          return stub(null, []);
      }
    },
  };
}

/**
 * `count` completed bookings of 100.00, each LEDGERED (at the level's 25 %) and
 * each tipped 1.00 — the state the SQL fold totals.
 */
async function seedLedgeredBookings(count: number, extra: any[] = []) {
  mktDb = emptyLedgerDb({
    buddyProfiles: { [BUDDY_PROFILE_ID]: { user_id: USER_ID, buddy_level: "new" } },
    feeRules: { new: 25 },
  });
  const rpc = fakeLedgerRpc(mktDb);
  for (let i = 0; i < count; i++) {
    const id = `bk-${String(i).padStart(6, "0")}`;
    mktDb.bookings[id] = {
      id, buddy_id: BUDDY_PROFILE_ID, traveler_id: "trav-1",
      status: "completed", total_usd: 100, deposit_usd: 30, cash_balance_usd: 70,
      cash_balance_confirmed_by_buddy: false, booking_date: "2026-03-15",
      category: "city", city: "Cebu", duration_h: 2, tip_usd: 0, pricing_type: "hourly",
    };
    await rpc("rb_post_booking_ledger", { p_booking_id: id, p_event: "booking_created", p_event_key: null, p_args: {} });
    await rpc("rb_post_booking_ledger", { p_booking_id: id, p_event: "tip", p_event_key: `tip-${i}`, p_args: { traveler_id: "trav-1", amount_usd: 1, note: null } });
  }
  for (const b of extra) mktDb.bookings[b.id] = { buddy_id: BUDDY_PROFILE_ID, traveler_id: "trav-1", ...b };
}

describe("M7 — the marketplace earnings dashboard is exhaustive, and the money is folded in the database", () => {
  beforeEach(async () => {
    _setTestServiceClient(marketplaceClient());
    mktBookingsError = null;
    mktAbsent = [];
    mktRpcError = {};
    mktMoneyReads = [];
  });

  it("totals all 1201 bookings — the figures are the fold's, past any row cap", async () => {
    await seedLedgeredBookings(1201);
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.completed.count, 1201);
    assert.equal(res.body.completed.totalUsd, 1201 * 100);
    assert.notEqual(
      res.body.completed.totalUsd, 1000 * 100,
      "100000 is what the pre-fix single select produced — short, and silently so",
    );
    assert.equal(res.body.estimatedPlatformFeeUsd, round2(1201 * 100 * 0.25));
    assert.equal(res.body.estimatedBuddyEarningsUsd, round2(1201 * 100 * 0.75));
    assert.equal(res.body.completed.unledgeredCount, 0);
  });

  it("totals all 1201 tips too, from the entries — and no commission came out of them", async () => {
    await seedLedgeredBookings(1201);
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tips.count, 1201);
    assert.equal(res.body.tips.total, 1201);
    assert.notEqual(res.body.tips.count, 1000, "the tips read was capped exactly like the bookings read");
    assert.equal(res.body.tipCommissionPercent, 0);
    assert.equal(res.body.estimatedPlatformFeeUsd, round2(1201 * 100 * 0.25), "the fee is 25 % of the SERVICE price only");
  });

  it("sums no money column in JavaScript: the handler reads no tips, fee or ledger table", async () => {
    await seedLedgeredBookings(3);
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(mktMoneyReads, []);
  });

  it("the LIST read is still exhaustive: a booking on the second page is counted", async () => {
    // The screen's lists and status counts still come from a paged read of the
    // bookings. Ids sort after every `bk-…`, so these land past the 1000-row cap.
    await seedLedgeredBookings(1201, [
      { id: "zz-cancelled", status: "cancelled_by_traveler", total_usd: 50, booking_date: "2026-03-16" },
      { id: "zz-disputed", status: "disputed", total_usd: 50, booking_date: "2026-03-16" },
    ]);
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.statusBreakdown.cancelled, res.body.statusBreakdown.disputed, res.body.statusBreakdown.completed],
      [1, 1, 1201],
      "a read that stopped at the first page reports 0 cancelled and 0 disputed",
    );
  });

  it("reports NOTHING as collected, for 1201 bookings that each name a 30.00 deposit (PAY-009)", async () => {
    await seedLedgeredBookings(1201);
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.body.completed.inAppAmountCollected, 0);
    assert.equal(res.body.completed.depositCollected, 0,
      "36030 is sum(deposit_usd) — the figure this field used to carry, for money nobody paid");
    assert.equal(res.body.isEstimated, true);
  });

  it("a failed booking read is a distinguishable failure, never a confident zero", async () => {
    await seedLedgeredBookings(3);
    mktBookingsError = { message: "connection reset by peer" };

    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error");
    assert.equal(
      res.body.completed, undefined,
      "`(res.data ?? [])` used to publish completed.totalUsd = 0 with a 200 — a buddy " +
      "cannot tell that apart from having earned nothing",
    );
  });

  it("a fold that cannot be read is a failure too — named, and not tips.total = 0", async () => {
    await seedLedgeredBookings(3);
    mktRpcError = { rb_buddy_ledger_totals: { code: "57014", message: "canceling statement due to statement timeout" } };

    const failed = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.equal(failed.body.error, "ledger_write_failed");
    assert.equal(failed.body.tips, undefined);
    assert.equal(failed.body.completed, undefined);

    mktRpcError = {};
    mktAbsent = ["rb_buddy_ledger_totals"];
    const absent = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(absent.status, 503, JSON.stringify(absent.body));
    assert.equal(absent.body.error, "ledger_unavailable", "'3824 is not applied' has its own name");
    assert.equal(absent.body.estimatedBuddyEarningsUsd, undefined);
  });

  it("does not leak the underlying database message", async () => {
    await seedLedgeredBookings(3);
    mktBookingsError = { message: "permission denied for relation rent_buddy_bookings" };
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(String(res.body.message ?? "").includes("permission denied"), false);

    mktBookingsError = null;
    mktRpcError = { rb_buddy_ledger_totals: { code: "42501", message: "permission denied for table rent_buddy_earnings_entries" } };
    const fold = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(JSON.stringify(fold.body).includes("permission denied"), false);
  });

  it("an empty booking set is still an honest 200 with zeros", async () => {
    // The point of the failure/zero distinction: a genuine zero must survive it.
    await seedLedgeredBookings(0);

    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.completed.count, 0);
    assert.equal(res.body.completed.totalUsd, 0);
    assert.equal(res.body.tips.total, 0);
    assert.equal(res.body.estimatedBuddyEarningsUsd, 0);
    assert.equal(res.body.isEstimated, true, "zero is still an estimate, not a claim that anything settled");
  });
});
