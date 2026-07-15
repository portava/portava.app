/**
 * Integration tests for trip invite accept/decline routes.
 *
 * Covers:
 *   POST /api/trips/:tripId/accept-invite
 *   POST /api/trips/:tripId/decline-invite
 *
 *  1.  No auth header → 401 (accept)
 *  2.  Invalid token → 401 (accept)
 *  3.  Invalid tripId → 400 (accept)
 *  4.  No invitation row for user → 404 (accept)
 *  5.  Invited user accepts → 200, role transitions to "member" in state
 *  6.  Already-member user tries to accept → 400 invalid_payload
 *  7.  No auth header → 401 (decline)
 *  8.  Invalid token → 401 (decline)
 *  9.  Invalid tripId → 400 (decline)
 * 10.  No invitation row for user → 404 (decline)
 * 11.  Invited user declines → 200, row deleted from state
 * 12.  Already-member user tries to decline → 400 invalid_payload
 * 13.  Already-declined (row deleted) user tries to re-decline → 404
 * 14.  Already-declined (row deleted) user tries to accept → 404
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripInviteRespond.test.ts
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
const TRIP_ID  = "33333333-0000-0000-0000-000000000001";

// ── Fake state ────────────────────────────────────────────────────────────────

interface TM { trip_id: string; user_id: string; role: string }
interface Trip { id: string; owner_id: string; title: string }

interface State {
  users:        Record<string, { id: string } | null>;
  trips:        Trip[];
  trip_members: TM[];
  profiles:     Array<{ id: string; display_name?: string; expo_push_token?: string }>;
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
    },
    trips: [
      { id: TRIP_ID, owner_id: ALICE_ID, title: "Beach Trip" },
    ],
    trip_members: [],
    profiles: [
      { id: ALICE_ID, display_name: "Alice" },
      { id: BOB_ID,   display_name: "Bob" },
    ],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _updatePayload: any = null;

    const b: any = {
      select(_cols?: string) { return b; },
      update(patch: any) { _op = "update"; _updatePayload = patch; return b; },
      delete() { _op = "delete"; return b; },
      insert(row: any) { _op = "insert"; return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "insert") return Promise.resolve({ data: null, error: null }).then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      const m = matchedRows();
      return { data: m[0] ? { ...m[0] } : null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows().map((r) => ({ ...r })), error: null };
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

async function post(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── POST /api/trips/:tripId/accept-invite ─────────────────────────────────────

describe("POST /api/trips/:tripId/accept-invite", () => {
  it("1. missing Authorization header returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`);
    assert.equal(r.status, 401);
    await close();
  });

  it("2. invalid/expired token returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`, "bad-token");
    assert.equal(r.status, 401);
    await close();
  });

  it("3. invalid tripId format returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/not-a-uuid/accept-invite`, "bob-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    await close();
  });

  it("4. user with no invitation row returns 404", async () => {
    const s = baseState();
    // Bob has no trip_members row at all
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`, "bob-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
    await close();
  });

  it("5. invited user accepts — returns 200 and role transitions to 'member' in state", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`, "bob-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body?.status, "accepted");
    assert.equal(r.body?.tripId, TRIP_ID);
    assert.equal(r.body?.role, "member");
    // Verify role was updated in state
    const row = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.ok(row, "membership row should still exist after accept");
    assert.equal(row!.role, "member");
    await close();
  });

  it("6. already-member user tries to accept — returns 400 invalid_payload", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`, "bob-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    // State must be unchanged
    const row = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.equal(row?.role, "member", "role should remain 'member' — no side effects");
    await close();
  });
});

// ── POST /api/trips/:tripId/decline-invite ────────────────────────────────────

describe("POST /api/trips/:tripId/decline-invite", () => {
  it("7. missing Authorization header returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`);
    assert.equal(r.status, 401);
    await close();
  });

  it("8. invalid/expired token returns 401", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`, "bad-token");
    assert.equal(r.status, 401);
    await close();
  });

  it("9. invalid tripId format returns 400", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/not-a-uuid/decline-invite`, "bob-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    await close();
  });

  it("10. user with no invitation row returns 404", async () => {
    const s = baseState();
    // Bob has no trip_members row
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`, "bob-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
    await close();
  });

  it("11. invited user declines — returns 200 and row is deleted from state", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`, "bob-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body?.status, "declined");
    assert.equal(r.body?.tripId, TRIP_ID);
    // Verify row was deleted
    const row = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.equal(row, undefined, "membership row should be deleted after decline");
    await close();
  });

  it("12. already-member user tries to decline — returns 400 invalid_payload, no side effects", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`, "bob-tok");
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    // Row must remain untouched
    const row = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.ok(row, "row should still exist — no side effects");
    assert.equal(row!.role, "member");
    await close();
  });

  it("13. re-decline after row already deleted returns 404", async () => {
    const s = baseState();
    // Simulate a previous decline having removed the row — Bob has no row at all
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/decline-invite`, "bob-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
    await close();
  });

  it("14. accept after row deleted (post-decline) returns 404", async () => {
    const s = baseState();
    // Bob declined previously — row is gone
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/accept-invite`, "bob-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
    await close();
  });
});
