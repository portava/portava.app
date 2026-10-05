/**
 * Rent-a-Buddy booking-CREATION gate consolidation (audit RAB-1 + RAB-2)
 *
 * The canonical POST /rent-a-buddy/bookings enforces a full safety-gate stack.
 * Three OTHER paths also INSERT a rent_buddy_bookings row:
 *   RAB-1  POST /rent-a-buddy/bookings/:bookingId/rebook   (rentABuddy.ts)
 *   RAB-2  POST /rent-a-buddy/packages/:packageId/book     (rentABuddyMarketplace.ts)
 *   RAB-2  POST /rent-a-buddy/offers/:offerId/accept       (rentABuddyMarketplace.ts)
 *
 * All three now run the SAME extracted helper (enforceBookingCreationGates), so
 * none may seat a booking POST /rent-a-buddy/bookings would refuse. These tests
 * prove the four blocking cases on EACH path, plus a positive control that the
 * gate does not over-block:
 *   - a blocked traveler cannot book a buddy who blocked them
 *   - an under-min-age traveler is refused
 *   - a nightlife booking with nightlife_admin_approved=false is refused
 *   - the high-risk two-sided verification gate fires (arrival, both unverified)
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyGateConsolidation.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { acceptedBookingQuote, acceptedLedgerPosting, answerLost, functionNotFound } from "./helpers/fakeRentBuddyLedgerRpc.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { specAliasRewrite } from "../lib/specAliasRewrite.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const TRAVELER_TOKEN = "gate-traveler-token";
const TRAVELER_ID    = "gate-traveler-1";
const BUDDY_USER     = "gate-buddy-user-1";
const BUDDY_PROF     = "gate-buddy-profile-1";


/**
 * Evaluate a PostgREST `or(...)` body against one row. Understands the two
 * forms the block check emits: top-level `col.eq.val` alternatives and
 * `and(col.eq.val,col.eq.val)` conjunctions of them.
 */
function orMatches(expr: string, row: any): boolean {
  const split = (s: string): string[] => {
    const out: string[] = []; let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const one = (c: string): boolean => {
    const and = c.match(/^and\((.*)\)$/s);
    if (and) return split(and[1]).every(one);
    const m = c.match(/^(\w+)\.(\w+)\.(.*)$/s);
    if (!m) return false;
    const [, col, op, val] = m;
    if (op === "is") return (row[col] ?? null) === (val === "null" ? null : val);
    return String(row[col]) === val;
  };
  return split(expr).some(one);
}

/** Set by a test that wants every request of a path to carry one Idempotency-Key. */
let idempotencyKey: string | null = null;

function req(method: string, path: string, body?: unknown, token = TRAVELER_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) } },
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

interface State {
  flags: Record<string, boolean>;
  profiles: Record<string, any>;
  buddyProfiles: Record<string, any>;
  bookings: Record<string, any>;
  packages: Record<string, any>;
  offers: Record<string, any>;
  blocks: Array<{ blocker_id: string; blocked_id: string }>;
  launchControls: any[];
  cityRestrictions: any[];
  restrictionsError: boolean;
  userLimits: Record<string, any>;
  availability: any[];
  availabilityExceptions: any[];
  insertedBookings: any[];
  /**
   * How migration 3824's functions answer. "posted" for every suite that is not
   * about the ledger; the last suites in this file drive the others.
   *
   *   posted       the quote answers; the posting commits and answers
   *   absent       3824 is NOT APPLIED: the quote and the posting are both missing
   *   error        the posting errors and commits NOTHING (every attempt)
   *   refused      the posting refuses the booking by name
   *   lost         the posting COMMITS and its answer is lost — once; asked again
   *                it answers `replayed`
   *   lost-always  the posting commits and EVERY answer is lost
   */
  ledger: "posted" | "absent" | "error" | "refused" | "lost" | "lost-always";
  /** Every rpc the routes made, in order. */
  rpcCalls: Array<{ fn: string; args: any }>;
  /** Ids of bookings DELETEd (a booking withdrawn because it could not be ledgered). */
  withdrawnBookingIds: string[];
  /** Ids of bookings whose ledger COMMITTED, one per booking (the posting is idempotent). */
  ledgeredBookingIds: string[];
  /** DELETEs refused because the booking has ledger entries (migration 3510). */
  refusedWithdrawals: string[];
}

let state: State;

function freshState(): State {
  return {
    // Only rent_buddy_enabled + nightlife on by default; everything else OFF so
    // no unrelated launch flag spuriously blocks (or opens) a path.
    flags: { rent_buddy_enabled: true, RENT_BUDDY_NIGHTLIFE_ENABLED: true },
    profiles: {
      [TRAVELER_ID]: { id: TRAVELER_ID, role: "user" },
      [BUDDY_USER]:  { id: BUDDY_USER,  role: "user" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: {
        // `country` is the real rent_buddy_profiles column and the server-side
        // source of the service country (deriveServiceCountry). `country_code`
        // is kept only as a harmless legacy alias some fixtures still reference.
        id: BUDDY_PROF, user_id: BUDDY_USER, city: "Miami", country: "US", country_code: "US",
        status: "active", admin_status: "active", group_approved: true,
        category_approvals: { nightlife: true, group: true },
        nightlife_admin_approved: true,
        verification_status: "verified", id_verified: true, phone_verified: true,
        hourly_rate_usd: 20, buddy_level: "established", new_buddy_public_only: false,
        new_buddy_max_hours: 8, disable_deposit_cash: false, cash_balance_accepted: true,
        risk_hold: false, available_now: false, max_group: 4,
      },
    },
    bookings: {},
    packages: {},
    offers: {},
    blocks: [],
    launchControls: [],
    cityRestrictions: [],
    restrictionsError: false,
    userLimits: {},
    availability: [],
    availabilityExceptions: [],
    insertedBookings: [],
    ledger: "posted",
    rpcCalls: [],
    withdrawnBookingIds: [],
    ledgeredBookingIds: [],
    refusedWithdrawals: [],
  };
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _updateData: null as any,
      _maybeSingle: false,
      _single: false,
      _delete: false,
      _orExpr: null as string | null,

      select() { return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      delete() { this._delete = true; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      lt(col: string, val: any) { this._filters.push(["lt", col, val]); return this; },
      gt(col: string, val: any) { this._filters.push(["gt", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      in(col: string, val: any) { this._filters.push(["in", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["ilike", col, val]); return this; },
      is(col: string, val: any) { this._filters.push(["is", col, val]); return this; },
      // Records the PostgREST `.or(...)` expression instead of discarding it.
      // The block check is now lib/blockGuard's single
      // `.or(and(...),and(...)).limit(1)` query — one query rather than two
      // `.maybeSingle()` reads, because a MUTUAL block is two rows and
      // maybeSingle raised on them. A no-op `or()` made every block invisible
      // to this fake, so "a blocked traveler cannot create a booking" passed
      // for the wrong reason. Only the `blocks` branch below consults it.
      or(expr: string) { this._orExpr = expr; return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._single = true; this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      _eq(col: string): any {
        const f = this._filters.find(([op, c]) => op === "eq" && c === col);
        return f ? f[2] : undefined;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // ── Inserts ─────────────────────────────────────────────────────────
        if (this._insertData !== null) {
          const row = { id: `gen-${Math.random().toString(36).slice(2)}`, ...this._insertData };
          if (t === "rent_buddy_bookings") state.insertedBookings.push(row);
          return { data: this._maybeSingle ? row : null, error: null };
        }

        // ── Deletes ─────────────────────────────────────────────────────────
        // Applied to the stored state: a booking withdrawn because its ledger
        // could not be posted is GONE from `insertedBookings`, which is what
        // every "no row seated" assertion in this file reads.
        if (this._delete) {
          if (t === "rent_buddy_bookings") {
            const id = this._eq("id");
            assert.ok(id !== undefined, "an unfiltered DELETE on rent_buddy_bookings");
            // Migration 3510: ledger entries are append-only and the cascade
            // from a booking's DELETE is refused. A LEDGERED booking stays.
            if (state.ledgeredBookingIds.includes(id)) {
              state.refusedWithdrawals.push(id);
              return { data: null, error: { code: "P0001", message: "rent_buddy_earnings_entries is append-only: DELETE refused" } };
            }
            state.withdrawnBookingIds.push(id);
            state.insertedBookings = state.insertedBookings.filter((r) => r.id !== id);
          }
          return { data: null, error: null };
        }

        // ── Updates ─────────────────────────────────────────────────────────
        if (this._updateData !== null) {
          if (t === "rent_buddy_offers") {
            const id = this._eq("id");
            const wantStatus = this._eq("status");
            const off = state.offers[id];
            const rows: any[] = [];
            if (off && (wantStatus === undefined || off.status === wantStatus)) {
              Object.assign(off, this._updateData);
              rows.push({ id: off.id });
            }
            return { data: this._maybeSingle ? (rows[0] ?? null) : rows, error: null };
          }
          return { data: null, error: null };
        }

        // ── Selects ─────────────────────────────────────────────────────────
        if (t === "feature_flags") {
          const flag = this._eq("flag");
          if (this._maybeSingle) return { data: flag != null ? { flag, enabled: !!state.flags[flag] } : null, error: null };
          return { data: Object.entries(state.flags).map(([f, e]) => ({ flag: f, enabled: e })), error: null };
        }

        if (t === "profiles") {
          const id = this._eq("id");
          if (this._maybeSingle) return { data: state.profiles[id] ?? null, error: null };
          return { data: Object.values(state.profiles), error: null };
        }

        if (t === "rent_buddy_profiles") {
          const id = this._eq("id");
          const userId = this._eq("user_id");
          let match: any = null;
          if (id !== undefined) match = state.buddyProfiles[id] ?? null;
          else if (userId !== undefined) match = Object.values(state.buddyProfiles).find((p: any) => p.user_id === userId) ?? null;
          if (this._maybeSingle) return { data: match, error: null };
          return { data: match ? [match] : [], error: null };
        }

        if (t === "rent_buddy_bookings") {
          const id = this._eq("id");
          // The Idempotency-Key lookup (lib/rentBuddyEarningsLedger.ts
          // #findBookingByCreationKey) reads the bookings this run CREATED.
          const creationKey = this._eq("creation_key");
          if (creationKey !== undefined) {
            const hits = state.insertedBookings.filter((r) => r.creation_key === creationKey && r.traveler_id === this._eq("traveler_id"));
            return { data: this._maybeSingle ? (hits[0] ?? null) : hits, error: null };
          }
          let rows = Object.values(state.bookings);
          if (id !== undefined) rows = rows.filter((r: any) => r.id === id);
          for (const [op, col, val] of this._filters) {
            if (op === "eq" && col !== "id") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_packages") {
          const id = this._eq("id");
          const pkg = id !== undefined ? state.packages[id] : Object.values(state.packages)[0];
          if (this._maybeSingle) return { data: pkg ?? null, error: null };
          return { data: pkg ? [pkg] : [], error: null };
        }

        if (t === "rent_buddy_offers") {
          const id = this._eq("id");
          const off = id !== undefined ? state.offers[id] : Object.values(state.offers)[0];
          if (this._maybeSingle) return { data: off ?? null, error: null };
          return { data: off ? [off] : [], error: null };
        }

        if (t === "blocks") {
          const hit = this._orExpr
            ? state.blocks.find((b) => orMatches(this._orExpr as string, b))
            : state.blocks.find(
                (b) => b.blocker_id === this._eq("blocker_id") && b.blocked_id === this._eq("blocked_id"),
              );
          // `.limit(1)` (no maybeSingle) resolves to an ARRAY, which is what
          // isBlockedBetween tests with `Array.isArray(data) && data.length > 0`.
          if (this._maybeSingle) return { data: hit ? { id: "block-1" } : null, error: null };
          return { data: hit ? [{ id: "block-1" }] : [], error: null };
        }

        if (t === "rent_buddy_launch_controls") {
          // Cascading match, mirroring getLaunchControl's per-query narrowing.
          let rows = [...state.launchControls];
          for (const [op, col, val] of this._filters) {
            if (op === "eq")  rows = rows.filter((r: any) => r[col] === val);
            if (op === "is" && val === null) rows = rows.filter((r: any) => r[col] == null);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          // count query used by the deny-by-default / countryCode fail-closed check
          return { data: state.launchControls, count: state.launchControls.length, error: null };
        }

        if (t === "rent_buddy_city_restrictions") {
          // Fail-closed probe: simulate an unreadable restrictions table.
          if (state.restrictionsError) return { data: null, error: { message: "boom" } };
          let rows = [...state.cityRestrictions];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "is" && val === null) rows = rows.filter((r: any) => r[col] == null);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          // Permissive: every city treated as open unless a test says otherwise.
          if (this._maybeSingle) return { data: { id: "r", city: "default", status: "public_mvp" }, error: null };
          return { data: [], count: 0, error: null };
        }

        if (t === "rent_buddy_global_controls") {
          const gc = { id: 1, all_bookings_paused: false, applications_paused: false, cash_balance_paused: false, nightlife_paused: false, force_full_in_app: false, force_public_meetup: false, force_delayed_posting: false };
          return { data: this._maybeSingle ? gc : [gc], error: null };
        }

        if (t === "rent_buddy_user_limits") {
          const userId = this._eq("user_id");
          if (this._maybeSingle) return { data: state.userLimits[userId] ?? null, error: null };
          return { data: Object.values(state.userLimits), error: null };
        }

        if (t === "rent_buddy_availability") {
          const buddyId = this._eq("buddy_id");
          const date = this._eq("date");
          const hit = state.availability.find((a) => a.buddy_id === buddyId && a.date === date);
          if (this._maybeSingle) return { data: hit ?? null, error: null };
          return { data: state.availability, error: null };
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

        // Everything else (buddy_booking_events, fee rules, ledger, analytics,
        // beta access, requests update, …) — benign empty defaults.
        if (this._maybeSingle) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    // The price and the earnings ledger are SQL functions since migration 3824,
    // and a booking that cannot be priced or ledgered is REFUSED (there is no
    // JavaScript fallback). `state.ledger` says how they answer: "posted" for
    // the gate suites, which are not about the ledger; every other function
    // stays absent, as it was with no `.rpc`.
    rpc: async (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args });
      if (state.ledger === "absent") return functionNotFound(fn);
      if (fn === "rb_quote_booking") return acceptedBookingQuote(args);
      if (fn !== "rb_post_booking_ledger") return functionNotFound(fn);
      if (state.ledger === "error") {
        return { data: null, error: { code: "40001", message: "could not serialize access due to concurrent update" } };
      }
      if (state.ledger === "refused") {
        return { data: { ok: false, refusal: "invalid_total", detail: "-5" }, error: null };
      }
      // The posting COMMITS. It is idempotent per booking: a second call for a
      // booking already ledgered writes nothing and answers `replayed`.
      const id = args.p_booking_id;
      const replay = state.ledgeredBookingIds.includes(id);
      if (!replay) state.ledgeredBookingIds.push(id);
      if (state.ledger === "lost-always" || (state.ledger === "lost" && !replay)) return answerLost();
      const posted = acceptedLedgerPosting(args);
      if (replay) Object.assign(posted.data, { replayed: true, entries_appended: 0, fee_percent: null, fee_source: null });
      return posted;
    },
    auth: {
      getUser: async (token: string) => {
        if (token === TRAVELER_TOKEN) return { data: { user: { id: TRAVELER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUTURE_DATE = new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10);

/** DOB for a traveler who is `years` old today. */
function dobForAge(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function seedCompletedBooking(category = "city"): string {
  const id = "orig-booking-1";
  state.bookings[id] = {
    id, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, status: "completed",
    city: "Miami", country_code: "US", category, duration_h: 2, group_size: 1,
    start_time: "10:00", payment_mode: "full_in_app", total_usd: 40,
  };
  return id;
}

function seedPackage(category = "city"): string {
  const id = "pkg-1";
  state.packages[id] = {
    id, buddy_id: BUDDY_PROF, is_active: true, admin_review_status: "approved",
    category, price_usd: 40, duration_h: 2, max_group: 4,
    buddy: state.buddyProfiles[BUDDY_PROF],
  };
  return id;
}

function seedOffer(category = "city"): string {
  const id = "offer-1";
  state.offers[id] = {
    id, status: "pending", buddy_profile_id: BUDDY_PROF, request_id: "rq-1",
    proposed_price_usd: 40, deposit_amount_usd: 40, cash_balance_usd: 0,
    payment_mode: "full_in_app", proposed_start: null, proposed_end: null, message: "hi",
    request: { id: "rq-1", traveler_id: TRAVELER_ID, city: "Miami", category, group_size: 1, country_code: "US" },
  };
  return id;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(specAliasRewrite);
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddyMarketplaceRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = freshState();
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// Each path is invoked through a tiny adapter so the four gate assertions can be
// shared. Returns the HTTP result; the caller checks status + insertedBookings.
async function rebook(): Promise<{ status: number; body: any }> {
  const orig = seedCompletedBooking(currentCategory);
  return req("POST", `/api/rent-a-buddy/bookings/${orig}/rebook`, { bookingDate: FUTURE_DATE, startTime: "10:00", durationH: 2 });
}
async function packageBook(): Promise<{ status: number; body: any }> {
  const pkg = seedPackage(currentCategory);
  return req("POST", `/api/rent-a-buddy/packages/${pkg}/book`, { bookingDate: FUTURE_DATE, groupSize: 1 });
}
async function offerAccept(): Promise<{ status: number; body: any }> {
  const offer = seedOffer(currentCategory);
  return req("POST", `/api/rent-a-buddy/offers/${offer}/accept`, {
    // offer.payment_mode drives the cash/full-in-app restriction checks
  });
}
// Canonical path — included in the "every creation path is gated" fail-closed proof.
async function directBooking(body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  return req("POST", `/api/rent-a-buddy/bookings`, {
    buddyId: BUDDY_PROF, bookingDate: FUTURE_DATE, durationH: 2, city: "Miami",
    category: currentCategory, groupSize: 1, ...body,
  });
}

let currentCategory = "city";
const paths: Array<{ name: string; run: () => Promise<{ status: number; body: any }> }> = [
  { name: "rebook",       run: rebook },
  { name: "package-book", run: packageBook },
  { name: "offer-accept", run: offerAccept },
];

// ── Positive control — the gate does not over-block ─────────────────────────────

describe("all creation paths seat a booking when every gate passes", () => {
  for (const p of paths) {
    it(`${p.name}: low-risk booking with no restrictions succeeds`, async () => {
      currentCategory = "city";
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, `expected success, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.insertedBookings.length, 1, "exactly one booking row should be created");
    });
  }
});

// ── Gate 1: blocked traveler ────────────────────────────────────────────────────

describe("a blocked traveler cannot create a booking", () => {
  for (const p of paths) {
    it(`${p.name}: refused (403 blocked) when the buddy has blocked the traveler, no row seated`, async () => {
      currentCategory = "city";
      state.blocks.push({ blocker_id: BUDDY_USER, blocked_id: TRAVELER_ID });
      const r = await p.run();
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "blocked");
      assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
    });
  }
});

// ── Gate 2: under-min-age traveler ──────────────────────────────────────────────

describe("an under-min-age traveler is refused", () => {
  for (const p of paths) {
    it(`${p.name}: refused (403 age_requirement) when traveler is under the launch-control minimum, no row seated`, async () => {
      currentCategory = "city";
      // Launch control for US: min age 18, ID/phone not required so age is the
      // gate that fires. Traveler is 16.
      state.launchControls = [{
        id: "lc-us", country_code: "US", city: null, category: null, enabled: true,
        waitlist_only: false, min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      }];
      state.profiles[TRAVELER_ID].date_of_birth = dobForAge(16);
      const r = await p.run();
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "age_requirement");
      assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
    });
  }
});

// ── Gate 3: nightlife without admin approval ────────────────────────────────────

describe("a nightlife booking with nightlife_admin_approved=false is refused", () => {
  for (const p of paths) {
    it(`${p.name}: refused (403 nightlife_not_approved), no row seated`, async () => {
      currentCategory = "nightlife";
      // Category is approved on the buddy, but the admin nightlife sign-off is not.
      state.buddyProfiles[BUDDY_PROF].nightlife_admin_approved = false;
      const r = await p.run();
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "nightlife_not_approved");
      assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
    });
  }
});

// ── Gate 4: high-risk two-sided verification ────────────────────────────────────

describe("the high-risk two-sided verification gate fires", () => {
  for (const p of paths) {
    it(`${p.name}: refused (403 verification_required) for an arrival booking when neither side is verified, no row seated`, async () => {
      currentCategory = "arrival";
      // Buddy AND traveler unverified — arrival is high-risk, so both-sided check blocks.
      Object.assign(state.buddyProfiles[BUDDY_PROF], { verification_status: "unverified", id_verified: false, phone_verified: false });
      const r = await p.run();
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "verification_required");
      assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
    });
  }
});

// ── City/category restrictions (rent_buddy_city_restrictions) ───────────────────
//
// Previously write-only (an admin route upserts it, nothing read it). It is now
// enforced inside the shared helper so every creation path honours it and no
// ordinary user can bypass it.

describe("rent_buddy_city_restrictions changes booking-gate behaviour", () => {
  it("require_public_meetup=true rejects a private-meetup booking that would otherwise succeed (POST /bookings)", async () => {
    currentCategory = "city";
    // Baseline: a private meetup on a low-risk 'city' booking succeeds when no
    // restriction is set (nightlife public-meetup gate does not apply here).
    const ok = await directBooking({ meetupLocation: "Hotel lobby" });
    assert.ok(ok.status === 201, `baseline should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(state.insertedBookings.length, 1);

    // Now add the restriction — the SAME private-meetup booking is rejected.
    state.insertedBookings = [];
    state.cityRestrictions = [{
      id: "cr-1", city: "Miami", category: null,
      require_public_meetup: true, disable_deposit_cash: false, require_full_in_app: false,
    }];
    const blocked = await directBooking({ meetupLocation: "come to my room" });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, "public_meetup_required");
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("require_full_in_app=true rejects a deposit_plus_cash package booking that would otherwise succeed (package-book)", async () => {
    currentCategory = "city";
    // Baseline: deposit_plus_cash package booking succeeds with no restriction.
    const okPkg = seedPackage("city");
    const ok = await req("POST", `/api/rent-a-buddy/packages/${okPkg}/book`, { bookingDate: FUTURE_DATE, groupSize: 1, paymentMode: "deposit_plus_cash" });
    assert.ok(ok.status === 201, `baseline should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(state.insertedBookings.length, 1);

    // With require_full_in_app, the same deposit_plus_cash booking is rejected.
    state.insertedBookings = [];
    state.cityRestrictions = [{
      id: "cr-2", city: "Miami", category: null,
      require_public_meetup: false, disable_deposit_cash: false, require_full_in_app: true,
    }];
    const pkg2 = seedPackage("city");
    const blocked = await req("POST", `/api/rent-a-buddy/packages/${pkg2}/book`, { bookingDate: FUTURE_DATE, groupSize: 1, paymentMode: "deposit_plus_cash" });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, "full_payment_required");
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
  });

  it("disable_deposit_cash=true rejects a deposit_plus_cash offer acceptance that would otherwise succeed (offer-accept)", async () => {
    currentCategory = "city";
    // Baseline: an offer priced with deposit_plus_cash is accepted with no restriction.
    const okOffer = seedOffer("city");
    state.offers[okOffer].payment_mode = "deposit_plus_cash";
    const ok = await req("POST", `/api/rent-a-buddy/offers/${okOffer}/accept`, {});
    assert.ok(ok.status === 200 || ok.status === 201, `baseline should succeed, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert.equal(state.insertedBookings.length, 1);

    // With disable_deposit_cash, the same offer acceptance is rejected.
    state.insertedBookings = [];
    state.cityRestrictions = [{
      id: "cr-3", city: "Miami", category: null,
      require_public_meetup: false, disable_deposit_cash: true, require_full_in_app: false,
    }];
    const offer2 = seedOffer("city");
    state.offers[offer2].payment_mode = "deposit_plus_cash";
    const blocked = await req("POST", `/api/rent-a-buddy/offers/${offer2}/accept`, {});
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, "cash_payment_unavailable");
    assert.equal(state.insertedBookings.length, 0, "no booking row should be created");
    // Offer must NOT have been claimed (still pending) — gate runs before the claim.
    assert.equal(state.offers[offer2].status, "pending");
  });

  it("a category-specific restriction is applied over a city-wide one (most specific wins)", async () => {
    currentCategory = "city";
    state.cityRestrictions = [
      { id: "cr-wide", city: "Miami", category: null, require_public_meetup: false, disable_deposit_cash: false, require_full_in_app: false },
      { id: "cr-cat",  city: "Miami", category: "city", require_public_meetup: false, disable_deposit_cash: false, require_full_in_app: true },
    ];
    const r = await directBooking({ paymentMode: "deposit_plus_cash", meetupLocation: "Hotel lobby" });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "full_payment_required");
    assert.equal(state.insertedBookings.length, 0);
  });
});

describe("every creation path is gated by rent_buddy_city_restrictions (fail-closed)", () => {
  const gatedPaths: Array<{ name: string; run: () => Promise<{ status: number; body: any }> }> = [
    { name: "POST /bookings", run: () => directBooking() },
    { name: "rebook",         run: rebook },
    { name: "package-book",   run: packageBook },
    { name: "offer-accept",   run: offerAccept },
  ];
  for (const p of gatedPaths) {
    it(`${p.name}: a restrictions load error rejects the booking (503), no row seated`, async () => {
      currentCategory = "city";
      state.restrictionsError = true;
      const r = await p.run();
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "restrictions_unavailable");
      assert.equal(state.insertedBookings.length, 0, "no booking row should be created when restrictions are unreadable");
    });
  }
});

// ── The earnings ledger: a booking that cannot be ledgered is not a booking ─────
//
// Payments PAY-050. Every creation path used to end
// `createEarningsLedgerEntry(...).catch(() => {})`: the booking was committed,
// the ledger write was fired and its failure thrown away, and the traveller got
// their booking back with no fee record behind it. Each path now posts the
// ledger FIRST, and a booking that really has no ledger is withdrawn and
// answered by NAME. Asserted on stored state for all four paths this harness
// drives (the fifth, the spec request, is in rentABuddySpecRequest.test.ts).

const allPaths = [...paths, { name: "POST /bookings", run: () => directBooking() }];
const postings = () => state.rpcCalls.filter((c) => c.fn === "rb_post_booking_ledger");

describe("every creation path refuses, and withdraws, a booking whose ledger cannot be posted", () => {
  for (const p of allPaths) {
    it(`${p.name}: CONTROL — with the ledger posted the booking is seated, and the ledger was posted for THAT booking`, async () => {
      currentCategory = "city";
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, `expected success, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.insertedBookings.length, 1);
      assert.equal(postings().length, 1, "exactly one posting per booking");
      assert.deepEqual(postings()[0]!.args, {
        p_booking_id: state.insertedBookings[0].id, p_event: "booking_created", p_event_key: null, p_args: {},
      });
      assert.deepEqual(state.withdrawnBookingIds, []);
      assert.deepEqual(state.ledgeredBookingIds, [state.insertedBookings[0].id]);
    });

    it(`${p.name}: migration 3824 is not applied → 503 ledger_unavailable BEFORE anything is inserted`, async () => {
      currentCategory = "city";
      state.ledger = "absent";
      const r = await p.run();
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "ledger_unavailable");
      assert.equal(r.body.retryable, true);
      assert.equal(r.body.booking, undefined, "a refusal must not hand back a booking");
      // The price is the database's: with no quote function there is no price,
      // so no booking row was written and there is nothing to withdraw.
      assert.equal(state.insertedBookings.length, 0);
      assert.deepEqual(state.withdrawnBookingIds, []);
      assert.equal(postings().length, 0);
    });

    it(`${p.name}: the posting call errored and committed nothing → confirmed by ONE re-post, then 503 ledger_write_failed and NO booking row remains`, async () => {
      currentCategory = "city";
      state.ledger = "error";
      const r = await p.run();
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "ledger_write_failed");
      assert.equal(r.body.retryable, true);
      assert.equal(r.body.booking, undefined, "a refusal must not hand back a booking");
      assert.equal(r.body.bookingId, undefined);
      assert.equal(state.withdrawnBookingIds.length, 1, "the inserted booking was not withdrawn");
      assert.equal(state.insertedBookings.length, 0, "a booking exists with no earnings ledger — the state PAY-050 is about");
      // An errored call may have committed, so it is asked again exactly once
      // BEFORE the booking is withdrawn — never withdrawn on the first error.
      assert.equal(postings().length, 2, "an unknown result is confirmed by one idempotent re-post, no more");
      assert.ok(postings().every((c) => c.args.p_booking_id === state.withdrawnBookingIds[0]),
        "the booking withdrawn must be the one the ledger failed for");
      assert.deepEqual(state.ledgeredBookingIds, []);
    });

    it(`${p.name}: the database REFUSED the booking by name → 4xx ledger_refused, retryable:false, and NO booking row remains`, async () => {
      currentCategory = "city";
      state.ledger = "refused";
      const r = await p.run();
      // A permanent refusal is not an outage: the same request will be refused
      // again, so it must not be a 503 a client retries for ever.
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.error, "ledger_refused");
      assert.equal(r.body.refusal, "invalid_total");
      assert.equal(r.body.retryable, false);
      assert.equal(r.body.booking, undefined);
      assert.equal(state.withdrawnBookingIds.length, 1, "the inserted booking was not withdrawn");
      assert.equal(state.insertedBookings.length, 0);
      assert.equal(postings().length, 1, "a definite refusal is not re-posted");
    });
  }

  it("offer-accept: the offer's claim is RELEASED with a WITHDRAWN booking — it is pending again and points at nothing", async () => {
    currentCategory = "city";
    state.ledger = "error";
    const r = await offerAccept();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(state.insertedBookings.length, 0);
    const offer = state.offers["offer-1"];
    assert.equal(offer.status, "pending", "an accepted offer with no booking can never be accepted again");
    assert.equal(offer.accepted_booking_id, undefined);

    // …so the traveller can accept it again once the ledger is back.
    state.ledger = "posted";
    const again = await req("POST", "/api/rent-a-buddy/offers/offer-1/accept", {});
    assert.ok(again.status === 200 || again.status === 201, JSON.stringify(again.body));
    assert.equal(state.insertedBookings.length, 1);
    assert.equal(state.offers["offer-1"].status, "accepted");
    assert.equal(state.offers["offer-1"].accepted_booking_id, state.insertedBookings[0].id);
  });
});

// ── The posting COMMITTED and its answer was lost ───────────────────────────────
//
// The defect (independent verification of PR #603): each path did `post → not
// written → DELETE the booking → 503 "not created, try again"`. When the posting
// had committed and only its answer was lost, the DELETE was REFUSED (3510 will
// not cascade over append-only ledger entries), the booking and its ledger
// stayed, the traveller was told nothing had been created, and a retry made a
// SECOND booking and a second ledger. Offer-accept released the claim as well,
// so one offer produced two bookings.

describe("a posting that committed, with its answer lost, is ONE booking and ONE ledger — never a 503", () => {
  for (const p of allPaths) {
    it(`${p.name}: the answer is lost once → the re-post confirms it; the booking is returned`, async () => {
      currentCategory = "city";
      state.ledger = "lost";
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, `a created booking was answered ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.insertedBookings.length, 1, "exactly one booking");
      assert.deepEqual(state.ledgeredBookingIds, [state.insertedBookings[0].id], "exactly one ledger, for that booking");
      assert.equal(postings().length, 2, "post, then one confirming re-post");
      assert.deepEqual(state.withdrawnBookingIds, [], "a ledgered booking must not be withdrawn");
      assert.deepEqual(state.refusedWithdrawals, [], "no withdrawal may even be attempted before the re-post");
    });

    it(`${p.name}: EVERY answer is lost → the withdrawal is refused, so the booking exists and is returned`, async () => {
      currentCategory = "city";
      state.ledger = "lost-always";
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, `a booking that exists was answered ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.insertedBookings.length, 1, "exactly one booking");
      assert.deepEqual(state.ledgeredBookingIds, [state.insertedBookings[0].id], "exactly one ledger");
      assert.deepEqual(state.refusedWithdrawals, [state.insertedBookings[0].id], "the DELETE was refused by the ledger's append-only rule");
      assert.deepEqual(state.withdrawnBookingIds, []);
    });

    it(`${p.name}: the same request retried with its Idempotency-Key returns the ORIGINAL booking`, async () => {
      currentCategory = "city";
      idempotencyKey = "attempt-0001-abcdef";
      try {
        const first = await p.run();
        assert.ok(first.status === 200 || first.status === 201, JSON.stringify(first.body));
        assert.equal(state.insertedBookings.length, 1);
        const original = state.insertedBookings[0];
        assert.ok(typeof original.creation_key === "string" && original.creation_key.endsWith(":attempt-0001-abcdef"),
          `the key is stored on the booking, scoped by the path and the resource: ${original.creation_key}`);

        // The client never saw the first answer and sends the SAME request again.
        const second = await p.run();
        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(second.body.idempotentReplay, true);
        assert.equal(state.insertedBookings.length, 1, "a retried create made a second booking");
        assert.equal(second.body.booking.id, original.id, "the retry must return the original booking");
        assert.deepEqual(state.ledgeredBookingIds, [original.id], "exactly one ledger");
      } finally {
        idempotencyKey = null;
      }
    });

    it(`${p.name}: a malformed Idempotency-Key is refused (400), not silently dropped`, async () => {
      currentCategory = "city";
      idempotencyKey = "short";
      try {
        const r = await p.run();
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.error, "invalid_idempotency_key");
        assert.equal(state.insertedBookings.length, 0);
      } finally {
        idempotencyKey = null;
      }
    });
  }

  it("offer-accept: the lost answer is retried with the key AFTER the offer is accepted → the original booking, not 'already accepted'", async () => {
    currentCategory = "city";
    idempotencyKey = "offer-attempt-000001";
    try {
      const first = await offerAccept();
      assert.ok(first.status === 200 || first.status === 201, JSON.stringify(first.body));
      assert.equal(state.offers["offer-1"].status, "accepted");
      // seedOffer() would reset the offer; retry against the stored, ACCEPTED one.
      const second = await req("POST", "/api/rent-a-buddy/offers/offer-1/accept", {});
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.idempotentReplay, true);
      assert.equal(second.body.bookingId, state.insertedBookings[0].id);
      assert.equal(state.insertedBookings.length, 1);
    } finally {
      idempotencyKey = null;
    }
  });

  it("offer-accept: a booking that could NOT be withdrawn keeps the offer's claim — a second accept cannot make a second booking", async () => {
    currentCategory = "city";
    state.ledger = "lost-always";
    const first = await offerAccept();
    assert.ok(first.status === 200 || first.status === 201, JSON.stringify(first.body));
    const offer = state.offers["offer-1"];
    assert.equal(offer.status, "accepted", "the claim was released over a booking that exists");
    assert.equal(offer.accepted_booking_id, state.insertedBookings[0].id);

    // A second accept of the same offer (no key: an old client).
    state.ledger = "posted";
    const second = await req("POST", "/api/rent-a-buddy/offers/offer-1/accept", {});
    assert.ok(second.status >= 400 && second.status < 500, `a second accept was answered ${second.status}: ${JSON.stringify(second.body)}`);
    assert.equal(state.insertedBookings.length, 1, "one offer made two bookings");
    assert.equal(state.ledgeredBookingIds.length, 1, "one offer made two ledgers");
  });
});

// ── What creation stores ────────────────────────────────────────────────────────

describe("creation stores the database's price and terms, no deposit, and an acceptance window", () => {
  for (const p of allPaths) {
    it(`${p.name}: total and terms come from rb_quote_booking; the deposit is 0 (owner ruling 2026-10-04)`, async () => {
      currentCategory = "city";
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      const quotes = state.rpcCalls.filter((c) => c.fn === "rb_quote_booking");
      assert.equal(quotes.length, 1, "exactly one quote per creation");
      assert.equal(quotes[0]!.args.p_buddy_profile_id, BUDDY_PROF);
      // The MARKET is not an argument: the function resolves it from the buddy.
      assert.deepEqual(Object.keys(quotes[0]!.args).sort(),
        ["p_buddy_profile_id", "p_category", "p_deposit_percent", "p_payment_mode", "p_quantity", "p_unit_price_usd"]);
      const row = state.insertedBookings[0];
      assert.equal(row.total_usd, 40);
      assert.equal(row.deposit_usd, 0, "a deposit was stored while the owner's switch is off");
      assert.ok(Number.isInteger(row.total_usd * 100) && Number.isInteger(row.cash_balance_usd * 100));
    });

    it(`${p.name}: the booking awaits the buddy and expires 24 h after creation`, async () => {
      currentCategory = "city";
      const before = Date.now();
      const r = await p.run();
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      const row = state.insertedBookings[0];
      assert.ok(["pending", "requested"].includes(row.status), row.status);
      assert.ok(typeof row.expires_at === "string", "a booking awaiting the buddy has no expires_at and never expires");
      const ms = new Date(row.expires_at).getTime() - before;
      assert.ok(ms > 23.9 * 3600_000 && ms < 24.1 * 3600_000, `expires_at is ${ms / 3600_000} h after creation`);
    });
  }

  it("offer-accept: an offer stored with a deposit before the ruling is booked with NONE", async () => {
    currentCategory = "city";
    const id = seedOffer("city");
    Object.assign(state.offers[id], { payment_mode: "deposit_plus_cash", deposit_amount_usd: 12, cash_balance_usd: 28 });
    const r = await req("POST", `/api/rent-a-buddy/offers/${id}/accept`, {});
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    const row = state.insertedBookings[0];
    assert.equal(row.deposit_usd, 0);
    assert.equal(row.cash_balance_usd, 40, "with no deposit the whole price is the cash balance");
    assert.equal(row.deposit_rule_applied, "no_deposit");
  });
});
