/**
 * Rent a Buddy — admin resolve-dispute non-disputed guard tests
 *
 * POST /api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute must reject
 * with 409 when the booking is not in `disputed` status (e.g. already `completed`
 * or `cancelled`), preventing accidental double-resolution.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyAdminResolveDisputeGuard.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";

// ── IDs / tokens ───────────────────────────────────────────────────────────────

const ADMIN_TOKEN    = "ard-admin-token";
const ADMIN_ID       = "ard-admin-user-1";
const TRAVELER_ID    = "ard-traveler-user-1";
const BUDDY_PROF_ID  = "ard-buddy-profile-1";
const BOOKING_ID     = "ard-booking-uuid-1";
const DISPUTE_ID     = "ard-dispute-uuid-1";

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

// ── Fake client state ─────────────────────────────────────────────────────────

interface ARDState {
  bookings:      Record<string, any>;
  profiles:      Record<string, any>;
  disputes:      Record<string, any>;
  adminActions:  any[];
  bookingUpdates: any[];
  disputeUpdates: any[];
}

let state: ARDState;

function resetState(bookingStatus: string): void {
  state = {
    bookings: {
      [BOOKING_ID]: {
        id:          BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id:    BUDDY_PROF_ID,
        status:      bookingStatus,
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
            // Find matching dispute by booking_id + status in (open/reviewing)
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
            // No matching open dispute — return not-found equivalent
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
  resetState("disputed");
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/rent-a-buddy/admin/bookings/:id/resolve-dispute — non-disputed guard", () => {
  const RESOLVE_BODY = { resolution: "resolved_in_favour_of_buddy", note: "Admin reviewed evidence." };

  it("returns 2xx for a disputed booking (baseline — guard must not fire)", async () => {
    // bookingStatus starts as 'disputed' from beforeEach
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.ok(
      r.status >= 200 && r.status < 300,
      `expected 2xx for disputed booking, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
  });

  it("returns 409 when booking status is 'completed'", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      r.status, 409,
      `expected 409 for completed booking, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body.error, "invalid_transition");
  });

  it("returns 409 when booking status is 'cancelled'", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      r.status, 409,
      `expected 409 for cancelled booking, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body.error, "invalid_transition");
  });

  it("does not update the dispute row when booking is 'completed'", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      state.disputeUpdates.length, 0,
      "no dispute row must be updated when booking is already completed",
    );
    // Dispute remains open
    assert.equal(
      state.disputes[DISPUTE_ID].status, "open",
      "dispute status must remain 'open' when the guard fires",
    );
  });

  it("does not update the dispute row when booking is 'cancelled'", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      state.disputeUpdates.length, 0,
      "no dispute row must be updated when booking is already cancelled",
    );
    assert.equal(
      state.disputes[DISPUTE_ID].status, "open",
      "dispute status must remain 'open' when the guard fires",
    );
  });

  it("does not change the booking status when booking is 'completed'", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    const updates = state.bookingUpdates.filter((u: any) => "status" in u);
    assert.equal(
      updates.length, 0,
      "booking status must not be written when the guard fires on a completed booking",
    );
    assert.equal(
      state.bookings[BOOKING_ID].status, "completed",
      "booking must remain 'completed' — no spurious status change",
    );
  });

  it("does not change the booking status when booking is 'cancelled'", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    const updates = state.bookingUpdates.filter((u: any) => "status" in u);
    assert.equal(
      updates.length, 0,
      "booking status must not be written when the guard fires on a cancelled booking",
    );
    assert.equal(
      state.bookings[BOOKING_ID].status, "cancelled",
      "booking must remain 'cancelled' — no spurious status change",
    );
  });

  it("does not insert an admin_action record when booking is 'completed'", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      state.adminActions.length, 0,
      "no admin_action must be recorded when the status guard rejects the request",
    );
  });

  it("does not insert an admin_action record when booking is 'cancelled'", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(
      state.adminActions.length, 0,
      "no admin_action must be recorded when the status guard rejects the request",
    );
  });

  it("returns 404 when the booking does not exist", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/non-existent-booking-id/resolve-dispute`,
      RESOLVE_BODY,
    );
    assert.equal(r.status, 404, `expected 404 for missing booking, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "not_found");
  });
});
