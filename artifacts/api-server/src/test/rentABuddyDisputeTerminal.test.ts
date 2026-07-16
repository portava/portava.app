/**
 * Rent a Buddy — dispute terminal-status guard tests
 *
 * POST /api/rent-a-buddy/bookings/:id/dispute must reject with 409 when the
 * booking is already in a terminal status (completed or cancelled). Filing a
 * dispute against a terminal booking would corrupt its final state.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyDisputeTerminal.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const TRAVELER_TOKEN  = "dt-traveler-token";
const BUDDY_TOKEN     = "dt-buddy-token";
const TRAVELER_ID     = "dt-traveler-user-1";
const BUDDY_USER_ID   = "dt-buddy-user-1";
const BUDDY_PROF_ID   = "dt-buddy-profile-1";
const BOOKING_ID      = "dt-booking-uuid-1";

const TOKEN_MAP: Record<string, string> = {
  [TRAVELER_TOKEN]: TRAVELER_ID,
  [BUDDY_TOKEN]:    BUDDY_USER_ID,
};

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = TRAVELER_TOKEN,
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

interface DTState {
  bookings:      Record<string, any>;
  buddyProfiles: Record<string, any>;
  disputes:      any[];
}

let state: DTState = { bookings: {}, buddyProfiles: {}, disputes: [] };

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table:       table,
      _filters:     [] as Array<[string, string, any]>,
      _insertData:  null as any,
      _updateData:  null as any,
      _maybeSingle: false,
      _limit:       1000,

      select()                { return this; },
      insert(data: any)       { this._insertData = data; return this; },
      update(data: any)       { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      order()                 { return this; },
      limit(n: number)        { this._limit = n; return this; },
      maybeSingle()           { this._maybeSingle = true; return this; },
      single()                { this._maybeSingle = true; return this; },
      // unused filter helpers needed by the router internals
      or()                    { return this; },
      lte()                   { return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_disputes") state.disputes.push(row);
          if (this._maybeSingle) return { data: row, error: null };
          return { data: null, error: null };
        }

        if (this._updateData !== null) {
          if (t === "rent_buddy_bookings") {
            for (const [, col, val] of this._filters) {
              if (col === "id" && state.bookings[val]) {
                Object.assign(state.bookings[val], this._updateData);
              }
            }
          }
          return { data: null, error: null };
        }

        // Selects
        if (t === "feature_flags") {
          // requireRentBuddyEnabled always enabled in these tests
          if (this._maybeSingle) return { data: { flag: "rent_buddy_enabled", enabled: true }, error: null };
          return { data: [{ flag: "rent_buddy_enabled", enabled: true }], error: null };
        }

        if (t === "rent_buddy_bookings") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: state.bookings[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.bookings), error: null };
        }

        if (t === "rent_buddy_profiles") {
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          if (eqId && this._maybeSingle)   return { data: state.buddyProfiles[eqId[2]] ?? null, error: null };
          if (eqUser && this._maybeSingle) {
            const match = Object.values(state.buddyProfiles).find((p: any) => p.user_id === eqUser[2]);
            return { data: match ?? null, error: null };
          }
          return { data: Object.values(state.buddyProfiles), error: null };
        }

        if (this._maybeSingle) return { data: null, error: null };
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
  app.use(rentABuddyRouter);

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
        id:          BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id:    BUDDY_PROF_ID,
        status:      "in_progress",
        dispute_window_expires_at: null,
      },
    },
    buddyProfiles: {
      [BUDDY_PROF_ID]: { id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID },
    },
    disputes: [],
  };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/rent-a-buddy/bookings/:id/dispute — terminal-status guard", () => {
  it("returns 200 for an in_progress booking (baseline — guard must not fire)", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.ok(
      r.status === 200 || r.status === 201,
      `expected 2xx for in_progress booking, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
  });

  it("returns 409 when booking status is 'completed'", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.equal(r.status, 409, `expected 409 for completed booking, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_transition");
  });

  it("returns 409 when booking status is 'cancelled'", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.equal(r.status, 409, `expected 409 for cancelled booking, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_transition");
  });

  it("does not insert a dispute row when the booking is completed", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.equal(state.disputes.length, 0, "no dispute row must be inserted for a completed booking");
  });

  it("does not insert a dispute row when the booking is cancelled", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.equal(state.disputes.length, 0, "no dispute row must be inserted for a cancelled booking");
  });

  it("buddy party also gets 409 when booking is completed", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" }, BUDDY_TOKEN);
    assert.equal(r.status, 409, `expected 409 for completed booking (buddy), got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_transition");
  });

  it("buddy party also gets 409 when booking is cancelled", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" }, BUDDY_TOKEN);
    assert.equal(r.status, 409, `expected 409 for cancelled booking (buddy), got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_transition");
  });

  it("the 409 response includes the currentStatus field", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "no_show" });
    assert.equal(r.body.currentStatus, "completed", "response must echo the booking status that caused the rejection");
  });
});
