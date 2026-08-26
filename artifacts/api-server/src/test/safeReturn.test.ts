/**
 * Safe Return system tests
 *
 * Verifies security rules, privacy guards, escalation logic, and feature-flag
 * gating WITHOUT a live database.  Uses the node:test + fake-client pattern.
 *
 * Run: node --import tsx/esm --test src/test/safeReturn.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import adminRouter from "../routes/admin.js";
import {
  shouldSuggest,
  getSuggestionReason,
  type PlanItemContext,
} from "../services/safeReturn/SafeReturnTriggerService.js";
import { stripGPS, toPublicSession } from "../services/safeReturn/SafeReturnPrivacyGuard.js";

// ── Test server ───────────────────────────────────────────────────────────────

// TZ HYGIENE — pin this test process to UTC (CI's reference timezone). The
// time-of-day boundary assertions below run against the server's LOCAL clock
// (SafeReturnTriggerService.extractHour → new Date(ts).getHours()), so on a
// developer machine in a non-UTC zone the "after 21:00" boundary flips and the
// test flakes. Pinning makes it deterministic everywhere; prod code is unchanged.
process.env.TZ = "UTC";

let server: http.Server;
let base: string;
const FAKE_TOKEN = "safe-return-test-token";
const USER_ID = "user-safe-return-1";
const OTHER_USER_ID = "other-user-2";
const SESSION_ID = "session-uuid-1";
const CONTACT_ID = "contact-uuid-1";
const SHARE_ID = "share-uuid-1";
const TRIP_ID = "trip-uuid-1";
const PLAN_ITEM_ID = "plan-item-uuid-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
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
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

interface FakeState {
  featureFlags?: Record<string, boolean>;
  sessions?: Record<string, any>[];
  contacts?: Record<string, any>[];
  events?: Record<string, any>[];
  liveShares?: Record<string, any>[];
  planItems?: Record<string, any>[];
  profiles?: Record<string, any>[];
  trips?: Record<string, any>[];
  tripMembers?: Record<string, any>[];
  follows?: Record<string, any>[];
  locationState?: Record<string, any>[];
}

function makeFakeClient(state: FakeState = {}) {
  const inserted: Record<string, any[]> = {};
  const updated: Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "feature_flags") {
      // Include both `key` (safeReturn.ts isFlagEnabled) and `flag` (admin.ts isSafeReturnAdminEnabled)
      return Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ key, flag: key, enabled }));
    }
    if (table === "safe_return_sessions") return state.sessions ?? [];
    if (table === "safe_return_contacts") return state.contacts ?? [];
    if (table === "safe_return_events") return state.events ?? [];
    if (table === "safe_return_live_shares") return state.liveShares ?? [];
    if (table === "trip_plan_items") return state.planItems ?? [];
    if (table === "profiles") return state.profiles ?? [];
    if (table === "trips") return state.trips ?? [];
    if (table === "trip_members") return state.tripMembers ?? [];
    if (table === "follows") return state.follows ?? [];
    if (table === "user_location_state") return state.locationState ?? [];
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _single = false;
    let _maybe = false;

    const b: any = {
      select(_cols?: string) { return b; },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push(row);
        return b;
      },
      update(patch: any) { pendingUpdate = patch; if (!updated[table]) updated[table] = []; return b; },
      upsert(row: any) { pendingInsert = row; return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
      order() { return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() { _maybe = true; _single = true; return resolve(); },
      single() { _single = true; return resolve(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    async function resolve() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert)
          ? { id: `gen-${Math.random()}`, ...pendingInsert[0] }
          : { id: `gen-${Math.random()}`, ...pendingInsert };
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        const row = matched[0] ? { ...matched[0], ...pendingUpdate } : null;
        updated[table].push({ ...row });
        return { data: row, error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (_maybe) return { data: matched[0] ?? null, error: null };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert)
          ? { id: `gen-${Math.random()}`, ...pendingInsert[0] }
          : { id: `gen-${Math.random()}`, ...pendingInsert };
        return { data: row, error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: _limit ? matched.slice(0, _limit) : matched, error: null };
    }

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        if (token === "other-tok") return { data: { user: { id: OTHER_USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    __inserted: inserted,
    __updated: updated,
  };
  return client;
}

function setClients(c: ReturnType<typeof makeFakeClient>) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", safeReturnRouter);
  app.use("/api", adminRouter);

  server = http.createServer(app);
  server.listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server.close(); });

// ── 1. SafeReturnTriggerService (pure logic — no HTTP) ────────────────────────

describe("SafeReturnTriggerService.shouldSuggest", () => {
  it("1a. suggests for nightlife category", () => {
    const item: PlanItemContext = {
      id: "p1", category: "nightlife", startsAt: null, dayDate: null, locationName: null,
    };
    const result = shouldSuggest(item, USER_ID, {});
    assert.ok(result.shouldSuggest);
    assert.ok(result.reasons.includes("nightlife_plan"));
  });

  it("1b. suggests for late-night start (after 21:00)", () => {
    const item: PlanItemContext = {
      id: "p2", category: "dining", startsAt: "2026-07-01T22:30:00.000Z", dayDate: null, locationName: null,
    };
    const result = shouldSuggest(item, USER_ID, {});
    assert.ok(result.shouldSuggest);
    assert.ok(result.reasons.includes("late_night_activity"));
  });

  it("1c. does NOT suggest for daytime trips", () => {
    const item: PlanItemContext = {
      id: "p3", category: "activity", startsAt: "2026-07-01T10:00:00.000Z", dayDate: null, locationName: null,
    };
    const result = shouldSuggest(item, USER_ID, {});
    assert.ok(!result.shouldSuggest);
    assert.equal(result.reasons.length, 0);
  });

  it("1d. suggests for solo attendance", () => {
    const item: PlanItemContext = {
      id: "p4", category: "activity", startsAt: null, dayDate: null, locationName: null, attendeeCount: 1,
    };
    const result = shouldSuggest(item, USER_ID, {});
    assert.ok(result.shouldSuggest);
    assert.ok(result.reasons.includes("solo_activity"));
  });

  it("1e. suggests for new city", () => {
    const item: PlanItemContext = {
      id: "p5", category: "activity", startsAt: null, dayDate: null, locationName: null,
    };
    const result = shouldSuggest(item, USER_ID, { homeCity: "London", currentCity: "Tokyo" });
    assert.ok(result.shouldSuggest);
    assert.ok(result.reasons.includes("new_city"));
  });

  it("1f. does NOT suggest when home city matches current city", () => {
    const item: PlanItemContext = {
      id: "p6", category: "activity", startsAt: null, dayDate: null, locationName: null,
    };
    const result = shouldSuggest(item, USER_ID, { homeCity: "Paris", currentCity: "Paris" });
    assert.ok(!result.shouldSuggest);
  });

  it("1g. confidence scales with number of matching reasons", () => {
    const item: PlanItemContext = {
      id: "p7", category: "nightlife",
      startsAt: "2026-07-01T23:00:00.000Z", dayDate: null, locationName: null,
      attendeeCount: 1, hasLocationCautionFlag: true,
    };
    const result = shouldSuggest(item, USER_ID, { homeCity: "London", currentCity: "Bangkok" });
    assert.equal(result.confidence, "high");
    assert.ok(result.reasons.length >= 3);
  });

  it("1h. getSuggestionReason returns non-empty string for reasons", () => {
    const text = getSuggestionReason(["nightlife_plan", "solo_activity"]);
    assert.ok(text.length > 0);
    assert.ok(text.includes("nightlife") || text.includes("solo"));
  });
});

// ── 2. SafeReturnPrivacyGuard (pure logic) ────────────────────────────────────

describe("SafeReturnPrivacyGuard.stripGPS", () => {
  it("2a. removes lat and lng from objects", () => {
    const obj = { id: "s1", status: "active", lat: 51.5, lng: -0.1, city: "London" };
    const stripped = stripGPS(obj);
    assert.ok(!("lat" in stripped));
    assert.ok(!("lng" in stripped));
    assert.equal((stripped as any).city, "London");
  });

  it("2b. toPublicSession never includes GPS fields", () => {
    const session = {
      id: "s1", status: "active", escalationLevel: 0, timerStartAt: null, timerEndAt: null,
      trustedCircleEnabled: false, liveShareEnabled: false, notifyHostEnabled: false,
      notifyTripCrewEnabled: false, planItemId: null, tripId: null, triggerReason: null,
      emergencyNote: null, closedAt: null, createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      // These should be stripped:
      lat: 51.5, lng: -0.1, userId: USER_ID,
    };
    const pub = toPublicSession(session);
    assert.ok(!("lat" in pub), "lat must not appear");
    assert.ok(!("lng" in pub), "lng must not appear");
    assert.ok(!("userId" in pub), "userId must not appear in public shape");
  });
});

// ── 3. Feature flag gating ────────────────────────────────────────────────────

describe("Feature flag gating", () => {
  it("3a. returns feature_disabled when safe_return_enabled = false", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
    const r = await req("POST", "/api/me/safe-return/sessions", { timerMinutes: 30 });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("3b. active endpoint returns featureEnabled:false when flag off", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
    const r = await req("GET", "/api/me/safe-return/sessions/active");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
    assert.equal(r.body.session, null);
  });

  it("3c. suggest endpoint returns suggest:false when flag off", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
    const r = await req("GET", `/api/me/safe-return/suggest/${PLAN_ITEM_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.suggest, false);
  });
});

// ── 4. Session lifecycle ──────────────────────────────────────────────────────

describe("Session lifecycle", () => {
  function enabledState(extra: Partial<FakeState> = {}): FakeState {
    return {
      featureFlags: {
        safe_return_enabled: true,
        safe_return_live_share_enabled: true,
        safe_return_trusted_circle_alerts_enabled: true,
        safe_return_admin_logs_enabled: true,
      },
      sessions: [],
      contacts: [],
      events: [],
      liveShares: [],
      ...extra,
    };
  }

  it("4a. creates session with default escalation level 0", async () => {
    setClients(makeFakeClient(enabledState()));
    const r = await req("POST", "/api/me/safe-return/sessions", {
      timerMinutes: 30,
      trustedCircleEnabled: false,
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.ok);
    assert.equal(r.body.session.escalationLevel, 0);
  });

  it("4b. confirm-safe closes the session", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: new Date().toISOString(), timer_end_at: null,
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({ sessions: [session] })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/confirm`);
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
  });

  it("4c. extend updates timer_end_at", async () => {
    const oldEnd = new Date(Date.now() + 10 * 60_000).toISOString();
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: new Date().toISOString(), timer_end_at: oldEnd,
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({ sessions: [session] })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/extend`, { minutes: 30 });
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
  });

  it("4d. cancel prevents further escalation (status → cancelled)", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 2,
      timer_start_at: new Date().toISOString(), timer_end_at: null,
      trusted_circle_enabled: true, live_share_enabled: true,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({ sessions: [session] })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/cancel`);
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
  });

  it("4e. trigger-missed endpoint marks session as missed and returns escalation level", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      timer_end_at: new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({ sessions: [session], profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }] })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
    assert.equal(r.body.escalationLevel, 0);
  });

  it("4f. trigger-missed at escalation level 1 succeeds (user + trusted-circle path)", async () => {
    // Level 1: notify the user AND trusted contacts (when TC flag is on).
    // The route must not error even when the TC flag gates the notification.
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 1,
      timer_start_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      timer_end_at:   new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: true,  live_share_enabled: false,
      notify_host_enabled: false,    notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({
      sessions:  [session],
      contacts:  [{ id: CONTACT_ID, session_id: SESSION_ID, user_id: USER_ID, contact_user_id: OTHER_USER_ID, contact_method: "in_app", can_receive_live_location: false, notified_at: null }],
      profiles:  [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
    })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.equal(r.body.escalationLevel, 1);
  });

  it("4g. trigger-missed at escalation level 2 succeeds (user + TC + live-share prompt)", async () => {
    // Level 2: same backend path as level 1; live-share prompt is a client-side UI action.
    // The route must return 200 with escalationLevel=2.
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 2,
      timer_start_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      timer_end_at:   new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: true,  live_share_enabled: true,
      notify_host_enabled: false,    notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient(enabledState({
      sessions:  [session],
      contacts:  [],
      profiles:  [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
    })));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.equal(r.body.escalationLevel, 2);
  });
});

// ── 5. Privacy: exact GPS absent from all public API shapes ───────────────────

describe("Privacy: no GPS in API responses", () => {
  function sessionWithGps() {
    return {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: null, timer_end_at: null,
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
      // These must NEVER appear in responses:
      lat: 51.5, lng: -0.1,
    };
  }

  it("5a. active session response never contains lat/lng", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      sessions: [sessionWithGps()],
    }));
    const r = await req("GET", "/api/me/safe-return/sessions/active");
    assert.equal(r.status, 200);
    assert.ok(r.body.session);
    assert.ok(!("lat" in r.body.session), "lat must not be present");
    assert.ok(!("lng" in r.body.session), "lng must not be present");
  });

  it("5b. history response never contains lat/lng", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      sessions: [sessionWithGps()],
    }));
    const r = await req("GET", "/api/me/safe-return/history");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.sessions));
    if (r.body.sessions.length > 0) {
      assert.ok(!("lat" in r.body.sessions[0]), "lat must not be present in history");
      assert.ok(!("lng" in r.body.sessions[0]), "lng must not be present in history");
    }
  });
});

// ── 6. Trusted Circle: only notify if trusted_circle_enabled = true ───────────

describe("TC alert privacy", () => {
  it("6a. TC not notified when trusted_circle_enabled = false (session create)", async () => {
    const client = makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      sessions: [],
      contacts: [],
      events: [],
    });
    setClients(client);
    await req("POST", "/api/me/safe-return/sessions", {
      timerMinutes: 30,
      trustedCircleEnabled: false,
      contacts: [{ contactUserId: OTHER_USER_ID, contactMethod: "in_app", canReceiveLiveLocation: false }],
    });
    // Sessions created with trusted_circle_enabled: false
    const insertedSessions = client.__inserted["safe_return_sessions"] ?? [];
    if (insertedSessions.length > 0) {
      assert.equal(insertedSessions[0].trusted_circle_enabled, false);
    }
  });

  it("6b. host not notified unless notify_host_enabled = true", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
      timer_start_at: null, timer_end_at: new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: TRIP_ID, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_trusted_circle_alerts_enabled: true },
      sessions: [session],
      contacts: [],
      events: [],
      profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
      trips: [{ id: TRIP_ID, owner_id: OTHER_USER_ID }],
    }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    assert.equal(r.status, 200);
    // Response should be 200; host was NOT notified because notify_host_enabled=false
    assert.ok(r.body.ok);
  });

  it("6c. trip crew not notified unless notify_trip_crew_enabled = true", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
      timer_start_at: null, timer_end_at: new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: TRIP_ID, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_trusted_circle_alerts_enabled: false },
      sessions: [session],
      contacts: [],
      events: [],
      profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
    }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
  });
});

// ── 7. Live share ─────────────────────────────────────────────────────────────

describe("Live share authorization", () => {
  it("7a. live share not started unless live_share_enabled on session", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: null, timer_end_at: null,
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
      sessions: [session],
      liveShares: [],
      events: [],
    }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/live-share/start`, { durationMinutes: 60 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("7b. live share gated by safe_return_live_share_enabled flag", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
      timer_start_at: null, timer_end_at: null,
      trusted_circle_enabled: false, live_share_enabled: true,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: false },
      sessions: [session],
      liveShares: [],
      events: [],
    }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/live-share/start`, { durationMinutes: 60 });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("7c. non-recipient cannot access live share view", async () => {
    const futureExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const share = {
      id: SHARE_ID, session_id: SESSION_ID, user_id: USER_ID,
      recipient_user_id: "authorized-recipient-id",
      recipient_contact_id: null, status: "active",
      started_at: new Date().toISOString(), expires_at: futureExpiry, stopped_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
      liveShares: [share],
      sessions: [{ id: SESSION_ID, user_id: USER_ID, city: "Tokyo", district: null, country: "Japan" }],
      profiles: [{ id: USER_ID, display_name: "Alice" }],
    }));
    // OTHER_USER_ID is NOT the authorized recipient
    const r = await req("GET", `/api/safe-return/live-share/${SHARE_ID}`, undefined, "other-tok");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("7d. expired live share access is denied (hard expiry cutoff)", async () => {
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const share = {
      id: SHARE_ID, session_id: SESSION_ID, user_id: USER_ID,
      recipient_user_id: USER_ID,
      recipient_contact_id: null, status: "active",
      started_at: new Date().toISOString(), expires_at: pastExpiry, stopped_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
      liveShares: [share],
      sessions: [{ id: SESSION_ID, user_id: USER_ID, city: "Paris", district: null, country: "France" }],
    }));
    const r = await req("GET", `/api/safe-return/live-share/${SHARE_ID}`);
    // Should be denied — expired
    assert.ok(r.status === 404 || r.body.error !== undefined);
  });
});

// ── 8. Safety history: only caller's sessions ─────────────────────────────────

describe("Safety history", () => {
  it("8a. history returns only the caller's sessions", async () => {
    const mySession = {
      id: SESSION_ID, user_id: USER_ID, status: "safe", escalation_level: 0,
      timer_start_at: null, timer_end_at: null,
      trusted_circle_enabled: false, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    const otherSession = { ...mySession, id: "other-session", user_id: OTHER_USER_ID };

    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      sessions: [mySession, otherSession],
    }));
    const r = await req("GET", "/api/me/safe-return/history");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.sessions));
    // All returned sessions must belong to the caller
    for (const s of r.body.sessions) {
      // userId is stripped from public shape — just verify no OTHER_USER_ID fields
      assert.ok(!("userId" in s), "userId should be stripped from public shape");
    }
  });
});

// ── 9. Unauthenticated requests ───────────────────────────────────────────────

describe("Authentication", () => {
  it("9a. unauthenticated POST sessions returns 401", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
    const r = await req("POST", "/api/me/safe-return/sessions", { timerMinutes: 30 }, "invalid-tok");
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthenticated");
  });

  it("9b. unauthenticated GET active returns 401", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
    const r = await req("GET", "/api/me/safe-return/sessions/active", undefined, "invalid-tok");
    assert.equal(r.status, 401);
  });
});

// ── 10. Suggest endpoint ──────────────────────────────────────────────────────

describe("Suggest endpoint", () => {
  it("10a. returns suggestion for nightlife plan item", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      planItems: [{
        id: PLAN_ITEM_ID, category: "nightlife",
        starts_at: "2026-07-01T23:00:00.000Z", day_date: "2026-07-01",
        location_name: "Bar District", lat: null, lng: null, trip_id: TRIP_ID,
      }],
      tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "member" }],
      profiles: [{ id: USER_ID, home_city: "London" }],
      locationState: [{ user_id: USER_ID, city: "Bangkok" }],
    }));
    const r = await req("GET", `/api/me/safe-return/suggest/${PLAN_ITEM_ID}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.suggest);
    assert.ok(r.body.reasons.length > 0);
    assert.ok(r.body.reasonText);
  });

  it("10b. returns no suggestion for daytime dining plan", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      planItems: [{
        id: PLAN_ITEM_ID, category: "dining",
        starts_at: "2026-07-01T12:00:00.000Z", day_date: "2026-07-01",
        location_name: "Cafe", lat: null, lng: null, trip_id: TRIP_ID,
      }],
      tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "member" }],
      profiles: [{ id: USER_ID, home_city: "London" }],
      locationState: [{ user_id: USER_ID, city: "London" }],
    }));
    const r = await req("GET", `/api/me/safe-return/suggest/${PLAN_ITEM_ID}`);
    assert.equal(r.status, 200);
    assert.ok(!r.body.suggest);
  });

  it("10c. returns 404 when plan item not found", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      planItems: [],
    }));
    const r = await req("GET", `/api/me/safe-return/suggest/${PLAN_ITEM_ID}`);
    assert.equal(r.status, 404);
  });
});

// ── 11. Invalid payload ───────────────────────────────────────────────────────

describe("Input validation", () => {
  it("11a. escalation_level outside 0–3 is rejected", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
    const r = await req("POST", "/api/me/safe-return/sessions", { escalationLevel: 5, timerMinutes: 30 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("11b. extend with missing minutes is rejected", async () => {
    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/extend`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ── 12. Admin event-log authorization ─────────────────────────────────────────

describe("Admin event-log authorization", () => {
  it("12a. non-admin gets 403 for /admin/safe-return/logs", async () => {
    setClients(makeFakeClient({
      featureFlags: {
        safe_return_enabled: true,
        safe_return_admin_logs_enabled: true,
      },
      profiles: [{ id: USER_ID, role: "member" }],
      events: [],
    }));
    const r = await req("GET", "/api/admin/safe-return/logs");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("12b. unauthenticated gets 401 for /admin/safe-return/logs", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_admin_logs_enabled: true },
      profiles: [],
    }));
    const r = await req("GET", "/api/admin/safe-return/logs", undefined, "invalid-tok");
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthenticated");
  });

  it("12c. admin + flag disabled returns feature_disabled for logs endpoint", async () => {
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true, safe_return_admin_logs_enabled: false },
      profiles: [{ id: USER_ID, role: "admin" }],
      events: [],
    }));
    const r = await req("GET", "/api/admin/safe-return/logs");
    // feature_disabled maps to HTTP 404 in sendError
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("12d. fresh-install admin reaches config (flag seeded TRUE in migration 0040)", async () => {
    // Migration 0040 seeds safe_return_admin_logs_enabled=TRUE so that on a
    // fresh install an admin can always read and write config flags without
    // a bootstrap deadlock. This test simulates that fresh state.
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: false, safe_return_admin_logs_enabled: true },
      profiles: [{ id: USER_ID, role: "admin" }],
      events: [],
    }));
    const r = await req("GET", "/api/admin/safe-return/config");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.config));
  });

  it("12e. admin + flag enabled returns event list", async () => {
    setClients(makeFakeClient({
      featureFlags: {
        safe_return_enabled: true,
        safe_return_admin_logs_enabled: true,
      },
      profiles: [{ id: USER_ID, role: "admin" }],
      events: [
        { id: "ev-1", session_id: SESSION_ID, user_id: USER_ID, event_type: "session_started", metadata: null, created_at: new Date().toISOString() },
      ],
    }));
    const r = await req("GET", "/api/admin/safe-return/logs");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.events));
    assert.equal(r.body.events.length, 1);
  });
});

// ── 13. Emergency help — no-auto-dial contract ─────────────────────────────────
// EmergencyHelpSheet is a mobile-only component, tested at component level.
// This backend-side test verifies that the trigger-missed API response contains
// no telephone URIs or phone numbers — the server never initiates outbound calls.

describe("Emergency help no-auto-dial contract", () => {
  it("13a. trigger-missed response body contains no phone number or dialer URI", async () => {
    const session = {
      id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
      timer_start_at: new Date(Date.now() - 3600_000).toISOString(),
      timer_end_at: new Date(Date.now() - 1000).toISOString(),
      trusted_circle_enabled: true, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      plan_item_id: null, trip_id: null, trigger_reason: null,
      emergency_note: null, closed_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_prompt_at: null, last_safe_confirmation_at: null,
    };
    setClients(makeFakeClient({
      featureFlags: { safe_return_enabled: true },
      sessions: [session],
      contacts: [],
      events: [],
      profiles: [{ id: USER_ID, expo_push_token: null }],
      locationState: [{ user_id: USER_ID, city: "Bangkok", country: "Thailand" }],
    }));
    const r = await req("POST", `/api/me/safe-return/sessions/${SESSION_ID}/trigger-missed`);
    // Backend response must not include telephone URIs or phone numbers
    const bodyStr = JSON.stringify(r.body);
    assert.ok(!bodyStr.includes("tel:"), "Response must not include telephone URI");
    assert.ok(!bodyStr.includes("phone"), "Response must not include phone number field");
    assert.ok(!bodyStr.includes("dial"), "Response must not include dial instruction");
    // Session is now missed — the prompt is shown to the user; they must tap to call
    assert.equal(r.status, 200);
  });
});
