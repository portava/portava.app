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
 *   M7  GET /rent-a-buddy/me/earnings/summary summed an unpaginated select of
 *       bookings AND an unpaginated select of tips in JavaScript, and turned a
 *       failed read into `[]` — so a buddy past PostgREST's row cap was shown a
 *       silently short total, and an outage was shown a confident $0.
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

interface TipDb {
  bookings: Record<string, any>;
  profiles: Record<string, any>;
  tips: Record<string, any>;
  ledger: Record<string, any>;
  onConflict?: string;
}

function seedTipDb(): TipDb {
  return {
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID, traveler_id: USER_ID, buddy_id: REAL_BUDDY_PROFILE,
        status: "completed", city: "Cebu", category: "city", tip_usd: null,
      },
    },
    profiles: { [REAL_BUDDY_PROFILE]: { id: REAL_BUDDY_PROFILE, user_id: REAL_BUDDY_USER } },
    tips: {},
    ledger: { [BOOKING_ID]: { booking_id: BOOKING_ID, tip_usd: 0 } },
  };
}

function tipClient(db: TipDb, opts: { rpc?: boolean; tipsReadError?: any; tipsWriteError?: any } = {}): any {
  const client: any = {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from(table: string) {
      let cols = "";
      const eqs: Array<[string, any]> = [];
      const eqVal = (c: string) => eqs.find(([k]) => k === c)?.[1];

      const b: any = {
        select(c = "") { cols = c; return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        insert: () => Promise.resolve({ data: null, error: null }),
        upsert(row: any, o: any) {
          if (table !== "rent_buddy_tips") return Promise.resolve({ data: null, error: null });
          if (opts.tipsWriteError) return Promise.resolve({ data: null, error: opts.tipsWriteError });
          db.onConflict = o?.onConflict;
          db.tips[row.booking_id] = { id: `tip-${row.booking_id}`, ...(db.tips[row.booking_id] ?? {}), ...row };
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: any) {
          return {
            eq(c: string, v: any) {
              if (table === "rent_buddy_earnings_ledger") Object.assign(db.ledger[v] ?? (db.ledger[v] = {}), patch);
              if (table === "rent_buddy_bookings" && db.bookings[v]) Object.assign(db.bookings[v], patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        maybeSingle() {
          switch (table) {
            case "feature_flags":
              return Promise.resolve({ data: { flag: "rent_buddy_enabled", enabled: true }, error: null });
            case "rent_buddy_bookings": {
              const row = db.bookings[eqVal("id")] ?? null;
              if (!row) return Promise.resolve({ data: null, error: null });
              // The route's own read joins the buddy profile; the primitive's
              // read does not. The join deliberately reports a DIFFERENT user.
              return Promise.resolve({
                data: cols.includes("buddy:")
                  ? { ...row, buddy: { user_id: JOINED_BUDDY_USER, city: row.city, buddy_level: "new" } }
                  : row,
                error: null,
              });
            }
            case "rent_buddy_profiles":
              return Promise.resolve({ data: db.profiles[eqVal("id")] ?? null, error: null });
            case "rent_buddy_tips":
              if (opts.tipsReadError) return Promise.resolve({ data: null, error: opts.tipsReadError });
              return Promise.resolve({ data: db.tips[eqVal("booking_id")] ?? null, error: null });
            default:
              return Promise.resolve({ data: null, error: null });
          }
        },
      };
      return b;
    },
  };

  // Migration 2330's rb_accumulate_booking_tip, modelled on the one property
  // the SQL buys: no await between the read and the write.
  client.rpc = async (fn: string, args: any) => {
    if (!opts.rpc || fn !== "rb_accumulate_booking_tip") {
      return { data: null, error: { message: "Could not find the function public." + fn } };
    }
    const bk = db.bookings[args.p_booking_id];
    if (!bk) return { data: null, error: { message: "booking not found" } };
    if (bk.traveler_id !== args.p_traveler_id) return { data: null, error: { message: "not the traveller" } };
    const bp = db.profiles[bk.buddy_id];
    if (!bp) return { data: null, error: { message: "no buddy profile" } };
    const existing = db.tips[args.p_booking_id];
    const total = round2(Number(existing?.amount_usd ?? 0) + Number(args.p_amount_usd));
    db.tips[args.p_booking_id] = {
      id: existing?.id ?? `tip-${args.p_booking_id}`,
      booking_id: args.p_booking_id,
      traveler_id: args.p_traveler_id,
      buddy_user_id: bp.user_id,
      amount_usd: total,
      note: args.p_note ?? null,
    };
    db.ledger[args.p_booking_id] = { ...(db.ledger[args.p_booking_id] ?? {}), tip_usd: total };
    bk.tip_usd = total;
    return { data: [{ total_tip_usd: total }], error: null };
  };

  return client;
}

describe("M8 — a second tip is ADDED, never substituted", () => {
  for (const mode of ["the atomic RPC path", "the non-atomic fallback path"] as const) {
    const rpc = mode === "the atomic RPC path";

    it(`${mode}: $5 then $20 leaves $25 on the booking`, async () => {
      const db = seedTipDb();
      _setTestServiceClient(tipClient(db, { rpc }));

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
      assert.equal(second.body.atomic, rpc, "and says whether the write was atomic");
    });

    it(`${mode}: both denormalised copies carry the running total, not the last amount`, async () => {
      const db = seedTipDb();
      _setTestServiceClient(tipClient(db, { rpc }));

      await request("POST", TIP_PATH, { amountUsd: 5 });
      await request("POST", TIP_PATH, { amountUsd: 20 });

      assert.equal(db.ledger[BOOKING_ID].tip_usd, 25,
        "the ledger's tip_usd used to be UPDATEd with the single amount");
      assert.equal(db.bookings[BOOKING_ID].tip_usd, 25,
        "and so did the booking's — three copies that could disagree");
    });

    it(`${mode}: the payee is derived from the booking, not taken from the caller's join`, async () => {
      const db = seedTipDb();
      _setTestServiceClient(tipClient(db, { rpc }));

      await request("POST", TIP_PATH, { amountUsd: 10 });

      assert.equal(
        db.tips[BOOKING_ID].buddy_user_id, REAL_BUDDY_USER,
        "the route used to write bk.buddy.user_id straight from its own joined select; " +
        "the tips row names who is owed money, so it is resolved from the booking",
      );
      assert.notEqual(db.tips[BOOKING_ID].buddy_user_id, JOINED_BUDDY_USER);
    });
  }
});

describe("M8 — a tip that cannot be applied FAILS THE REQUEST", () => {
  it("a failed read of the existing tip is a 500, not a total derived from it", async () => {
    // The pre-fix route never read the existing row at all: it upserted the
    // single amount and answered { ok: true }. Answering 200 here would mean
    // the running total was computed from a read that did not happen.
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { rpc: false, tipsReadError: { message: "connection reset" } }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error");
    assert.equal(res.body.ok, undefined, "no success envelope on a money write that did not land");
    assert.deepEqual(db.tips, {}, "and nothing was written");
  });

  it("a failed tip write is a 500 and leaves the record untouched", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { rpc: false, tipsWriteError: { message: "deadlock detected" } }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.deepEqual(db.tips, {});
    assert.equal(db.ledger[BOOKING_ID].tip_usd, 0, "no half-applied tip");
    assert.equal(db.bookings[BOOKING_ID].tip_usd, null);
  });

  it("does not leak the database's message to the traveller", async () => {
    const db = seedTipDb();
    _setTestServiceClient(tipClient(db, { rpc: false, tipsWriteError: { message: "deadlock detected" } }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(String(res.body.message ?? "").includes("deadlock"), false);
  });

  it("still rejects a tip on someone else's booking", async () => {
    const db = seedTipDb();
    db.bookings[BOOKING_ID].traveler_id = "somebody-else";
    _setTestServiceClient(tipClient(db, { rpc: true }));

    const res = await request("POST", TIP_PATH, { amountUsd: 10 });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(db.tips, {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M7 — GET /rent-a-buddy/me/earnings/summary reads EVERY row, or says it cannot
// ═════════════════════════════════════════════════════════════════════════════

const MARKETPLACE_SUMMARY = "/api/rent-a-buddy/me/earnings/summary";

let mktBookings: any[] = [];
let mktBookingsError: any = null;
let mktTips: any[] = [];
let mktTipsError: any = null;

function marketplaceClient(): any {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
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
          return stub(feeRow("new", 25));
        case "rent_buddy_bookings":
          return pagedTable(() => mktBookings, () => mktBookingsError);
        case "rent_buddy_tips":
          return pagedTable(() => mktTips, () => mktTipsError);
        case "trust_profiles":
          return stub({ overall_score: 70, public_level: "trusted" });
        default:
          return stub(null, []);
      }
    },
  };
}

function completedBookings(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `bk-${String(i).padStart(6, "0")}`,
    status: "completed", total_usd: 100, deposit_usd: 30, cash_balance_usd: 70,
    cash_balance_confirmed_by_buddy: false, booking_date: "2026-03-15",
    category: "city", city: "Cebu", duration_h: 2, tip_usd: 0, pricing_type: "hourly",
  }));
}

describe("M7 — the marketplace earnings dashboard is exhaustive", () => {
  beforeEach(() => {
    _setTestServiceClient(marketplaceClient());
    mktBookings = completedBookings(1201);
    mktBookingsError = null;
    mktTips = Array.from({ length: 1201 }, (_, i) => ({ id: `tip-${i}`, amount_usd: 1 }));
    mktTipsError = null;
  });

  it("totals all 1201 bookings past a 1000-row cap, not the first page", async () => {
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
  });

  it("totals all 1201 tips too — the other unpaginated select in the same Promise.all", async () => {
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tips.count, 1201);
    assert.equal(res.body.tips.total, 1201);
    assert.notEqual(res.body.tips.count, 1000, "the tips read was capped exactly like the bookings read");
  });

  it("counts every row once — a client that ignores `range` must not double-count", async () => {
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.body.completed.count, 1201);
    assert.ok(res.body.completed.count <= mktBookings.length);
  });

  it("a failed booking read is a distinguishable failure, never a confident zero", async () => {
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

  it("a failed tip read is a failure too, not tips.total = 0", async () => {
    mktTipsError = { message: "statement timeout" };

    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error");
    assert.equal(res.body.tips, undefined);
  });

  it("does not leak the underlying database message", async () => {
    mktBookingsError = { message: "permission denied for relation rent_buddy_bookings" };
    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(String(res.body.message ?? "").includes("permission denied"), false);
  });

  it("an empty booking set is still an honest 200 with zeros", async () => {
    // The point of the null/[] distinction: a genuine zero must survive it.
    mktBookings = [];
    mktTips = [];

    const res = await request("GET", MARKETPLACE_SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.completed.count, 0);
    assert.equal(res.body.completed.totalUsd, 0);
    assert.equal(res.body.tips.total, 0);
  });
});
