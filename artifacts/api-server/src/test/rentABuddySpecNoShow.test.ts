/**
 * Rent a Buddy Spec router — report-no-show grace period tests
 *
 * The canonical POST /api/rent-a-buddy/bookings/:id/report-no-show must:
 *   1. Create a rent_buddy_safety_events row (event_type = "no_show")
 *   2. Update booking status to "no_show_pending"
 *   3. Set no_show_grace_expires_at to ~2 hours from now
 *   4. Return gracePeriodExpiresAt in the response
 *
 * Run: node --import tsx/esm --test src/test/rentABuddySpecNoShow.test.ts
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

const TRAVELER_TOKEN = "ns-traveler-token";
const BUDDY_TOKEN    = "ns-buddy-token";
const OTHER_TOKEN    = "ns-other-token";
const TRAVELER_ID    = "ns-traveler-user-1";
const BUDDY_USER_ID  = "ns-buddy-user-1";
const BUDDY_PROF_ID  = "ns-buddy-profile-1";
const OTHER_USER_ID  = "ns-other-user-1";
const BOOKING_ID     = "ns-booking-uuid-1";

const TOKEN_MAP: Record<string, string> = {
  [TRAVELER_TOKEN]: TRAVELER_ID,
  [BUDDY_TOKEN]:    BUDDY_USER_ID,
  [OTHER_TOKEN]:    OTHER_USER_ID,
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

interface NSState {
  bookings:       Record<string, any>;
  buddyProfiles:  Record<string, any>;
  safetyEvents:   any[];
}

let state: NSState = { bookings: {}, buddyProfiles: {}, safetyEvents: [] };

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table:       table,
      _filters:     [] as Array<[string, string, any]>,
      _insertData:  null as any,
      _updateData:  null as any,
      _maybeSingle: false,

      select()              { return this; },
      insert(data: any)     { this._insertData = data; return this; },
      update(data: any)     { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      maybeSingle()         { this._maybeSingle = true; return this; },
      single()              { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_safety_events") state.safetyEvents.push(row);
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

        // FIXTURE, not behaviour. POST /rent-a-buddy/bookings/:id/report-no-show
        // writes a rent_buddy_safety_event and moves the booking status, so it
        // now clears the Rent-a-Buddy master switch like every other write
        // handler in the lane. This fake fell through to `{ data: null }` for
        // feature_flags, which a real database reports as "the flag row does not
        // exist" — the lane is off — and the handler correctly 403s. The
        // assertions below are about no-show semantics, not about the master
        // switch, so the fixture is corrected to describe a database in which
        // Rent-a-Buddy is enabled. Nothing here is relaxed.
        if (t === "feature_flags") {
          const eqFlag = this._filters.find(([op, col]) => op === "eq" && col === "flag");
          const flag = eqFlag ? eqFlag[2] : null;
          const row = flag ? { flag, enabled: true } : null;
          if (this._maybeSingle) return { data: row, error: null };
          return { data: row ? [row] : [], error: null };
        }

        if (t === "rent_buddy_bookings") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: state.bookings[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.bookings), error: null };
        }

        if (t === "rent_buddy_profiles") {
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqUser && this._maybeSingle) {
            const match = Object.values(state.buddyProfiles).find((p: any) => p.user_id === eqUser[2]);
            return { data: match ?? null, error: null };
          }
          if (eqId && this._maybeSingle) return { data: state.buddyProfiles[eqId[2]] ?? null, error: null };
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
    bookings: {
      [BOOKING_ID]: {
        id:          BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id:    BUDDY_PROF_ID,
        status:      "confirmed",
      },
    },
    buddyProfiles: {
      [BUDDY_PROF_ID]: { id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID },
    },
    safetyEvents: [],
  };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/rent-a-buddy/bookings/:id/report-no-show — spec router", () => {
  it("returns 201 and gracePeriodExpiresAt when traveler reports a no-show", async () => {
    const before = Date.now();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "buddy never arrived" });
    const after = Date.now();

    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.gracePeriodExpiresAt, "response must include gracePeriodExpiresAt");

    const expiry = new Date(r.body.gracePeriodExpiresAt).getTime();
    assert.ok(expiry > before + 1.9 * 3600 * 1000, "grace expiry should be ~2h from now");
    assert.ok(expiry < after  + 2.1 * 3600 * 1000, "grace expiry should not be more than 2h+buffer from now");
  });

  it("creates a no_show safety event", async () => {
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    const event = state.safetyEvents.find((e) => e.event_type === "no_show");
    assert.ok(event, "should have inserted a no_show safety event");
    assert.equal(event.booking_id, BOOKING_ID);
    assert.equal(event.actor_user_id, TRAVELER_ID);
  });

  it("transitions the booking status to no_show_pending", async () => {
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    assert.equal(
      state.bookings[BOOKING_ID].status,
      "no_show_pending",
      "booking status should be no_show_pending",
    );
  });

  it("sets no_show_grace_expires_at on the booking", async () => {
    const before = Date.now();
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    const expiry = state.bookings[BOOKING_ID].no_show_grace_expires_at;
    assert.ok(expiry, "booking should have no_show_grace_expires_at");
    assert.ok(
      new Date(expiry).getTime() > before + 1.9 * 3600 * 1000,
      "grace expiry should be ~2h from now",
    );
  });

  it("also works when the buddy party reports the no-show", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.gracePeriodExpiresAt, "response must include gracePeriodExpiresAt");
    assert.equal(state.bookings[BOOKING_ID].status, "no_show_pending");
  });

  it("returns 403 for a non-party caller", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, {}, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("returns 404 for an unknown booking", async () => {
    const r = await req("POST", `/api/rent-a-buddy/bookings/unknown-booking/report-no-show`);
    assert.equal(r.status, 404);
  });

  it("returns 409 when the same party reports a no-show a second time (no_show_pending)", async () => {
    // First report succeeds
    const first = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "first report" });
    assert.equal(first.status, 201, `first call should be 201, got ${first.status}: ${JSON.stringify(first.body)}`);

    // Booking is now no_show_pending — second call must be rejected
    const second = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "duplicate" });
    assert.equal(second.status, 409, `second call should be 409, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 1, "no second safety event should be inserted when the guard rejects the duplicate");
  });

  it("does not insert a second safety event on a duplicate report", async () => {
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    const noShowEvents = state.safetyEvents.filter((e) => e.event_type === "no_show");
    assert.equal(noShowEvents.length, 1, "only one safety event should exist after a duplicate report");
  });

  it("returns 409 when the booking is already in disputed status", async () => {
    // Simulate a booking already in disputed state
    state.bookings[BOOKING_ID].status = "disputed";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 0, "no safety event should be inserted for a booking already in disputed status");
  });

  it("returns 409 when the buddy files a second no-show report after the first one lands", async () => {
    // Buddy files the first report — should succeed
    const first = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "traveler never arrived" }, BUDDY_TOKEN);
    assert.equal(first.status, 201, `first buddy call should be 201, got ${first.status}: ${JSON.stringify(first.body)}`);
    assert.ok(first.body.gracePeriodExpiresAt, "first response must include gracePeriodExpiresAt");

    // Booking is now no_show_pending — buddy's second call must be rejected
    const second = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "duplicate buddy report" }, BUDDY_TOKEN);
    assert.equal(second.status, 409, `second buddy call should be 409, got ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 1, "no second safety event should be inserted when the buddy's duplicate is rejected");
  });

  it("returns 409 when the traveler tries to report after the buddy already filed a no-show", async () => {
    // Buddy files first — should succeed
    const buddyReport = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "traveler never arrived" }, BUDDY_TOKEN);
    assert.equal(buddyReport.status, 201, `buddy call should be 201, got ${buddyReport.status}: ${JSON.stringify(buddyReport.body)}`);

    // Booking is now no_show_pending — traveler's subsequent call must also be rejected
    const travelerReport = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "cross-party duplicate" }, TRAVELER_TOKEN);
    assert.equal(travelerReport.status, 409, `traveler cross-party call should be 409, got ${travelerReport.status}: ${JSON.stringify(travelerReport.body)}`);
    assert.equal(travelerReport.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 1, "no second safety event should be inserted when the cross-party duplicate is rejected");
  });

  it("returns 409 when the booking is already completed", async () => {
    state.bookings[BOOKING_ID].status = "completed";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    assert.equal(r.status, 409, `expected 409 for completed booking, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 0, "no safety event should be inserted for a completed booking");
  });

  it("returns 409 when the booking is already cancelled", async () => {
    state.bookings[BOOKING_ID].status = "cancelled";
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`);
    assert.equal(r.status, 409, `expected 409 for cancelled booking, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "already_reported");
    assert.equal(state.safetyEvents.length, 0, "no safety event should be inserted for a cancelled booking");
  });
});

// ── no_show_count increment guard tests ───────────────────────────────────────

const RD_ADMIN_TOKEN   = "rd-admin-token";
const RD_ADMIN_ID      = "rd-admin-user-1";
const RD_TRAVELER_ID   = "rd-traveler-user-1";
const RD_BUDDY_PROF_ID = "rd-buddy-prof-1";
const RD_BUDDY_USER_ID = "rd-buddy-user-1";
const RD_BOOKING_ID    = "rd-booking-uuid-2";
const RD_DISPUTE_ID    = "rd-dispute-uuid-1";

interface RdState {
  booking:       any;
  dispute:       any;
  buddyProfile:  any;
}

let rdState: RdState = { booking: null, dispute: null, buddyProfile: null };

function makeBaseDispute(overrides: Partial<{ reason: string; raised_by: string }> = {}) {
  return {
    id:          RD_DISPUTE_ID,
    booking_id:  RD_BOOKING_ID,
    status:      "open",
    reason:      overrides.reason  ?? "no_show",
    raised_by:   overrides.raised_by ?? RD_TRAVELER_ID,
  };
}

function makeResolveClient() {
  function fakeTable(table: string) {
    return {
      _table:       table,
      _filters:     [] as Array<[string, string, any]>,
      _insertData:  null as any,
      _updateData:  null as any,
      _isSingle:    false,
      _isMaybe:     false,
      _doSelect:    false,

      select()                  { this._doSelect = true; return this; },
      insert(data: any)         { this._insertData = data; return this; },
      update(data: any)         { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      maybeSingle()             { this._isMaybe  = true; return this; },
      single()                  { this._isSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // ── INSERT ──────────────────────────────────────────────────────────
        if (this._insertData !== null) {
          const row = { id: `gen-${Date.now()}`, ...this._insertData };
          return { data: row, error: null };
        }

        // ── UPDATE ──────────────────────────────────────────────────────────
        if (this._updateData !== null) {
          if (t === "rent_buddy_bookings") {
            Object.assign(rdState.booking, this._updateData);
            return { data: rdState.booking, error: null };
          }
          if (t === "rent_buddy_disputes") {
            // Only update if the status filter matches
            const inF = this._filters.find(([op, col]) => op === "in" && col === "status");
            const statusOk = !inF || (inF[2] as string[]).includes(rdState.dispute?.status);
            if (!statusOk || !rdState.dispute) {
              return { data: null, error: { message: "no matching dispute" } };
            }
            Object.assign(rdState.dispute, this._updateData);
            const row = { ...rdState.dispute };
            return { data: row, error: null };
          }
          if (t === "rent_buddy_profiles") {
            Object.assign(rdState.buddyProfile, this._updateData);
            return { data: rdState.buddyProfile, error: null };
          }
          return { data: null, error: null };
        }

        // ── SELECT ──────────────────────────────────────────────────────────
        if (t === "profiles") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId?.[2] === RD_ADMIN_ID) return { data: { role: "admin" }, error: null };
          return { data: null, error: null };
        }

        if (t === "rent_buddy_bookings") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId?.[2] === rdState.booking?.id) return { data: rdState.booking, error: null };
          return { data: null, error: null };
        }

        if (t === "rent_buddy_disputes") {
          const eqBooking = this._filters.find(([op, col]) => op === "eq" && col === "booking_id");
          const inStatus  = this._filters.find(([op, col]) => op === "in" && col === "status");
          if (eqBooking?.[2] === rdState.dispute?.booking_id) {
            const statusOk = !inStatus || (inStatus[2] as string[]).includes(rdState.dispute.status);
            if (statusOk) return { data: rdState.dispute, error: null };
          }
          return { data: null, error: null };
        }

        if (t === "rent_buddy_profiles") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId?.[2] === rdState.buddyProfile?.id) return { data: rdState.buddyProfile, error: null };
          return { data: null, error: null };
        }

        if (this._isSingle || this._isMaybe) return { data: null, error: null };
        return { data: [], error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        if (token === RD_ADMIN_TOKEN) return { data: { user: { id: RD_ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

describe("POST resolve-dispute — no_show_count increment guard", () => {
  beforeEach(() => {
    rdState = {
      booking: {
        id:          RD_BOOKING_ID,
        traveler_id: RD_TRAVELER_ID,
        buddy_id:    RD_BUDDY_PROF_ID,
        status:      "disputed",
      },
      dispute: makeBaseDispute(),
      buddyProfile: {
        id:           RD_BUDDY_PROF_ID,
        user_id:      RD_BUDDY_USER_ID,
        no_show_count: 0,
      },
    };
    const client = makeResolveClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("increments no_show_count when reason is no_show, raised by traveler, resolved as cancelled", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${RD_BOOKING_ID}/resolve-dispute`,
      { resolution: "confirmed_no_show", favorTraveler: true },
      RD_ADMIN_TOKEN,
    );
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      rdState.buddyProfile.no_show_count,
      1,
      "no_show_count should increment when all conditions are met",
    );
  });

  it("does NOT increment no_show_count when reason is not no_show (e.g. quality)", async () => {
    rdState.dispute = makeBaseDispute({ reason: "quality" });
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${RD_BOOKING_ID}/resolve-dispute`,
      { resolution: "quality_issue", favorTraveler: true },
      RD_ADMIN_TOKEN,
    );
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      rdState.buddyProfile.no_show_count,
      0,
      "no_show_count must not increment when dispute reason is not no_show",
    );
  });

  it("does NOT increment no_show_count when the dispute was raised by the buddy (not the traveler)", async () => {
    rdState.dispute = makeBaseDispute({ raised_by: RD_BUDDY_USER_ID });
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${RD_BOOKING_ID}/resolve-dispute`,
      { resolution: "confirmed_no_show", favorTraveler: true },
      RD_ADMIN_TOKEN,
    );
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      rdState.buddyProfile.no_show_count,
      0,
      "no_show_count must not increment when dispute was raised by the buddy",
    );
  });

  it("does NOT increment no_show_count when resolved as completed (favorTraveler=false)", async () => {
    const r = await req(
      "POST",
      `/api/rent-a-buddy/admin/bookings/${RD_BOOKING_ID}/resolve-dispute`,
      { resolution: "session_completed", favorTraveler: false },
      RD_ADMIN_TOKEN,
    );
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      rdState.buddyProfile.no_show_count,
      0,
      "no_show_count must not increment when booking is resolved as completed",
    );
  });
});
