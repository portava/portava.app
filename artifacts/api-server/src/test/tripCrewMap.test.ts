/**
 * Trip Crew Map — access-control and crew-list tests
 *
 * Tests the GET /api/trips/:tripId/crew/map handler that lives in
 * tripCrewLocation.ts (mounted at /api via routes/index.ts).
 *
 * Key verifications:
 *   - Feature flag off → featureEnabled: false, 200
 *   - Unauthenticated → 401
 *   - Non-member → not_member error
 *   - Invited (pending) member CAN view the crew map (getMemberRoleAny)
 *   - Accepted member sees crew including invited peers
 *   - Owner is excluded from their own view (getCrewMap excludes viewerId)
 *   - Member cards have correct shape
 *
 * Run: node --import tsx/esm --test src/test/tripCrewMap.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripCrewLocationRouter from "../routes/tripCrewLocation.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const OWNER_TOKEN   = "crewmap-owner-token";
const MEMBER_TOKEN  = "crewmap-member-token";
const INVITED_TOKEN = "crewmap-invited-token";
const OTHER_TOKEN   = "crewmap-other-token";

const OWNER_ID   = "a0000001-0000-0000-0000-000000000001";
const MEMBER_ID  = "a0000001-0000-0000-0000-000000000002";
const INVITED_ID = "a0000001-0000-0000-0000-000000000003";
const OTHER_ID   = "a0000001-0000-0000-0000-000000000099";
const TRIP_ID    = "b0000001-0000-0000-0000-000000000001";

function req(
  method: string,
  path: string,
  token: string | null = OWNER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
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
    r.end();
  });
}

// ── Fake client ───────────────────────────────────────────────────────────────

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
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
}

function makeFakeClient(state: FakeState = {}) {
  function getRows(table: string): any[] {
    if (table === "feature_flags")                  return Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, enabled }));
    if (table === "trips")                          return state.trips ?? [];
    if (table === "trip_members")                   return state.tripMembers ?? [];
    if (table === "profiles")                       return state.profiles ?? [];
    if (table === "trip_crew_location_preferences") return state.crewPrefs ?? [];
    if (table === "user_location_state")            return state.locationState ?? [];
    if (table === "user_location_preferences")      return state.locationPreferences ?? [];
    if (table === "plan_checkins")                  return state.planCheckins ?? [];
    if (table === "safe_return_sessions")           return state.safeReturnSessions ?? [];
    if (table === "trip_crew_location_sessions")    return state.crewSessions ?? [];
    if (table === "blocks")                         return state.blocks ?? [];
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    const filters: Array<(r: any) => boolean> = [];
    let _maybe = false;
    let _limit: number | null = null;

    const b: any = {
      select(_cols?: string) { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      lt(col: string, val: any)    { filters.push((r) => r[col] < val); return b; },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return b; },
      or(expr: string) {
        // Parses "col.eq.val" terms separated by commas (OR) — enough for the
        // bidirectional block lookup fetchBlockedSet issues.
        const parts = expr.split(",").map((p) => {
          const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
          return m ? { col: m[1], val: m[3] } : null;
        }).filter(Boolean) as { col: string; val: string }[];
        filters.push((r) => parts.some(({ col, val }) => String(r[col]) === val));
        return b;
      },
      order()                      { return b; },
      limit(n: number)             { _limit = n; return b; },
      maybeSingle()                { _maybe = true; return resolveOne(); },
      single()                     { return resolveOne(); },
      then(onF: any, onR: any)     { return resolveList().then(onF, onR); },
    };

    async function resolveOne() {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: _limit ? matched.slice(0, _limit) : matched, error: null };
    }

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        if (token === OWNER_TOKEN)   return { data: { user: { id: OWNER_ID } },   error: null };
        if (token === MEMBER_TOKEN)  return { data: { user: { id: MEMBER_ID } },  error: null };
        if (token === INVITED_TOKEN) return { data: { user: { id: INVITED_ID } }, error: null };
        if (token === OTHER_TOKEN)   return { data: { user: { id: OTHER_ID } },   error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
  return client;
}

function setClients(c: ReturnType<typeof makeFakeClient>) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FLAG_ON  = { trip_crew_map_enabled: true };

const OWNER_TRIP = [{ id: TRIP_ID, owner_id: OWNER_ID }];

const OWNER_MEMBER_ROW    = { trip_id: TRIP_ID, user_id: OWNER_ID,   role: "owner"   };
const ACCEPTED_MEMBER_ROW = { trip_id: TRIP_ID, user_id: MEMBER_ID,  role: "member"  };
const INVITED_MEMBER_ROW  = { trip_id: TRIP_ID, user_id: INVITED_ID, role: "invited" };

// getCrewMap uses full_name / username (not name / handle)
const PROFILES = [
  { id: OWNER_ID,   username: "owner_handle",   full_name: "Trip Owner",      avatar_url: "https://cdn.example.com/owner.jpg" },
  { id: MEMBER_ID,  username: "member_handle",  full_name: "Accepted Member", avatar_url: null },
  { id: INVITED_ID, username: "invited_handle", full_name: "Invited Person",  avatar_url: "https://cdn.example.com/invited.jpg" },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripCrewLocationRouter);

  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /trips/:tripId/crew/map — invited-member access and crew list", () => {

  it("1. Unauthenticated request returns 401", async () => {
    setClients(makeFakeClient({ featureFlags: FLAG_ON, trips: OWNER_TRIP, tripMembers: [OWNER_MEMBER_ROW] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, null);
    assert.equal(r.status, 401);
  });

  it("2. Feature flag off returns featureEnabled: false with 200", async () => {
    setClients(makeFakeClient({
      featureFlags: { trip_crew_map_enabled: false },
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, false);
    assert.deepEqual(r.body.members, []);
  });

  it("3. Non-member is rejected with not_member error", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("4. Invited (pending) member can view the crew map", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, INVITED_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
    assert.ok(Array.isArray(r.body.members));
  });

  it("5. Accepted member receives 200 with featureEnabled: true", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
    assert.ok(Array.isArray(r.body.members));
  });

  it("6. Crew map includes invited members alongside accepted members", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    // Viewer (MEMBER_ID) is excluded from their own list, so we see owner + invited
    const memberIds = r.body.members.map((m: any) => m.userId);
    assert.ok(memberIds.includes(OWNER_ID),   "owner should be in crew list");
    assert.ok(memberIds.includes(INVITED_ID), "invited member should appear in crew list");
    assert.ok(!memberIds.includes(MEMBER_ID), "viewer should not appear in their own list");
  });

  it("7. Member cards have the required shape", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(r.body.members.length > 0);
    const card = r.body.members[0];
    assert.ok("userId" in card,           "card must have userId");
    assert.ok("statusLabel" in card,      "card must have statusLabel");
    assert.ok("safeReturnActive" in card, "card must have safeReturnActive");
    assert.ok("liveShareActive" in card,  "card must have liveShareActive");
    assert.ok("ghostMode" in card,        "card must have ghostMode");
  });

  it("8. Trip with only the calling owner returns empty members (viewer excluded from list)", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    // Owner is excluded from their own view; no other members → empty list
    assert.deepEqual(r.body.members, []);
    assert.equal(r.body.totalCount, 0);
  });

  it("9. Owner sees all other crew (accepted + invited) but not themselves", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const memberIds = r.body.members.map((m: any) => m.userId);
    assert.ok(memberIds.includes(MEMBER_ID),  "accepted member should appear");
    assert.ok(memberIds.includes(INVITED_ID), "invited member should appear");
    assert.ok(!memberIds.includes(OWNER_ID),  "owner should not see themselves");
  });

  it("10. totalCount matches the number of returned members", async () => {
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.equal(r.body.totalCount, r.body.members.length);
  });

  it("11. A crew member the viewer blocked is excluded from the map (server-side)", async () => {
    // Viewer = MEMBER_ID; MEMBER blocked INVITED. INVITED must not appear even
    // though they are a trip member — the block is enforced in getCrewMap, not
    // just the client.
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
      blocks: [{ blocker_id: MEMBER_ID, blocked_id: INVITED_ID }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    const ids = r.body.members.map((m: any) => m.userId);
    assert.ok(ids.includes(OWNER_ID),    "owner should still appear");
    assert.ok(!ids.includes(INVITED_ID), "blocked member must not appear on the crew map");
    assert.equal(r.body.totalCount, r.body.members.length);
  });

  it("12. A crew member who blocked the viewer is excluded (reverse direction)", async () => {
    // INVITED blocked MEMBER. When MEMBER views the map, INVITED must not appear
    // — blocking is symmetric for location visibility.
    setClients(makeFakeClient({
      featureFlags: FLAG_ON,
      trips: OWNER_TRIP,
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
      blocks: [{ blocker_id: INVITED_ID, blocked_id: MEMBER_ID }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    const ids = r.body.members.map((m: any) => m.userId);
    assert.ok(ids.includes(OWNER_ID),    "owner should still appear");
    assert.ok(!ids.includes(INVITED_ID), "member who blocked the viewer must not appear");
  });

});
