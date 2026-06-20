/**
 * Backend tests for group chat endpoints.
 *
 * Covers:
 *   GET /api/trips/:tripId/chat     — create/fetch trip group thread
 *   GET /api/circles/:ownerId/chat  — create/fetch circle group thread
 *   GET /api/me/threads             — left_at filtering, new thread fields
 *   GET /api/threads/:id/messages   — left member cannot read
 *   POST /api/threads/:id/messages  — left member cannot send
 *
 * Runtime: node:test + node:assert/strict.
 * A real Express server starts on a random port; fetch() issues HTTP calls.
 * The fake Supabase client is injected via http.ts's _setTestClient test slot.
 *
 * Run: node --import tsx/esm --test src/test/groupChat.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";

// ── User IDs ─────────────────────────────────────────────────────────────────

const ALICE_ID   = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
const BOB_ID     = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";
const CAROL_ID   = "cccccccc-0000-0000-0000-cccccccccccc";
const TRIP_ID    = "dddddddd-0000-0000-0000-dddddddddddd";
const THREAD_ID  = "eeeeeeee-0000-0000-0000-eeeeeeeeeeee";
const CIRCLE_TID = "ffffffff-0000-0000-0000-ffffffffffff";

// ── Fake state ────────────────────────────────────────────────────────────────

interface TripMember  { trip_id: string; user_id: string; role: string }
interface CircleMem   { owner_id: string; member_id: string }
interface Thread      { id: string; thread_type: string; trip_id: string | null; circle_owner_id: string | null; title: string | null; status: string; last_message_at: string | null; created_at: string; updated_at: string }
interface ThreadMem   { thread_id: string; user_id: string; role: string; joined_at: string; left_at: string | null; muted_at: string | null; archived_at: string | null }
interface Profile     { id: string; handle: string; name: string; avatar_url: string | null }
interface Trip        { id: string; title: string; destination_city: string }

interface State {
  users:            Record<string, { id: string } | null>;
  trip_members:     TripMember[];
  circle_memberships: CircleMem[];
  message_threads:  Thread[];
  message_thread_members: ThreadMem[];
  profiles:         Profile[];
  trips:            Trip[];
  messages:         any[];
  message_translations: any[];
}

const ALICE_PROFILE: Profile = { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null };
const BOB_PROFILE:   Profile = { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null };
const CAROL_PROFILE: Profile = { id: CAROL_ID, handle: "carol", name: "Carol", avatar_url: null };

const BASE_TRIP: Trip = { id: TRIP_ID, title: "Paris Trip", destination_city: "Paris" };

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trip_members: [],
    circle_memberships: [],
    message_threads: [],
    message_thread_members: [],
    profiles: [ALICE_PROFILE, BOB_PROFILE, CAROL_PROFILE],
    trips: [BASE_TRIP],
    messages: [],
    message_translations: [],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  const insertedRows: Array<{ table: string; row: any }> = [];
  const upsertedRows: Array<{ table: string; rows: any[] }> = [];
  const updatedRows:  Array<{ table: string; patch: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any | null = null;
    let pendingUpdate: any | null = null;
    let pendingUpsert: any[] | null = null;
    let upsertOpts: any   = null;
    let isDelete = false;
    let selectCols = "*";

    const builder: any = {
      select(cols: string)  { selectCols = cols; return builder; },
      insert(row: any)      { pendingInsert = row; insertedRows.push({ table, row }); return builder; },
      update(patch: any)    { pendingUpdate = patch; updatedRows.push({ table, patch }); return builder; },
      delete()              { isDelete = true; return builder; },
      upsert(rows: any, opts?: any) {
        pendingUpsert = Array.isArray(rows) ? rows : [rows];
        upsertOpts = opts;
        upsertedRows.push({ table, rows: pendingUpsert });
        return builder;
      },
      eq(col: string, val: any)   { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any)   {
        filters.push((r) => val === null ? (r[col] === null || r[col] === undefined) : r[col] === val);
        return builder;
      },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return builder; },
      lt(col: string, val: any)   { filters.push((r) => r[col] < val); return builder; },
      order()  { return builder; },
      limit()  { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function getSource(): any[] {
      switch (table) {
        case "trip_members":           return state.trip_members;
        case "circle_memberships":     return state.circle_memberships;
        case "message_threads":        return state.message_threads;
        case "message_thread_members": return state.message_thread_members;
        case "profiles":               return state.profiles;
        case "trips":                  return state.trips;
        case "messages":               return state.messages;
        case "message_translations":   return state.message_translations;
        default: return [];
      }
    }

    function filteredRows(): any[] {
      return getSource().filter((r) => filters.every((f) => f(r)));
    }

    async function resolveSingle(maybe: boolean): Promise<{ data: any; error: null }> {
      if (pendingInsert) {
        const row = { id: `auto-${Math.random().toString(36).slice(2)}`, ...pendingInsert };
        // side-effect: add to state
        (getSource() as any[]).push(row);
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = filteredRows();
        if (matched[0]) {
          Object.assign(matched[0], pendingUpdate);
          return { data: matched[0], error: null };
        }
        return { data: null, error: null };
      }
      if (isDelete) {
        const src = getSource() as any[];
        const toRemove = filteredRows();
        for (const r of toRemove) {
          const idx = src.indexOf(r);
          if (idx !== -1) src.splice(idx, 1);
        }
        return { data: null, error: null };
      }
      const matched = filteredRows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "no rows" } } as any;
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList(): Promise<{ data: any[]; error: null }> {
      if (pendingUpsert) {
        const src = getSource() as any[];
        const conflict = upsertOpts?.onConflict ?? "";
        const conflictCols = conflict ? conflict.split(",").map((c: string) => c.trim()) : [];

        for (const row of pendingUpsert) {
          const existing = conflictCols.length
            ? src.find((r) => conflictCols.every((c: string) => r[c] === row[c]))
            : null;
          if (existing) {
            Object.assign(existing, row);
          } else {
            src.push({ id: `auto-${Math.random().toString(36).slice(2)}`, ...row });
          }
        }
        return { data: pendingUpsert, error: null };
      }
      if (pendingUpdate) {
        const matched = filteredRows();
        for (const r of matched) Object.assign(r, pendingUpdate);
        return { data: matched, error: null };
      }
      return { data: filteredRows(), error: null };
    }

    return builder;
  }

  const auth = {
    getUser(token: string) {
      const user = state.users[token] ?? null;
      if (!user) return Promise.resolve({ data: { user: null }, error: { message: "invalid token" } });
      return Promise.resolve({ data: { user }, error: null });
    },
  };

  return { from, auth, _inserted: insertedRows, _upserted: upsertedRows, _updated: updatedRows };
}

// ── Express app ───────────────────────────────────────────────────────────────

function makeApp(client: ReturnType<typeof makeFakeClient>) {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", messagingRouter);
  return app;
}

// ── Test server lifecycle ─────────────────────────────────────────────────────

let server: Server;
let base: string;
let client: ReturnType<typeof makeFakeClient>;

function freshClient(overrides?: Partial<State>) {
  const state = { ...baseState(), ...overrides };
  client = makeFakeClient(state);
  const app = makeApp(client);
  if (server) {
    server.close();
  }
  server = createServer(app);
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}/api`;
      resolve();
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authed(token: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  };
}

// ── Tests: GET /api/trips/:tripId/chat ────────────────────────────────────────

describe("GET /api/trips/:tripId/chat", () => {
  it("401 when unauthenticated", async () => {
    await freshClient();
    const res = await fetch(`${base}/trips/${TRIP_ID}/chat`);
    assert.equal(res.status, 401);
  });

  it("400 on invalid trip UUID", async () => {
    await freshClient();
    const res = await fetch(`${base}/trips/not-a-uuid/chat`, authed("alice-tok"));
    assert.equal(res.status, 400);
  });

  it("403 when user is not a trip member", async () => {
    await freshClient();
    const res = await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"));
    assert.equal(res.status, 403);
  });

  it("403 when user is 'invited' (not yet accepted)", async () => {
    await freshClient({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited" }],
    });
    const res = await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"));
    assert.equal(res.status, 403);
  });

  it("200 and creates thread when trip owner opens chat", async () => {
    await freshClient({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
    });
    const res = await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.threadId, "should have threadId");
    assert.equal(body.threadType, "trip");
    assert.equal(body.tripId, TRIP_ID);
    assert.ok(typeof body.title === "string" && body.title.length > 0, "should have title");
  });

  it("200 and creates thread when accepted member opens chat", async () => {
    await freshClient({
      trip_members: [
        { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" },
        { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member" },
      ],
    });
    const res = await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("bob-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.threadType, "trip");
    assert.ok(body.threadId);
  });

  it("idempotent: same threadId on second call", async () => {
    await freshClient({
      trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
    });
    const r1 = await (await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"))).json();
    const r2 = await (await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"))).json();
    assert.equal(r1.threadId, r2.threadId, "thread id must be stable across calls");
  });

  it("adds all accepted trip members to the thread on creation", async () => {
    const state = baseState();
    state.trip_members = [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner"  },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member" },
      { trip_id: TRIP_ID, user_id: CAROL_ID, role: "invited" },
    ];
    await freshClient(state);
    await fetch(`${base}/trips/${TRIP_ID}/chat`, authed("alice-tok"));

    const activeMembers = state.message_thread_members.filter(
      (m) => m.left_at === null || m.left_at === undefined
    );
    const memberIds = activeMembers.map((m) => m.user_id);
    assert.ok(memberIds.includes(ALICE_ID), "owner should be in thread");
    assert.ok(memberIds.includes(BOB_ID),   "accepted member should be in thread");
    assert.ok(!memberIds.includes(CAROL_ID), "invited (pending) member should NOT be in thread");
  });
});

// ── Tests: GET /api/circles/:circleOwnerId/chat ───────────────────────────────

describe("GET /api/circles/:circleOwnerId/chat", () => {
  it("401 when unauthenticated", async () => {
    await freshClient();
    const res = await fetch(`${base}/circles/${ALICE_ID}/chat`);
    assert.equal(res.status, 401);
  });

  it("400 on invalid UUID", async () => {
    await freshClient();
    const res = await fetch(`${base}/circles/not-valid/chat`, authed("alice-tok"));
    assert.equal(res.status, 400);
  });

  it("200 when circle owner opens their own chat", async () => {
    await freshClient({
      circle_memberships: [{ owner_id: ALICE_ID, member_id: BOB_ID }],
    });
    const res = await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("alice-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.threadId);
    assert.equal(body.threadType, "circle");
    assert.equal(body.circleOwnerId, ALICE_ID);
  });

  it("200 when an accepted circle member opens chat", async () => {
    await freshClient({
      circle_memberships: [{ owner_id: ALICE_ID, member_id: BOB_ID }],
    });
    const res = await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("bob-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.threadType, "circle");
  });

  it("403 when user is not in the circle", async () => {
    await freshClient({
      circle_memberships: [{ owner_id: ALICE_ID, member_id: BOB_ID }],
    });
    const res = await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("carol-tok"));
    assert.equal(res.status, 403);
  });

  it("idempotent: same threadId on second call for circle", async () => {
    await freshClient({
      circle_memberships: [{ owner_id: ALICE_ID, member_id: BOB_ID }],
    });
    const r1 = await (await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("alice-tok"))).json();
    const r2 = await (await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("alice-tok"))).json();
    assert.equal(r1.threadId, r2.threadId);
  });

  it("includes owner in circle thread members", async () => {
    const state = baseState();
    state.circle_memberships = [{ owner_id: ALICE_ID, member_id: BOB_ID }];
    await freshClient(state);
    await fetch(`${base}/circles/${ALICE_ID}/chat`, authed("alice-tok"));
    const memberIds = state.message_thread_members.map((m) => m.user_id);
    assert.ok(memberIds.includes(ALICE_ID), "owner should be a thread member");
    assert.ok(memberIds.includes(BOB_ID),   "circle member should be a thread member");
  });
});

// ── Tests: left_at filtering in GET /api/me/threads ──────────────────────────
//
// GET /me/threads calls getServiceClient() for thread details after the initial
// left_at membership filter. That secondary call returns null in test (no real
// Supabase creds). We therefore only test the left_at exclusion path which
// short-circuits BEFORE reaching getServiceClient() (no thread IDs → early 200).
// The threadType/title fields added to the response are verified via the group
// chat endpoint tests below (which use auth.client throughout).

describe("GET /api/me/threads — left_at filtering", () => {
  it("returns 200 with empty threads when user has left all threads", async () => {
    const now = new Date().toISOString();
    const state = baseState();
    const thread: Thread = {
      id: THREAD_ID,
      thread_type: "direct",
      trip_id: null,
      circle_owner_id: null,
      title: null,
      status: "active",
      last_message_at: null,
      created_at: now,
      updated_at: now,
    };
    state.message_threads = [thread];
    // Alice has left this thread — the filter will exclude her, yielding 0 threadIds → early exit
    state.message_thread_members = [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "member", joined_at: now, left_at: now, muted_at: null, archived_at: null },
    ];
    await freshClient(state);
    const res = await fetch(`${base}/me/threads`, authed("alice-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.threads.length, 0, "left thread should not appear in inbox");
  });

  it("returns 200 with empty threads when user has no memberships at all", async () => {
    await freshClient();
    const res = await fetch(`${base}/me/threads`, authed("alice-tok"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.threads, []);
  });
});

// ── Tests: membership checks with left_at ────────────────────────────────────

describe("GET /api/threads/:threadId/messages — left member cannot read", () => {
  it("403 when left_at is set (member has left)", async () => {
    const now = new Date().toISOString();
    const state = baseState();
    state.message_thread_members = [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "member", joined_at: now, left_at: now, muted_at: null, archived_at: null },
    ];
    await freshClient(state);
    const res = await fetch(`${base}/threads/${THREAD_ID}/messages`, authed("alice-tok"));
    assert.equal(res.status, 403);
  });

  it("active member passes the left_at membership gate (not 403)", async () => {
    // After the membership check, GET /threads/:id/messages calls getServiceClient()
    // which returns null in the test environment (no real Supabase creds) → 503.
    // We verify the membership gate itself: a member with left_at=null must NOT get 403.
    const now = new Date().toISOString();
    const state = baseState();
    state.message_thread_members = [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "member", joined_at: now, left_at: null, muted_at: null, archived_at: null },
    ];
    await freshClient(state);
    const res = await fetch(`${base}/threads/${THREAD_ID}/messages`, authed("alice-tok"));
    assert.notEqual(res.status, 403, "active member must not be rejected by the membership gate");
  });
});

describe("POST /api/threads/:threadId/messages — left member cannot send", () => {
  it("403 when left_at is set", async () => {
    const now = new Date().toISOString();
    const state = baseState();
    state.message_thread_members = [
      { thread_id: THREAD_ID, user_id: ALICE_ID, role: "member", joined_at: now, left_at: now, muted_at: null, archived_at: null },
    ];
    await freshClient(state);
    const res = await fetch(`${base}/threads/${THREAD_ID}/messages`, authed("alice-tok", {
      method: "POST",
      body: JSON.stringify({ body: "hello" }),
    }));
    assert.equal(res.status, 403);
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

after(() => { if (server) server.close(); });
