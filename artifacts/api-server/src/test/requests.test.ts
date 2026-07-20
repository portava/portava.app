/**
 * Integration tests for the unified Request Inbox routes.
 *
 * Covers:
 *  - GET  /api/me/requests       — all-status list (friend, circle, trip)
 *  - GET  /api/me/requests/count — incoming-pending badge count
 *  - POST /api/me/requests/friend_request/:id/accept|decline|cancel
 *  - POST /api/me/requests/circle_invite/:id/accept|decline
 *  - POST /api/me/requests/trip_invite/:tripId/accept|decline|cancel
 *  - Count transitions after each action type
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest needed).
 * A real Express server starts on a random port per test; fetch() issues HTTP calls.
 * The fake Supabase client is injected via http.ts's _setTestClient test slot.
 *
 * Run: node --import tsx/esm --test src/test/requests.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import requestsRouter from "../routes/requests.js";

// ── Fake state ────────────────────────────────────────────────────────────────

interface FR { id: string; requester_id: string; recipient_id: string; status: string; created_at: string }
interface CI { id: string; owner_id: string; recipient_id: string; status: string; created_at: string }
interface TM { trip_id: string; user_id: string; role: string; created_at: string }
interface Trip { id: string; title: string }
interface Profile { id: string; handle: string; name: string; avatar_url: string | null }
interface UF { user_a: string; user_b: string; accepted_request_id: string; created_at: string }
interface CM { user_id: string; other_id: string; created_at: string }

interface State {
  users: Record<string, { id: string } | null>;
  friend_requests:    FR[];
  circle_invites:     CI[];
  trip_members:       TM[];
  trips:              Trip[];
  profiles:           Profile[];
  user_friendships:   UF[];
  circle_memberships: CM[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    friend_requests:    [],
    circle_invites:     [],
    trip_members:       [],
    trips:              [],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null },
      { id: CAROL_ID, handle: "carol", name: "Carol", avatar_url: null },
    ],
    user_friendships:   [],
    circle_memberships: [],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
// Supports select/update/delete/upsert with mutable in-memory state.

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" = "select";
    let _updatePayload: any = null;

    const b: any = {
      select(_sel?: string) { return b; },

      update(changes: any) { _op = "update"; _updatePayload = changes; return b; },

      delete() { _op = "delete"; return b; },

      upsert(row: any) {
        let source: any[] = (state as any)[table];
        if (!source) { source = []; (state as any)[table] = source; }
        source.push(row);
        return Promise.resolve({ data: null, error: null });
      },

      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      gt(col: string, val: any) { filters.push((r: any) => r[col] > val); return b; },
      gte(col: string, val: any) { filters.push((r: any) => r[col] >= val); return b; },
      lt(col: string, val: any) { filters.push((r: any) => r[col] < val); return b; },
      lte(col: string, val: any) { filters.push((r: any) => r[col] <= val); return b; },
      not(col: string, op: string, val: any) {
        if (op === 'is') filters.push((r: any) => r[col] !== val);
        else if (op === 'in') filters.push((r: any) => !(val as any[]).includes(r[col]));
        else filters.push((r: any) => r[col] !== val);
        return b;
      },
      is(col: string, val: any) {
        if (val === null) filters.push((r: any) => r[col] == null);
        else filters.push((r: any) => r[col] === val);
        return b;
      },
      or(_expr: string) {
        // No-op: unknown tables return empty; complex or() expressions not needed in test state.
        return b;
      },
      ilike(col: string, pat: string) {
        const prefix = pat.replace(/%/g, '').toLowerCase();
        filters.push((r: any) => String(r[col] ?? '').toLowerCase().startsWith(prefix));
        return b;
      },
      order()  { return b; },
      limit()  { return b; },
      range()  { return b; },

      maybeSingle() { return resolveOne(); },
      single()      { return resolveOne(); },

      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] {
      return (state as any)[table] ?? [];
    }
    function matchedRows() {
      return getSource().filter((r: any) => filters.every((f) => f(r)));
    }
    async function resolveOne()   { return { data: matchedRows()[0] ?? null, error: null }; }
    async function resolveList()  { return { data: matchedRows(),             error: null }; }
    async function resolveUpdate() {
      for (const row of getSource()) {
        if (filters.every((f) => f(row))) Object.assign(row, _updatePayload);
      }
      return { data: null, error: null };
    }
    async function resolveDelete() {
      (state as any)[table] = getSource().filter((r: any) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Server helpers ────────────────────────────────────────────────────────────

function makeApp(state: State) {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", requestsRouter);
  return app;
}

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  const app = makeApp(state);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, state, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const T1 = "2026-06-01T00:00:00Z";
const T2 = "2026-06-02T00:00:00Z"; // newer

// All IDs must be valid UUIDs — isUuid() guards are present in the cancel route
const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID = "cccccccc-0000-0000-0000-000000000003";
const FR_ID    = "11111111-0000-0000-0000-000000000001";
const CI_ID    = "22222222-0000-0000-0000-000000000002";
const TRIP_ID  = "33333333-0000-0000-0000-000000000003";

// ── GET /api/me/requests ──────────────────────────────────────────────────────

describe("GET /api/me/requests", () => {
  it("returns 401 without auth token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await get(srv.port, "/api/me/requests");
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthenticated");
    } finally { await srv.close(); }
  });

  it("returns 401 with an invalid token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await get(srv.port, "/api/me/requests", "bad-tok");
      assert.equal(r.status, 401);
    } finally { await srv.close(); }
  });

  it("returns empty items array when no requests exist", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.items));
      assert.equal(r.body.items.length, 0);
    } finally { await srv.close(); }
  });

  it("surfaces an incoming friend request for the recipient", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      const item = r.body.items[0];
      assert.equal(item.type,      "friend_request");
      assert.equal(item.direction, "incoming");
      assert.equal(item.id,        FR_ID);
      assert.equal(item.actor?.handle, "bob");
    } finally { await srv.close(); }
  });

  it("surfaces an outgoing friend request for the requester", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items[0].direction,    "outgoing");
      assert.equal(r.body.items[0].actor?.handle, "bob");
    } finally { await srv.close(); }
  });

  it("returns incoming circle invite for the recipient", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items[0].type,      "circle_invite");
      assert.equal(r.body.items[0].direction, "incoming");
    } finally { await srv.close(); }
  });

  it("returns incoming trip invite with trip name and owner as actor", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali Adventure" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID,   role: "owner",   created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      const item = r.body.items[0];
      assert.equal(item.type,             "trip_invite");
      assert.equal(item.direction,        "incoming");
      assert.equal(item.targetName,       "Bali Adventure");
      assert.equal(item.actor?.handle,    "bob");
    } finally { await srv.close(); }
  });

  it("returns accepted friend request — all statuses included", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "accepted", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      assert.equal(r.body.items[0].status, "accepted");
    } finally { await srv.close(); }
  });

  it("returns outgoing trip invite for trip owner (actor = invitee)", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Tokyo Run" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner",   created_at: T1 });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID,   role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      const item = r.body.items[0];
      assert.equal(item.type,          "trip_invite");
      assert.equal(item.direction,     "outgoing");
      assert.equal(item.targetName,    "Tokyo Run");
      assert.equal(item.actor?.handle, "bob");
      assert.ok(item.id.includes(TRIP_ID), "compound id includes tripId");
    } finally { await srv.close(); }
  });

  it("sorts items globally newest-first", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    state.circle_invites.push({ id: CI_ID,  owner_id: BOB_ID,    recipient_id: ALICE_ID, status: "pending", created_at: T2 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 2);
      assert.equal(r.body.items[0].type, "circle_invite",  "newer circle invite comes first");
      assert.equal(r.body.items[1].type, "friend_request", "older friend request comes second");
    } finally { await srv.close(); }
  });
});

// ── GET /api/me/requests/count ────────────────────────────────────────────────

describe("GET /api/me/requests/count", () => {
  it("returns 401 without auth token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await get(srv.port, "/api/me/requests/count");
      assert.equal(r.status, 401);
    } finally { await srv.close(); }
  });

  it("returns count 0 when no incoming requests", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 0);
    } finally { await srv.close(); }
  });

  it("counts all incoming pending types", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID,  requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    state.circle_invites.push({ id: CI_ID,   owner_id: BOB_ID,    recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    state.trips.push({ id: TRIP_ID, title: "Trip" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 3);
    } finally { await srv.close(); }
  });

  it("does not count outgoing requests in the badge count", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 0);
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/friend_request/:id/accept ───────────────────────────────

describe("POST /me/requests/friend_request/:id/accept", () => {
  it("recipient accepts → status becomes accepted and friendship is created", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "friends");
      assert.equal(state.friend_requests[0].status, "accepted", "status mutated in state");
      assert.equal(state.user_friendships.length, 1, "friendship row created");
      assert.equal(state.user_friendships[0].accepted_request_id, FR_ID);
    } finally { await srv.close(); }
  });

  it("requester cannot accept their own request (403)", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.friend_requests[0].status, "pending", "status unchanged");
      assert.equal(state.user_friendships.length, 0, "no friendship created");
    } finally { await srv.close(); }
  });

  it("cannot accept an already-accepted request (400)", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "accepted", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/friend_request/:id/decline ─────────────────────────────

describe("POST /me/requests/friend_request/:id/decline", () => {
  it("recipient declines → status becomes declined", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/decline`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
      assert.equal(state.friend_requests[0].status, "declined");
    } finally { await srv.close(); }
  });

  it("requester cannot decline (only recipient can) → 403", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/decline`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.friend_requests[0].status, "pending");
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/friend_request/:id/cancel ──────────────────────────────

describe("POST /me/requests/friend_request/:id/cancel", () => {
  it("requester cancels → status becomes cancelled", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/cancel`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
      assert.equal(state.friend_requests[0].status, "cancelled");
    } finally { await srv.close(); }
  });

  it("recipient cannot cancel (only requester can) → 403", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/cancel`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.friend_requests[0].status, "pending");
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/circle_invite/:id/accept ───────────────────────────────

describe("POST /me/requests/circle_invite/:id/accept", () => {
  it("recipient accepts → status accepted and circle_membership created", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/accept`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "accepted");
      assert.equal(r.body.ownerId, BOB_ID);
      assert.equal(state.circle_invites[0].status, "accepted");
      assert.equal(state.circle_memberships.length, 1, "membership created");
      assert.equal(state.circle_memberships[0].user_id,  BOB_ID);
      assert.equal(state.circle_memberships[0].other_id, ALICE_ID);
    } finally { await srv.close(); }
  });

  it("non-recipient cannot accept (403)", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      // alice is the OWNER; she tries to accept her own invite — not allowed
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/accept`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.circle_memberships.length, 0);
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/circle_invite/:id/cancel ───────────────────────────────

describe("POST /me/requests/circle_invite/:id/cancel", () => {
  it("owner cancels their outgoing invite → status becomes cancelled", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/cancel`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
      assert.equal(state.circle_invites[0].status, "cancelled");
    } finally { await srv.close(); }
  });

  it("recipient cannot cancel a circle invite they received (403)", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/cancel`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.circle_invites[0].status, "pending");
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/circle_invite/:id/decline ──────────────────────────────

describe("POST /me/requests/circle_invite/:id/decline", () => {
  it("recipient declines → status becomes declined", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/decline`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
      assert.equal(state.circle_invites[0].status, "declined");
    } finally { await srv.close(); }
  });

  it("owner cannot decline their own invite (403)", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/decline`, "alice-tok");
      assert.equal(r.status, 403);
      assert.equal(state.circle_invites[0].status, "pending");
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/trip_invite/:tripId/accept ─────────────────────────────

describe("POST /me/requests/trip_invite/:tripId/accept", () => {
  it("invitee accepts → role becomes member", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID,   role: "owner",   created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/accept`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "member");
      const tm = state.trip_members.find((m) => m.trip_id === TRIP_ID && m.user_id === ALICE_ID);
      assert.equal(tm?.role, "member", "role updated in state");
    } finally { await srv.close(); }
  });

  it("non-invitee cannot accept (no row → 404)", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    // alice is NOT a trip_member at all — carol is invited
    state.trip_members.push({ trip_id: TRIP_ID, user_id: CAROL_ID, role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/accept`, "alice-tok");
      assert.equal(r.status, 404);
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/trip_invite/:tripId/decline ────────────────────────────

describe("POST /me/requests/trip_invite/:tripId/decline", () => {
  it("invitee declines → trip_members row is deleted", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/decline`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
      const remaining = state.trip_members.filter((m) => m.trip_id === TRIP_ID && m.user_id === ALICE_ID);
      assert.equal(remaining.length, 0, "invite row deleted");
    } finally { await srv.close(); }
  });

  it("non-invitee cannot decline (no row → 404)", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/decline`, "alice-tok");
      assert.equal(r.status, 404);
    } finally { await srv.close(); }
  });
});

// ── POST /me/requests/trip_invite/:tripId/cancel ─────────────────────────────

describe("POST /me/requests/trip_invite/:tripId/cancel", () => {
  it("trip owner cancels invite → invitee row is deleted", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner",   created_at: T1 });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID,   role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/cancel`, "alice-tok", { inviteeId: BOB_ID });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
      const remaining = state.trip_members.filter((m) => m.trip_id === TRIP_ID && m.user_id === BOB_ID);
      assert.equal(remaining.length, 0, "invitee row deleted");
    } finally { await srv.close(); }
  });

  it("non-owner cannot cancel a trip invite (403)", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    // alice is a member, not owner
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "member",  created_at: T1 });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID,   role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/cancel`, "alice-tok", { inviteeId: BOB_ID });
      assert.equal(r.status, 403);
      const remaining = state.trip_members.filter((m) => m.user_id === BOB_ID);
      assert.equal(remaining.length, 1, "invitee row untouched");
    } finally { await srv.close(); }
  });

  it("missing inviteeId returns 400", async () => {
    const state = baseState();
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", created_at: T1 });
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/cancel`, "alice-tok");
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });
});

// ── Count transitions after actions ──────────────────────────────────────────

describe("count transitions after actions", () => {
  it("accepting a friend request removes it from the badge count", async () => {
    const state = baseState();
    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const before = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(before.body.count, 1);

      await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");

      const after = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(after.body.count, 0, "badge drops to 0 after accept");
    } finally { await srv.close(); }
  });

  it("declining a circle invite removes it from the badge count", async () => {
    const state = baseState();
    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
    const srv = await startServer(state);
    try {
      const before = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(before.body.count, 1);

      await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/decline`, "alice-tok");

      const after = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(after.body.count, 0, "badge drops to 0 after decline");
    } finally { await srv.close(); }
  });

  it("declining a trip invite removes it from the badge count", async () => {
    const state = baseState();
    state.trips.push({ id: TRIP_ID, title: "Bali" });
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
    const srv = await startServer(state);
    try {
      const before = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(before.body.count, 1);

      await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/decline`, "alice-tok");

      const after = await get(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(after.body.count, 0, "badge drops to 0 after decline");
    } finally { await srv.close(); }
  });
});
