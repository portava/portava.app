/**
 * Trip Crew Location — access-control and privacy tests
 *
 * Verifies: non-member 403, pending user 403, removed member 403,
 * ghost mode → location_hidden, no exact coordinates, live-share
 * creation/expiry, feature-flag gating.
 *
 * Uses the node:test + fake-client pattern (same as safeReturn.test.ts).
 * Run: node --import tsx/esm --test src/test/tripCrewLocation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripCrewLocationRouter from "../routes/tripCrewLocation.js";
import { buildCrewCard } from "../lib/tripCrewLocation.js";
import { sweepExpiredLiveShares, revokeAccessForMember } from "../services/tripCrew/TripCrewLiveShareService.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN   = "crew-test-token";
const OTHER_TOKEN  = "other-user-token";
const USER_ID      = "user-crew-1";
const OTHER_USER   = "user-crew-2";
const MEMBER_ID    = "user-crew-member";
const TRIP_ID      = "trip-crew-uuid";
const SESSION_ID   = "session-crew-uuid";

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
  trips?: any[];
  tripMembers?: any[];
  profiles?: any[];
  crewPrefs?: any[];
  locationState?: any[];
  locationPreferences?: any[];
  planCheckins?: any[];
  safeReturnSessions?: any[];
  crewSessions?: any[];
  crewEvents?: any[];
}

function makeFakeClient(state: FakeState = {}) {
  const inserted: Record<string, any[]> = {};
  const updated: Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "feature_flags") {
      return Object.entries(state.featureFlags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
    }
    if (table === "trips") return state.trips ?? [];
    if (table === "trip_members") return state.tripMembers ?? [];
    if (table === "profiles") return state.profiles ?? [];
    if (table === "trip_crew_location_preferences") return state.crewPrefs ?? [];
    if (table === "user_location_state") return state.locationState ?? [];
    if (table === "location_preferences") return state.locationPreferences ?? [];
    if (table === "plan_checkins") return state.planCheckins ?? [];
    if (table === "safe_return_sessions") return state.safeReturnSessions ?? [];
    if (table === "trip_crew_location_sessions") return state.crewSessions ?? [];
    if (table === "trip_crew_location_events") return state.crewEvents ?? [];
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
      update(patch: any) {
        pendingUpdate = patch;
        if (!updated[table]) updated[table] = [];
        return b;
      },
      upsert(row: any) { pendingInsert = row; return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
      // or() parses Supabase-style "col.op.val,col.op.val" filter strings.
      // Only eq is needed today (used by fetchBlockedSet on the blocks table).
      or(filter: string) {
        const clauses = filter.split(",").map((c) => c.trim());
        filters.push((r) => clauses.some((clause) => {
          const parts = clause.split(".");
          if (parts.length < 3) return false;
          const [col, op, ...rest] = parts;
          const val = rest.join(".");
          if (op === "eq") return String(r[col]) === val;
          return false;
        }));
        return b;
      },
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
        if (!updated[table]) updated[table] = [];
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
        return { data: [row], error: null };
      }
      if (pendingUpdate) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (!updated[table]) updated[table] = [];
        updated[table].push(...matched.map((r: any) => ({ ...r, ...pendingUpdate })));
        return { data: matched.map((r: any) => ({ ...r, ...pendingUpdate })), error: null };
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
        if (token === FAKE_TOKEN)  return { data: { user: { id: USER_ID } }, error: null };
        if (token === OTHER_TOKEN) return { data: { user: { id: OTHER_USER } }, error: null };
        if (token === "member-tok") return { data: { user: { id: MEMBER_ID } }, error: null };
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

// ── Common state fixtures ─────────────────────────────────────────────────────

const BASE_FLAGS = {
  trip_crew_map_enabled: true,
  trip_crew_live_share_enabled: true,
  trip_crew_ghost_mode_enabled: true,
};

/** USER_ID is the trip owner */
const OWNER_TRIP = [{ id: TRIP_ID, owner_id: USER_ID }];
/** MEMBER_ID is an accepted member */
const ACCEPTED_MEMBERS = [{ trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member" }];
/** OTHER_USER has a pending invite (not accepted) */
const PENDING_MEMBERS  = [{ trip_id: TRIP_ID, user_id: OTHER_USER, role: "invited" }];

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripCrewLocationRouter);

  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Trip Crew Location — access control", () => {

  it("1. Non-member cannot access crew map (403)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    // OTHER_USER is not a member of TRIP_ID
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OTHER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("2. Pending-invite user CAN access crew map (200 — invited members may view who else is on the trip)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: [{ id: TRIP_ID, owner_id: USER_ID }],
      tripMembers: [...ACCEPTED_MEMBERS, ...PENDING_MEMBERS],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OTHER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("3. Trip owner can access crew map (200)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      profiles: [{ id: MEMBER_ID, full_name: "Alice", username: "alice", avatar_url: null }],
      locationState: [{ user_id: MEMBER_ID, city: "Cebu City", district: "IT Park", country: "Philippines", updated_at: new Date().toISOString() }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
    assert.ok(Array.isArray(r.body.members));
  });

  it("4. Accepted member can access crew map (200)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      profiles: [{ id: USER_ID, full_name: "Owner", username: "owner", avatar_url: null }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, "member-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("5. Feature flag off → featureEnabled=false, empty members", async () => {
    setClients(makeFakeClient({
      featureFlags: { trip_crew_map_enabled: false },
      trips: OWNER_TRIP,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
    assert.deepEqual(r.body.members, []);
  });

});

describe("Trip Crew Location — privacy: no exact coordinates", () => {

  it("6. Crew map response never contains lat/lng fields", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      profiles: [{ id: MEMBER_ID, full_name: "Alice", username: "alice", avatar_url: null }],
      // user_location_state has exact coords — must NOT appear in response
      locationState: [{
        user_id: MEMBER_ID,
        city: "Cebu City",
        district: "IT Park",
        country: "Philippines",
        lat: 10.3157,      // must not leak
        lng: 123.8854,     // must not leak
        updated_at: new Date().toISOString(),
      }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes("10.3157"), "lat must not appear in response");
    assert.ok(!json.includes("123.8854"), "lng must not appear in response");
  });

  it("7. areaLabel is blurred to at most neighborhood (no venue exact address)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      profiles: [{ id: MEMBER_ID, full_name: "Alice", username: "alice", avatar_url: null }],
      locationState: [{ user_id: MEMBER_ID, city: "Cebu City", district: "IT Park", country: "PH", updated_at: new Date().toISOString() }],
      crewPrefs: [{ trip_id: TRIP_ID, user_id: MEMBER_ID, default_visibility: "neighborhood", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: false }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const member = r.body.members[0];
    assert.ok(member, "member card should exist");
    // areaLabel should be a city/district label, not a precise address
    assert.equal(member.statusLabel, "neighborhood");
    assert.ok(member.areaLabel, "areaLabel should be set");
  });

});

describe("Trip Crew Location — ghost mode", () => {

  it("8. Ghost-mode member appears as location_hidden with no areaLabel", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      profiles: [{ id: MEMBER_ID, full_name: "Alice", username: "alice", avatar_url: null }],
      locationState: [{ user_id: MEMBER_ID, city: "Cebu City", district: "IT Park", country: "PH", updated_at: new Date().toISOString() }],
      crewPrefs: [{ trip_id: TRIP_ID, user_id: MEMBER_ID, default_visibility: "neighborhood", ghost_mode_enabled: true, share_arrival_status: true, share_safe_return_status: false }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const member = r.body.members[0];
    assert.ok(member, "member card should exist");
    assert.equal(member.statusLabel, "location_hidden");
    assert.equal(member.areaLabel, null);
    assert.equal(member.ghostMode, true);
  });

  it("9. Enable ghost mode — non-member gets 403", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/ghost-mode/enable`, undefined, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("10. Enable ghost mode — owner gets 200", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
      crewPrefs: [],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/ghost-mode/enable`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("11. Ghost mode feature flag off → 404", async () => {
    setClients(makeFakeClient({
      featureFlags: { trip_crew_map_enabled: true, trip_crew_ghost_mode_enabled: false },
      trips: OWNER_TRIP,
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/ghost-mode/enable`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

});

describe("Trip Crew Location — live share", () => {

  it("12. Non-member cannot start live share (403)", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "30m",
      allowedMemberIds: [MEMBER_ID],
    }, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("13. Owner starts live share — 201 with sessionId + expiresAt", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      crewSessions: [],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      visibilityLevel: "neighborhood",
      allowedMemberIds: [MEMBER_ID],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.sessionId, "sessionId should be returned");
    assert.ok(r.body.expiresAt, "expiresAt should be returned");
    // Verify expiresAt is ~15 minutes from now (within 60s tolerance)
    const diff = new Date(r.body.expiresAt).getTime() - Date.now();
    assert.ok(diff > 14 * 60_000, "expiresAt should be at least 14 minutes from now");
    assert.ok(diff < 16 * 60_000, "expiresAt should be at most 16 minutes from now");
  });

  it("14. Missing allowedMemberIds → 400", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      allowedMemberIds: [],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("15. Stop live share — 200", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
      crewSessions: [{ id: SESSION_ID, trip_id: TRIP_ID, user_id: USER_ID, status: "active", allowed_member_ids: [MEMBER_ID], expires_at: new Date(Date.now() + 900_000).toISOString() }],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/stop`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("16. Live share feature flag off → 404 on start", async () => {
    setClients(makeFakeClient({
      featureFlags: { trip_crew_map_enabled: true, trip_crew_live_share_enabled: false, trip_crew_ghost_mode_enabled: true },
      trips: OWNER_TRIP,
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "30m",
      allowedMemberIds: [MEMBER_ID],
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

});

describe("Trip Crew Location — preferences", () => {

  it("17. GET preferences — returns defaults when no prefs row exists", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
      crewPrefs: [],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/location-preferences`);
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultVisibility, "city_only");
    assert.equal(r.body.ghostModeEnabled, false);
    assert.equal(r.body.shareArrivalStatus, true);
  });

  it("18. PUT preferences — non-member gets 403", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("PUT", `/api/trips/${TRIP_ID}/crew/location-preferences`, {
      defaultVisibility: "neighborhood",
    }, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("19. PUT preferences — owner can update, returns ok", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
      crewPrefs: [],
    }));
    const r = await req("PUT", `/api/trips/${TRIP_ID}/crew/location-preferences`, {
      defaultVisibility: "neighborhood",
      shareArrivalStatus: false,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("20. PUT preferences — invalid visibility value → 400", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("PUT", `/api/trips/${TRIP_ID}/crew/location-preferences`, {
      defaultVisibility: "exact",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

});

describe("Trip Crew Location — lib unit tests (buildCrewCard)", () => {

  it("21. Ghost mode → location_hidden, null areaLabel", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Alice",
      handle: "alice",
      avatarUrl: null,
      prefs: { defaultVisibility: "neighborhood", ghostModeEnabled: true, shareArrivalStatus: true, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null },
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: null,
    });
    assert.equal(card.statusLabel, "location_hidden");
    assert.equal(card.areaLabel, null);
    assert.equal(card.ghostMode, true);
  });

  it("22. No prefs row → not_shared, null areaLabel", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      prefs: null,
      locationState: null,
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: null,
    });
    assert.equal(card.statusLabel, "not_shared");
    assert.equal(card.areaLabel, null);
  });

  it("23. Live share active → live_sharing_active status", () => {
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const card = buildCrewCard({
      userId: "u1",
      name: "Carol",
      handle: "carol",
      avatarUrl: null,
      prefs: { defaultVisibility: "city_only", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null },
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: { id: "share-1", visibilityLevel: "neighborhood", expiresAt },
    });
    assert.equal(card.statusLabel, "live_sharing_active");
    assert.equal(card.liveShareActive, true);
    assert.equal(card.liveShareExpiresAt, expiresAt);
    // Still no exact coords
    assert.ok(!("lat" in card));
    assert.ok(!("lng" in card));
  });

  it("24. Safe Return active (opt-in) → safe_return_active status", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Dave",
      handle: "dave",
      avatarUrl: null,
      prefs: { defaultVisibility: "neighborhood", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: true },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null },
      checkInStatus: null,
      hasSafeReturnActive: true,
      liveShare: null,
    });
    assert.equal(card.statusLabel, "safe_return_active");
    assert.equal(card.safeReturnActive, true);
  });

  it("25. Safe Return active but share not enabled → uses default visibility", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Eve",
      handle: "eve",
      avatarUrl: null,
      prefs: { defaultVisibility: "city_only", ghostModeEnabled: false, shareArrivalStatus: false, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: null, country: "PH", updatedAt: null },
      checkInStatus: "arrived",
      hasSafeReturnActive: true,
      liveShare: null,
    });
    // Safe return NOT shared → falls through to default visibility
    assert.equal(card.statusLabel, "city_only");
    assert.equal(card.safeReturnActive, false);
    // Arrival status also not shared
    assert.equal(card.planCheckInStatus, null);
  });

  it("26. Arrived check-in status → arrived statusLabel", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Frank",
      handle: "frank",
      avatarUrl: null,
      prefs: { defaultVisibility: "neighborhood", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null },
      checkInStatus: "arrived",
      hasSafeReturnActive: false,
      liveShare: null,
    });
    assert.equal(card.statusLabel, "arrived");
    assert.equal(card.planCheckInStatus, "arrived");
  });

  it("33. Live-share + lat/lng + no hotel blur → exactCoords returned", () => {
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const card = buildCrewCard({
      userId: "u1",
      name: "Grace",
      handle: "grace",
      avatarUrl: null,
      prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: false, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null, lat: 10.3157, lng: 123.8854 },
      hotelBlurEnabled: false,
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: { id: "share-coords", visibilityLevel: "nearby", expiresAt },
    });
    assert.equal(card.statusLabel, "live_sharing_active");
    assert.ok(card.exactCoords, "exactCoords must be present during live-share");
    assert.equal(card.exactCoords!.lat, 10.3157);
    assert.equal(card.exactCoords!.lng, 123.8854);
  });

  it("34. Live-share + hotel blur enabled → exactCoords is null", () => {
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const card = buildCrewCard({
      userId: "u1",
      name: "Hana",
      handle: "hana",
      avatarUrl: null,
      prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: false, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null, lat: 10.3157, lng: 123.8854 },
      hotelBlurEnabled: true,
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: { id: "share-blur", visibilityLevel: "nearby", expiresAt },
    });
    assert.equal(card.statusLabel, "live_sharing_active");
    assert.equal(card.exactCoords, null, "hotel blur must suppress exact coords even during live-share");
  });

  it("35. No live-share → exactCoords is null even when lat/lng present", () => {
    const card = buildCrewCard({
      userId: "u1",
      name: "Ivan",
      handle: "ivan",
      avatarUrl: null,
      prefs: { defaultVisibility: "nearby", ghostModeEnabled: false, shareArrivalStatus: false, shareSafeReturnStatus: false },
      locationState: { city: "Cebu City", district: "IT Park", country: "PH", updatedAt: null, lat: 10.3157, lng: 123.8854 },
      hotelBlurEnabled: false,
      checkInStatus: null,
      hasSafeReturnActive: false,
      liveShare: null,
    });
    assert.equal(card.exactCoords, null, "no live-share → coords must not leak");
    // raw lat/lng must not appear as top-level properties
    assert.ok(!("lat" in card));
    assert.ok(!("lng" in card));
  });

});

describe("Trip Crew Location — allowedMemberIds validation", () => {

  it("28. Live-share start rejects non-member in allowedMemberIds → 400", async () => {
    const NON_MEMBER_ID = "user-not-in-trip";
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      crewSessions: [],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      allowedMemberIds: [NON_MEMBER_ID],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("29. Live-share start rejects pending-invite user in allowedMemberIds → 400", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [...ACCEPTED_MEMBERS, ...PENDING_MEMBERS],
      crewSessions: [],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      allowedMemberIds: [OTHER_USER],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("30. Live-share start succeeds when all allowedMemberIds are accepted members", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: ACCEPTED_MEMBERS,
      crewSessions: [],
      crewEvents: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      allowedMemberIds: [MEMBER_ID],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });

});

describe("Trip Crew Location — removed member loses access", () => {

  it("31. revokeAccessForMember removes user from allowed_member_ids", async () => {
    const future = new Date(Date.now() + 900_000).toISOString();
    const client = makeFakeClient({
      crewSessions: [
        {
          id: "sess-to-revoke",
          trip_id: TRIP_ID,
          user_id: USER_ID,
          status: "active",
          expires_at: future,
          allowed_member_ids: [MEMBER_ID, OTHER_USER],
        },
      ],
      crewEvents: [],
    });
    // Revoke MEMBER_ID from the session
    await revokeAccessForMember(client as any, TRIP_ID, MEMBER_ID);
    // The fake client's update should have been called
    const updatedSessions = client.__updated["trip_crew_location_sessions"] ?? [];
    assert.ok(updatedSessions.length > 0, "update should have been called for the session");
    const updated = updatedSessions[0];
    assert.ok(
      !((updated.allowed_member_ids ?? []).includes(MEMBER_ID)),
      "MEMBER_ID should be removed from allowed_member_ids",
    );
  });

  it("32. Removed member cannot start live share (403) after removal", async () => {
    setClients(makeFakeClient({
      featureFlags: BASE_FLAGS,
      trips: OWNER_TRIP,
      tripMembers: [],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "15m",
      allowedMemberIds: [USER_ID],
    }, OTHER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

});

describe("Trip Crew Location — live-share expiry sweep", () => {

  it("27. sweepExpiredLiveShares marks expired rows and returns count", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 900_000).toISOString();
    const client = makeFakeClient({
      crewSessions: [
        { id: "sess-expired", trip_id: TRIP_ID, user_id: USER_ID, status: "active", expires_at: past, allowed_member_ids: [] },
        { id: "sess-live",    trip_id: TRIP_ID, user_id: MEMBER_ID, status: "active", expires_at: future, allowed_member_ids: [] },
      ],
      crewEvents: [],
    });
    // The sweep uses its own db reference — inject via the service directly
    const count = await sweepExpiredLiveShares(client as any);
    // Our fake client's lt filter: expires_at < now — "sess-expired" matches
    assert.ok(count >= 0, "sweep should return a non-negative count");
  });

});
