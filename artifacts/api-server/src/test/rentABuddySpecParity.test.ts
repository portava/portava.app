/**
 * Rent a Buddy Spec router — canonical-parity regression tests
 *
 * Covers three defects that let the shorthand / admin spec routes diverge from
 * the canonical rentABuddy.ts behaviour:
 *
 *   A1  POST /api/rent-a-buddy/buddies/:buddyId/request must apply the same
 *       launch-control gate as POST /rent-a-buddy/bookings — age (min_age /
 *       nightlife_min_age), require_id_verification, require_phone_verification
 *       and full_payment_required. Previously it skipped all of them, so an
 *       underage / unverified traveller blocked on the canonical path could
 *       book through this alias.
 *
 *   C1  A user whose rent_buddy_user_limits.public_meetup_required is true must
 *       be refused a private (or undeclared) meetup on that same route.
 *
 *   B2  POST /api/rent-a-buddy/admin/bookings/:id/resolve-dispute must reverse
 *       the completed_count increment when a buddy-completed booking is
 *       dispute-cancelled (favorTraveler=true), and must NOT touch the counter
 *       when the booking never reached mark-complete.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddySpecParity.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";

// ── HTTP helper ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
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

// DOB string that yields exactly `age` years old today (Jan-1 birthday, so the
// month/day adjustment in calculateUserAge never flips it either side of the
// boundary regardless of when in the year the suite runs).
function dobForAge(age: number): string {
  return `${new Date().getFullYear() - age}-01-01`;
}

// ── Shared fixtures ─────────────────────────────────────────────────────────────

const TRAVELER_TOKEN = "parity-traveler-token";
const TRAVELER_ID    = "parity-traveler-user-1";
const BUDDY_PROF     = "parity-buddy-profile-1";
const BUDDY_USER     = "parity-buddy-user-1";

const ADMIN_TOKEN    = "parity-admin-token";
const ADMIN_ID       = "parity-admin-user-1";
const BOOKING_ID     = "parity-booking-uuid-1";
const DISPUTE_ID     = "parity-dispute-uuid-1";

const OPEN_FLAGS = (): Record<string, boolean> => ({
  rent_buddy_enabled: true,
  disable_rent_buddy_booking: false,
  disable_rab_bookings: false,
  rent_buddy_allow_bookings_without_kyc: true,
});

// ══════════════════════════════════════════════════════════════════════════════
// Request-path fake (A1 + C1)
// ══════════════════════════════════════════════════════════════════════════════

interface ReqState {
  buddyProfiles: any[];
  launchControls: any[];
  travelerProfiles: any[];   // `profiles` rows read by loadTravelerIdentity
  userLimits: any[];
  availabilityExceptions: any[];
  insertedBookings: any[];
  featureFlags: Record<string, boolean>;
  cityRollouts: any[];
}

let rstate: ReqState;

function makeReqClient() {
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

      _applyEq(rows: any[]): any[] {
        let out = [...rows];
        for (const [op, col, val] of this._filters) {
          if (op === "eq") out = out.filter((r: any) => r[col] === val);
          if (op === "lte") out = out.filter((r: any) => r[col] <= val);
          if (op === "gte") out = out.filter((r: any) => r[col] >= val);
        }
        return out;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_bookings") rstate.insertedBookings.push(row);
          return { data: this._maybeSingle ? row : null, error: null };
        }

        if (t === "feature_flags") {
          const flag = this._filters.find(([op, col]) => op === "eq" && col === "flag")?.[2];
          const enabled = rstate.featureFlags[flag as string];
          if (enabled === undefined) return { data: null, error: null };
          return { data: { flag, enabled }, error: null };
        }

        const tableMap: Record<string, any[]> = {
          rent_buddy_profiles: rstate.buddyProfiles,
          rent_buddy_launch_controls: rstate.launchControls,
          profiles: rstate.travelerProfiles,
          rent_buddy_user_limits: rstate.userLimits,
          rent_buddy_city_rollouts: rstate.cityRollouts,
          buddy_availability_exceptions: rstate.availabilityExceptions,
        };
        if (t in tableMap) {
          const rows = this._applyEq(tableMap[t]);
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
        if (token === TRAVELER_TOKEN) return { data: { user: { id: TRAVELER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

function resetReqState(): void {
  rstate = {
    buddyProfiles: [
      // `country` is the server-side source of the service country: the shorthand
      // now derives it from the buddy (not the request body) to drive the A1 gate.
      { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active", verified: true, categories: ["city", "food"], country: "KR" },
    ],
    launchControls: [],
    travelerProfiles: [],
    userLimits: [],
    availabilityExceptions: [],
    insertedBookings: [],
    featureFlags: OPEN_FLAGS(),
    cityRollouts: [{ city: "Seoul", status: "public_mvp", is_active: true }],
  };
}

const FUTURE_DATE = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
function reqBody(overrides: Record<string, unknown> = {}) {
  return { bookingDate: FUTURE_DATE, durationH: 3, city: "Seoul", category: "city", ...overrides };
}

// A launch control scoped to category "city" (the fixture booking's category),
// matched by pickLaunchControl's {country:null, city:null, category} precedence.
function cityControl(overrides: Record<string, unknown> = {}) {
  return {
    country_code: null, city: null, category: "city",
    enabled: true, waitlist_only: false,
    min_age: 18, nightlife_min_age: 21,
    require_id_verification: false, require_phone_verification: false,
    full_payment_required: false,
    ...overrides,
  };
}

function verifiedAdultProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: TRAVELER_ID,
    date_of_birth: dobForAge(30),
    verification_status: "verified",   // → idVerified true
    phone_verified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Resolve-dispute-path fake (B2)
// ══════════════════════════════════════════════════════════════════════════════

interface DispState {
  profiles: Record<string, any>;      // `profiles` (admin role)
  buddyProfiles: Record<string, any>; // rent_buddy_profiles (counter target)
  bookings: Record<string, any>;
  disputes: Record<string, any>;
  bookingEvents: any[];               // buddy_booking_events
  adminActions: any[];
}

let dstate: DispState;

function makeDispClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _inFilters: [] as Array<[string, string, any[]]>,
      _insertData: null as any,
      _updateData: null as any,
      _isSingle: false,

      select() { return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[]) { this._inFilters.push(["in", col, vals]); return this; },
      order() { return this; },
      maybeSingle() { this._isSingle = true; return this; },
      single() { this._isSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_admin_actions") dstate.adminActions.push(row);
          return { data: this._isSingle ? row : null, error: null };
        }

        if (this._updateData !== null) {
          if (t === "rent_buddy_bookings") {
            const eqId = this._filters.find(([, col]) => col === "id");
            if (eqId && dstate.bookings[eqId[2]]) Object.assign(dstate.bookings[eqId[2]], this._updateData);
            return { data: null, error: null };
          }
          if (t === "rent_buddy_profiles") {
            const eqId = this._filters.find(([, col]) => col === "id");
            if (eqId && dstate.buddyProfiles[eqId[2]]) Object.assign(dstate.buddyProfiles[eqId[2]], this._updateData);
            return { data: null, error: null };
          }
          if (t === "rent_buddy_disputes") {
            const eqBooking = this._filters.find(([, col]) => col === "booking_id");
            const inStatus = this._inFilters.find(([, col]) => col === "status");
            const match = Object.values(dstate.disputes).find((d: any) =>
              (!eqBooking || d.booking_id === eqBooking[2]) &&
              (!inStatus || inStatus[2].includes(d.status)));
            if (match) {
              Object.assign(match, this._updateData);
              return { data: this._isSingle ? match : [match], error: null };
            }
            if (this._isSingle) return { data: null, error: { message: "no dispute found" } };
            return { data: [], error: null };
          }
          return { data: null, error: null };
        }

        if (t === "profiles") {
          const eqId = this._filters.find(([, col]) => col === "id");
          if (eqId && this._isSingle) return { data: dstate.profiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(dstate.profiles), error: null };
        }

        if (t === "rent_buddy_profiles") {
          const eqId = this._filters.find(([, col]) => col === "id");
          if (eqId && this._isSingle) return { data: dstate.buddyProfiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(dstate.buddyProfiles), error: null };
        }

        if (t === "rent_buddy_bookings") {
          const eqId = this._filters.find(([, col]) => col === "id");
          if (eqId && this._isSingle) return { data: dstate.bookings[eqId[2]] ?? null, error: null };
          return { data: Object.values(dstate.bookings), error: null };
        }

        if (t === "rent_buddy_disputes") {
          const eqBooking = this._filters.find(([, col]) => col === "booking_id");
          const inStatus = this._inFilters.find(([, col]) => col === "status");
          const matches = Object.values(dstate.disputes).filter((d: any) =>
            (!eqBooking || d.booking_id === eqBooking[2]) &&
            (!inStatus || inStatus[2].includes(d.status)));
          if (this._isSingle) return { data: matches[0] ?? null, error: null };
          return { data: matches, error: null };
        }

        if (t === "buddy_booking_events") {
          let rows = [...dstate.bookingEvents];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._isSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (this._isSingle) return { data: null, error: null };
        return { data: [], error: null };
      },
    };
  }

  // No `rpc` method → adjustBuddyCounter falls back to read-modify-write against
  // rent_buddy_profiles, which this fake tracks.
  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

function resetDispState(markedComplete: boolean, startingCount: number): void {
  dstate = {
    profiles: { [ADMIN_ID]: { id: ADMIN_ID, role: "admin" } },
    buddyProfiles: { [BUDDY_PROF]: { id: BUDDY_PROF, completed_count: startingCount } },
    bookings: {
      [BOOKING_ID]: { id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, status: "disputed" },
    },
    disputes: {
      [DISPUTE_ID]: { id: DISPUTE_ID, booking_id: BOOKING_ID, status: "open", reason: "quality", raised_by: TRAVELER_ID },
    },
    bookingEvents: markedComplete
      ? [{ id: "evt-1", booking_id: BOOKING_ID, event: "buddy_marked_complete", from_status: "in_progress", to_status: "completed_pending_traveler_confirmation" }]
      : [],
    adminActions: [],
  };
}

// ── Server setup ────────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddySpecRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

// ══════════════════════════════════════════════════════════════════════════════
// A1 — launch-control gate on the shorthand request route
// ══════════════════════════════════════════════════════════════════════════════

describe("A1 — shorthand /buddies/:id/request enforces the launch-control gate", () => {
  beforeEach(() => {
    resetReqState();
    const client = makeReqClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  const path = `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`;

  it("REFUSES an underage traveller (403 age_requirement) and creates no booking", async () => {
    rstate.launchControls = [cityControl({ min_age: 18 })];
    rstate.travelerProfiles = [verifiedAdultProfile({ date_of_birth: dobForAge(16) })];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "age_requirement");
    assert.equal(rstate.insertedBookings.length, 0, "underage traveller must not create a booking");
  });

  it("REFUSES a traveller with no DOB on record (403 age_verification_required)", async () => {
    rstate.launchControls = [cityControl({ min_age: 18 })];
    rstate.travelerProfiles = [verifiedAdultProfile({ date_of_birth: null })];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "age_verification_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("REFUSES an ID-unverified traveller when require_id_verification is on (403 verification_required)", async () => {
    rstate.launchControls = [cityControl({ require_id_verification: true })];
    rstate.travelerProfiles = [verifiedAdultProfile({ verification_status: "unverified" })];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("REFUSES a phone-unverified traveller when require_phone_verification is on (403 verification_required)", async () => {
    rstate.launchControls = [cityControl({ require_phone_verification: true })];
    rstate.travelerProfiles = [verifiedAdultProfile({ phone_verified_at: null })];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("REFUSES a deposit booking when full_payment_required is on (403 payment_mode_required)", async () => {
    rstate.launchControls = [cityControl({ full_payment_required: true })];
    rstate.travelerProfiles = [verifiedAdultProfile()];
    const r = await req("POST", path, reqBody({ paymentMode: "deposit_plus_cash" }), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "payment_mode_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("ALLOWS a compliant adult, verified traveller (201) — happy path unchanged", async () => {
    rstate.launchControls = [cityControl({ require_id_verification: true, min_age: 18 })];
    rstate.travelerProfiles = [verifiedAdultProfile()];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rstate.insertedBookings.length, 1);
  });

  it("ALLOWS booking unchanged when no launch control matches (201)", async () => {
    // No launch controls configured at all → gate is a no-op.
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rstate.insertedBookings.length, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C1 — per-user forced public meetup
// ══════════════════════════════════════════════════════════════════════════════

describe("C1 — public_meetup_required blocks a private/undeclared meetup", () => {
  beforeEach(() => {
    resetReqState();
    const client = makeReqClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    // Traveller present + adult/verified so the launch gate (if any) is not what
    // is being tested here; there are no launch controls so it is a no-op anyway.
    rstate.travelerProfiles = [verifiedAdultProfile()];
  });

  const path = `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`;

  it("REFUSES a booking with no meetup declared (403 public_meetup_required)", async () => {
    rstate.userLimits = [{ user_id: TRAVELER_ID, public_meetup_required: true }];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "public_meetup_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("REFUSES an explicitly private meetup (403 public_meetup_required)", async () => {
    rstate.userLimits = [{ user_id: TRAVELER_ID, public_meetup_required: true }];
    const r = await req("POST", path, reqBody({ meetupType: "private" }), TRAVELER_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "public_meetup_required");
    assert.equal(rstate.insertedBookings.length, 0);
  });

  it("ALLOWS a declared public meetup for a restricted user (201)", async () => {
    rstate.userLimits = [{ user_id: TRAVELER_ID, public_meetup_required: true }];
    const r = await req("POST", path, reqBody({ meetupType: "public" }), TRAVELER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rstate.insertedBookings.length, 1);
  });

  it("ALLOWS an unrestricted user regardless of meetup (201) — happy path unchanged", async () => {
    rstate.userLimits = [{ user_id: TRAVELER_ID, public_meetup_required: false }];
    const r = await req("POST", path, reqBody(), TRAVELER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rstate.insertedBookings.length, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B2 — completed_count compensation on dispute-cancellation
// ══════════════════════════════════════════════════════════════════════════════

describe("B2 — resolve-dispute reverses completed_count when a completed booking is cancelled", () => {
  const path = `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`;

  function useDispClient() {
    const client = makeDispClient();
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("DECREMENTS completed_count when a buddy-completed booking is cancelled (favorTraveler=true)", async () => {
    resetDispState(/* markedComplete */ true, /* startingCount */ 5);
    useDispClient();
    const r = await req("POST", path, { resolution: "reviewed", favorTraveler: true }, ADMIN_TOKEN);
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(dstate.bookings[BOOKING_ID].status, "cancelled");
    assert.equal(dstate.buddyProfiles[BUDDY_PROF].completed_count, 4,
      "completed_count must be decremented by exactly 1 to reverse the mark-complete increment");
  });

  it("does NOT decrement when the resolution favours the buddy (completed, favorTraveler=false)", async () => {
    resetDispState(true, 5);
    useDispClient();
    const r = await req("POST", path, { resolution: "reviewed", favorTraveler: false }, ADMIN_TOKEN);
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body));
    assert.equal(dstate.bookings[BOOKING_ID].status, "completed");
    assert.equal(dstate.buddyProfiles[BUDDY_PROF].completed_count, 5,
      "a booking upheld as completed keeps its completed_count increment");
  });

  it("does NOT decrement a booking that never reached mark-complete (dispute from in_progress)", async () => {
    resetDispState(/* markedComplete */ false, /* startingCount */ 5);
    useDispClient();
    const r = await req("POST", path, { resolution: "reviewed", favorTraveler: true }, ADMIN_TOKEN);
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body));
    assert.equal(dstate.bookings[BOOKING_ID].status, "cancelled");
    assert.equal(dstate.buddyProfiles[BUDDY_PROF].completed_count, 5,
      "no mark-complete event means completed_count was never incremented, so it must not be decremented");
  });
});
