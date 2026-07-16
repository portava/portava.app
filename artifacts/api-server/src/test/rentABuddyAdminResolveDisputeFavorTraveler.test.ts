/**
 * Rent a Buddy — admin resolve-dispute favorTraveler flag tests
 *
 * POST /api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute must set the
 * booking status to 'cancelled' when favorTraveler === true, and 'completed' when
 * favorTraveler is false or absent.  The response body must echo the correct
 * bookingStatus in both cases.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyAdminResolveDisputeFavorTraveler.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";

// ── IDs / tokens ───────────────────────────────────────────────────────────────

const ADMIN_TOKEN   = "aft-admin-token";
const ADMIN_ID      = "aft-admin-user-1";
const TRAVELER_ID   = "aft-traveler-user-1";
const BUDDY_PROF_ID = "aft-buddy-profile-1";
const BOOKING_ID    = "aft-booking-uuid-1";
const DISPUTE_ID    = "aft-dispute-uuid-1";

const TOKEN_MAP: Record<string, string> = {
  [ADMIN_TOKEN]: ADMIN_ID,
};

// ── HTTP helper ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = ADMIN_TOKEN,
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

// ── Fake client state ──────────────────────────────────────────────────────────

interface AFTState {
  bookings:       Record<string, any>;
  profiles:       Record<string, any>;
  disputes:       Record<string, any>;
  adminActions:   any[];
  bookingUpdates: any[];
  disputeUpdates: any[];
}

let state: AFTState;

function resetState(): void {
  state = {
    bookings: {
      [BOOKING_ID]: {
        id:          BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id:    BUDDY_PROF_ID,
        status:      "disputed",
      },
    },
    profiles: {
      [ADMIN_ID]: { id: ADMIN_ID, role: "admin" },
    },
    disputes: {
      [DISPUTE_ID]: {
        id:         DISPUTE_ID,
        booking_id: BOOKING_ID,
        status:     "open",
        reason:     "quality",
        raised_by:  TRAVELER_ID,
      },
    },
    adminActions:   [],
    bookingUpdates: [],
    disputeUpdates: [],
  };
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table:      table,
      _filters:    [] as Array<[string, string, any]>,
      _inFilters:  [] as Array<[string, string, any[]]>,
      _insertData: null as any,
      _updateData: null as any,
      _isSingle:   false,

      select()               { return this; },
      insert(data: any)      { this._insertData = data; return this; },
      update(data: any)      { this._updateData = data; return this; },
      eq(col: string, val: any)          { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[])       { this._inFilters.push(["in", col, vals]); return this; },
      order()                { return this; },
      maybeSingle()          { this._isSingle = true; return this; },
      single()               { this._isSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // ── inserts ────────────────────────────────────────────────────────────
        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_admin_actions") state.adminActions.push(row);
          if (this._isSingle) return { data: row, error: null };
          return { data: null, error: null };
        }

        // ── updates ────────────────────────────────────────────────────────────
        if (this._updateData !== null) {
          if (t === "rent_buddy_bookings") {
            const eqId = this._filters.find(([, col]) => col === "id");
            if (eqId && state.bookings[eqId[2]]) {
              state.bookingUpdates.push({ id: eqId[2], ...this._updateData });
              Object.assign(state.bookings[eqId[2]], this._updateData);
            }
            if (this._isSingle) return { data: null, error: null };
            return { data: null, error: null };
          }
          if (t === "rent_buddy_disputes") {
            const eqBooking = this._filters.find(([, col]) => col === "booking_id");
            const inStatus  = this._inFilters.find(([, col]) => col === "status");
            const match = Object.values(state.disputes).find((d: any) =>
              (!eqBooking || d.booking_id === eqBooking[2]) &&
              (!inStatus  || inStatus[2].includes(d.status))
            );
            if (match) {
              state.disputeUpdates.push({ id: match.id, ...this._updateData });
              Object.assign(match, this._updateData);
              if (this._isSingle) return { data: match, error: null };
              return { data: [match], error: null };
            }
            if (this._isSingle) return { data: null, error: { message: "no dispute found" } };
            return { data: [], error: null };
          }
          return { data: null, error: null };
        }

        // ── selects ────────────────────────────────────────────────────────────
        if (t === "profiles") {
          const eqId = this._filters.find(([, col]) => col === "id");
          if (eqId && this._isSingle) return { data: state.profiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.profiles), error: null };
        }

        if (t === "rent_buddy_bookings") {
          const eqId = this._filters.find(([, col]) => col === "id");
          if (eqId && this._isSingle) return { data: state.bookings[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.bookings), error: null };
        }

        if (t === "rent_buddy_disputes") {
          const eqBooking = this._filters.find(([, col]) => col === "booking_id");
          const inStatus  = this._inFilters.find(([, col]) => col === "status");
          const matches = Object.values(state.disputes).filter((d: any) =>
            (!eqBooking || d.booking_id === eqBooking[2]) &&
            (!inStatus  || inStatus[2].includes(d.status))
          );
          if (this._isSingle) return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }

        if (this._isSingle) return { data: null, error: null };
        return { data: [], error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        const id = TOKEN_MAP[token];
        if (!id) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id } }, error: null };
      },
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

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
  resetState();
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const BASE_BODY = { resolution: "reviewed", note: "Admin decision." };

describe("POST /api/rent-a-buddy/admin/bookings/:id/resolve-dispute — favorTraveler flag", () => {

  // ── favorTraveler === true → 'cancelled' ──────────────────────────────────

  it("sets booking status to 'cancelled' when favorTraveler is true", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: true },
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      state.bookings[BOOKING_ID].status,
      "cancelled",
      `booking.status should be 'cancelled' when favorTraveler=true, got '${state.bookings[BOOKING_ID].status}'`,
    );
  });

  it("echoes bookingStatus='cancelled' in the response body when favorTraveler is true", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: true },
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body.bookingStatus,
      "cancelled",
      `response.bookingStatus should be 'cancelled' when favorTraveler=true, got '${r.body.bookingStatus}'`,
    );
  });

  it("records a booking status update to 'cancelled' when favorTraveler is true", async () => {
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: true },
    );
    const statusUpdates = state.bookingUpdates.filter((u: any) => "status" in u);
    assert.equal(
      statusUpdates.length,
      1,
      "exactly one booking status update must be recorded",
    );
    assert.equal(
      statusUpdates[0].status,
      "cancelled",
      `booking update must carry status='cancelled', got '${statusUpdates[0].status}'`,
    );
  });

  // ── favorTraveler === false → 'completed' ─────────────────────────────────

  it("sets booking status to 'completed' when favorTraveler is false", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: false },
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      state.bookings[BOOKING_ID].status,
      "completed",
      `booking.status should be 'completed' when favorTraveler=false, got '${state.bookings[BOOKING_ID].status}'`,
    );
  });

  it("echoes bookingStatus='completed' in the response body when favorTraveler is false", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: false },
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body.bookingStatus,
      "completed",
      `response.bookingStatus should be 'completed' when favorTraveler=false, got '${r.body.bookingStatus}'`,
    );
  });

  it("records a booking status update to 'completed' when favorTraveler is false", async () => {
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: false },
    );
    const statusUpdates = state.bookingUpdates.filter((u: any) => "status" in u);
    assert.equal(
      statusUpdates.length,
      1,
      "exactly one booking status update must be recorded",
    );
    assert.equal(
      statusUpdates[0].status,
      "completed",
      `booking update must carry status='completed', got '${statusUpdates[0].status}'`,
    );
  });

  // ── favorTraveler absent → 'completed' ────────────────────────────────────

  it("sets booking status to 'completed' when favorTraveler is absent", async () => {
    // favorTraveler not sent at all
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      BASE_BODY,
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      state.bookings[BOOKING_ID].status,
      "completed",
      `booking.status should be 'completed' when favorTraveler is absent, got '${state.bookings[BOOKING_ID].status}'`,
    );
  });

  it("echoes bookingStatus='completed' in the response body when favorTraveler is absent", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      BASE_BODY,
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body.bookingStatus,
      "completed",
      `response.bookingStatus should be 'completed' when favorTraveler is absent, got '${r.body.bookingStatus}'`,
    );
  });

  // ── favorTraveler truthy non-boolean (e.g. 1) → must not set 'cancelled' ─

  it("sets booking status to 'completed' when favorTraveler is truthy but not strictly true (e.g. 1)", async () => {
    // The implementation uses favorTraveler === true (strict), so a non-boolean
    // truthy value must fall through to 'completed'.
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { ...BASE_BODY, favorTraveler: 1 },
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(
      r.body.bookingStatus,
      "completed",
      `strict-equality check: favorTraveler=1 must NOT trigger 'cancelled', got '${r.body.bookingStatus}'`,
    );
    assert.equal(
      state.bookings[BOOKING_ID].status,
      "completed",
      `booking.status must be 'completed' for favorTraveler=1, got '${state.bookings[BOOKING_ID].status}'`,
    );
  });
});
