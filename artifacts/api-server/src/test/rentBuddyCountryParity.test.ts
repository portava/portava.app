/**
 * Rent-a-Buddy — SERVICE-COUNTRY parity across every booking-creation entry path
 *
 * The service country that governs launch-controls / city-restrictions is derived
 * SERVER-SIDE from the buddy being booked (deriveServiceCountry) — never from the
 * client body — and snapshotted onto the booking/request row. This suite proves
 * that for the SAME (buddy country, city, category, launch-control config) the
 * POLICY DECISION is identical across the three real entry paths:
 *
 *   (a) direct   POST /api/rent-a-buddy/bookings                    (rentABuddy.ts)
 *   (b) shorthand POST /api/rent-a-buddy/buddies/:buddyId/request   (rentABuddySpec.ts)
 *   (c) marketplace POST /api/rent-a-buddy/requests  (create-request snapshots the
 *       country) → POST /api/rent-a-buddy/offers/:offerId/accept    (rentABuddyMarketplace.ts)
 *
 * Cases proven for all three:
 *   • a country-scoped control with enabled=false   → REFUSE (403 location_unavailable)
 *   • a country-scoped control + an underage traveller → REFUSE (403 age_requirement)
 *   • an enabled country-scoped control + compliant traveller → ALLOW (2xx, one row)
 *   • fail-closed: buddy country unresolved + controls present → REFUSE (400), no row
 *
 * Mutation proof (run manually, documented in the PR): make deriveServiceCountry
 * return null and the three ALLOW assertions flip to refuse / the parity holds
 * RED; restore and they go GREEN. See the note above assertAllRefuse below.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyCountryParity.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";
import rentABuddyMarketplaceRouter from "../routes/rentABuddyMarketplace.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";
import { specAliasRewrite } from "../lib/specAliasRewrite.js";

// ── HTTP helper ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const TRAVELER_TOKEN = "country-parity-traveler-token";
const TRAVELER_ID    = "country-parity-traveler-1";
const BUDDY_USER     = "country-parity-buddy-user-1";
const BUDDY_PROF     = "country-parity-buddy-profile-1";

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", "authorization": `Bearer ${TRAVELER_TOKEN}` } },
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

/** DOB (Jan-1 birthday) that makes the traveller exactly `years` old today. */
function dobForAge(years: number): string {
  return `${new Date().getFullYear() - years}-01-01`;
}

// ── Shared mutable state + fake supabase client ─────────────────────────────────

interface State {
  flags: Record<string, boolean>;
  profiles: Record<string, any>;
  buddyProfiles: Record<string, any>;
  launchControls: any[];
  cityRestrictions: any[];
  cityRollouts: any[];        // { city, country, status }
  userLimits: Record<string, any>;
  blocks: Array<{ blocker_id: string; blocked_id: string }>;
  availabilityExceptions: any[];
  offers: Record<string, any>;
  insertedBookings: any[];
  insertedRequests: any[];
}

let state: State;

const CITY = "Miami";

function freshState(): State {
  return {
    flags: {
      rent_buddy_enabled: true,
      RENT_BUDDY_NIGHTLIFE_ENABLED: true,
      // identity provider is not operational under test; this override lets the
      // KYC gate pass so we can exercise the country gate itself.
      rent_buddy_allow_bookings_without_kyc: true,
    },
    profiles: {
      [TRAVELER_ID]: verifiedAdult(),
      [BUDDY_USER]:  { id: BUDDY_USER, role: "user" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: {
        id: BUDDY_PROF, user_id: BUDDY_USER, city: CITY, country: "US",
        status: "active", admin_status: "active", group_approved: true,
        categories: ["city", "food", "nightlife"],
        category_approvals: { nightlife: true, group: true },
        nightlife_admin_approved: true,
        verification_status: "verified", id_verified: true, phone_verified: true,
        hourly_rate_usd: 20, buddy_level: "established",
        new_buddy_public_only: false, new_buddy_max_hours: 8,
        available_now: false, max_group: 4,
      },
    },
    launchControls: [],
    cityRestrictions: [],
    cityRollouts: [{ city: CITY, country: "US", status: "public_mvp" }],
    userLimits: {},
    blocks: [],
    availabilityExceptions: [],
    offers: {},
    insertedBookings: [],
    insertedRequests: [],
  };
}

function verifiedAdult(overrides: Record<string, unknown> = {}) {
  return {
    id: TRAVELER_ID, role: "user",
    date_of_birth: dobForAge(30),
    verification_status: "verified",      // → idVerified
    phone_verified_at: "2026-01-01T00:00:00Z", // → phoneVerified
    ...overrides,
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

      select() { return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      lt(col: string, val: any) { this._filters.push(["lt", col, val]); return this; },
      gt(col: string, val: any) { this._filters.push(["gt", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      in(col: string, val: any) { this._filters.push(["in", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      is(col: string, val: any) { this._filters.push(["is", col, val]); return this; },
      or() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

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
          if (t === "rent_buddy_requests") state.insertedRequests.push(row);
          return { data: this._maybeSingle ? row : row, error: null };
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

        if (t === "rent_buddy_global_controls") {
          const gc = { id: 1, all_bookings_paused: false, applications_paused: false, cash_balance_paused: false, nightlife_paused: false, force_full_in_app: false, force_public_meetup: false, force_delayed_posting: false };
          return { data: this._maybeSingle ? gc : [gc], error: null };
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

        if (t === "rent_buddy_launch_controls") {
          // Cascading match, mirroring getLaunchControl's per-query narrowing.
          let rows = [...state.launchControls];
          for (const [op, col, val] of this._filters) {
            if (op === "eq")  rows = rows.filter((r: any) => r[col] === val);
            if (op === "is" && val === null) rows = rows.filter((r: any) => r[col] == null);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          // count query (fail-closed precheck) + select-all (shorthand)
          return { data: state.launchControls, count: state.launchControls.length, error: null };
        }

        if (t === "rent_buddy_city_restrictions") {
          let rows = [...state.cityRestrictions];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "is" && val === null) rows = rows.filter((r: any) => r[col] == null);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          const city = this._eq("city");
          const hit = state.cityRollouts.find((r: any) => r.city === city) ?? null;
          if (this._maybeSingle) return { data: hit, error: null };
          return { data: state.cityRollouts, error: null };
        }

        if (t === "rent_buddy_user_limits") {
          const userId = this._eq("user_id");
          if (this._maybeSingle) return { data: state.userLimits[userId] ?? null, error: null };
          return { data: Object.values(state.userLimits), error: null };
        }

        if (t === "rent_buddy_availability") {
          if (this._maybeSingle) return { data: null, error: null };
          return { data: [], error: null };
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

        if (t === "blocks") {
          const blocker = this._eq("blocker_id");
          const blocked = this._eq("blocked_id");
          const hit = state.blocks.find((b) => b.blocker_id === blocker && b.blocked_id === blocked);
          return { data: hit ? { id: "block-1" } : null, error: null };
        }

        if (t === "rent_buddy_offers") {
          const id = this._eq("id");
          const off = id !== undefined ? state.offers[id] : Object.values(state.offers)[0];
          if (this._maybeSingle) return { data: off ?? null, error: null };
          return { data: off ? [off] : [], error: null };
        }

        if (t === "rent_buddy_bookings") {
          // completed-count / history lookups etc. — benign empty.
          if (this._maybeSingle) return { data: null, error: null };
          return { data: [], count: 0, error: null };
        }

        // Everything else (buddy_booking_events, beta access, ledger, analytics,
        // notifications, requests update, …) — benign defaults.
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

// ── Server ──────────────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(specAliasRewrite);
  app.use("/api", rentABuddySpecRouter);
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

const FUTURE_DATE = new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10);

interface Config {
  buddyCountry?: string | null;   // buddy.country (server-side service country)
  rolloutCountry?: string | null; // rent_buddy_city_rollouts.country for CITY
  launchControls?: any[];
  travelerOverrides?: Record<string, unknown>;
  category?: string;
}

/** Reset state and apply a scenario config. */
function applyConfig(cfg: Config): void {
  state = freshState();
  if ("buddyCountry" in cfg) state.buddyProfiles[BUDDY_PROF].country = cfg.buddyCountry ?? null;
  if ("rolloutCountry" in cfg) state.cityRollouts = cfg.rolloutCountry == null
    ? [{ city: CITY, status: "public_mvp" }]                       // no country → null snapshot
    : [{ city: CITY, country: cfg.rolloutCountry, status: "public_mvp" }];
  if (cfg.launchControls) state.launchControls = cfg.launchControls;
  if (cfg.travelerOverrides) state.profiles[TRAVELER_ID] = verifiedAdult(cfg.travelerOverrides);
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

interface Decision { status: number; error: string | undefined; seated: number }

async function runDirect(category: string): Promise<Decision> {
  const r = await req("POST", "/api/rent-a-buddy/bookings", {
    buddyId: BUDDY_PROF, bookingDate: FUTURE_DATE, durationH: 2, city: CITY,
    category, groupSize: 1,
    // Client sends a bogus countryCode; the gate MUST ignore it and use the buddy.
    countryCode: "ZZ",
  });
  return { status: r.status, error: r.body?.error, seated: state.insertedBookings.length };
}

async function runShorthand(category: string): Promise<Decision> {
  const r = await req("POST", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/request`, {
    bookingDate: FUTURE_DATE, durationH: 2, city: CITY, category, groupSize: 1,
    countryCode: "ZZ", // ignored — derived from the buddy
  });
  return { status: r.status, error: r.body?.error, seated: state.insertedBookings.length };
}

async function runMarketplace(category: string): Promise<Decision> {
  // create-request snapshots the service country onto the request row.
  const cr = await req("POST", "/api/rent-a-buddy/requests", { city: CITY, category, groupSize: 1 });
  if (cr.status >= 400) return { status: cr.status, error: cr.body?.error, seated: state.insertedBookings.length };
  const request = state.insertedRequests[0];
  // A buddy makes an offer on that request; the traveller accepts it.
  const offerId = "offer-parity-1";
  state.offers[offerId] = {
    id: offerId, status: "pending", buddy_profile_id: BUDDY_PROF, request_id: request.id,
    proposed_price_usd: 40, deposit_amount_usd: 40, cash_balance_usd: 0,
    payment_mode: "full_in_app", proposed_start: null, proposed_end: null, message: "hi",
    request, // authoritative snapshot embed (incl. country_code) — what offer-accept reads
  };
  const r = await req("POST", `/api/rent-a-buddy/offers/${offerId}/accept`, {});
  return { status: r.status, error: r.body?.error, seated: state.insertedBookings.length };
}

const PATHS: Array<{ name: string; run: (category: string) => Promise<Decision> }> = [
  { name: "direct POST /bookings",      run: runDirect },
  { name: "shorthand /buddies/:id/request", run: runShorthand },
  { name: "create-request → offer-accept",  run: runMarketplace },
];

// Country-scoped control keyed on "US" (the buddy's registered country).
function usControl(overrides: Record<string, unknown> = {}) {
  return {
    id: "lc-us", country_code: "US", city: null, category: null,
    enabled: true, waitlist_only: false,
    min_age: 18, nightlife_min_age: 21,
    require_id_verification: false, require_phone_verification: false,
    full_payment_required: false,
    ...overrides,
  };
}

// ── Parity: a country control that REFUSES on all three ──────────────────────────

describe("country-scoped control enabled=false → REFUSES identically on every path", () => {
  const cfg: Config = { buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: false, waitlist_only: false })] };
  for (const p of PATHS) {
    it(`${p.name}: 403 location_unavailable, no booking seated`, async () => {
      applyConfig(cfg);
      const d = await p.run("city");
      assert.equal(d.status, 403, `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.error, "location_unavailable", `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.seated, 0, `${p.name} must seat no booking`);
    });
  }
});

describe("country-scoped control + underage traveller → REFUSES identically on every path", () => {
  const cfg: Config = {
    buddyCountry: "US", rolloutCountry: "US",
    launchControls: [usControl({ min_age: 25 })],
    travelerOverrides: { date_of_birth: dobForAge(19) }, // 19 < 25
  };
  for (const p of PATHS) {
    it(`${p.name}: 403 age_requirement, no booking seated`, async () => {
      applyConfig(cfg);
      const d = await p.run("city");
      assert.equal(d.status, 403, `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.error, "age_requirement", `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.seated, 0, `${p.name} must seat no booking`);
    });
  }
});

// ── Parity: a config that ALLOWS on all three ────────────────────────────────────
//
// MUTATION PROOF: force deriveServiceCountry (rentABuddy.ts) to `return null`.
// The direct + shorthand paths then resolve a null service country while the "US"
// control is present, so both fail closed (400) instead of 201 — these three
// assertions go RED. Restore the function and they return GREEN. This is what
// proves the assertions actually depend on the server-side derivation.

describe("enabled country-scoped control + compliant traveller → ALLOWS identically on every path", () => {
  const cfg: Config = { buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: true, min_age: 18 })] };
  for (const p of PATHS) {
    it(`${p.name}: 2xx and exactly one booking seated`, async () => {
      applyConfig(cfg);
      const d = await p.run("city");
      assert.ok(d.status >= 200 && d.status < 300, `${p.name} expected 2xx → ${JSON.stringify(d)}`);
      assert.equal(d.seated, 1, `${p.name} must seat exactly one booking`);
    });
  }
});

// ── Parity: fail-closed when the buddy country cannot be resolved ────────────────

describe("buddy country unresolved + controls present → FAILS CLOSED identically on every path", () => {
  // Buddy has no country AND the city has no rollout country, so the request
  // snapshot is null too → offer-accept re-derives from the (country-less) buddy
  // and also fails closed.
  const cfg: Config = { buddyCountry: null, rolloutCountry: null, launchControls: [usControl({ enabled: true })] };
  for (const p of PATHS) {
    it(`${p.name}: 400 invalid_payload, no booking seated`, async () => {
      applyConfig(cfg);
      const d = await p.run("city");
      assert.equal(d.status, 400, `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.error, "invalid_payload", `${p.name} → ${JSON.stringify(d)}`);
      assert.equal(d.seated, 0, `${p.name} must seat no booking`);
    });
  }
});

// ── The client-supplied countryCode is IGNORED for policy ────────────────────────

describe("client-supplied countryCode cannot change the decision", () => {
  it("direct: a bogus body countryCode does not dodge the buddy's country control", async () => {
    // Buddy is "US" with a disabled US control. Client sends countryCode:"ZZ"
    // (no control) — if it were trusted, the booking would be allowed. It is not.
    applyConfig({ buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: false })] });
    const d = await runDirect("city");
    assert.equal(d.status, 403, JSON.stringify(d));
    assert.equal(d.error, "location_unavailable", JSON.stringify(d));
    assert.equal(d.seated, 0);
  });

  it("shorthand: a bogus body countryCode does not dodge the buddy's country control", async () => {
    applyConfig({ buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: false })] });
    const d = await runShorthand("city");
    assert.equal(d.status, 403, JSON.stringify(d));
    assert.equal(d.error, "location_unavailable", JSON.stringify(d));
    assert.equal(d.seated, 0);
  });
});

// ── The booking/request rows carry the snapshot ──────────────────────────────────

describe("the derived service country is snapshotted onto the created rows", () => {
  it("direct booking persists country_code from the buddy", async () => {
    applyConfig({ buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: true })] });
    const d = await runDirect("city");
    assert.ok(d.status >= 200 && d.status < 300, JSON.stringify(d));
    assert.equal(state.insertedBookings[0]?.country_code, "US");
  });

  it("create-request persists country_code from the city rollout, and offer-accept's booking inherits it", async () => {
    applyConfig({ buddyCountry: "US", rolloutCountry: "US", launchControls: [usControl({ enabled: true })] });
    const d = await runMarketplace("city");
    assert.ok(d.status >= 200 && d.status < 300, JSON.stringify(d));
    assert.equal(state.insertedRequests[0]?.country_code, "US", "request row snapshots the country");
    assert.equal(state.insertedBookings[0]?.country_code, "US", "offer-accept booking carries the request snapshot");
  });
});
