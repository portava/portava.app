/**
 * Rent a Buddy Spec router — booking-request blocked-date regression tests
 *
 * The spec router's POST /api/rent-a-buddy/buddies/:buddyId/request path
 * must reject bookingDates that fall inside a buddy's blocked/vacation
 * ranges (buddy_availability_exceptions) with 409 buddy_unavailable, and
 * still allow requests on free dates.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddySpecRequest.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { acceptedLedgerPosting, answerLost, functionNotFound } from "./helpers/fakeRentBuddyLedgerRpc.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "rbs-req-test-token";
const USER_ID    = "spec-req-traveler-1";
const BUDDY_PROF = "spec-req-buddy-profile-1";
const BUDDY_USER = "spec-req-buddy-user-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
      ...extraHeaders,
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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

// ── Fake client state ─────────────────────────────────────────────────────────

interface SpecState {
  buddyProfiles: any[];
  availabilityExceptions: any[];
  insertedBookings: any[];
  /** feature_flags rows read by checkRentBuddyAccess / the kill switches. */
  featureFlags: Record<string, boolean>;
  /** rent_buddy_city_rollouts rows, matched by the .ilike("city", …) probe. */
  cityRollouts: any[];
  /** rent_buddy_user_limits rows, keyed by user_id. */
  userLimits: any[];
  /**
   * How rb_post_booking_ledger answers; unset ⇒ "posted". `lost`: the posting
   * COMMITS and its answer is lost once (asked again it answers `replayed`);
   * `lost-always`: it commits and every answer is lost.
   */
  ledger?: "posted" | "absent" | "error" | "lost" | "lost-always";
  /** Every rb_post_booking_ledger call the route made. */
  ledgerCalls?: any[];
  /** Ids of bookings whose ledger COMMITTED (one per booking: the posting is idempotent). */
  ledgered?: string[];
  /** DELETEs refused because the booking has ledger entries (migration 3510). */
  refusedWithdrawals?: string[];
}

const OPEN_FLAGS = (): Record<string, boolean> => ({
  // Everything the booking gate stack reads, in its permissive state, so the
  // pre-existing cases keep asserting what they were written to assert. The
  // gate-specific cases override these individually.
  rent_buddy_enabled: true,
  disable_rent_buddy_booking: false,
  disable_rab_bookings: false,
  rent_buddy_allow_bookings_without_kyc: true,
});

let state: SpecState = {
  buddyProfiles: [], availabilityExceptions: [], insertedBookings: [],
  featureFlags: OPEN_FLAGS(), cityRollouts: [], userLimits: [],
};

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _maybeSingle: false,
      _delete: false,

      select() { return this; },
      insert(data: any) { this._insertData = data; return this; },
      // A booking withdrawn because its ledger could not be posted. APPLIED to
      // `insertedBookings`, so "no booking row" below is a statement about what
      // is stored, not about what was attempted.
      delete() { this._delete = true; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      // checkRentBuddyAccess probes the city rollout with .ilike("city", city)
      // (rentABuddyRollout.ts). Without this method the booking gate throws
      // "this.ilike is not a function" and asyncHandler turns it into a 500 on
      // every case in this file. Treated as eq — these fixtures use exact city
      // names, so case-insensitivity is not what is under test here.
      ilike(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      or() { return this; },
      order() { return this; },
      // PostgREST `.is("category", null)` — reached since this route began
      // enforcing rent_buddy_city_restrictions through the shared
      // enforceCityRestrictions helper, whose city-wide lookup asks for the row
      // with a NULL category. Without this method the route crashes with a
      // TypeError and a 500-from-crash would masquerade as a refusal.
      is(col: string, val: any) { this._filters.push(["is", col, val]); return this; },
      // PostgREST `.limit()` — reached since the block check became
      // lib/blockGuard's single `.or(...).limit(1)` query (one query instead of
      // two `.maybeSingle()` reads, because a MUTUAL block is two rows and
      // maybeSingle raised on them). Without this method the route crashes with
      // a TypeError and a 500-from-crash would masquerade as a refusal.
      limit() { return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._delete) {
          if (t === "rent_buddy_bookings") {
            const id = this._filters.find(([op, col]) => op === "eq" && col === "id")?.[2];
            assert.ok(id !== undefined, "an unfiltered DELETE on rent_buddy_bookings");
            // Migration 3510: a booking with ledger entries cannot be deleted.
            if ((state.ledgered ?? []).includes(id)) {
              (state.refusedWithdrawals ??= []).push(id);
              return { data: null, error: { code: "P0001", message: "rent_buddy_earnings_entries is append-only: DELETE refused" } };
            }
            state.insertedBookings = state.insertedBookings.filter((r: any) => r.id !== id);
          }
          return { data: null, error: null };
        }

        // The Idempotency-Key lookup: the bookings THIS run created, by key.
        if (t === "rent_buddy_bookings" && this._filters.some(([op, col]) => op === "eq" && col === "creation_key")) {
          const want = (c: string) => this._filters.find(([op, col]) => op === "eq" && col === c)?.[2];
          return { data: state.insertedBookings.filter((r: any) => r.creation_key === want("creation_key") && r.traveler_id === want("traveler_id")), error: null };
        }

        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_bookings") state.insertedBookings.push(row);
          return { data: this._maybeSingle ? row : null, error: null };
        }

        if (t === "rent_buddy_profiles") {
          let rows = [...state.buddyProfiles];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        // Tables the booking gate stack reads. Before the gates were added to
        // this route none of them were touched, so the fake fell through to the
        // empty default — which now reads as "feature off" and 403s everything.
        if (t === "feature_flags") {
          const flag = this._filters.find(([op, col]) => op === "eq" && col === "flag")?.[2];
          const enabled = state.featureFlags[flag as string];
          if (enabled === undefined) return { data: null, error: null };
          return { data: { flag, enabled }, error: null };
        }

        // rent_buddy_city_restrictions — no restriction rows in these fixtures,
        // so the helper finds nothing and enforces nothing. Answered explicitly
        // (rather than by falling through to the empty default) so that a future
        // fixture can seed a row here and have it actually apply.
        if (t === "rent_buddy_city_restrictions") {
          return { data: this._maybeSingle ? null : [], error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          let rows = [...state.cityRollouts];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_user_limits") {
          let rows = [...state.userLimits];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "buddy_availability_exceptions") {
          let rows = [...state.availabilityExceptions];
          for (const [op, col, val] of this._filters) {
            if (op === "eq")  rows = rows.filter((r: any) => r[col] === val);
            if (op === "lte") rows = rows.filter((r: any) => r[col] <= val);
            if (op === "gte") rows = rows.filter((r: any) => r[col] >= val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (this._maybeSingle) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    // The earnings ledger is one SQL function since migration 3824, and a
    // booking whose ledger cannot be posted is REFUSED (there is no JavaScript
    // fallback). The function answers "posted" unless a case sets
    // `state.ledger`; every other function stays absent, as it was with no `.rpc`.
    rpc: async (fn: string, args: any) => {
      if (fn !== "rb_post_booking_ledger") return functionNotFound(fn);
      (state.ledgerCalls ??= []).push(args);
      if (state.ledger === "absent") return functionNotFound(fn);
      if (state.ledger === "error") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      // The posting COMMITS, once per booking.
      const ledgered = (state.ledgered ??= []);
      const replay = ledgered.includes(args.p_booking_id);
      if (!replay) ledgered.push(args.p_booking_id);
      if (state.ledger === "lost-always" || (state.ledger === "lost" && !replay)) return answerLost();
      const posted = acceptedLedgerPosting(args);
      if (replay) Object.assign(posted.data, { replayed: true, entries_appended: 0 });
      return posted;
    },
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const FUTURE_DATE = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
const OTHER_DATE  = new Date(Date.now() + 86400000 * 20).toISOString().slice(0, 10);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddySpecRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = {
    buddyProfiles: [
      {
        id: BUDDY_PROF, user_id: BUDDY_USER,
        status: "active", admin_status: "active", verified: true,
        categories: ["city", "food"],
      },
    ],
    availabilityExceptions: [],
    insertedBookings: [],
    // Gate stack open by default so the availability cases below keep testing
    // availability rather than the gates. Each gate case closes exactly one.
    //
    // "public_mvp", not "live": the status string is matched against
    // KNOWN_CITY_STATUSES in rentABuddyRollout.ts, and anything outside that
    // set hits the deliberate fail-closed branch and 403s with
    // city_not_available. "live" is not a rollout status and never was — the
    // fixture invented it, so every case in this describe block was rejected by
    // the gate before reaching the availability logic it was written to test.
    // The guard behaved correctly; the fixture named a state that does not
    // exist. KNOWN_CITY_STATUSES is the source of truth for this value.
    featureFlags: OPEN_FLAGS(),
    cityRollouts: [{ city: "Seoul", status: "public_mvp", is_active: true }],
    userLimits: [],
  };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

function requestBody(overrides: Record<string, unknown> = {}) {
  return { bookingDate: FUTURE_DATE, durationH: 3, city: "Seoul", category: "city", ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Spec router booking request — blocked-date enforcement", () => {
  it("rejects a request on a single blocked date with 409 buddy_unavailable", async () => {
    state.availabilityExceptions = [
      { id: "ex-1", buddy_id: BUDDY_PROF, exception_date: FUTURE_DATE, end_date: null, exception_type: "blocked" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("rejects a request inside a vacation range with 409 buddy_unavailable", async () => {
    const rangeStart = new Date(Date.now() + 86400000 * 8).toISOString().slice(0, 10);
    const rangeEnd   = new Date(Date.now() + 86400000 * 12).toISOString().slice(0, 10);
    state.availabilityExceptions = [
      { id: "ex-2", buddy_id: BUDDY_PROF, exception_date: rangeStart, end_date: rangeEnd, exception_type: "vacation" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
    assert.match(r.body.message ?? "", /vacation/i);
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("allows a request on a free date (201) even when other dates are blocked", async () => {
    state.availabilityExceptions = [
      { id: "ex-3", buddy_id: BUDDY_PROF, exception_date: FUTURE_DATE, end_date: null, exception_type: "blocked" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody({ bookingDate: OTHER_DATE }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.booking_date, OTHER_DATE);
    assert.equal(r.body.booking?.status, "pending");
    assert.equal(state.insertedBookings.length, 1);
  });

  it("allows a request when the buddy has no availability exceptions at all (201)", async () => {
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.city, "Seoul");
    assert.equal(r.body.booking?.category, "city");
    assert.equal(state.insertedBookings.length, 1);
  });
});

// ── PAY-050: the fifth creation path does not seat an unledgered booking ──────
//
// This route ended `createEarningsLedgerEntry(...).catch(() => {})` like the
// other four. The other four are driven by rentABuddyGateConsolidation.test.ts;
// this is the same assertion for the spec request, on stored state.

describe("Spec router booking request — a booking that cannot be ledgered is refused and withdrawn", () => {
  it("CONTROL: the ledger is posted once, for the booking that was inserted", async () => {
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(state.insertedBookings.length, 1);
    assert.deepEqual(state.ledgerCalls, [{
      p_booking_id: state.insertedBookings[0].id, p_event: "booking_created", p_event_key: null, p_args: {},
    }]);
  });

  for (const [ledger, error, posts] of [["absent", "ledger_unavailable", 1], ["error", "ledger_write_failed", 2]] as const) {
    it(`posting ${ledger} → 503 ${error}; no booking row remains and none is returned`, async () => {
      state.ledger = ledger;
      const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, error);
      assert.equal(r.body.retryable, true);
      assert.equal(r.body.booking, undefined);
      // A function that is NOT THERE is a definite answer: one attempt. A call
      // that ERRORED may have committed, so it is confirmed by exactly one
      // idempotent re-post before the booking is withdrawn.
      assert.equal(state.ledgerCalls?.length, posts, "an unknown result is confirmed once; a definite one is not re-posted");
      assert.equal(state.insertedBookings.length, 0,
        "a booking exists with no earnings ledger — the state PAY-050 is about");
      assert.equal(JSON.stringify(r.body).includes("statement timeout"), false, "the database's message is for the log");
    });
  }
});

// ── The posting committed and its answer was lost ─────────────────────────────
//
// Independent verification of PR #603: the route answered 503 "not created, try
// again" over a booking and a ledger that both existed (the DELETE of a ledgered
// booking is refused by 3510), and the retry made a second booking.

describe("Spec router booking request — a committed posting whose answer is lost is ONE booking, never a 503", () => {
  it("the answer is lost once → confirmed by the re-post; 201 and exactly one booking and one ledger", async () => {
    state.ledger = "lost";
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(state.insertedBookings.length, 1);
    assert.deepEqual(state.ledgered, [state.insertedBookings[0].id]);
    assert.equal(state.ledgerCalls?.length, 2);
    assert.equal(state.refusedWithdrawals, undefined, "no withdrawal may be attempted before the re-post");
  });

  it("every answer is lost → the withdrawal is refused, so the booking exists and is returned (201)", async () => {
    state.ledger = "lost-always";
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.id, state.insertedBookings[0].id);
    assert.equal(state.insertedBookings.length, 1);
    assert.deepEqual(state.ledgered, [state.insertedBookings[0].id]);
    assert.deepEqual(state.refusedWithdrawals, [state.insertedBookings[0].id]);
  });

  it("a request retried with its Idempotency-Key returns the ORIGINAL booking — one booking, one ledger", async () => {
    const key = { "idempotency-key": "spec-attempt-000001" };
    const first = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody(), FAKE_TOKEN, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(state.insertedBookings[0].creation_key, `request:${BUDDY_PROF}:spec-attempt-000001`);
    const second = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody(), FAKE_TOKEN, key);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.booking.id, first.body.booking.id);
    assert.equal(state.insertedBookings.length, 1, "a retried request made a second booking");
    assert.deepEqual(state.ledgered, [first.body.booking.id]);
    // A different attempt (a new key) is a new booking.
    const other = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody({ bookingDate: OTHER_DATE }), FAKE_TOKEN, { "idempotency-key": "spec-attempt-000002" });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(state.insertedBookings.length, 2);
  });

  it("a malformed Idempotency-Key → 400, and nothing is created", async () => {
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody(), FAKE_TOKEN, { "idempotency-key": "bad key" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_idempotency_key");
    assert.equal(state.insertedBookings.length, 0);
  });

  it("the request awaits the buddy and expires 24 h after it was made", async () => {
    const before = Date.now();
    const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, requestBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = state.insertedBookings[0];
    assert.equal(row.status, "pending");
    assert.ok(typeof row.expires_at === "string", "a pending request with no expires_at never expires");
    const ms = new Date(row.expires_at).getTime() - before;
    assert.ok(ms > 23.9 * 3600_000 && ms < 24.1 * 3600_000, `expires_at is ${ms / 3600_000} h after creation`);
  });
});
