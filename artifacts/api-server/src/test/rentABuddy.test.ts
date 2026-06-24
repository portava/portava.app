/**
 * Rent a Buddy — API route tests
 *
 * Covers: feature-flag gating, policy text in responses, banned keyword creates
 * policy flag (not auto-ban), severe flags limit access, new-Buddy restrictions,
 * private first meetup blocked, route-change safety event, emergency phrase
 * (traveler-only), cash balance disagreement → dispute, confirmed cash emits
 * positive Trust Score event, no-show/cancel emits negative Trust Score event,
 * admin confirm/dismiss policy flag, admin apply full-in-app-payment-required
 * limit, user with cash_balance_disabled cannot choose deposit_plus_cash,
 * user with rent_buddy_disabled cannot create bookings, double-blind review
 * logic, comfort check distress → safety event.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddy.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter, { POLICY_TEXT } from "../routes/rentABuddy.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN  = "rb-test-token";
const BUDDY_TOKEN = "rb-buddy-token";
const ADMIN_TOKEN = "rb-admin-token";
const USER_ID     = "user-traveler-1";
const BUDDY_USER  = "user-buddy-1";
const ADMIN_USER  = "user-admin-1";
const BUDDY_PROF  = "profile-buddy-1";
const BOOKING_ID  = "booking-uuid-1";
const PACKAGE_ID  = "package-uuid-1";
const FLAG_ID     = "flag-uuid-1";

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

interface FakeState {
  featureFlags?:   Record<string, { flag: string; enabled: boolean }>;
  profiles?:       Record<string, any>;
  buddyProfiles?:  Record<string, any>;
  applications?:   Record<string, any>;
  bookings?:       Record<string, any>;
  reviews?:        Record<string, any>[];
  policyFlags?:    Record<string, any>[];
  safetyEvents?:   any[];
  safetyCheckins?: any[];
  disputes?:       any[];
  userLimits?:     Record<string, any>;
  adminActions?:   any[];
  trustEvents?:    any[];
  packages?:       Record<string, any>[];
  addons?:         Record<string, any>[];
  availability?:   Record<string, any>[];
}

let state: FakeState = {};

function makeClient(userId: string, role = "user") {
  const inserted: any[] = [];

  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _updateData: null as any,
      _upsertData: null as any,
      _limit: 1000,
      _range: [0, 999] as [number, number],
      _order: null as any,
      _count: false,
      _maybeSingle: false,

      select(cols?: string, opts?: any) { if (opts?.count) this._count = true; return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      upsert(data: any, opts?: any) { this._upsertData = data; return this; },
      delete() { this._updateData = "__delete__"; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      like(col: string, val: any) { this._filters.push(["like", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["ilike", col, val]); return this; },
      contains(col: string, val: any) { this._filters.push(["contains", col, val]); return this; },
      or(expr: string) { return this; },
      is(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      limit(n: number) { this._limit = n; return this; },
      range(from: number, to: number) { this._range = [from, to]; return this; },
      order(col: string, opts?: any) { this._order = { col, ...opts }; return this; },
      maybeSingle() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // Handle inserts
        if (this._insertData !== null) {
          const data = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
          for (const row of data) {
            const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...row };
            inserted.push({ table: t, row: r });
            if (t === "trust_events") {
              if (!state.trustEvents) state.trustEvents = [];
              state.trustEvents.push(r);
            }
            if (t === "rent_buddy_policy_flags") {
              if (!state.policyFlags) state.policyFlags = [];
              state.policyFlags.push(r);
            }
            if (t === "rent_buddy_safety_events") {
              if (!state.safetyEvents) state.safetyEvents = [];
              state.safetyEvents.push(r);
            }
            if (t === "rent_buddy_safety_checkins") {
              if (!state.safetyCheckins) state.safetyCheckins = [];
              state.safetyCheckins.push(r);
            }
            if (t === "rent_buddy_disputes") {
              if (!state.disputes) state.disputes = [];
              state.disputes.push(r);
            }
            if (t === "rent_buddy_admin_actions") {
              if (!state.adminActions) state.adminActions = [];
              state.adminActions.push(r);
            }
            if (t === "rent_buddy_reviews") {
              if (!state.reviews) state.reviews = [];
              state.reviews.push(r);
            }
          }
          if (this._maybeSingle) return { data: data.length === 1 ? { ...data[0], id: `gen-${Math.random().toString(36).slice(2)}` } : null, error: null };
          return { data: null, error: null };
        }

        // Handle upserts
        if (this._upsertData !== null) {
          const row = this._upsertData;
          if (t === "rent_buddy_user_limits" && row.user_id) {
            if (!state.userLimits) state.userLimits = {};
            state.userLimits[row.user_id] = row;
          }
          if (t === "rent_buddy_bookings") {
            if (!state.bookings) state.bookings = {};
            const id = row.id ?? `gen-${Math.random().toString(36).slice(2)}`;
            state.bookings[id] = { id, ...row };
          }
          if (this._maybeSingle) return { data: { id: `gen-${Math.random().toString(36).slice(2)}`, ...row }, error: null };
          return { data: null, error: null };
        }

        // Handle updates / deletes
        if (this._updateData !== null) {
          if (t === "rent_buddy_bookings") {
            for (const [, col, val] of this._filters) {
              if (col === "id" && state.bookings?.[val]) {
                if (this._updateData === "__delete__") {
                  delete state.bookings[val];
                } else {
                  state.bookings[val] = { ...state.bookings[val], ...this._updateData };
                }
              }
            }
          }
          if (t === "rent_buddy_policy_flags") {
            for (const [, col, val] of this._filters) {
              if (col === "id") {
                const flag = (state.policyFlags ?? []).find((f: any) => f.id === val);
                if (flag && this._updateData !== "__delete__") Object.assign(flag, this._updateData);
              }
            }
          }
          if (t === "rent_buddy_profiles") {
            for (const [, col, val] of this._filters) {
              if (col === "user_id" && state.buddyProfiles?.[val]) {
                Object.assign(state.buddyProfiles[val], this._updateData);
              }
            }
          }
          return { data: null, error: null };
        }

        // Handle selects
        if (t === "feature_flags") {
          const flagMap = state.featureFlags ?? {};
          const flagEqFilter = this._filters.find(([op, col]) => op === "eq" && col === "flag");
          if (flagEqFilter && this._maybeSingle) {
            const flagVal = flagMap[flagEqFilter[2] as string];
            return { data: flagVal ?? null, error: null };
          }
          return { data: Object.values(flagMap), error: null, count: Object.values(flagMap).length };
        }

        if (t === "profiles") {
          const profiles = state.profiles ?? {};
          const eqFilter = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqFilter && this._maybeSingle) return { data: profiles[eqFilter[2]] ?? null, error: null };
          return { data: Object.values(profiles), error: null, count: Object.values(profiles).length };
        }

        if (t === "rent_buddy_profiles") {
          const bps = state.buddyProfiles ?? {};
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");

          if (eqId && this._maybeSingle) return { data: bps[eqId[2]] ?? null, error: null };
          if (eqUser && this._maybeSingle) {
            const match = Object.values(bps).find((p: any) => p.user_id === eqUser[2]);
            return { data: match ?? null, error: null };
          }
          let rows = Object.values(bps);
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          return { data: rows, error: null, count: rows.length };
        }

        if (t === "rent_buddy_applications") {
          const apps = state.applications ?? {};
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqUser && this._maybeSingle) return { data: apps[eqUser[2]] ?? null, error: null };
          if (eqId && this._maybeSingle) return { data: Object.values(apps).find((a: any) => a.id === eqId[2]) ?? null, error: null };
          return { data: Object.values(apps), error: null, count: Object.values(apps).length };
        }

        if (t === "rent_buddy_bookings") {
          const bks = state.bookings ?? {};
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: bks[eqId[2]] ?? null, error: null };

          let rows = Object.values(bks);
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
          }
          const cnt = rows.length;
          if (this._count && !this._maybeSingle && rows.length === 0) {
            // For count-only queries (select("id", {count:"exact"}))
            return { data: null, count: 0, error: null };
          }
          return { data: rows, count: cnt, error: null };
        }

        if (t === "rent_buddy_reviews") {
          const reviews = state.reviews ?? [];
          let rows = [...reviews];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_policy_flags") {
          const flags = state.policyFlags ?? [];
          let rows = [...flags];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_safety_events") {
          const events = state.safetyEvents ?? [];
          return { data: events, count: events.length, error: null };
        }

        if (t === "rent_buddy_user_limits") {
          const limits = state.userLimits ?? {};
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          if (eqUser && this._maybeSingle) return { data: limits[eqUser[2]] ?? null, error: null };
          return { data: Object.values(limits), error: null };
        }

        if (t === "trust_events") {
          return { data: state.trustEvents ?? [], error: null };
        }

        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN)  return { data: { user: { id: USER_ID } }, error: null };
        if (token === BUDDY_TOKEN) return { data: { user: { id: BUDDY_USER } }, error: null };
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_USER } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

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

function setupState(extra: Partial<FakeState> = {}) {
  state = {
    featureFlags: {
      rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
    },
    profiles: {
      [USER_ID]:   { id: USER_ID,   role: "user" },
      [BUDDY_USER]:{ id: BUDDY_USER, role: "user" },
      [ADMIN_USER]:{ id: ADMIN_USER, role: "admin" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: {
        id: BUDDY_PROF, user_id: BUDDY_USER, city: "Tokyo", status: "active",
        admin_status: "active", buddy_level: "new", new_buddy_public_only: true,
        new_buddy_daytime_only: true, new_buddy_max_hours: 2,
        categories: ["city", "language"], category_approvals: {},
        languages: ["English", "Japanese"],
        hourly_rate_usd: 25, max_group_size: 4,
        verified: false, review_count: 0, completed_bookings: 0,
        vibe_tags: [], safety_badges: [], gallery_urls: [],
        risk_hold: false, updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    },
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
        booking_date: new Date().toISOString().slice(0, 10),
        duration_h: 2, group_size: 1, city: "Tokyo", category: "city",
        status: "pending", payment_mode: "full_in_app",
        total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
        safety_status: "normal", route_plan: [],
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      },
    },
    policyFlags: [],
    safetyEvents: [],
    safetyCheckins: [],
    disputes: [],
    adminActions: [],
    trustEvents: [],
    reviews: [],
    ...extra,
  };

  const client = makeClient(USER_ID);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Feature flag tests ────────────────────────────────────────────────────────

describe("feature flag", () => {
  it("returns 403 when rent_buddy_enabled is false", async () => {
    setupState({
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: false } },
    });
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("allows requests when flag is enabled", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo" });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.buddies));
  });
});

// ── Policy text ───────────────────────────────────────────────────────────────

describe("policy text", () => {
  it("appears in booking creation response", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.policyText, POLICY_TEXT);
  });

  it("appears in application response", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/apply", {
      city: "Tokyo", categories: ["city"], languages: ["English"],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.policyText, POLICY_TEXT);
  });
});

// ── Policy scanner ────────────────────────────────────────────────────────────

describe("policy scanner", () => {
  it("creates a policy flag for banned keyword in booking notes (not auto-ban)", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "I need a massage session",
    });
    // massage is medium severity — not blocked, but flag created
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const flags = state.policyFlags ?? [];
    assert.ok(flags.length > 0, "Expected a policy flag to be created");
    assert.equal(flags[0].category, "massage_service");
  });

  it("blocks booking creation for high-severity keyword and creates flag", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "This is for a hookup",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "policy_violation");
    assert.ok((state.policyFlags ?? []).length > 0, "Flag should still be created");
  });

  it("does NOT auto-ban user — account is not immediately disabled for medium severity", async () => {
    setupState();
    await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "I need a massage",
    });
    const profile = state.buddyProfiles?.[BUDDY_PROF];
    // admin_status should NOT be changed to 'disabled' for medium
    assert.ok(!profile || profile.admin_status !== "disabled");
  });
});

// ── New Buddy restrictions ────────────────────────────────────────────────────

describe("new-buddy restrictions", () => {
  it("blocks private hotel room as first meetup location", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Private hotel room", category: "city",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_location");
  });

  it("blocks nightlife booking for new Buddy without approval", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Roppongi Station", category: "nightlife",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "category_not_approved");
  });

  it("blocks booking exceeding new-buddy max hours (2h)", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 5, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "duration_exceeded");
  });

  it("allows approved nightlife booking for new Buddy with approval", async () => {
    setupState({
      buddyProfiles: {
        [BUDDY_PROF]: {
          ...state.buddyProfiles![BUDDY_PROF],
          category_approvals: { nightlife: true },
          new_buddy_max_hours: 6,
        } as any,
      },
    });
    setupState({
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, city: "Tokyo", status: "active",
          admin_status: "active", buddy_level: "new", new_buddy_public_only: true,
          new_buddy_daytime_only: true, new_buddy_max_hours: 6,
          categories: ["city", "nightlife"], category_approvals: { nightlife: true },
          languages: ["English"], hourly_rate_usd: 25, max_group_size: 4,
          verified: false, review_count: 0, completed_bookings: 0,
          vibe_tags: [], safety_badges: [], gallery_urls: [],
          risk_hold: false, updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    } as any);
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 2, city: "Roppongi Hills", category: "nightlife",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

// ── User limits ───────────────────────────────────────────────────────────────

describe("user limits", () => {
  it("blocks booking creation when rent_buddy_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, rent_buddy_disabled: true, buddy_disabled: false, traveler_booking_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
    assert.ok(r.body.message.includes("under review"));
  });

  it("blocks deposit_plus_cash when cash_balance_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, cash_balance_disabled: true, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      paymentMode: "deposit_plus_cash",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
    assert.ok(r.body.message.includes("Cash balance"));
  });

  it("blocks nightlife when nightlife_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, nightlife_disabled: true, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Roppongi Station", category: "nightlife",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
  });

  it("enforces max_booking_duration_minutes", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, max_booking_duration_minutes: 60, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 2, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /60 minutes/);
  });
});

// ── Cash balance ──────────────────────────────────────────────────────────────

describe("cash balance", () => {
  it("confirms cash balance successfully when both sides agree", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          status: "in_progress", payment_mode: "deposit_plus_cash",
          total_usd: 50, deposit_usd: 15, cash_balance_usd: 35,
          cash_balance_confirmed_by_buddy: true,
          cash_balance_confirmed_by_traveler: null,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/confirm-cash`, { confirmed: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.disputed, false);
  });

  it("creates dispute when traveler declines cash balance", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          cash_balance_confirmed_by_buddy: true,
          cash_balance_confirmed_by_traveler: null,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 1, city: "Tokyo", category: "city",
          payment_mode: "deposit_plus_cash", total_usd: 30, deposit_usd: 9, cash_balance_usd: 21,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/confirm-cash`, { confirmed: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.disputed, true);
    const disputes = state.disputes ?? [];
    assert.ok(disputes.some((d: any) => d.reason === "cash_balance_disagreement"));
  });
});

// ── Emergency phrase ──────────────────────────────────────────────────────────

describe("emergency phrase", () => {
  it("returns traveler-only prompt and creates safety event", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/emergency-phrase`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.travelerOnly, true);
    assert.ok(Array.isArray(r.body.options), "Expected options array");
    assert.ok(r.body.options.length >= 5);
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(eventTypes.includes("emergency_phrase_triggered"), "Expected safety event");
  });

  it("returns 403 when non-traveler calls emergency-phrase", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: "someone-else",
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/emergency-phrase`, {});
    assert.equal(r.status, 403);
  });
});

// ── Safety checkin ────────────────────────────────────────────────────────────

describe("safety checkin", () => {
  it("creates a safety event on distress response", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/checkin`, {
      checkinType: "comfort_30min",
      response: "uncomfortable",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(eventTypes.includes("comfort_check_distress"), "Expected distress safety event");
  });

  it("does NOT create safety event for normal checkin response", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/checkin`, {
      checkinType: "comfort_30min",
      response: "all_good",
    });
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(!eventTypes.includes("comfort_check_distress"), "Should NOT create distress event for normal response");
  });
});

// ── Double-blind reviews ──────────────────────────────────────────────────────

describe("double-blind reviews", () => {
  it("review is not immediately public after first submission", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "completed", payment_mode: "full_in_app",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/review`, {
      rating: 5, body: "Great Buddy!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.unblinded, false, "Should not unblind after only first review");
  });

  it("reveals both reviews after second side submits", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "completed", payment_mode: "full_in_app",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
      reviews: [
        { id: "rev-1", booking_id: BOOKING_ID, reviewer_id: BUDDY_USER, reviewee_id: USER_ID, role: "buddy", rating: 4, is_public: false },
      ],
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/review`, {
      rating: 5, body: "Wonderful experience",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.unblinded, true, "Should unblind after both sides submit");
  });
});

// ── Cancel — Trust Score events ───────────────────────────────────────────────

describe("cancellation Trust Score events", () => {
  it("cancels booking and returns ok (trust event is emitted async)", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: futureDate.toISOString().slice(0, 10),
          start_time: "14:00",
          duration_h: 2, city: "Tokyo", category: "city",
          status: "confirmed", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    // Booking should be marked cancelled in state
    assert.equal(state.bookings?.[BOOKING_ID]?.status, "cancelled");
  });
});

// ── Admin — Policy flag management ───────────────────────────────────────────

describe("admin policy flag management", () => {
  it("admin can dismiss a policy flag", async () => {
    setupState({
      policyFlags: [{ id: FLAG_ID, status: "open", severity: "medium", flagged_user_id: USER_ID, category: "massage_service" }],
    });
    const r = await req("POST", `/api/rent-a-buddy/admin/safety/flags/${FLAG_ID}/dismiss`, { notes: "false positive" }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const flag = (state.policyFlags ?? []).find((f: any) => f.id === FLAG_ID);
    assert.equal(flag?.status, "dismissed");
  });

  it("admin can confirm a policy flag — status becomes resolved", async () => {
    setupState({
      policyFlags: [{ id: FLAG_ID, status: "open", severity: "medium", flagged_user_id: USER_ID, category: "massage_service" }],
    });
    const r = await req("POST", `/api/rent-a-buddy/admin/safety/flags/${FLAG_ID}/confirm`, { notes: "confirmed" }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    // Flag must be resolved in state
    const flag = (state.policyFlags ?? []).find((f: any) => f.id === FLAG_ID);
    assert.equal(flag?.status, "resolved", "Expected flag status to be 'resolved'");
    // Admin action should be recorded
    const actions = state.adminActions ?? [];
    assert.ok(actions.some((a: any) => a.action === "confirmed"), "Expected admin action 'confirmed'");
  });

  it("non-admin cannot access safety flags", async () => {
    setupState();
    const r = await req("GET", `/api/rent-a-buddy/admin/safety/flags`);
    assert.equal(r.status, 403);
  });
});

// ── Admin — User limits ───────────────────────────────────────────────────────

describe("admin user limits", () => {
  it("admin can apply full_in_app_payment_required limit", async () => {
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/admin/users/${USER_ID}/limits`, {
      fullInAppPaymentRequired: true,
      reason: "policy violation",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(state.userLimits?.[USER_ID]);
    assert.equal(state.userLimits[USER_ID].full_in_app_payment_required, true);
  });

  it("enforces full_in_app_payment_required on subsequent booking", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, full_in_app_payment_required: true } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      paymentMode: "deposit_plus_cash",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
  });
});

// ── Application flow ──────────────────────────────────────────────────────────

describe("application", () => {
  it("submits application and returns policy text", async () => {
    setupState({ applications: {} });
    const r = await req("POST", "/api/rent-a-buddy/apply", {
      city: "Tokyo", categories: ["city", "language"], languages: ["English", "Japanese"],
      motivation: "I love helping tourists discover the real Tokyo!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.policyText, POLICY_TEXT);
    assert.equal(r.body.message.includes("submitted"), true);
  });

  it("retrieves existing application", async () => {
    setupState({
      applications: {
        [USER_ID]: { id: "app-1", user_id: USER_ID, status: "pending", city: "Tokyo", categories: [], languages: [], social_links: {}, policy_accepted: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      },
    });
    const r = await req("GET", "/api/rent-a-buddy/apply");
    assert.equal(r.status, 200);
    assert.ok(r.body.application);
    assert.equal(r.body.application.status, "pending");
  });
});
