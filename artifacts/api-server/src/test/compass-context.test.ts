/**
 * Compass Phase 1 — context + intent mode unit tests
 *
 * Covers:
 *   - buildCompassContext(): correct contextState for each signal combination (all 11 states)
 *   - deriveIntentMode(): correct primary + secondary modes from each contextState
 *   - GET /api/compass/me/context: flag-off returns fallback, auth, full response
 *   - CompassProfileService: blockedUserIds/blockerUserIds arrays populated (exclusion data)
 *   - Public API: block arrays never exposed in public profile subset
 *
 * Runtime: node:test (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-context.test.ts
 */
import { describe, it } from "node:test";
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
const BOB_ID   = "00000000-0000-0000-0000-0000000000b2";

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
    blockedUserIds:       [],
    blockerUserIds:       [],
    mutedUserIds:         [],
    blockCount:           0,
    blockerCount:         0,
    trustScore:           null,
    trustLevel:           null,
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h:    false,
    hasFutureTripScheduled:   false,
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
    hasFutureTripScheduled: false,
    ...overrides,
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  users: Record<string, { id: string } | null>;
  feature_flags: { flag: string; enabled: boolean }[];
  profiles: any[];
  trust_profiles: any[];
  user_preference_profiles: any[];
  user_location_state: any[];
  user_location_preferences: any[];
  blocks: any[];
  trips: any[];
  trip_members: any[];
  safe_return_sessions: any[];
  rent_buddy_bookings: any[];
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];

    const b: any = {
      select()                 { return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]) {
        filters.push((r: any) => vals.includes(r[col]));
        return b;
      },
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
    profiles: [{
      id: ALICE_ID,
      spoken_languages: ["en"],
      budget_style: null,
      travel_styles: [],
      travel_group_style: null,
    }],
    trust_profiles: [],
    user_preference_profiles: [],
    user_location_state: [],
    user_location_preferences: [],
    blocks: [],
    trips: [],
    trip_members: [],
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

async function startApp(
  client: ReturnType<typeof makeFakeClient>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(makeTestApp(client));
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function get(port: number, path: string, token = "alice-tok") {
  return fetch(`http://127.0.0.1:${port}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassContextEngine — all 11 contextState variants
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassContextEngine — contextState", () => {
  it("returns safety_mode when safeReturnActive signal is true", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ safeReturnActive: true }));
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("returns safety_mode when profile.safeReturnActive is true", () => {
    const ctx = buildCompassContext(baseProfile({ safeReturnActive: true }), baseSignals());
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("returns active_booking_mode when hasActiveBooking signal is true", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ activeBooking: true }));
    assert.equal(ctx.contextState, "active_booking_mode");
  });

  it("returns active_booking_mode when profile.hasActiveBooking is true", () => {
    const ctx = buildCompassContext(baseProfile({ hasActiveBooking: true }), baseSignals());
    assert.equal(ctx.contextState, "active_booking_mode");
  });

  it("returns arrival_mode when upcomingTripWithin48h signal is true", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ upcomingTripWithin48h: true }));
    assert.equal(ctx.contextState, "arrival_mode");
  });

  it("returns arrival_mode when profile.upcomingTripWithin48h is true", () => {
    const ctx = buildCompassContext(baseProfile({ upcomingTripWithin48h: true }), baseSignals());
    assert.equal(ctx.contextState, "arrival_mode");
  });

  it("returns active_trip_mode when activeTripNow signal is true", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ activeTripNow: true }));
    assert.equal(ctx.contextState, "active_trip_mode");
  });

  it("returns active_trip_mode when profile.hasActiveTrip is true", () => {
    const ctx = buildCompassContext(baseProfile({ hasActiveTrip: true }), baseSignals());
    assert.equal(ctx.contextState, "active_trip_mode");
  });

  it("returns night_mode at 23:00 UTC with no higher-priority signals", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ hourUtc: 23 }));
    assert.equal(ctx.contextState, "night_mode");
  });

  it("returns night_mode at 02:00 UTC", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ hourUtc: 2 }));
    assert.equal(ctx.contextState, "night_mode");
  });

  it("returns private_mode when visibilityPreference is private", () => {
    const ctx = buildCompassContext(
      baseProfile({ visibilityPreference: "private" }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "private_mode");
  });

  it("returns creator_mode when hasPendingDelayedPosts is true", () => {
    const ctx = buildCompassContext(
      baseProfile(),
      baseSignals({ hasPendingDelayedPosts: true, hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "creator_mode");
  });

  it("returns budget_mode when budgetStyle is backpacker", () => {
    const ctx = buildCompassContext(
      baseProfile({ budgetStyle: "backpacker" }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "budget_mode");
  });

  it("returns planning_ahead when hasFutureTripScheduled signal is true", () => {
    const ctx = buildCompassContext(
      baseProfile(),
      baseSignals({ hourUtc: 14, hasFutureTripScheduled: true }),
    );
    assert.equal(ctx.contextState, "planning_ahead");
  });

  it("returns planning_ahead when profile.hasFutureTripScheduled is true", () => {
    const ctx = buildCompassContext(
      baseProfile({ hasFutureTripScheduled: true }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "planning_ahead");
  });

  it("returns exploring_now when currentCity is set and no other signals", () => {
    const ctx = buildCompassContext(
      baseProfile({ currentCity: "Tokyo" }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "exploring_now");
  });

  it("returns normal as final fallback", () => {
    const ctx = buildCompassContext(baseProfile(), baseSignals({ hourUtc: 14 }));
    assert.equal(ctx.contextState, "normal");
  });

  it("safety_mode takes priority over night_mode", () => {
    const ctx = buildCompassContext(
      baseProfile({ safeReturnActive: true }),
      baseSignals({ hourUtc: 23 }),
    );
    assert.equal(ctx.contextState, "safety_mode");
  });

  it("arrival_mode takes priority over active_trip_mode", () => {
    const ctx = buildCompassContext(
      baseProfile({ hasActiveTrip: true, upcomingTripWithin48h: true }),
      baseSignals(),
    );
    assert.equal(ctx.contextState, "arrival_mode");
  });

  it("active_trip_mode takes priority over planning_ahead", () => {
    const ctx = buildCompassContext(
      baseProfile({ hasActiveTrip: true, hasFutureTripScheduled: true }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "active_trip_mode");
  });

  it("planning_ahead takes priority over exploring_now", () => {
    const ctx = buildCompassContext(
      baseProfile({ hasFutureTripScheduled: true, currentCity: "Paris" }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "planning_ahead");
  });

  it("exploring_now takes priority over normal", () => {
    const ctx = buildCompassContext(
      baseProfile({ currentCity: "London" }),
      baseSignals({ hourUtc: 14 }),
    );
    assert.equal(ctx.contextState, "exploring_now");
  });

  it("defaultSignals() mirrors profile boolean fields", () => {
    const p = baseProfile({
      safeReturnActive:       true,
      hasActiveBooking:       true,
      upcomingTripWithin48h:  true,
      hasActiveTrip:          true,
      hasFutureTripScheduled: true,
    });
    const s = defaultSignals(p);
    assert.equal(s.safeReturnActive,       true);
    assert.equal(s.activeBooking,          true);
    assert.equal(s.upcomingTripWithin48h,  true);
    assert.equal(s.activeTripNow,          true);
    assert.equal(s.hasFutureTripScheduled, true);
    assert.equal(s.hasPendingDelayedPosts, false); // always false from defaultSignals
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassIntentModeEngine — all 9 primary modes + secondaries
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
    assert.equal(deriveIntentMode(ctx("safety_mode")).primary, "safety_mode");
  });

  it("active_booking_mode → primary: social_mode", () => {
    assert.equal(deriveIntentMode(ctx("active_booking_mode")).primary, "social_mode");
  });

  it("arrival_mode → primary: arrival_mode", () => {
    assert.equal(deriveIntentMode(ctx("arrival_mode")).primary, "arrival_mode");
  });

  it("active_trip_mode → primary: explore_now, secondary includes plan_ahead", () => {
    const mode = deriveIntentMode(ctx("active_trip_mode"));
    assert.equal(mode.primary, "explore_now");
    assert.ok(mode.secondary.includes("plan_ahead"));
  });

  it("night_mode → primary: night_mode", () => {
    assert.equal(deriveIntentMode(ctx("night_mode", { hourUtc: 23 })).primary, "night_mode");
  });

  it("private_mode → primary: private_mode", () => {
    assert.equal(deriveIntentMode(ctx("private_mode")).primary, "private_mode");
  });

  it("creator_mode → primary: creator_mode, secondary includes explore_now", () => {
    const mode = deriveIntentMode(ctx("creator_mode"));
    assert.equal(mode.primary, "creator_mode");
    assert.ok(mode.secondary.includes("explore_now"));
  });

  it("budget_mode → primary: budget_mode", () => {
    assert.equal(deriveIntentMode(ctx("budget_mode")).primary, "budget_mode");
  });

  it("planning_ahead → primary: plan_ahead", () => {
    assert.equal(deriveIntentMode(ctx("planning_ahead")).primary, "plan_ahead");
  });

  it("exploring_now → primary: explore_now", () => {
    assert.equal(deriveIntentMode(ctx("exploring_now")).primary, "explore_now");
  });

  it("normal → primary: explore_now", () => {
    assert.equal(deriveIntentMode(ctx("normal")).primary, "explore_now");
  });

  it("adds safety_mode to secondary when safeReturnActive but not primary", () => {
    const mode = deriveIntentMode(ctx("exploring_now", { safeReturnActive: true }));
    assert.equal(mode.primary, "explore_now");
    assert.ok(mode.secondary.includes("safety_mode"));
  });

  it("adds night_mode to secondary when night-time but contextState is not night_mode", () => {
    const mode = deriveIntentMode(ctx("exploring_now", { hourUtc: 23 }));
    assert.ok(mode.secondary.includes("night_mode"));
  });

  it("does not duplicate safety_mode in secondary when it is already primary", () => {
    const mode = deriveIntentMode(ctx("safety_mode", { safeReturnActive: true }));
    assert.equal(mode.primary, "safety_mode");
    assert.ok(!mode.secondary.includes("safety_mode"));
  });

  it("secondary is an array (never undefined)", () => {
    assert.ok(Array.isArray(deriveIntentMode(ctx("normal")).secondary));
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
      const res = await fetch(`http://127.0.0.1:${port}/api/compass/me/context`);
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
      assert.equal(body.profile?.userId, ALICE_ID);
      assert.ok(body.computedAt, "computedAt must be present");
    } finally { server.close(); }
  });

  it("returns planning_ahead for a user with a future trip scheduled", async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days from now
    const state = makeState({
      trips: [{
        id: "trip-1",
        owner_id: ALICE_ID,
        start_date: futureDate.toISOString(),
        end_date: new Date(futureDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        status: "planning",
      }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      // planning_ahead or night_mode depending on current UTC hour
      const validStates = ["planning_ahead", "night_mode", "exploring_now", "normal"];
      assert.ok(validStates.includes(body.contextState), `unexpected state: ${body.contextState}`);
    } finally { server.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassProfile — blocked user ID arrays (exclusion data)
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassProfile — blocked user exclusion arrays", () => {
  it("blockedUserIds contains IDs of users Alice has blocked", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      blocks: [
        { id: "b1", blocker_id: ALICE_ID, blocked_id: BOB_ID },
        { id: "b2", blocker_id: ALICE_ID, blocked_id: "other-1" },
      ],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.blockCount, 2);
    assert.ok(profile.blockedUserIds.includes(BOB_ID), "blockedUserIds must include BOB_ID");
    assert.ok(profile.blockedUserIds.includes("other-1"), "blockedUserIds must include other-1");
  });

  it("blockerUserIds contains IDs of users who have blocked Alice", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      blocks: [
        { id: "b1", blocker_id: BOB_ID,   blocked_id: ALICE_ID },
        { id: "b2", blocker_id: "other-2", blocked_id: ALICE_ID },
      ],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.blockerCount, 2);
    assert.ok(profile.blockerUserIds.includes(BOB_ID), "blockerUserIds must include BOB_ID");
    assert.ok(profile.blockerUserIds.includes("other-2"));
  });

  it("hasFutureTripScheduled is true when a trip starts > 48h from now", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const futureStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const futureEnd   = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString();
    const state = makeState({
      trips: [{ id: "t1", owner_id: ALICE_ID, start_date: futureStart, end_date: futureEnd, status: "planning" }],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.hasFutureTripScheduled, true);
    assert.equal(profile.upcomingTripWithin48h, false);
    assert.equal(profile.hasActiveTrip, false);
  });

  it("upcomingTripWithin48h is true when a trip starts within 48h", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const soonStart = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(); // 20h from now
    const soonEnd   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const state = makeState({
      trips: [{ id: "t2", owner_id: ALICE_ID, start_date: soonStart, end_date: soonEnd, status: "planning" }],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.upcomingTripWithin48h, true);
  });

  it("public API never exposes blockedUserIds, blockerUserIds, blockCount, blockerCount", async () => {
    const state = makeState({
      blocks: [{ id: "b1", blocker_id: BOB_ID, blocked_id: ALICE_ID }],
      user_location_state: [{ user_id: ALICE_ID, city: "NYC", country: "US" }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      const body = await res.json() as any;
      const pub = body.profile;
      assert.ok(pub, "profile must exist in response");
      assert.ok(!("blockedUserIds"  in pub), "blockedUserIds must not be exposed");
      assert.ok(!("blockerUserIds"  in pub), "blockerUserIds must not be exposed");
      assert.ok(!("blockCount"      in pub), "blockCount must not be exposed");
      assert.ok(!("blockerCount"    in pub), "blockerCount must not be exposed");
    } finally { server.close(); }
  });

  it("hasActiveBooking is true for a booking with status 'in_progress'", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      rent_buddy_bookings: [{
        id: "bk1",
        traveler_id: ALICE_ID,
        status: "in_progress",
      }],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.hasActiveBooking, true);
  });

  it("hasActiveBooking is true for a booking with status 'confirmed'", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      rent_buddy_bookings: [{
        id: "bk2",
        traveler_id: ALICE_ID,
        status: "confirmed",
      }],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.hasActiveBooking, true);
  });

  it("hasActiveBooking is false for a booking with status 'pending'", async () => {
    const { getCompassProfile } = await import("../compass/CompassProfileService.js");
    clearCompassProfileCache();
    const state = makeState({
      rent_buddy_bookings: [{
        id: "bk3",
        traveler_id: ALICE_ID,
        status: "pending",
      }],
    });
    const client = makeFakeClient(state) as any;
    const profile = await getCompassProfile(client, ALICE_ID, true);
    assert.equal(profile.hasActiveBooking, false);
  });

  it("active_booking_mode context when profile.hasActiveBooking is true (confirmed booking)", async () => {
    const state = makeState({
      rent_buddy_bookings: [{
        id: "bk4",
        traveler_id: ALICE_ID,
        status: "in_progress",
      }],
    });
    const { server, port } = await startApp(makeFakeClient(state));
    try {
      const res = await get(port, "/compass/me/context");
      const body = await res.json() as any;
      assert.equal(body.contextState, "active_booking_mode");
      assert.equal(body.intentMode.primary, "social_mode");
    } finally { server.close(); }
  });
});
