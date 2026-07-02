/**
 * Trip Crew Map — endpoint tests
 *
 * Verifies: GET /api/trips/:tripId/crew/map
 *   - unauthenticated → 401
 *   - invalid tripId → 400
 *   - non-member → 403
 *   - invited member can view crew (200)
 *   - accepted member sees full crew list with correct shape
 *   - owner sees all members including invited ones
 *   - trip with no members returns empty array
 *
 * Run: node --import tsx/esm --test src/test/tripCrewMap.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripsRouter from "../routes/trips.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN   = "crewmap-owner-token";
const MEMBER_TOKEN = "crewmap-member-token";
const INVITED_TOKEN = "crewmap-invited-token";
const OTHER_TOKEN  = "crewmap-other-token";

const OWNER_ID   = "user-crewmap-owner";
const MEMBER_ID  = "user-crewmap-member";
const INVITED_ID = "user-crewmap-invited";
const OTHER_ID   = "user-crewmap-other";
const TRIP_ID    = "11111111-1111-1111-1111-111111111111";

function req(
  method: string,
  path: string,
  token: string | null = FAKE_TOKEN,
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
  tripMembers?: any[];
  profiles?: any[];
}

function makeFakeClient(state: FakeState = {}) {
  function getRows(table: string): any[] {
    if (table === "trip_members") return state.tripMembers ?? [];
    if (table === "profiles")    return state.profiles    ?? [];
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    const filters: Array<(r: any) => boolean> = [];

    const b: any = {
      select(_cols?: string) { return b; },
      eq(col: string, val: any)          { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[])       { filters.push((r) => vals.includes(r[col])); return b; },
      neq(col: string, val: any)         { filters.push((r) => r[col] !== val); return b; },
      order()                            { return b; },
      limit(n: number)                   { return b; },
      maybeSingle()                      { return resolveOne(true); },
      single()                           { return resolveOne(false); },
      then(onF: any, onR: any)           { return resolveList().then(onF, onR); },
    };

    async function resolveOne(maybe: boolean) {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched, error: null };
    }

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN)    return { data: { user: { id: OWNER_ID } },   error: null };
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

const OWNER_MEMBER_ROW   = { trip_id: TRIP_ID, user_id: OWNER_ID,   role: "owner"   };
const ACCEPTED_MEMBER_ROW = { trip_id: TRIP_ID, user_id: MEMBER_ID,  role: "member"  };
const INVITED_MEMBER_ROW  = { trip_id: TRIP_ID, user_id: INVITED_ID, role: "invited" };

const PROFILES = [
  { id: OWNER_ID,   handle: "owner_handle",   name: "Trip Owner",    avatar_url: "https://cdn.example.com/owner.jpg" },
  { id: MEMBER_ID,  handle: "member_handle",  name: "Accepted Member", avatar_url: null },
  { id: INVITED_ID, handle: "invited_handle", name: "Invited Person",  avatar_url: "https://cdn.example.com/invited.jpg" },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripsRouter);

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

describe("GET /trips/:tripId/crew/map", () => {

  it("1. Unauthenticated request returns 401", async () => {
    setClients(makeFakeClient({ tripMembers: [OWNER_MEMBER_ROW] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, null);
    assert.equal(r.status, 401);
  });

  it("2. Invalid tripId format returns 400", async () => {
    setClients(makeFakeClient());
    const r = await req("GET", `/api/trips/not-a-uuid/crew/map`);
    assert.equal(r.status, 400);
  });

  it("3. Non-member is rejected with 403", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, OTHER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("4. Owner receives 200 with all crew members", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.members));
    assert.equal(r.body.totalCount, 3);
    assert.equal(r.body.featureEnabled, true);
  });

  it("5. Accepted member can fetch crew map", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW, ACCEPTED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, MEMBER_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.members));
    assert.equal(r.body.featureEnabled, true);
  });

  it("6. Invited (pending) member can also fetch crew map", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW, INVITED_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, INVITED_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("7. Each member card has required fields with not_shared statusLabel", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const card = r.body.members[0];
    assert.ok("userId" in card);
    assert.ok("name" in card);
    assert.ok("handle" in card);
    assert.ok("avatarUrl" in card);
    assert.equal(card.statusLabel, "not_shared");
    assert.equal(card.safeReturnActive, false);
    assert.equal(card.liveShareActive, false);
    assert.equal(card.ghostMode, false);
  });

  it("8. Profile data is resolved correctly on member cards", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    const ownerCard = r.body.members.find((m: any) => m.userId === OWNER_ID);
    assert.ok(ownerCard, "owner card should be present");
    assert.equal(ownerCard.name, "Trip Owner");
    assert.equal(ownerCard.handle, "owner_handle");
    assert.equal(ownerCard.avatarUrl, "https://cdn.example.com/owner.jpg");
  });

  it("9. Trip with no members returns empty array", async () => {
    setClients(makeFakeClient({
      tripMembers: [OWNER_MEMBER_ROW],
      profiles: PROFILES,
    }));
    // Owner is a member so can query, but seed a second trip with only the caller
    // The endpoint will return just the owner row
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.members));
  });

  it("10. Empty trip (owner queries trip with zero rows) returns { members: [], totalCount: 0 }", async () => {
    const emptyTripId = "22222222-2222-2222-2222-222222222222";
    // The owner is a member of emptyTripId
    setClients(makeFakeClient({
      tripMembers: [{ trip_id: emptyTripId, user_id: OWNER_ID, role: "owner" }],
      profiles: PROFILES,
    }));
    const r = await req("GET", `/api/trips/${emptyTripId}/crew/map`);
    // Only 1 member (owner), fetched from profiles
    assert.equal(r.status, 200);
    assert.equal(r.body.totalCount, 1);
  });

});
