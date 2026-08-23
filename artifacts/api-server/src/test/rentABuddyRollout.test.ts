/**
 * Rent a Buddy Rollout — smoke test suite
 *
 * Covers all 17 core flows plus: MVP category enforcement, beta-only mode,
 * owner override audit log, global pause, cash balance pause, test booking
 * exclusion from public counts, test payment production block, metrics
 * calculation, and audit log creation on rollout actions.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddyRollout.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRolloutRouter, { invalidateGcCache, checkRentBuddyAccess } from "../routes/rentABuddyRollout.js";
import rentABuddyRouter, { POLICY_TEXT } from "../routes/rentABuddy.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const ADMIN_TOKEN    = "rollout-admin-token";
const USER_TOKEN     = "rollout-user-token";
const BUDDY_TOKEN    = "rollout-buddy-token";
const ADMIN_ID       = "admin-user-1";
const USER_ID        = "traveler-user-1";
const BUDDY_USER_ID  = "buddy-user-1";
const BUDDY_PROF_ID  = "buddy-profile-1";
const CITY_ID        = "city-rollout-1";
const CHECKLIST_ID   = "checklist-1";
const BETA_ID        = "beta-access-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = USER_TOKEN,
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

// ── Fake state ────────────────────────────────────────────────────────────────

interface RolloutState {
  featureFlags:      Record<string, { flag: string; enabled: boolean }>;
  profiles:          Record<string, any>;
  buddyProfiles:     Record<string, any>;
  bookings:          Record<string, any>;
  cityRollouts:      Record<string, any>;
  betaAccess:        Record<string, any>;
  checklists:        Record<string, any>;
  globalControls:    any;
  auditLogs:         any[];
  waitlist:          any[];
  applications:      Record<string, any>;
  reviews:           any[];
  policyFlags:       any[];
  disputes:          any[];
  safetyCheckins:    any[];
}

let state: RolloutState;

function resetState(overrides: Partial<RolloutState> = {}): void {
  state = {
    featureFlags: {
      rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
      RENT_BUDDY_MVP_MODE:               { flag: "RENT_BUDDY_MVP_MODE", enabled: false },
      RENT_BUDDY_ADMIN_ONLY_MODE:        { flag: "RENT_BUDDY_ADMIN_ONLY_MODE", enabled: false },
      RENT_BUDDY_BETA_ONLY_MODE:         { flag: "RENT_BUDDY_BETA_ONLY_MODE", enabled: false },
      RENT_BUDDY_NIGHTLIFE_ENABLED:      { flag: "RENT_BUDDY_NIGHTLIFE_ENABLED", enabled: true },
      RENT_BUDDY_GROUP_BOOKINGS_ENABLED: { flag: "RENT_BUDDY_GROUP_BOOKINGS_ENABLED", enabled: false },
      RENT_BUDDY_CASH_BALANCE_ENABLED:   { flag: "RENT_BUDDY_CASH_BALANCE_ENABLED", enabled: false },
      RENT_BUDDY_PACKAGES_ENABLED:       { flag: "RENT_BUDDY_PACKAGES_ENABLED", enabled: false },
      RENT_BUDDY_OFFERS_ENABLED:         { flag: "RENT_BUDDY_OFFERS_ENABLED", enabled: false },
      RENT_BUDDY_DELAYED_POSTING_REQUIRED:{ flag: "RENT_BUDDY_DELAYED_POSTING_REQUIRED", enabled: false },
    },
    profiles: {
      [ADMIN_ID]:      { id: ADMIN_ID, role: "admin", verified: true },
      [USER_ID]:       { id: USER_ID,  role: "user",  verified: true },
      [BUDDY_USER_ID]: { id: BUDDY_USER_ID, role: "user", verified: true },
    },
    buddyProfiles: {
      [BUDDY_PROF_ID]: {
        id: BUDDY_PROF_ID, user_id: BUDDY_USER_ID, city: "Bangkok", status: "active",
        admin_status: "active", verified: true, completed_bookings: 5,
        average_rating: 4.8, review_count: 5, categories: ["city", "language"],
        hourly_rate_usd: 25,
      },
    },
    bookings: {},
    cityRollouts: {
      [CITY_ID]: {
        id: CITY_ID, city: "Bangkok", country: "TH", status: "public_mvp",
        status_changed_at: new Date().toISOString(), status_changed_by: ADMIN_ID,
        target_launch_date: null, buddy_cap: null, notes: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    },
    betaAccess: {
      [BETA_ID]: {
        id: BETA_ID, user_id: USER_ID, city: "Bangkok",
        access_type: "invited", status: "active",
        invited_by: ADMIN_ID, created_at: new Date().toISOString(),
      },
    },
    checklists: {
      [CHECKLIST_ID]: {
        id: CHECKLIST_ID, city_rollout_id: CITY_ID,
        checklist_status: "passed",
        policy_scan_passed: true, safety_flow_passed: true, booking_flow_passed: true,
        telegraph_passed: true, trust_score_passed: true, payment_flow_passed: true,
        moderation_passed: true, waitlist_flow_passed: true, buddy_application_passed: true,
        tested_by_admin_id: ADMIN_ID, tested_at: new Date().toISOString(),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    },
    globalControls: {
      id: 1, all_bookings_paused: false, applications_paused: false,
      cash_balance_paused: false, nightlife_paused: false,
      force_full_in_app: false, force_public_meetup: false, force_delayed_posting: false,
    },
    auditLogs:    [],
    waitlist:     [],
    applications: {},
    reviews:      [],
    policyFlags:  [],
    disputes:     [],
    safetyCheckins: [],
  };
  Object.assign(state, overrides);
}

function makeClient(userId: string, role = "user") {
  return {
    auth: {
      async getUser(token: string) {
        let uid = userId;
        if (token === ADMIN_TOKEN)  uid = ADMIN_ID;
        if (token === USER_TOKEN)   uid = USER_ID;
        if (token === BUDDY_TOKEN)  uid = BUDDY_USER_ID;
        return { data: { user: { id: uid } }, error: null };
      },
    },
    from(table: string) {
      return fakeTable(table);
    },
  };

  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _updateData: null as any,
      _upsertData: null as any,
      _maybeSingle: false,
      _orderBy: null as any,
      _rangeFrom: 0,
      _rangeTo: 999,
      _count: false,

      select(cols?: string, opts?: any) { if (opts?.count) this._count = true; return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      upsert(data: any, _opts?: any) { this._upsertData = data; return this; },
      delete() { this._updateData = "__delete__"; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["ilike", col, val.replace(/%/g, "")]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      contains(col: string, val: any) { this._filters.push(["contains", col, val]); return this; },
      or() { return this; },
      is(col: string, val: any) { this._filters.push(["is", col, val]); return this; },
      limit(n: number) { return this; },
      range(from: number, to: number) { this._rangeFrom = from; this._rangeTo = to; return this; },
      order(col: string, _opts?: any) { this._orderBy = col; return this; },
      maybeSingle() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // ── Inserts ──
        if (this._insertData !== null) {
          const data = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
          const rows: any[] = data.map((d: any) => ({ id: `gen-${Math.random().toString(36).slice(2)}`, ...d }));

          if (t === "rent_buddy_launch_audit_logs") {
            for (const r of rows) state.auditLogs.push(r);
          }
          if (t === "rent_buddy_city_rollouts") {
            for (const r of rows) state.cityRollouts[r.id] = r;
          }
          if (t === "rent_buddy_beta_access") {
            for (const r of rows) state.betaAccess[r.id] = r;
          }
          if (t === "rent_buddy_launch_checklists") {
            for (const r of rows) state.checklists[r.id] = r;
          }
          if (t === "rent_buddy_waitlist") {
            for (const r of rows) state.waitlist.push(r);
          }
          if (t === "rent_buddy_bookings") {
            for (const r of rows) state.bookings[r.id] = r;
          }

          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: null, error: null };
        }

        // ── Upserts ──
        if (this._upsertData !== null) {
          const d = this._upsertData;
          if (t === "rent_buddy_beta_access") {
            const existing = Object.values(state.betaAccess).find(
              (r: any) => r.user_id === d.user_id && r.city === d.city,
            );
            if (existing) {
              Object.assign(existing, d);
              if (this._maybeSingle) return { data: existing, error: null };
            } else {
              const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...d };
              state.betaAccess[r.id] = r;
              if (this._maybeSingle) return { data: r, error: null };
            }
          }
          if (t === "rent_buddy_launch_checklists") {
            const existing = Object.values(state.checklists).find(
              (r: any) => r.city_rollout_id === d.city_rollout_id,
            );
            if (existing) {
              Object.assign(existing, d);
              if (this._maybeSingle) return { data: existing, error: null };
            } else {
              const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...d };
              state.checklists[r.id] = r;
              if (this._maybeSingle) return { data: r, error: null };
            }
          }
          if (t === "rent_buddy_global_controls") {
            Object.assign(state.globalControls, d);
            if (this._maybeSingle) return { data: state.globalControls, error: null };
          }
          if (t === "rent_buddy_waitlist") {
            const existing = state.waitlist.find(
              (r: any) => r.user_id === d.user_id && r.city === d.city,
            );
            if (existing) {
              Object.assign(existing, d);
            } else {
              state.waitlist.push({ id: `gen-${Math.random().toString(36).slice(2)}`, ...d });
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        }

        // ── Updates ──
        if (this._updateData !== null) {
          const applyUpdate = (obj: any) => {
            if (this._updateData !== "__delete__") Object.assign(obj, this._updateData);
          };

          if (t === "rent_buddy_city_rollouts") {
            for (const [op, col, val] of this._filters) {
              if (op === "eq" && col === "id" && state.cityRollouts[val]) {
                applyUpdate(state.cityRollouts[val]);
              }
            }
          }
          if (t === "rent_buddy_beta_access") {
            for (const [op, col, val] of this._filters) {
              if (op === "eq" && col === "id" && state.betaAccess[val]) {
                applyUpdate(state.betaAccess[val]);
              }
            }
          }
          if (t === "rent_buddy_launch_checklists") {
            for (const [op, col, val] of this._filters) {
              if (op === "eq" && col === "id") {
                const cl = Object.values(state.checklists).find((r: any) => r.id === val);
                if (cl) applyUpdate(cl);
              }
            }
          }
          if (t === "rent_buddy_global_controls") {
            applyUpdate(state.globalControls);
          }
          if (t === "rent_buddy_bookings") {
            for (const [op, col, val] of this._filters) {
              if (op === "eq" && col === "id" && state.bookings[val]) {
                applyUpdate(state.bookings[val]);
              }
            }
          }
          return { data: null, error: null };
        }

        // ── Selects ──
        if (t === "feature_flags") {
          const flagMap = state.featureFlags;
          const eqFlag = this._filters.find(([op, col]) => op === "eq" && col === "flag");
          if (eqFlag && this._maybeSingle) return { data: flagMap[eqFlag[2]] ?? null, error: null };
          return { data: Object.values(flagMap), error: null };
        }

        if (t === "profiles") {
          const profiles = state.profiles;
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: profiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(profiles), error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          const rolls = Object.values(state.cityRollouts);
          const eqId    = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const ilikeCity = this._filters.find(([op, col]) => op === "ilike" && col === "city");
          const eqStatus  = this._filters.find(([op, col]) => op === "eq" && col === "status");

          if (eqId && this._maybeSingle) return { data: state.cityRollouts[eqId[2]] ?? null, error: null };
          if (ilikeCity && this._maybeSingle) {
            const match = rolls.find((r: any) => r.city.toLowerCase() === (ilikeCity[2] as string).toLowerCase());
            return { data: match ?? null, error: null };
          }
          let rows = [...rolls];
          if (eqStatus) rows = rows.filter((r: any) => r.status === eqStatus[2]);
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_beta_access") {
          const entries = Object.values(state.betaAccess);
          const eqId     = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const eqUser   = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          const ilikeCity = this._filters.find(([op, col]) => op === "ilike" && col === "city");
          const eqStatus  = this._filters.find(([op, col]) => op === "eq" && col === "status");

          if (eqId && this._maybeSingle) return { data: state.betaAccess[eqId[2]] ?? null, error: null };
          let rows = [...entries];
          if (eqUser)    rows = rows.filter((r: any) => r.user_id === eqUser[2]);
          if (ilikeCity) rows = rows.filter((r: any) => r.city.toLowerCase() === (ilikeCity[2] as string).toLowerCase());
          if (eqStatus)  rows = rows.filter((r: any) => r.status === eqStatus[2]);
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "rent_buddy_launch_checklists") {
          const eqId    = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const eqCity  = this._filters.find(([op, col]) => op === "eq" && col === "city_rollout_id");
          if (eqId && this._maybeSingle) {
            const cl = Object.values(state.checklists).find((r: any) => r.id === eqId[2]);
            return { data: cl ?? null, error: null };
          }
          if (eqCity && this._maybeSingle) {
            const cl = Object.values(state.checklists).find((r: any) => r.city_rollout_id === eqCity[2]);
            return { data: cl ?? null, error: null };
          }
          let rows = Object.values(state.checklists);
          if (eqCity) rows = rows.filter((r: any) => r.city_rollout_id === eqCity[2]);
          return { data: rows, error: null };
        }

        if (t === "rent_buddy_global_controls") {
          const gc = state.globalControls ?? {
            id: 1,
            all_bookings_paused: false,
            applications_paused: false,
            cash_balance_paused: false,
            nightlife_paused: false,
            force_full_in_app: false,
            force_public_meetup: false,
            force_delayed_posting: false,
          };
          if (this._maybeSingle) return { data: gc, error: null };
          return { data: [gc], count: 1, error: null };
        }

        if (t === "rent_buddy_launch_audit_logs") {
          let rows = [...state.auditLogs];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_waitlist") {
          let rows = [...state.waitlist];
          for (const [op, col, val] of this._filters) {
            if (op === "ilike") rows = rows.filter((r: any) => r[col]?.toLowerCase() === (val as string).toLowerCase());
            if (op === "eq")    rows = rows.filter((r: any) => r[col] === val);
          }
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_profiles") {
          const bps = Object.values(state.buddyProfiles);
          const ilikeCity = this._filters.find(([op, col]) => op === "ilike" && col === "city");
          const eqStatus  = this._filters.find(([op, col]) => op === "eq" && col === "status");
          const eqUserId  = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          let rows = [...bps];
          if (ilikeCity) rows = rows.filter((r: any) => r.city?.toLowerCase() === (ilikeCity[2] as string).toLowerCase());
          if (eqStatus)  rows = rows.filter((r: any) => r.status === eqStatus[2]);
          if (eqUserId)  rows = rows.filter((r: any) => r.user_id === eqUserId[2]);
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_applications") {
          const apps = Object.values(state.applications);
          const ilikeCity = this._filters.find(([op, col]) => op === "ilike" && col === "city");
          let rows = [...apps];
          if (ilikeCity) rows = rows.filter((r: any) => r.city?.toLowerCase() === (ilikeCity[2] as string).toLowerCase());
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_bookings") {
          const bks = Object.values(state.bookings);
          const eqId    = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const ilikeCity = this._filters.find(([op, col]) => op === "ilike" && col === "city");
          if (eqId && this._maybeSingle) return { data: state.bookings[eqId[2]] ?? null, error: null };
          let rows = [...bks];
          if (ilikeCity) rows = rows.filter((r: any) => r.city?.toLowerCase() === (ilikeCity[2] as string).toLowerCase());
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_reviews") {
          return { data: state.reviews, count: state.reviews.length, error: null };
        }

        if (t === "rent_buddy_policy_flags") {
          return { data: state.policyFlags, count: state.policyFlags.length, error: null };
        }

        if (t === "rent_buddy_disputes") {
          return { data: state.disputes, count: state.disputes.length, error: null };
        }

        if (t === "rent_buddy_safety_checkins") {
          return { data: state.safetyCheckins, count: state.safetyCheckins.length, error: null };
        }

        return { data: [], count: 0, error: null };
      },
    };
  }
}

function setupClient(userId: string, role = "user"): void {
  const client = makeClient(userId, role);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddyRolloutRouter);
  app.use("/api", rentABuddyRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetState();
  invalidateGcCache();
  setupClient(ADMIN_ID, "admin");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Flag off hides entry points
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 1: Feature flag off blocks access", () => {
  it("GET /api/rent-buddy/launch-status returns unknown when service not configured", async () => {
    // launch-status works without auth — just check it responds
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.ok(r.status === 200 || r.status === 503);
  });

  it("checkRentBuddyAccess blocks when rent_buddy_enabled is false", async () => {
    state.featureFlags["rent_buddy_enabled"].enabled = false;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("checkRentBuddyAccess allows when rent_buddy_enabled is true", async () => {
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. City disabled blocks booking
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 2: City disabled blocks booking", () => {
  it("launch-status returns not_available for disabled city", async () => {
    state.cityRollouts[CITY_ID].status = "disabled";
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "disabled");
    assert.equal(r.body.available, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Waitlist mode
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 3: Waitlist mode", () => {
  it("city in waitlist_only status has waitlistOpen=true", async () => {
    state.cityRollouts[CITY_ID].status = "waitlist_only";
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.waitlistOpen, true);
    assert.equal(r.body.available, false);
    assert.ok(r.body.message.toLowerCase().includes("waitlist"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Underage / unverified guard (passthrough to existing rentABuddy checks)
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 4: City availability banner shows correct state", () => {
  it("public_mvp city shows available=true", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "public_mvp");
    assert.equal(r.body.available, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Unverified Buddy block — MVP mode
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 5: MVP category whitelist enforcement", () => {
  it("nightlife is blocked in MVP mode via waitlist endpoint", async () => {
    state.featureFlags["RENT_BUDDY_MVP_MODE"].enabled = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/waitlist", { city: "Bangkok", category: "nightlife" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "category_not_available");
  });

  it("MVP mode: allowed category (city) passes access check via waitlist", async () => {
    state.featureFlags["RENT_BUDDY_MVP_MODE"].enabled = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/waitlist", { city: "Bangkok", category: "city" }, USER_TOKEN);
    assert.equal(r.status, 201);
  });

  it("MVP mode: group category blocked by whitelist (category_not_available)", async () => {
    state.featureFlags["RENT_BUDDY_MVP_MODE"].enabled = true;
    state.featureFlags["RENT_BUDDY_GROUP_BOOKINGS_ENABLED"].enabled = false;
    setupClient(USER_ID);
    // "group" is not in MVP_ALLOWED_CATEGORIES so the whitelist gate fires first
    const r = await req("POST", "/api/rent-a-buddy/waitlist", { city: "Bangkok", category: "group" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "category_not_available");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Admin city rollout board
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 6: Admin city rollout board", () => {
  it("GET /api/admin/rent-buddy/rollout/cities returns cities list", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", "/api/admin/rent-buddy/rollout/cities", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.cities));
    assert.ok(r.body.cities.length >= 1);
    assert.equal(r.body.cities[0].city, "Bangkok");
  });

  it("non-admin gets 403", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/admin/rent-buddy/rollout/cities", undefined, USER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("POST /api/admin/rent-buddy/rollout/cities creates a city rollout", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/admin/rent-buddy/rollout/cities", { city: "Tokyo", country: "JP" }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
    assert.ok(r.body.city);
    // Audit log should be written
    assert.ok(state.auditLogs.some((l: any) => l.action === "city_created"));
  });

  it("POST requires city field", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/admin/rent-buddy/rollout/cities", {}, ADMIN_TOKEN);
    assert.equal(r.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Admin city pause/resume
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 7 + 15: Admin city pause/resume", () => {
  it("pause transitions city to paused status", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/pause`, { reason: "safety review" }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.toStatus, "paused");
    assert.equal(state.cityRollouts[CITY_ID].status, "paused");
    assert.ok(state.auditLogs.some((l: any) => l.action === "city_paused"));
  });

  it("resume transitions city back to public_mvp", async () => {
    state.cityRollouts[CITY_ID].status = "paused";
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/resume`, { resumeStatus: "public_mvp" }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.toStatus, "public_mvp");
    assert.equal(state.cityRollouts[CITY_ID].status, "public_mvp");
    assert.ok(state.auditLogs.some((l: any) => l.action === "city_resumed"));
  });

  it("resuming a non-paused city returns 409", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/resume`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Existing bookings survive pause (launch-status still returns paused message)
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 16: Existing bookings survive city pause", () => {
  it("paused city shows paused message but city row still exists", async () => {
    state.cityRollouts[CITY_ID].status = "paused";
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "paused");
    assert.ok(r.body.message.toLowerCase().includes("paused"));
    assert.equal(r.body.available, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Status advance with QA gate
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 9: QA gate for public_mvp advancement", () => {
  it("advance from beta_testing to public_mvp with passed checklist", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.toStatus, "public_mvp");
    assert.equal(state.cityRollouts[CITY_ID].status, "public_mvp");
    assert.ok(state.auditLogs.some((l: any) => l.action === "city_status_advanced"));
  });

  it("advance to public_mvp fails when checklist not passed", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    state.checklists[CHECKLIST_ID].checklist_status = "pending";
    state.checklists[CHECKLIST_ID].policy_scan_passed = false;
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "qa_not_passed");
  });

  // These two tests previously asserted that the override required role "owner"
  // and that a plain "admin" got a 403. That pair passed only because the first
  // one FABRICATED an owner: `state.profiles[ADMIN_ID].role = "owner"`. No such
  // row can exist — `profiles_role_check` is
  // CHECK (role = ANY (ARRAY['user','admin'])) and rejects 'owner' even for a
  // superuser (verified live 2026-08-09). So the "happy path" test exercised a
  // state the database forbids, and the "non-owner" test asserted the only
  // behaviour production could ever produce. Together they made a permanently
  // unreachable branch look fully covered, which is exactly why it survived.
  //
  // The override is now an admin capability, still requiring overrideReason and
  // still audit-logged. These tests assert that, against a reachable state.

  it("admin override with reason bypasses QA gate and writes audit log", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    state.checklists[CHECKLIST_ID].checklist_status = "pending";
    state.checklists[CHECKLIST_ID].policy_scan_passed = false;
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, { overrideReason: "Exec approval: launch event" }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.toStatus, "public_mvp");
    const overrideLog = state.auditLogs.find((l: any) => l.action === "qa_override");
    assert.ok(overrideLog, "qa_override audit log entry expected");
    assert.ok(overrideLog.override_reason.includes("Exec approval"));
  });

  it("a non-admin cannot reach the QA override at all", async () => {
    // The authorisation boundary that actually exists: requireAdmin, which
    // admits only role 'admin'. Supplying an overrideReason does not help.
    state.cityRollouts[CITY_ID].status = "beta_testing";
    state.checklists[CHECKLIST_ID].checklist_status = "pending";
    state.checklists[CHECKLIST_ID].policy_scan_passed = false;
    setupClient(USER_ID);
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, { overrideReason: "I want to override" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(state.cityRollouts[CITY_ID].status, "beta_testing", "status must not advance");
    assert.ok(
      !state.auditLogs.some((l: any) => l.action === "qa_override"),
      "no qa_override audit entry may be written for a non-admin",
    );
  });

  it("advance from disabled returns next status in order", async () => {
    state.cityRollouts[CITY_ID].status = "disabled";
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.toStatus, "waitlist_only");
  });

  it("advance from public_mvp returns 409", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "no_next_status");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. QA checklist management
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 10: QA checklist management", () => {
  it("GET /api/admin/rent-buddy/qa/checklists returns checklists", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", `/api/admin/rent-buddy/qa/checklists?cityRolloutId=${CITY_ID}`, undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.body.checklists.length >= 1);
  });

  it("mark-passed sets all boolean fields and status", async () => {
    state.checklists[CHECKLIST_ID].checklist_status = "pending";
    state.checklists[CHECKLIST_ID].policy_scan_passed = false;
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/qa/checklists/${CHECKLIST_ID}/mark-passed`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    const cl = Object.values(state.checklists).find((c: any) => c.id === CHECKLIST_ID) as any;
    assert.equal(cl.checklist_status, "passed");
    assert.equal(cl.policy_scan_passed, true);
    assert.equal(cl.safety_flow_passed, true);
    assert.ok(state.auditLogs.some((l: any) => l.action === "checklist_marked_passed"));
  });

  it("mark-failed sets status to failed and writes audit log", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/qa/checklists/${CHECKLIST_ID}/mark-failed`, { reason: "Booking flow broken" }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    const cl = Object.values(state.checklists).find((c: any) => c.id === CHECKLIST_ID) as any;
    assert.equal(cl.checklist_status, "failed");
    assert.ok(state.auditLogs.some((l: any) => l.action === "checklist_marked_failed"));
  });

  it("POST /api/admin/rent-buddy/qa/checklists creates new checklist", async () => {
    const newCityId = "city-rollout-2";
    state.cityRollouts[newCityId] = { id: newCityId, city: "Seoul", status: "internal_testing" };
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/admin/rent-buddy/qa/checklists", { cityRolloutId: newCityId }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Beta access management
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 11: Beta access management", () => {
  it("GET /api/admin/rent-buddy/beta-access returns access list", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", "/api/admin/rent-buddy/beta-access", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.betaAccess));
    assert.ok(r.body.betaAccess.length >= 1);
  });

  it("POST /api/admin/rent-buddy/beta-access grants beta access", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/admin/rent-buddy/beta-access", {
      userId: "new-user-99", city: "Tokyo", accessType: "tester", notes: "friend of team",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
    assert.ok(state.auditLogs.some((l: any) => l.action === "beta_access_granted"));
  });

  it("GET /api/rent-buddy/me/beta-status returns active access for beta user", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/me/beta-status", undefined, USER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.hasBetaAccess, true);
    assert.ok(r.body.access.length >= 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Flow 17: Beta revoke immediately blocks access
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 17: Beta revoke", () => {
  it("revoke sets status to revoked and writes audit log", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", `/api/admin/rent-buddy/beta-access/${BETA_ID}/revoke`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(state.betaAccess[BETA_ID].status, "revoked");
    assert.ok(state.auditLogs.some((l: any) => l.action === "beta_access_revoked"));
  });

  it("revoked user no longer shows beta access in me/beta-status", async () => {
    state.betaAccess[BETA_ID].status = "revoked";
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/me/beta-status", undefined, USER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.hasBetaAccess, false);
    assert.equal(r.body.access.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Global pause controls
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow: Global pause controls", () => {
  it("GET /api/admin/rent-buddy/global-controls returns current state", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", "/api/admin/rent-buddy/global-controls", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok("all_bookings_paused" in r.body.controls);
  });

  it("PATCH /api/admin/rent-buddy/global-controls updates controls and writes audit log", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("PATCH", "/api/admin/rent-buddy/global-controls", { all_bookings_paused: true }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(state.auditLogs.some((l: any) => l.action === "global_controls_updated"));
  });

  it("non-admin cannot update global controls", async () => {
    setupClient(USER_ID);
    const r = await req("PATCH", "/api/admin/rent-buddy/global-controls", { all_bookings_paused: true }, USER_TOKEN);
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Beta-only mode
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow: Beta-only mode", () => {
  it("beta-only mode flag is stored in feature_flags", () => {
    assert.ok("RENT_BUDDY_BETA_ONLY_MODE" in state.featureFlags);
    assert.equal(state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled, false);
  });

  it("enabling RENT_BUDDY_BETA_ONLY_MODE flag is reflected in state", () => {
    state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled = true;
    assert.equal(state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Test booking exclusion from public counts
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow: Test booking exclusion from metrics", () => {
  it("metrics endpoint separates real vs test bookings", async () => {
    state.bookings["real-1"] = { id: "real-1", city: "Bangkok", status: "completed", total_usd: 100, traveler_id: USER_ID, is_test_booking: false };
    state.bookings["test-1"] = { id: "test-1", city: "Bangkok", status: "completed", total_usd: 50, traveler_id: ADMIN_ID, is_test_booking: true };
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/metrics`, undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.bookings.real, 1);
    assert.equal(r.body.bookings.test, 1);
    assert.equal(r.body.bookings.completed, 1);
    assert.equal(r.body.revenue.totalUsd, 100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. MVP graduation checklist in metrics
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow: MVP graduation checklist in metrics", () => {
  it("graduationReady is false when no active verified buddies", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/metrics`, undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok("graduationChecklist" in r.body);
    // With only 1 buddy and no real bookings, most checks will fail
    assert.equal(r.body.graduationChecklist.minBuddies10, false);
  });

  it("graduationReady is true when all criteria met", async () => {
    // Set up 10 verified active buddies
    for (let i = 0; i < 10; i++) {
      state.buddyProfiles[`bp-${i}`] = { id: `bp-${i}`, user_id: `u-${i}`, city: "Bangkok", status: "active", verified: true, completed_bookings: 5 };
    }
    // Add 5 completed real bookings
    for (let i = 0; i < 5; i++) {
      state.bookings[`rb-${i}`] = { id: `rb-${i}`, city: "Bangkok", status: "completed", total_usd: 80, traveler_id: `t-${i}`, is_test_booking: false };
    }
    // Add good reviews
    state.reviews = Array.from({ length: 5 }, (_, i) => ({ id: `rv-${i}`, rating: 4.5 }));

    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/metrics`, undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.graduationChecklist.minBuddies10, true);
    assert.equal(r.body.graduationChecklist.minCompletedBookings5, true);
    assert.equal(r.body.graduationChecklist.avgRating4, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. Audit log endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow: Audit log", () => {
  it("GET /api/admin/rent-buddy/audit-log returns paginated logs", async () => {
    state.auditLogs.push({ id: "log-1", admin_id: ADMIN_ID, action: "city_created", city_rollout_id: CITY_ID, created_at: new Date().toISOString() });
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", "/api/admin/rent-buddy/audit-log", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.body.logs.length >= 1);
    assert.ok("total" in r.body);
  });

  it("audit log filters by cityRolloutId", async () => {
    state.auditLogs.push({ id: "log-x", admin_id: ADMIN_ID, action: "city_paused", city_rollout_id: CITY_ID, created_at: new Date().toISOString() });
    state.auditLogs.push({ id: "log-y", admin_id: ADMIN_ID, action: "beta_access_granted", city_rollout_id: "other-city", created_at: new Date().toISOString() });
    setupClient(ADMIN_ID, "admin");
    const r = await req("GET", `/api/admin/rent-buddy/audit-log?cityRolloutId=${CITY_ID}`, undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    const logs = r.body.logs as any[];
    assert.ok(logs.every((l: any) => l.city_rollout_id === CITY_ID));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. Launch status — all cities listing
// ─────────────────────────────────────────────────────────────────────────────
describe("Launch status: all cities", () => {
  it("GET /api/rent-buddy/launch-status without city param returns cities array", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.cities));
    assert.ok(r.body.cities.length >= 1);
    assert.ok(r.body.cities[0].message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. City not found returns disabled
// ─────────────────────────────────────────────────────────────────────────────
describe("Launch status: unknown city", () => {
  it("unknown city returns disabled status", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=ZZUnknownCity");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "disabled");
    assert.equal(r.body.available, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. PATCH city rollout metadata
// ─────────────────────────────────────────────────────────────────────────────
describe("Admin city PATCH", () => {
  it("PATCH updates metadata fields", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("PATCH", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}`, { buddyCap: 50, notes: "Soft launch" }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(state.auditLogs.some((l: any) => l.action === "city_updated"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21. Status advancement chain
// ─────────────────────────────────────────────────────────────────────────────
describe("Status advancement: full chain", () => {
  it("advances through disabled → waitlist_only → buddy_applications_open", async () => {
    state.cityRollouts[CITY_ID].status = "disabled";
    setupClient(ADMIN_ID, "admin");

    let r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.body.toStatus, "waitlist_only");

    r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.body.toStatus, "buddy_applications_open");

    r = await req("POST", `/api/admin/rent-buddy/rollout/cities/${CITY_ID}/advance-status`, {}, ADMIN_TOKEN);
    assert.equal(r.body.toStatus, "internal_testing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22. Beta access: grant already-existing access is idempotent (upsert)
// ─────────────────────────────────────────────────────────────────────────────
describe("Beta access: idempotent grant", () => {
  it("granting same city+user again upserts without error", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/admin/rent-buddy/beta-access", { userId: USER_ID, city: "Bangkok" }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23. Applications open status — applications endpoint
// ─────────────────────────────────────────────────────────────────────────────
describe("City status: applicationsOpen flag", () => {
  it("public_mvp city shows applicationsOpen=true", async () => {
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.applicationsOpen, true);
  });

  it("disabled city shows applicationsOpen=false", async () => {
    state.cityRollouts[CITY_ID].status = "disabled";
    setupClient(USER_ID);
    const r = await req("GET", "/api/rent-buddy/launch-status?city=Bangkok");
    assert.equal(r.status, 200);
    assert.equal(r.body.applicationsOpen, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 24: Beta-only mode HTTP enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: Beta-only mode HTTP enforcement", () => {
  it("RENT_BUDDY_BETA_ONLY_MODE blocks apply for non-beta user", async () => {
    state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled = true;
    state.betaAccess = {};
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/apply", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "beta_access_required");
  });

  it("RENT_BUDDY_BETA_ONLY_MODE blocks waitlist for non-beta user", async () => {
    state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled = true;
    state.betaAccess = {};
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "beta_access_required");
  });

  it("RENT_BUDDY_BETA_ONLY_MODE allows user with active beta access", async () => {
    state.featureFlags["RENT_BUDDY_BETA_ONLY_MODE"].enabled = true;
    // USER_ID still has BETA_ID (Bangkok, active) in state
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 25: Admin-only mode HTTP enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: Admin-only mode HTTP enforcement", () => {
  it("RENT_BUDDY_ADMIN_ONLY_MODE blocks non-admin from waitlist", async () => {
    state.featureFlags["RENT_BUDDY_ADMIN_ONLY_MODE"].enabled = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "admin_only");
  });

  it("RENT_BUDDY_ADMIN_ONLY_MODE allows admin through", async () => {
    state.featureFlags["RENT_BUDDY_ADMIN_ONLY_MODE"].enabled = true;
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
  });

  it("RENT_BUDDY_ADMIN_ONLY_MODE allows owner role through", async () => {
    state.featureFlags["RENT_BUDDY_ADMIN_ONLY_MODE"].enabled = true;
    state.profiles[ADMIN_ID].role = "owner";
    setupClient(ADMIN_ID, "owner");
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, ADMIN_TOKEN);
    assert.equal(r.status, 201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 26: Global pause controls block booking and apply
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: Global pause controls block booking/apply", () => {
  const bookingBody = {
    buddyId: BUDDY_PROF_ID, bookingDate: "2026-08-01", durationH: 3,
    groupSize: 1, city: "Bangkok", category: "city", paymentMode: "full_in_app",
  };

  it("all_bookings_paused blocks book action via bookings route (503 globally_paused)", async () => {
    state.globalControls.all_bookings_paused = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", bookingBody, USER_TOKEN);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "globally_paused");
  });

  it("applications_paused blocks apply action (503 applications_paused)", async () => {
    state.globalControls.applications_paused = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/apply", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "applications_paused");
  });

  it("cash_balance_paused blocks deposit_plus_cash booking (503 cash_balance_paused)", async () => {
    state.globalControls.cash_balance_paused = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", { ...bookingBody, paymentMode: "deposit_plus_cash" }, USER_TOKEN);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "cash_balance_paused");
  });

  it("force_full_in_app blocks deposit_plus_cash booking (403 full_payment_required)", async () => {
    state.globalControls.force_full_in_app = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", { ...bookingBody, paymentMode: "deposit_plus_cash" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "full_payment_required");
  });

  it("force_public_meetup blocks private meetup booking (403 private_meetup_unavailable)", async () => {
    state.globalControls.force_public_meetup = true;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", { ...bookingBody, meetupLocation: { type: "private" } }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "private_meetup_unavailable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 27: MVP mode — ID verification required for booking
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: MVP mode ID-verification gate", () => {
  const bookingBody = {
    buddyId: BUDDY_PROF_ID, bookingDate: "2026-08-01", durationH: 3,
    groupSize: 1, city: "Bangkok", category: "city", paymentMode: "full_in_app",
  };

  it("MVP mode blocks booking when user has no id-verified rent_buddy_profile (403 verification_required)", async () => {
    state.featureFlags["RENT_BUDDY_MVP_MODE"].enabled = true;
    // USER_ID has no entry in buddyProfiles → query returns null
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", bookingBody, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "verification_required");
  });

  it("MVP mode allows booking when the TRAVELLER is ID-verified on their profile", async () => {
    state.featureFlags["RENT_BUDDY_MVP_MODE"].enabled = true;
    // The booking actor is the traveller, so their ID verification lives on
    // `profiles` — not on a rent_buddy_profiles row, which only exists for
    // users who applied to become a buddy. `verification_level` is what the
    // real verification flow writes; the bare `verified` boolean is a display
    // badge and is deliberately not accepted as identity evidence.
    state.profiles[USER_ID].verification_level = "id";
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", bookingBody, USER_TOKEN);
    // idVerified check passes — route continues; must not return verification_required
    assert.notEqual(r.body.error, "verification_required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 28: City beta_testing status blocks non-beta users
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: City beta_testing blocks non-beta user", () => {
  it("beta_testing city blocks waitlist for user without beta access", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    state.betaAccess = {};
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "city_beta_access_required");
  });

  it("beta_testing city allows waitlist for user with active city beta access", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    // USER_ID has BETA_ID (Bangkok, active)
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-buddy/waitlist", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 201);
  });

  it("beta_testing city blocks apply for user without beta access", async () => {
    state.cityRollouts[CITY_ID].status = "beta_testing";
    state.betaAccess = {};
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/apply", { city: "Bangkok" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "city_beta_access_required");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 29: Test booking creation is admin-only
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: Test booking creation restricted to admins", () => {
  const testBookingBody = {
    buddyId: BUDDY_PROF_ID, bookingDate: "2026-08-01", durationH: 3,
    groupSize: 1, city: "Bangkok", category: "city", paymentMode: "full_in_app",
    is_test_booking: true,
  };

  it("non-admin cannot create test booking (403 forbidden)", async () => {
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/bookings", testBookingBody, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("admin can create test booking — passes the test-booking guard", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req("POST", "/api/rent-a-buddy/bookings", testBookingBody, ADMIN_TOKEN);
    // Guard passes; further processing may succeed or fail on other validations but must not be 403 forbidden
    assert.notEqual(r.body.error, "forbidden");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate: City creation is always disabled — no direct path to public_mvp
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: city creation always starts at disabled", () => {
  it("status=public_mvp in body is ignored — city created at disabled", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req(
      "POST", "/api/admin/rent-buddy/rollout/cities",
      { city: "Singapore", country: "Singapore", status: "public_mvp" },
      ADMIN_TOKEN,
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.city.status, "disabled",
      "caller-supplied status=public_mvp must be ignored");
  });

  it("status=beta_testing in body is ignored — city created at disabled", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req(
      "POST", "/api/admin/rent-buddy/rollout/cities",
      { city: "Kuala Lumpur", country: "Malaysia", status: "beta_testing" },
      ADMIN_TOKEN,
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.city.status, "disabled");
  });

  it("omitting status also creates at disabled", async () => {
    setupClient(ADMIN_ID, "admin");
    const r = await req(
      "POST", "/api/admin/rent-buddy/rollout/cities",
      { city: "Tokyo", country: "Japan" },
      ADMIN_TOKEN,
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.city.status, "disabled");
  });

  it("audit log records toStatus=disabled regardless of body status", async () => {
    setupClient(ADMIN_ID, "admin");
    await req(
      "POST", "/api/admin/rent-buddy/rollout/cities",
      { city: "Seoul", country: "South Korea", status: "public_mvp" },
      ADMIN_TOKEN,
    );
    const createdCity = Object.values(state.cityRollouts).find((r: any) => r.city === "Seoul") as any;
    assert.ok(createdCity, "city row should exist");
    const log = state.auditLogs.find(
      (l: any) => l.action === "city_created" && l.city_rollout_id === createdCity.id,
    );
    assert.ok(log, "audit log entry should exist");
    assert.equal(log.to_status, "disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA Gate 30: Buddy dashboard mutations gated by rollout (feature_disabled)
// ─────────────────────────────────────────────────────────────────────────────
describe("QA Gate: Buddy dashboard mutations blocked when feature disabled", () => {
  it("PATCH /api/rent-a-buddy/dashboard/offer blocked when rent_buddy_enabled=false", async () => {
    state.featureFlags["rent_buddy_enabled"].enabled = false;
    setupClient(USER_ID);
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/offer", { tagline: "test" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("POST /api/rent-a-buddy/dashboard/packages blocked when rent_buddy_enabled=false", async () => {
    state.featureFlags["rent_buddy_enabled"].enabled = false;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/dashboard/packages", { title: "Tour", category: "city", durationH: 3, priceUsd: 50 }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("POST /api/rent-a-buddy/dashboard/availability blocked when rent_buddy_enabled=false", async () => {
    state.featureFlags["rent_buddy_enabled"].enabled = false;
    setupClient(USER_ID);
    const r = await req("POST", "/api/rent-a-buddy/dashboard/availability", { entries: [] }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("PATCH /api/rent-a-buddy/me/profile blocked when rent_buddy_enabled=false", async () => {
    state.featureFlags["rent_buddy_enabled"].enabled = false;
    setupClient(USER_ID);
    const r = await req("PATCH", "/api/rent-a-buddy/me/profile", { tagline: "test" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("Buddy dashboard mutations blocked when RENT_BUDDY_ADMIN_ONLY_MODE=true for non-admin", async () => {
    state.featureFlags["RENT_BUDDY_ADMIN_ONLY_MODE"].enabled = true;
    setupClient(USER_ID);
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/offer", { tagline: "test" }, USER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "admin_only");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive city status coverage for checkRentBuddyAccess
//
// Tests every CityRolloutStatus value directly against the exported function.
// If a new status is added to the DB enum without updating checkRentBuddyAccess,
// the "unknown status" test will fail (expected — the gap is now visible).
// ─────────────────────────────────────────────────────────────────────────────
describe("checkRentBuddyAccess: exhaustive city status coverage", () => {
  /**
   * Minimal fake service client for direct checkRentBuddyAccess calls.
   * Handles only the tables the function queries; returns stable values
   * for everything except the city status, which is parameterised.
   */
  function makeScForStatus(cityStatus: string, opts: { betaActive?: boolean } = {}): any {
    return {
      from(table: string) {
        const t = table;
        const filters: Record<string, any> = {};
        const self: any = {
          select() { return self; },
          eq(col: string, val: any)    { filters[col] = val; return self; },
          ilike(col: string, val: any) { filters[col] = val; return self; },
          maybeSingle() { return self; },
          in() { return self; },
          async then(resolve: (v: any) => void) {
            if (t === "feature_flags") {
              const flag = filters["flag"] as string;
              // Only rent_buddy_enabled is on; all mode/gate flags are off
              resolve({ data: { flag, enabled: flag === "rent_buddy_enabled" }, error: null });
              return;
            }
            if (t === "rent_buddy_global_controls") {
              resolve({
                data: {
                  id: 1, all_bookings_paused: false, applications_paused: false,
                  cash_balance_paused: false, nightlife_paused: false,
                  force_full_in_app: false, force_public_meetup: false, force_delayed_posting: false,
                },
                error: null,
              });
              return;
            }
            if (t === "rent_buddy_city_rollouts") {
              resolve({ data: { id: "c1", city: "TestCity", status: cityStatus }, error: null });
              return;
            }
            if (t === "rent_buddy_beta_access") {
              const d = opts.betaActive
                ? { id: "b1", user_id: USER_ID, city: "TestCity", status: "active" }
                : null;
              resolve({ data: d, error: null });
              return;
            }
            if (t === "profiles") {
              resolve({ data: { id: USER_ID, role: "user" }, error: null });
              return;
            }
            if (t === "rent_buddy_profiles") {
              // id_verified=true so MVP-mode book check doesn't block
              resolve({ data: { id: "rp1", user_id: USER_ID, id_verified: true }, error: null });
              return;
            }
            resolve({ data: null, error: null });
          },
        };
        return self;
      },
    };
  }

  const CITY = "TestCity";

  beforeEach(() => {
    invalidateGcCache();
  });

  // ── disabled ────────────────────────────────────────────────────────────────

  it("disabled — blocks book action (city_not_available)", async () => {
    const sc = makeScForStatus("disabled");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });

  it("disabled — blocks read action (city_not_available)", async () => {
    const sc = makeScForStatus("disabled");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });

  // ── suspended ───────────────────────────────────────────────────────────────

  it("suspended — blocks book action (city_not_available)", async () => {
    const sc = makeScForStatus("suspended");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });

  it("suspended — blocks read action (city_not_available)", async () => {
    const sc = makeScForStatus("suspended");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });

  // ── waitlist_only ───────────────────────────────────────────────────────────

  it("waitlist_only — allows waitlist action", async () => {
    const sc = makeScForStatus("waitlist_only");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "waitlist" });
    assert.equal(r.allowed, true);
  });

  it("waitlist_only — allows read action", async () => {
    const sc = makeScForStatus("waitlist_only");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, true);
  });

  it("waitlist_only — blocks book action (waitlist_only)", async () => {
    const sc = makeScForStatus("waitlist_only");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "waitlist_only");
  });

  // ── buddy_applications_open ─────────────────────────────────────────────────

  it("buddy_applications_open — allows apply action", async () => {
    const sc = makeScForStatus("buddy_applications_open");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "apply" });
    assert.equal(r.allowed, true);
  });

  it("buddy_applications_open — allows read action", async () => {
    const sc = makeScForStatus("buddy_applications_open");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, true);
  });

  it("buddy_applications_open — blocks book action (not_open_for_bookings)", async () => {
    const sc = makeScForStatus("buddy_applications_open");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "not_open_for_bookings");
  });

  // ── internal_testing ────────────────────────────────────────────────────────

  it("internal_testing — blocks non-test user for any action (internal_testing)", async () => {
    const sc = makeScForStatus("internal_testing");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read", isTestUser: false });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "internal_testing");
  });

  it("internal_testing — allows isTestUser=true for book action", async () => {
    const sc = makeScForStatus("internal_testing");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book", isTestUser: true });
    assert.equal(r.allowed, true);
  });

  // ── beta_testing ────────────────────────────────────────────────────────────

  it("beta_testing — blocks non-beta user for book action (city_beta_access_required)", async () => {
    const sc = makeScForStatus("beta_testing", { betaActive: false });
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_beta_access_required");
  });

  it("beta_testing — blocks non-beta user for apply action (city_beta_access_required)", async () => {
    const sc = makeScForStatus("beta_testing", { betaActive: false });
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "apply" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_beta_access_required");
  });

  it("beta_testing — allows read action without beta access", async () => {
    const sc = makeScForStatus("beta_testing", { betaActive: false });
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, true);
  });

  it("beta_testing — allows book action with active beta access", async () => {
    const sc = makeScForStatus("beta_testing", { betaActive: true });
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, true);
  });

  // ── public_mvp ──────────────────────────────────────────────────────────────

  it("public_mvp — allows book action", async () => {
    const sc = makeScForStatus("public_mvp");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, true);
  });

  it("public_mvp — allows read action", async () => {
    const sc = makeScForStatus("public_mvp");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, true);
  });

  // ── paused ──────────────────────────────────────────────────────────────────

  it("paused — blocks book action (city_paused)", async () => {
    const sc = makeScForStatus("paused");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_paused");
  });

  it("paused — allows read action", async () => {
    const sc = makeScForStatus("paused");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, true);
  });

  it("paused — allows waitlist action", async () => {
    const sc = makeScForStatus("paused");
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "waitlist" });
    assert.equal(r.allowed, true);
  });

  // ── unknown / future status ─────────────────────────────────────────────────
  // This test is the regression guard: if a new DB enum value is added without
  // updating checkRentBuddyAccess, a test like this must be added too.
  // The fail-closed guard in the function ensures it returns city_not_available
  // rather than silently allowing access.

  it("unknown status — blocked by fail-closed guard (city_not_available)", async () => {
    const sc = makeScForStatus("future_unhandled_status" as any);
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "read" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });

  it("unknown status — blocked even for book action", async () => {
    const sc = makeScForStatus("vip_only" as any);
    const r = await checkRentBuddyAccess({ sc, userId: USER_ID, city: CITY, action: "book" });
    assert.equal(r.allowed, false);
    assert.equal((r as any).code, "city_not_available");
  });
});
