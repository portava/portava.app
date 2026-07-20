/**
 * Failure-path tests for friend_requests status updates.
 *
 * Regression guard for schema drift: friends.ts/requests.ts used to write
 * responded_at/updated_at columns that did not exist live, and the Supabase
 * update error was ignored — accept/decline/cancel reported success while the
 * row never changed (PGRST204 silently swallowed). These tests inject an
 * update error into the fake client and assert every status-changing route
 * returns db_error instead of a success payload.
 *
 * Run: node --import tsx/esm --test src/test/friendRequestUpdateFailure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import requestsRouter from "../routes/requests.js";
import friendsRouter from "../routes/friends.js";

// ── Fake state ────────────────────────────────────────────────────────────────

interface FR { id: string; requester_id: string; recipient_id: string; status: string; created_at: string; responded_at?: string | null; updated_at?: string | null }

interface State {
  users: Record<string, { id: string } | null>;
  friend_requests: FR[];
  profiles: Array<{ id: string; handle: string; name: string; avatar_url: string | null }>;
  user_friendships: any[];
  /** tables whose update() should fail with a PGRST204-style error */
  failUpdateTables: Set<string>;
}

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const FR_ID    = "11111111-0000-0000-0000-000000000001";
const T1 = "2026-06-01T00:00:00Z";

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
    },
    friend_requests: [],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null },
    ],
    user_friendships: [],
    failUpdateTables: new Set(),
  };
}

const DRIFT_ERROR = {
  message: "Could not find the 'responded_at' column of 'friend_requests' in the schema cache",
  code: "PGRST204",
};

// ── Fake Supabase client (update can fail per-table) ─────────────────────────

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
      is(col: string, val: any) { filters.push((r: any) => val === null ? r[col] == null : r[col] === val); return b; },
      not() { return b; },
      or() { return b; },
      gte() { return b; },
      lte() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }
    async function resolveOne()  { return { data: matchedRows()[0] ?? null, error: null }; }
    async function resolveList() { return { data: matchedRows(), error: null }; }
    async function resolveUpdate() {
      if (state.failUpdateTables.has(table)) {
        return { data: null, error: DRIFT_ERROR };
      }
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

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", requestsRouter);
  app.use("/api", friendsRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, state, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
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

function pendingRequest(): FR {
  return { id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 };
}

function assertDbError(r: { status: number; body: any }, state: State) {
  assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, "db_error");
  assert.equal(state.friend_requests[0].status, "pending", "row must remain pending on failed update");
}

// ── requests.ts routes ────────────────────────────────────────────────────────

describe("requests.ts friend_request update failure surfaces db_error", () => {
  it("accept returns db_error and does not report friends", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");
      assertDbError(r, state);
      assert.equal(state.user_friendships.length, 0, "no friendship row on failed accept");
    } finally { await srv.close(); }
  });

  it("decline returns db_error", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/decline`, "alice-tok");
      assertDbError(r, state);
    } finally { await srv.close(); }
  });

  it("cancel returns db_error", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/cancel`, "bob-tok");
      assertDbError(r, state);
    } finally { await srv.close(); }
  });

  it("accept still succeeds when the update succeeds (control)", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/friend_request/${FR_ID}/accept`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(state.friend_requests[0].status, "accepted");
    } finally { await srv.close(); }
  });
});

// ── friends.ts routes ─────────────────────────────────────────────────────────

describe("friends.ts friend_request update failure surfaces db_error", () => {
  it("accept returns db_error and does not create a friendship", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/friend-requests/${FR_ID}/accept`, "alice-tok");
      assertDbError(r, state);
      assert.equal(state.user_friendships.length, 0, "no friendship row on failed accept");
    } finally { await srv.close(); }
  });

  it("decline returns db_error", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/friend-requests/${FR_ID}/decline`, "alice-tok");
      assertDbError(r, state);
    } finally { await srv.close(); }
  });

  it("cancel returns db_error", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/friend-requests/${FR_ID}/cancel`, "bob-tok");
      assertDbError(r, state);
    } finally { await srv.close(); }
  });

  it("send: reactivating a declined request returns db_error when the update fails", async () => {
    const state = baseState();
    state.friend_requests.push({ ...pendingRequest(), status: "declined" });
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/users/${ALICE_ID}/friend-request`, "bob-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.friend_requests[0].status, "declined", "row unchanged on failed reactivation");
    } finally { await srv.close(); }
  });

  // The auto-accept branch of POST /users/:userId/friend-request is reachable now:
  // the route lets the mutual-pending case through via canAcceptFriendRequest.

  it("send: mutual-pending auto-accepts and creates a friendship", async () => {
    const state = baseState();
    // Bob already sent Alice a pending request; Alice now sends one to Bob.
    state.friend_requests.push(pendingRequest());
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/users/${BOB_ID}/friend-request`, "alice-tok");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.status, "friends");
      assert.equal(r.body?.autoAccepted, true);
      assert.equal(r.body?.requestId, FR_ID);
      assert.equal(state.friend_requests[0].status, "accepted");
      assert.equal(state.user_friendships.length, 1, "friendship row created on auto-accept");
    } finally { await srv.close(); }
  });

  it("send: mutual-pending auto-accept returns db_error when the update fails", async () => {
    const state = baseState();
    state.friend_requests.push(pendingRequest());
    state.failUpdateTables.add("friend_requests");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/users/${BOB_ID}/friend-request`, "alice-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.friend_requests[0].status, "pending", "row unchanged on failed auto-accept");
      assert.equal(state.user_friendships.length, 0, "no friendship row on failed auto-accept");
    } finally { await srv.close(); }
  });
});
