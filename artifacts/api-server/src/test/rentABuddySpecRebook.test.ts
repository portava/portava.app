/**
 * Rent a Buddy Spec router — rebook blocked-date regression tests
 *
 * The spec router's POST /api/rent-a-buddy/bookings/:bookingId/rebook path
 * must reject dates that fall inside a buddy's blocked/vacation ranges
 * (buddy_availability_exceptions) with 409 buddy_unavailable, and still
 * allow rebooking onto free dates.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddySpecRebook.test.ts
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

const FAKE_TOKEN = "rbs-test-token";
const USER_ID    = "spec-traveler-1";
const BUDDY_PROF = "spec-buddy-profile-1";
const BOOKING_ID = "spec-booking-1";

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
  bookings: Record<string, any>;
  availabilityExceptions: any[];
  insertedBookings: any[];
}

let state: SpecState = { bookings: {}, availabilityExceptions: [], insertedBookings: [] };

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

        if (t === "rent_buddy_bookings") {
          let rows = Object.values(state.bookings);
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
  app.use(rentABuddySpecRouter);

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
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
        status: "completed", city: "Seoul", category: "city", group_size: 2,
      },
    },
    availabilityExceptions: [],
    insertedBookings: [],
  };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Spec router rebook — blocked-date enforcement", () => {
  it("rejects rebook onto a single blocked date with 409 buddy_unavailable", async () => {
    state.availabilityExceptions = [
      { id: "ex-1", buddy_id: BUDDY_PROF, exception_date: FUTURE_DATE, end_date: null, exception_type: "blocked" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      durationH: 3,
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("rejects rebook onto a date inside a vacation range with 409 buddy_unavailable", async () => {
    const rangeStart = new Date(Date.now() + 86400000 * 8).toISOString().slice(0, 10);
    const rangeEnd   = new Date(Date.now() + 86400000 * 12).toISOString().slice(0, 10);
    state.availabilityExceptions = [
      { id: "ex-2", buddy_id: BUDDY_PROF, exception_date: rangeStart, end_date: rangeEnd, exception_type: "vacation" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE, // 10 days out → inside [8, 12] range
      durationH: 3,
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
    assert.match(r.body.message ?? "", /vacation/i);
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("allows rebook onto a free date (201) even when other dates are blocked", async () => {
    state.availabilityExceptions = [
      { id: "ex-3", buddy_id: BUDDY_PROF, exception_date: FUTURE_DATE, end_date: null, exception_type: "blocked" },
    ];
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/rebook`, {
      bookingDate: OTHER_DATE,
      durationH: 3,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.booking_date, OTHER_DATE);
    assert.equal(r.body.booking?.status, "pending");
    assert.equal(r.body.rebookedFromId, BOOKING_ID);
    assert.equal(state.insertedBookings.length, 1);
  });

  it("allows rebook when the buddy has no availability exceptions at all (201)", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      durationH: 2,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.city, "Seoul");
    assert.equal(r.body.booking?.category, "city");
  });
});
