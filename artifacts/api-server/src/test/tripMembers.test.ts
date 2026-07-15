/**
 * Integration tests for trip member add/remove routes.
 *
 * Covers:
 *   1.  Non-owner adding a member gets 403
 *   2.  Owner adding a new user returns 201 with correct body
 *   3.  Owner adding an already-existing member with the same role returns 200 idempotent
 *   4.  Owner adding a member with a different role updates and returns 200
 *   5.  Missing / invalid trip UUID returns 400
 *   6.  Missing / invalid userId in body returns 400
 *   7.  Invalid role value returns 400
 *   8.  Non-owner removing a member gets 403
 *   9.  Owner removing a member returns 200
 *  10.  Removing a member whose role is "owner" returns 400
 *  11.  Removing a user who is not on the trip returns 404
 *  12.  Invalid userId param on DELETE returns 400
 *  13.  Invalid tripId param on DELETE returns 400
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripMembers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";

// ── ID constants (valid UUIDs) ────────────────────────────────────────────────

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID = "cccccccc-0000-0000-0000-000000000003";
const TRIP_ID  = "33333333-0000-0000-0000-000000000001";

// ── Fake state ────────────────────────────────────────────────────────────────

interface TM { trip_id: string; user_id: string; role: string }
interface Trip { id: string; owner_id: string }

interface State {
  users:        Record<string, { id: string } | null>;
  trips:        Trip[];
  trip_members: TM[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trips: [
      { id: TRIP_ID, owner_id: ALICE_ID },
    ],
    trip_members: [],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any = null;
    let _updatePayload: any = null;

    const b: any = {
      select(_cols?: string) { return b; },
      insert(row: any) { _op = "insert"; _insertRow = row; return b; },
      update(patch: any) { _op = "update"; _updatePayload = patch; return b; },
      delete() { _op = "delete"; return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      maybeSingle() { return resolveOne(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "insert") return resolveInsert().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      if (_op === "update") {
        const m = matchedRows();
        return { data: m[0] ? { ...m[0], ..._updatePayload } : null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ?? null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows(), error: null };
    }

    async function resolveInsert() {
      const arr = getSource();
      arr.push({ ..._insertRow });
      return { data: null, error: null };
    }

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

// ── Server helpers ─────────────────────────────────────────────────────────────

function makeApp(state: State) {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", tripsRouter);
  return app;
}

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  const app = makeApp(state);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        port, state,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections();
          srv.close((e) => e ? rej(e) : res());
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function post(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE", headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── POST /api/trips/:tripId/members ───────────────────────────────────────────

describe("POST /api/trips/:tripId/members — add member", () => {
  it("1. non-owner gets 403", async () => {
    const s = baseState();
    // Bob is a regular member, not the owner
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "bob-tok", { userId: CAROL_ID });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    await close();
  });

  it("2. owner adding a new user returns 201 with correct body", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "added");
    assert.equal(r.body.tripId, TRIP_ID);
    assert.equal(r.body.userId, BOB_ID);
    assert.equal(r.body.role, "member");
    // Verify row was actually inserted into state
    const inserted = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.ok(inserted, "member row should be present in state after add");
    assert.equal(inserted!.role, "member");
    await close();
  });

  it("3. owner adding already-existing member with same role returns 200 idempotent", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "already_member");
    assert.equal(r.body.idempotent, true);
    assert.equal(r.body.role, "member");
    await close();
  });

  it("4. owner adding member with a different role updates and returns 200", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "updated");
    assert.equal(r.body.role, "member");
    // Role should be updated in state
    const row = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.equal(row?.role, "member");
    await close();
  });

  it("5. missing userId in body returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("5b. invalid (non-UUID) userId in body returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: "not-a-uuid" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("5c. invalid (non-UUID) tripId in path returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/bad-trip-id/members`, "alice-tok", { userId: BOB_ID });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("6. invalid role value returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "owner" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("7. owner cannot add themselves (returns 400)", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: ALICE_ID });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });
});

// ── DELETE /api/trips/:tripId/members/:userId ─────────────────────────────────

describe("DELETE /api/trips/:tripId/members/:userId — remove member", () => {
  it("8. non-owner removing a member gets 403", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    s.trip_members.push({ trip_id: TRIP_ID, user_id: CAROL_ID, role: "member" });
    const { port, close } = await startServer(s);
    // Bob (non-owner) tries to remove Carol
    const r = await del(port, `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "bob-tok");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    await close();
  });

  it("9. owner removing a member returns 200 and row is deleted", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "removed");
    assert.equal(r.body.tripId, TRIP_ID);
    assert.equal(r.body.userId, BOB_ID);
    // Verify row is gone from state
    const stillThere = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.equal(stillThere, undefined, "member row should be deleted from state");
    await close();
  });

  it("10. removing a member whose role is 'owner' returns 400", async () => {
    const s = baseState();
    // Bob has owner role on this trip (Alice is the actual trip.owner_id but Bob also has "owner" in trip_members)
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "owner" });
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("11. removing a user not on the trip returns 404", async () => {
    const s = baseState();
    // Carol is not a member of the trip
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "alice-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
    await close();
  });

  it("12. invalid userId param on DELETE returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/members/not-a-uuid`, "alice-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("13. invalid tripId param on DELETE returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/bad-trip-id/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });

  it("14. owner cannot remove themselves (returns 400)", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/members/${ALICE_ID}`, "alice-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    await close();
  });
});

// ── syncTripChatMembers wiring tests ──────────────────────────────────────────
//
// Strategy: extend the fake state with message_threads + message_thread_members,
// run the real syncTripChatMembers against it (fire-and-forget), flush two
// setImmediate ticks to let the promise settle, then inspect state.
//
// Failure tests use a client that rejects on `message_threads` access so the
// whole sync promise rejects — confirming the .catch() handler reaches
// req.log.error without altering the HTTP response.
// ─────────────────────────────────────────────────────────────────────────────

const THREAD_ID = "44444444-0000-0000-0000-000000000001";

interface MTMember { thread_id: string; user_id: string; role: string; left_at: string | null }
interface MThread  { id: string; thread_type: string; trip_id?: string; title?: string }

interface ExtState extends State {
  message_threads:        MThread[];
  message_thread_members: MTMember[];
}

function extBaseState(): ExtState {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trips: [
      { id: TRIP_ID, owner_id: ALICE_ID },
    ],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" },
    ],
    message_threads: [
      { id: THREAD_ID, thread_type: "trip", trip_id: TRIP_ID, title: "Test Trip" },
    ],
    message_thread_members: [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "owner", left_at: null },
    ],
  };
}

function makeFakeClientExt(state: ExtState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any   = null;
    let _updatePayload: any = null;
    let _singleMode = false;

    const b: any = {
      select(_cols?: string)       { return b; },
      insert(row: any)             { _op = "insert"; _insertRow = Array.isArray(row) ? row[0] : row; return b; },
      update(patch: any)           { _op = "update"; _updatePayload = patch; return b; },
      delete()                     { _op = "delete"; return b; },
      eq(col: string, val: any)    { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      maybeSingle()                { _singleMode = true; return resolveOne(); },
      single()                     { _singleMode = true; return resolveOne(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "insert") return resolveInsert().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] {
      if (!Object.prototype.hasOwnProperty.call(state, table)) {
        (state as any)[table] = [];
      }
      return (state as any)[table];
    }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      if (_op === "update") {
        const m = matchedRows();
        return { data: m[0] ? { ...m[0], ..._updatePayload } : null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ? { ...m[0] } : null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows().map((r: any) => ({ ...r })), error: null };
    }

    async function resolveInsert() {
      const arr = getSource();
      const newRow = { ..._insertRow };
      arr.push(newRow);
      return { data: _singleMode ? newRow : null, error: null };
    }

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

function makeSyncErrorClient(state: ExtState) {
  const base = makeFakeClientExt(state);
  return {
    from(table: string) {
      if (table === "message_threads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.reject(new Error("simulated chat sync failure")),
              }),
            }),
          }),
        };
      }
      return base.from(table);
    },
    auth: base.auth,
  };
}

async function flushMicrotasks() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

interface SyncLog { errors: Array<unknown[]> }

interface ExtTestServer { port: number; close: () => Promise<void> }

function makeAppExt(
  state: ExtState,
  clientFactory: (s: ExtState) => unknown,
  log?: SyncLog,
) {
  _setTestClient(clientFactory(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = {
      error: (...args: unknown[]) => { log?.errors.push(args); },
      info:  () => {},
      warn:  () => {},
    };
    next();
  });
  app.use("/api", tripsRouter);
  return app;
}

async function startServerExt(
  state: ExtState,
  clientFactory: (s: ExtState) => unknown,
  log?: SyncLog,
): Promise<ExtTestServer> {
  const app = makeAppExt(state, clientFactory, log);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

describe("syncTripChatMembers wiring — POST /members and DELETE /members/:userId", () => {
  it("15. sync called after POST insert: new member appears in thread_members with left_at=null", async () => {
    const s = extBaseState();
    const { port, close } = await startServerExt(s, makeFakeClientExt);

    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "added");

    await flushMicrotasks();

    const bobThread = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === BOB_ID,
    );
    assert.ok(bobThread, "syncTripChatMembers should have inserted Bob into message_thread_members");
    assert.equal(bobThread!.left_at, null, "Bob's thread membership should be active (left_at = null)");

    await close();
  });

  it("16. sync called after POST role-update: updated member's thread left_at cleared", async () => {
    const s = extBaseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited" });
    s.message_thread_members.push({
      thread_id: THREAD_ID,
      user_id: BOB_ID,
      role: "invited",
      left_at: "2024-01-01T00:00:00.000Z",
    });
    const { port, close } = await startServerExt(s, makeFakeClientExt);

    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 200, `expected 200 updated, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "updated");

    await flushMicrotasks();

    const bobThread = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === BOB_ID,
    );
    assert.ok(bobThread, "Bob's message_thread_members row should still exist");
    assert.equal(
      bobThread!.left_at,
      null,
      "syncTripChatMembers should have cleared Bob's left_at after he became an accepted member",
    );

    await close();
  });

  it("17. sync called after DELETE remove: removed member gets left_at set in thread", async () => {
    const s = extBaseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    s.message_thread_members.push({ thread_id: THREAD_ID, user_id: BOB_ID, role: "member", left_at: null });
    const { port, close } = await startServerExt(s, makeFakeClientExt);

    const r = await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "removed");

    await flushMicrotasks();

    const bobThread = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === BOB_ID,
    );
    assert.ok(bobThread, "Bob's thread_members row should remain (soft-remove)");
    assert.notEqual(
      bobThread!.left_at,
      null,
      "syncTripChatMembers should have set left_at for the removed member",
    );

    await close();
  });

  it("18. sync failure on POST does not change 201 response; req.log.error is called", async () => {
    const s = extBaseState();
    const log: SyncLog = { errors: [] };
    const { port, close } = await startServerExt(s, makeSyncErrorClient, log);

    const r = await post(port, `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: BOB_ID, role: "member" });
    assert.equal(r.status, 201, `route must still return 201 when sync fails, got ${r.status}`);
    assert.equal(r.body.status, "added");

    await flushMicrotasks();

    const hasSyncErr = log.errors.some(([, msg]) => msg === "syncTripChatMembers failed");
    assert.ok(hasSyncErr, "req.log.error should be called with 'syncTripChatMembers failed' when sync throws");

    await close();
  });

  it("19. sync failure on DELETE does not change 200 response; req.log.error is called", async () => {
    const s = extBaseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const log: SyncLog = { errors: [] };
    const { port, close } = await startServerExt(s, makeSyncErrorClient, log);

    const r = await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 200, `route must still return 200 when sync fails, got ${r.status}`);
    assert.equal(r.body.status, "removed");

    await flushMicrotasks();

    const hasSyncErr = log.errors.some(([, msg]) => msg === "syncTripChatMembers failed");
    assert.ok(hasSyncErr, "req.log.error should be called with 'syncTripChatMembers failed' when sync throws");

    await close();
  });
});
