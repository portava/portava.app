/**
 * Side-effect integration tests for DELETE /api/trips/:tripId/members/:userId
 *
 * The route is fire-and-forget for two post-removal operations:
 *   1. syncTripChatMembers  — sets left_at on the removed member's thread row
 *   2. revokeAccessForMember — strips the user from live-share allowed_member_ids
 *                              and logs an access_revoked event
 *
 * Strategy: run both functions against an extended fake client that supports all
 * the tables they write to (message_thread_members, trip_crew_location_sessions,
 * trip_crew_location_events). After the HTTP response resolves, flush two
 * setImmediate ticks so the fire-and-forget promises settle, then inspect state.
 *
 * Also confirms 403 (non-owner) and 404 (member not found) produce no side effects.
 *
 * Run: node --import tsx/esm --test src/test/deleteMemberSideEffects.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";

// ── ID constants ──────────────────────────────────────────────────────────────

const ALICE_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID     = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID   = "cccccccc-0000-0000-0000-000000000003";
const TRIP_ID    = "33333333-0000-0000-0000-000000000001";
const THREAD_ID  = "44444444-0000-0000-0000-000000000001";
const SESSION_ID = "55555555-0000-0000-0000-000000000001";

// ── State shape ───────────────────────────────────────────────────────────────

interface TM       { trip_id: string; user_id: string; role: string }
interface TripRow  { id: string; owner_id: string; title?: string; destination_city?: string }
interface MThread  { id: string; thread_type: string; trip_id?: string; title?: string }
interface MTMember { thread_id: string; user_id: string; role: string; left_at: string | null }
interface LiveSession {
  id: string; trip_id: string; user_id: string;
  status: string; allowed_member_ids: string[];
}
interface LocationEvent {
  trip_id: string; user_id: string; event_type: string; metadata: Record<string, unknown>;
}

interface State {
  users:                       Record<string, { id: string } | null>;
  trips:                       TripRow[];
  trip_members:                TM[];
  message_threads:             MThread[];
  message_thread_members:      MTMember[];
  trip_crew_location_sessions: LiveSession[];
  trip_crew_location_events:   LocationEvent[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trips: [
      { id: TRIP_ID, owner_id: ALICE_ID, title: "Summer Trip", destination_city: "Tokyo" },
    ],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner"  },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member" },
    ],
    // Pre-seed a thread so syncTripChatMembers finds it and skips the insert path.
    message_threads: [
      { id: THREAD_ID, thread_type: "trip", trip_id: TRIP_ID, title: "Summer Trip · Tokyo" },
    ],
    message_thread_members: [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "owner",  left_at: null },
      { thread_id: THREAD_ID, user_id: BOB_ID,   role: "member", left_at: null },
    ],
    // Alice has an active live-share session that lists Bob as an allowed viewer.
    trip_crew_location_sessions: [
      {
        id:                 SESSION_ID,
        trip_id:            TRIP_ID,
        user_id:            ALICE_ID,
        status:             "active",
        allowed_member_ids: [BOB_ID],
      },
    ],
    trip_crew_location_events: [],
  };
}

// ── Extended fake Supabase client ─────────────────────────────────────────────
// Supports all filter/mutation ops used by the route and its two side-effect
// helpers (syncTripChatMembers + revokeAccessForMember).

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any   = null;
    let _updatePayload: any = null;
    let _singleMode = false;

    const b: any = {
      select(_cols?: string)      { return b; },
      insert(row: any)            { _op = "insert"; _insertRow = Array.isArray(row) ? row[0] : row; return b; },
      update(patch: any)          { _op = "update"; _updatePayload = patch; return b; },
      delete()                    { _op = "delete"; return b; },
      eq(col: string, val: any)   { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      gt(col: string, val: any)   { filters.push((r: any) => r[col] > val); return b; },
      lt(col: string, val: any)   { filters.push((r: any) => r[col] < val); return b; },
      is(col: string, val: any) {
        if (val === null) {
          filters.push((r: any) => r[col] === null || r[col] === undefined);
        } else {
          filters.push((r: any) => r[col] === val);
        }
        return b;
      },
      maybeSingle() { _singleMode = true; return resolveOne(); },
      single()      { _singleMode = true; return resolveOne(); },
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
      return { data: m[0] ?? null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows(), error: null };
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

// ── Server / HTTP helpers ─────────────────────────────────────────────────────

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

async function del(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE", headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Flush two setImmediate ticks so fire-and-forget promises can settle. */
async function flushMicrotasks() {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("DELETE /api/trips/:tripId/members/:userId — side effects", () => {
  it("1. 200 happy path: HTTP response shape is correct", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);

    const r = await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status,  "removed");
    assert.equal(r.body.tripId,  TRIP_ID);
    assert.equal(r.body.userId,  BOB_ID);
    // DB row should be gone
    const stillThere = s.trip_members.find((m) => m.user_id === BOB_ID && m.trip_id === TRIP_ID);
    assert.equal(stillThere, undefined, "Bob's trip_members row should be deleted");

    await close();
  });

  it("2. syncTripChatMembers called: removed member gets left_at set in thread", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);

    await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    await flushMicrotasks();

    const bobRow = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === BOB_ID,
    );
    assert.ok(bobRow, "Bob's message_thread_members row should still exist (soft-remove)");
    assert.notEqual(
      bobRow!.left_at, null,
      "syncTripChatMembers should have set left_at for the removed member",
    );

    // Alice stays active in the thread
    const aliceRow = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === ALICE_ID,
    );
    assert.equal(aliceRow?.left_at, null, "Alice's thread membership should be unaffected");

    await close();
  });

  it("3. revokeAccessForMember called: removed member stripped from live-share session", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);

    await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    await flushMicrotasks();

    const session = s.trip_crew_location_sessions.find((sess) => sess.id === SESSION_ID);
    assert.ok(session, "live-share session should still exist");
    assert.ok(
      !session!.allowed_member_ids.includes(BOB_ID),
      "revokeAccessForMember should have removed BOB_ID from allowed_member_ids",
    );

    await close();
  });

  it("4. revokeAccessForMember called: access_revoked event logged with correct args", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);

    await del(port, `/api/trips/${TRIP_ID}/members/${BOB_ID}`, "alice-tok");
    await flushMicrotasks();

    const evt = s.trip_crew_location_events.find(
      (e) => e.user_id === BOB_ID && e.event_type === "access_revoked",
    );
    assert.ok(evt, "revokeAccessForMember should log an access_revoked event for the removed user");
    assert.equal(evt!.trip_id, TRIP_ID,
      "access_revoked event should carry the correct tripId");
    assert.equal((evt!.metadata as any).reason, "member_removed",
      "access_revoked event metadata.reason should be 'member_removed'");

    await close();
  });

  it("5. 403 when caller is not trip owner — no side effects run", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP_ID, user_id: CAROL_ID, role: "member" });
    const { port, close } = await startServer(s);

    const r = await del(port, `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "bob-tok");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");

    await flushMicrotasks();

    assert.equal(s.trip_crew_location_events.length, 0, "no location events should be logged on 403");
    const bobThread = s.message_thread_members.find(
      (m) => m.thread_id === THREAD_ID && m.user_id === BOB_ID,
    );
    assert.equal(bobThread?.left_at, null, "thread membership should be unchanged on 403");

    await close();
  });

  it("6. 404 when member not found — no side effects run", async () => {
    const s = baseState();
    // Carol is not on the trip at all
    const { port, close } = await startServer(s);

    const r = await del(port, `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "alice-tok");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");

    await flushMicrotasks();

    assert.equal(s.trip_crew_location_events.length, 0, "no location events should be logged on 404");

    await close();
  });
});
