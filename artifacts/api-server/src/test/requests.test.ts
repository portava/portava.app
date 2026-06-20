/**
 * Integration tests for GET /api/me/requests and GET /api/me/requests/count.
 *
 * Uses node:test + node:assert (no vitest/supertest required).
 * A real Express server starts on a random port per test suite; fetch() makes HTTP calls.
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

interface State {
  users: Record<string, { id: string } | null>;
  friend_requests: FR[];
  circle_invites: CI[];
  trip_members: TM[];
  trips: Trip[];
  profiles: Profile[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: "alice-id" },
      "bob-tok":   { id: "bob-id" },
    },
    friend_requests: [],
    circle_invites:  [],
    trip_members:    [],
    trips:           [],
    profiles: [
      { id: "alice-id", handle: "alice", name: "Alice", avatar_url: null },
      { id: "bob-id",   handle: "bob",   name: "Bob",   avatar_url: null },
    ],
  };
}

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const builder: any = {
      select() { return builder; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function getSource(): any[] {
      switch (table) {
        case "friend_requests": return state.friend_requests;
        case "circle_invites":  return state.circle_invites;
        case "trip_members":    return state.trip_members;
        case "trips":           return state.trips;
        case "profiles":        return state.profiles;
        default:                return [];
      }
    }

    function matchedRows() {
      return getSource().filter((r) => filters.every((f) => f(r)));
    }

    async function resolveOne() {
      return { data: matchedRows()[0] ?? null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows(), error: null };
    }

    return builder;
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

function makeApp(state: State) {
  const client = makeFakeClient(state);
  _setTestClient(client, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", requestsRouter);
  return app;
}

interface TestServer { port: number; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  const app = makeApp(state);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))) });
    });
    srv.on("error", reject);
  });
}

async function call(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const AT = "2026-06-20T00:00:00Z";

// ── GET /api/me/requests ─────────────────────────────────────────────────────

describe("GET /api/me/requests", () => {
  it("returns 401 without auth token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await call(srv.port, "/api/me/requests");
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "unauthenticated");
    } finally { await srv.close(); }
  });

  it("returns 401 with an invalid token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await call(srv.port, "/api/me/requests", "bad-tok");
      assert.equal(r.status, 401);
    } finally { await srv.close(); }
  });

  it("returns empty items array when no requests exist", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.items));
      assert.equal(r.body.items.length, 0);
    } finally { await srv.close(); }
  });

  it("surfaces an incoming friend request for the recipient", async () => {
    const state = baseState();
    state.friend_requests.push({ id: "fr-1", requester_id: "bob-id", recipient_id: "alice-id", status: "pending", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      const item = r.body.items[0];
      assert.equal(item.type, "friend_request");
      assert.equal(item.direction, "incoming");
      assert.equal(item.id, "fr-1");
      assert.equal(item.actor?.handle, "bob");
    } finally { await srv.close(); }
  });

  it("surfaces an outgoing friend request for the requester", async () => {
    const state = baseState();
    state.friend_requests.push({ id: "fr-2", requester_id: "alice-id", recipient_id: "bob-id", status: "pending", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      assert.equal(r.body.items[0].direction, "outgoing");
      assert.equal(r.body.items[0].actor?.handle, "bob");
    } finally { await srv.close(); }
  });

  it("returns incoming circle invite for the recipient", async () => {
    const state = baseState();
    state.circle_invites.push({ id: "ci-1", owner_id: "bob-id", recipient_id: "alice-id", status: "pending", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      const item = r.body.items[0];
      assert.equal(item.type, "circle_invite");
      assert.equal(item.direction, "incoming");
    } finally { await srv.close(); }
  });

  it("returns incoming trip invite with trip name for the invitee", async () => {
    const state = baseState();
    state.trips.push({ id: "trip-1", title: "Bali Adventure" });
    state.trip_members.push({ trip_id: "trip-1", user_id: "alice-id", role: "invited", created_at: AT });
    state.trip_members.push({ trip_id: "trip-1", user_id: "bob-id", role: "owner", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      const item = r.body.items[0];
      assert.equal(item.type, "trip_invite");
      assert.equal(item.direction, "incoming");
      assert.equal(item.targetName, "Bali Adventure");
      assert.equal(item.actor?.handle, "bob");
    } finally { await srv.close(); }
  });

  it("user sees only their own requests — accepted/declined items filtered out", async () => {
    const state = baseState();
    state.friend_requests.push({ id: "fr-a", requester_id: "bob-id", recipient_id: "alice-id", status: "accepted", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 0);
    } finally { await srv.close(); }
  });
});

// ── GET /api/me/requests/count ───────────────────────────────────────────────

describe("GET /api/me/requests/count", () => {
  it("returns 401 without auth token", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await call(srv.port, "/api/me/requests/count");
      assert.equal(r.status, 401);
    } finally { await srv.close(); }
  });

  it("returns count 0 when no incoming requests", async () => {
    const srv = await startServer(baseState());
    try {
      const r = await call(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 0);
    } finally { await srv.close(); }
  });

  it("counts all incoming pending request types", async () => {
    const state = baseState();
    state.friend_requests.push({ id: "fr-1", requester_id: "bob-id", recipient_id: "alice-id", status: "pending", created_at: AT });
    state.circle_invites.push({ id: "ci-1", owner_id: "bob-id", recipient_id: "alice-id", status: "pending", created_at: AT });
    state.trips.push({ id: "trip-1", title: "Trip" });
    state.trip_members.push({ trip_id: "trip-1", user_id: "alice-id", role: "invited", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 3);
    } finally { await srv.close(); }
  });

  it("does not count outgoing requests in the badge count", async () => {
    const state = baseState();
    state.friend_requests.push({ id: "fr-out", requester_id: "alice-id", recipient_id: "bob-id", status: "pending", created_at: AT });
    const srv = await startServer(state);
    try {
      const r = await call(srv.port, "/api/me/requests/count", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 0);
    } finally { await srv.close(); }
  });
});
