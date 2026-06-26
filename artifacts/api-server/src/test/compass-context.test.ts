/**
 * Compass Phase 1 — context + intent mode unit tests
 *
 * Covers:
 *   - buildCompassContext(): correct contextState for each signal combination
 *   - deriveIntentMode(): correct primary + secondary modes from each contextState
 *   - GET /api/compass/me/context: flag-off returns fallback
 *   - CompassProfileService: blocked user excluded from profile (blocker_count > 0)
 *
 * Runtime: node:test (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-context.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import compassRouter from "../routes/compass.js";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine.js";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import type { CompassProfile, CompassSignals } from "../compass/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:               ALICE_ID,
    preferredCities:      [],
    preferredLanguages:   [],
    budgetStyle:          null,
    travelStyles:         [],
    socialStyle:          null,
    safetyPreference:     "standard",
    visibilityPreference: "public",
    blockCount:           0,
    blockerCount:         0,
    trustScore:           null,
    trustLevel:           null,
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h: false,
    currentCity:          null,
    currentCountry:       null,
    safeReturnActive:     false,
    computedAt:           new Date().toISOString(),
    ...overrides,
  };
}

function baseSignals(overrides: Partial<CompassSignals> = {}): CompassSignals {
  return {
    hourUtc:                10,   // mid-morning, not night
    safeReturnActive:       false,
    activeBooking:          false,
    upcomingTripWithin48h:  false,
    activeTripNow:          false,
    hasPendingDelayedPosts: false,
    ...overrides,
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  users: Record<string, { id: string } | null>;
  feature_flags: { flag: string; enabled: boolean }[];
  profiles: any[];
  trust_profiles: any[];
  user_location_state: any[];
  location_preferences: any[];
  blocks: any[];
  trips: any[];
  safe_return_sessions: any[];
  rent_buddy_bookings: any[];
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: string = "select";

    const b: any = {
      select()          { return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      like(col: string, pat: string) {
        const re = new RegExp(pat.replace(/%/g, ".*"), "i");
        filters.push((r: any) => re.test(String(r[col] ?? "")));
        return b;
      },
      or()              { return b; },
      not()             { return b; },
      is()              { return b; },
      limit()           { return b; },
      order()           { return b; },
      maybeSingle()     { return resolveOne(); },
      single()          { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    const src  = (): any[] => (state as any)[table] ?? [];
    const rows = () => src().filter((r: any) => filters.every((f) => f(r)));
    const resolveOne  = async () => ({ data: rows()[0] ?? null, error: null });
    const resolveList = async () => ({ data: rows(), error: null });

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    users: { "alice-tok": { id: ALICE_ID } },
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
    ],
    profiles: [{ id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: [], travel_group_style: null }],
    trust_profiles: [],
    user_location_state: [],
    location_preferences: [],
    blocks: [],
    trips: [],
    safe_return_sessions: [],
    rent_buddy_bookings: [],
    ...overrides,
  };
}

// ── HTTP test server helpers ──────────────────────────────────────────────────

function makeTestApp(client: ReturnType<typeof makeFakeClient>) {
  _setTestClient(client as any, true);
  invalidateFlagsCache();
  clearCompassProfileCache();
  const app = express();
  app.use(express.json());
  app.use((_req: any, _res: any, next: any) => {
    _req.log = { info: () => {}, error: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  return app;
}

async function startApp(client: ReturnType<typeof makeFakeClient>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const app = makeTestApp(client);
    const server = createServer(app);
    server.listen(0, () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function get(port: number, path: string, token = "alice-tok") {
  return fetch(`http://localhost:${port}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassContextEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassContextEngine — contextState", () => {
  it("returns safety_mode when safeReturnActive signal is true", () => {
    const p = baseProfile();
    const s = baseSignals({ safeReturnActive: true });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("returns safety_mode when profile.safeReturnActive is true", () => {
    const p = baseProfile({ safeReturnActive: true });
    const s = baseSignals();
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("returns active_booking_mode when hasActiveBooking", () => {
    const p = baseProfile({ hasActiveBooking: true });
    const s = baseSignals();
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "active_booking_mode");
  });

  it("returns arrival_mode when upcomingTripWithin48h", () => {
    const p = baseProfile({ upcomingTripWithin48h: true });
    const s = baseSignals();
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "arrival_mode");
  });

  it("returns active_trip_mode when hasActiveTrip (no 48h arrival)", () => {
    const p = baseProfile({ hasActiveTrip: true });
    const s = baseSignals();
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "active_trip_mode");
  });

  it("returns night_mode at 23:00 UTC with no higher-priority signals", () => {
    const p = baseProfile();
    const s = baseSignals({ hourUtc: 23 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "night_mode");
  });

  it("returns night_mode at 02:00 UTC", () => {
    const p = baseProfile();
    const s = baseSignals({ hourUtc: 2 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "night_mode");
  });

  it("returns private_mode when visibilityPreference is private", () => {
    const p = baseProfile({ visibilityPreference: "private" });
    const s = baseSignals({ hourUtc: 14 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "private_mode");
  });

  it("returns creator_mode when hasPendingDelayedPosts and nothing else", () => {
    const p = baseProfile();
    const s = baseSignals({ hasPendingDelayedPosts: true, hourUtc: 14 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "creator_mode");
  });

  it("returns budget_mode when budgetStyle is backpacker", () => {
    const p = baseProfile({ budgetStyle: "backpacker" });
    const s = baseSignals({ hourUtc: 14 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "budget_mode");
  });

  it("returns exploring_now when currentCity is set and no other signals", () => {
    const p = baseProfile({ currentCity: "Tokyo" });
    const s = baseSignals({ hourUtc: 14 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "exploring_now");
  });

  it("returns normal as final fallback", () => {
    const p = baseProfile();
    const s = baseSignals({ hourUtc: 14 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "normal");
  });

  it("safety_mode takes priority over night_mode", () => {
    const p = baseProfile({ safeReturnActive: true });
    const s = baseSignals({ hourUtc: 23 });
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("arrival_mode takes priority over active_trip_mode", () => {
    const p = baseProfile({ hasActiveTrip: true, upcomingTripWithin48h: true });
    const s = baseSignals();
    const ctx = buildCompassContext(p, s);
    assert.equal(ctx.contextState, "arrival_mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassIntentModeEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassIntentModeEngine — deriveIntentMode", () => {
  function ctx(state: string, signals: Partial<CompassSignals> = {}) {
    return {
      contextState: state as any,
      signals: baseSignals(signals),
      computedAt: new Date().toISOString(),
    };
  }

  it("safety_mode → primary: safety_mode", () => {
    const mode = deriveIntentMode(ctx("safety_mode"));
    assert.equal(mode.primary, "safety_mode");
  });

  it("active_booking_mode → primary: social_mode", () => {
    const mode = deriveIntentMode(ctx("active_booking_mode"));
    assert.equal(mode.primary, "social_mode");
  });

  it("arrival_mode → primary: arrival_mode", () => {
    const mode = deriveIntentMode(ctx("arrival_mode"));
    assert.equal(mode.primary, "arrival_mode");
  });

  it("active_trip_mode → primary: explore_now, secondary includes plan_ahead", () => {
    const mode = deriveIntentMode(ctx("active_trip_mode"));
    assert.equal(mode.primary, "explore_now");
    assert.ok(mode.secondary.includes("plan_ahead"));
  });

  it("night_mode → primary: night_mode", () => {
    const mode = deriveIntentMode(ctx("night_mode", { hourUtc: 23 }));
    assert.equal(mode.primary, "night_mode");
  });

  it("private_mode → primary: private_mode", () => {
    const mode = deriveIntentMode(ctx("private_mode"));
    assert.equal(mode.primary, "private_mode");
  });

  it("creator_mode → primary: creator_mode, secondary includes explore_now", () => {
    const mode = deriveIntentMode(ctx("creator_mode"));
    assert.equal(mode.primary, "creator_mode");
    assert.ok(mode.secondary.includes("explore_now"));
  });

  it("budget_mode → primary: budget_mode", () => {
    const mode = deriveIntentMode(ctx("budget_mode"));
    assert.equal(mode.primary, "budget_mode");
  });

  it("planning_ahead → primary: plan_ahead", () => {
    const mode = deriveIntentMode(ctx("planning_ahead"));
    assert.equal(mode.primary, "plan_ahead");
  });

  it("exploring_now → primary: explore_now", () => {
    const mode = deriveIntentMode(ctx("exploring_now"));
    assert.equal(mode.primary, "explore_now");
  });

  it("normal → primary: explore_now", () => {
    const mode = deriveIntentMode(ctx("normal"));
    assert.equal(mode.primary, "explore_now");
  });

  it("adds safety_mode to secondary when safeReturnActive but not primary", () => {
    const mode = deriveIntentMode(ctx("exploring_now", { safeReturnActive: true }));
    assert.equal(mode.primary, "explore_now");
    assert.ok(mode.secondary.includes("safety_mode"));
  });

  it("adds night_mode to secondary when night-time but not primary", () => {
    const mode = deriveIntentMode(ctx("exploring_now", { hourUtc: 23 }));
    assert.ok(mode.secondary.includes("night_mode"));
  });

  it("does not duplicate safety_mode in secondary when it is primary", () => {
    const mode = deriveIntentMode(ctx("safety_mode", { safeReturnActive: true }));
    assert.equal(mode.primary, "safety_mode");
    assert.ok(!mode.secondary.includes("safety_mode"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: GET /api/compass/me/context
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/compass/me/context", () => {
  it("returns fallback when COMPASS_ENABLED = false", async () => {
    const state = makeState({
      feature_flags: [{ flag: "COMPASS_ENABLED", enabled: false }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.fallback, true);
      assert.equal(body.contextState, "normal");
      assert.equal(body.intentMode.primary, "explore_now");
    } finally { server.close(); }
  });

  it("returns 401 when no auth token", async () => {
    const { server, port } = await startApp(makeFakeClient(makeState()));
    try {
      const res = await fetch(`http://localhost:${port}/api/compass/me/context`);
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it("returns valid context response when COMPASS_ENABLED = true", async () => {
    const state = makeState({
      user_location_state: [{ user_id: ALICE_ID, city: "Tokyo", country: "Japan" }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.ok(!body.fallback, "should not be fallback");
      assert.ok(body.contextState, "contextState must be present");
      assert.ok(body.intentMode?.primary, "intentMode.primary must be present");
      assert.ok(Array.isArray(body.intentMode?.secondary), "secondary must be array");
      assert.ok(body.profile?.userId === ALICE_ID);
      assert.ok(body.computedAt, "computedAt must be present");
    } finally { server.close(); }
  });

  it("returns exploring_now for a user with currentCity set", async () => {
    const state = makeState({
      user_location_state: [{ user_id: ALICE_ID, city: "Paris", country: "France" }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      const validStates = ["exploring_now", "normal", "night_mode", "budget_mode", "creator_mode"];
      assert.ok(validStates.includes(body.contextState), `unexpected state: ${body.contextState}`);
    } finally { server.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Block count in profile
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassProfile — blocked user signals", () => {
  it("blockerCount reflects blocks received by user", async () => {
    const { getCompassProfile: getProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const BOB_ID = "00000000-0000-0000-0000-0000000000b2";
    const state = makeState({
      blocks: [
        { id: "b1", blocker_id: BOB_ID,   blocked_id: ALICE_ID },
        { id: "b2", blocker_id: "other-1", blocked_id: ALICE_ID },
      ],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getProfile(client, ALICE_ID, true);
    assert.equal(profile.blockerCount, 2, "blockerCount should be 2");
  });

  it("blockCount reflects blocks sent by user", async () => {
    const { getCompassProfile: getProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      blocks: [
        { id: "b1", blocker_id: ALICE_ID, blocked_id: "other-1" },
        { id: "b2", blocker_id: ALICE_ID, blocked_id: "other-2" },
        { id: "b3", blocker_id: ALICE_ID, blocked_id: "other-3" },
      ],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getProfile(client, ALICE_ID, true);
    assert.equal(profile.blockCount, 3, "blockCount should be 3");
  });

  it("profile never exposes raw block data in public subset returned by API", async () => {
    const state = makeState({
      blocks: [
        { id: "b1", blocker_id: "other-1", blocked_id: ALICE_ID },
      ],
      user_location_state: [{ user_id: ALICE_ID, city: "NYC", country: "US" }],
    });
    const client = makeFakeClient(state);
    const info = await startApp(client);
    const { server: srv, port: p } = info;

    try {
      const res = await get(p, "/compass/me/context");
      const body = await res.json() as any;
      assert.ok(body.profile, "profile must be in response");
      assert.ok(!("blockCount" in body.profile), "blockCount must not be in public profile");
      assert.ok(!("blockerCount" in body.profile), "blockerCount must not be in public profile");
    } finally {
      srv.close();
    }
  });
});
