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
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
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

      select() { return this; },
      insert(data: any) { this._insertData = data; return this; },
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
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

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
    featureFlags: OPEN_FLAGS(),
    cityRollouts: [{ city: "Seoul", status: "live", is_active: true }],
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
