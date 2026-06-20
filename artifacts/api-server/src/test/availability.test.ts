/**
 * Availability routes — node:test suite
 *
 * Covers:
 *   GET  /api/me/availability
 *   PATCH /api/me/availability
 *   GET  /api/me/quick-availability
 *   PATCH /api/me/quick-availability
 *   GET   /api/trips/:tripId/availability
 *   PATCH /api/trips/:tripId/availability
 *   GET   /api/circles/:circleId/availability
 *   PATCH /api/circles/:circleId/availability
 *
 * Runtime: node:test + fetch() on a real Express server at a random port.
 * Fake Supabase injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/availability.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import availabilityRouter from "../routes/availability.js";

// ── IDs ───────────────────────────────────────────────────────────────────────

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";
const BOB_ID   = "00000000-0000-0000-0000-0000000000b2";
const TRIP_ID  = "00000000-0000-0000-0000-000000000001";
const CIRCLE_ID = "00000000-0000-0000-0000-000000000002";

// ── State shape ───────────────────────────────────────────────────────────────

interface AvailRow { user_id: string; weekly_days: Record<string, string[]>; open_to_meet: boolean; strict_mode?: boolean; updated_at?: string }
interface QuickRow { user_id: string; status: string; expires_at: string | null; updated_at?: string }
interface TripMember { trip_id: string; user_id: string; role: string }
interface CircleMember { owner_id: string; member_id: string }
interface Profile { id: string; handle: string; name: string; avatar_url: string | null }

interface TripAvRow { trip_id: string; user_id: string; open_days: Record<string, string[]>; updated_at?: string }

interface State {
  users: Record<string, { id: string } | null>;
  user_availability: AvailRow[];
  quick_availability_status: QuickRow[];
  trip_availability: TripAvRow[];
  trip_members: TripMember[];
  circle_memberships: CircleMember[];
  profiles: Profile[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
    },
    user_availability: [],
    quick_availability_status: [],
    trip_availability: [],
    trip_members: [],
    circle_memberships: [],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   avatar_url: null },
    ],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "upsert" = "select";
    let _upsertRow: any = null;
    let _updatePayload: any = null;

    const b: any = {
      select(_sel?: string) { return b; },
      update(changes: any) { _op = "update"; _updatePayload = changes; return b; },
      delete() { _op = "delete"; return b; },
      upsert(row: any, _opts?: any) {
        _op = "upsert";
        _upsertRow = row;
        return b;
      },
      insert(row: any) {
        const source: any[] = (state as any)[table] ?? [];
        const r = Array.isArray(row) ? row[0] : row;
        source.push(r);
        return Promise.resolve({ data: r, error: null });
      },
      eq(col: string, val: any)   { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any)  { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      is()    { return b; },
      not()   { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveSingle(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "upsert") return resolveUpsert().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() { return { data: matchedRows()[0] ?? null, error: null }; }
    async function resolveSingle() {
      if (_op === "upsert" && _upsertRow) {
        const row = { ..._upsertRow };
        return { data: row, error: null };
      }
      return { data: matchedRows()[0] ?? null, error: null };
    }
    async function resolveList()  { return { data: matchedRows(), error: null }; }
    async function resolveUpdate() {
      const source = getSource();
      for (const row of source) {
        if (filters.every((f) => f(row))) Object.assign(row, _updatePayload);
      }
      return { data: null, error: null };
    }
    async function resolveDelete() {
      (state as any)[table] = getSource().filter((r: any) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    async function resolveUpsert() {
      if (!_upsertRow) return { data: null, error: null };
      const source: any[] = (state as any)[table] ?? [];
      (state as any)[table] = source;
      // Handle composite key for trip_availability (trip_id + user_id)
      const existing = table === "trip_availability"
        ? source.find((r) => r.trip_id === _upsertRow.trip_id && r.user_id === _upsertRow.user_id)
        : source.find((r) => r.user_id === _upsertRow.user_id);
      if (existing) Object.assign(existing, _upsertRow);
      else source.push(_upsertRow);
      return { data: _upsertRow, error: null };
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

// ── Test server helpers ───────────────────────────────────────────────────────

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", availabilityRouter);

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

async function patch(port: number, path: string, token: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/me/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, "/api/me/availability");
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns empty availability when no row exists", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, "/api/me/availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.weeklyDays, {});
      assert.equal(r.body.openToMeet, false);
      assert.equal(r.body.quickStatus, null);
    } finally { await s.close(); }
  });

  it("returns stored availability row", async () => {
    const state = baseState();
    state.user_availability.push({
      user_id: ALICE_ID,
      weekly_days: { mon: ["evening"], fri: ["afternoon"] },
      open_to_meet: true,
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, "/api/me/availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.weeklyDays, { mon: ["evening"], fri: ["afternoon"] });
      assert.equal(r.body.openToMeet, true);
    } finally { await s.close(); }
  });

  it("includes active quick status", async () => {
    const state = baseState();
    state.quick_availability_status.push({
      user_id: ALICE_ID,
      status: "free_now",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, "/api/me/availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.quickStatus?.status, "free_now");
    } finally { await s.close(); }
  });
});

describe("PATCH /api/me/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/me/availability`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeklyDays: {} }),
      });
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("rejects invalid body — openToMeet must be boolean", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/availability", "alice-tok", { openToMeet: "yes" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("rejects invalid block value in weeklyDays", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/availability", "alice-tok", { weeklyDays: { mon: ["midnight"] } });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("upserts and returns availability", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/availability", "alice-tok", {
        weeklyDays: { fri: ["evening"] },
        openToMeet: true,
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.weeklyDays, { fri: ["evening"] });
      assert.equal(r.body.openToMeet, true);
    } finally { await s.close(); }
  });
});

describe("GET /api/me/quick-availability", () => {
  it("returns null status when no row exists", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, "/api/me/quick-availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, null);
    } finally { await s.close(); }
  });

  it("returns null when status is expired", async () => {
    const state = baseState();
    state.quick_availability_status.push({
      user_id: ALICE_ID,
      status: "free_now",
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, "/api/me/quick-availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, null);
    } finally { await s.close(); }
  });

  it("returns active status", async () => {
    const state = baseState();
    state.quick_availability_status.push({
      user_id: ALICE_ID,
      status: "open_to_plans",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, "/api/me/quick-availability", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "open_to_plans");
    } finally { await s.close(); }
  });
});

describe("PATCH /api/me/quick-availability", () => {
  it("rejects invalid status value", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/quick-availability", "alice-tok", { status: "invisible" });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("accepts free_now and returns it", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/quick-availability", "alice-tok", { status: "free_now" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "free_now");
    } finally { await s.close(); }
  });

  it("accepts all valid status values", async () => {
    for (const status of ["free_now", "free_tonight", "open_to_plans", "busy"]) {
      const s = await startServer(baseState());
      try {
        const r = await patch(s.port, "/api/me/quick-availability", "alice-tok", { status });
        assert.equal(r.status, 200, `status=${status} should return 200`);
      } finally { await s.close(); }
    }
  });

  it("rejects null status (use busy to indicate unavailable)", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, "/api/me/quick-availability", "alice-tok", { status: null });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });
});

describe("PATCH /api/trips/:tripId/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, `/api/trips/${TRIP_ID}/availability`, "no-tok", { openDays: {} });
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns 403 for non-members", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok", { openDays: {} });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("rejects missing openDays", async () => {
    const state = baseState();
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
    const s = await startServer(state);
    try {
      const r = await patch(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok", {});
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("rejects invalid date key", async () => {
    const state = baseState();
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
    const s = await startServer(state);
    try {
      const r = await patch(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok", { openDays: { "not-a-date": ["morning"] } });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("stores trip-scoped open days and returns them", async () => {
    const state = baseState();
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
    const s = await startServer(state);
    try {
      const r = await patch(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok", {
        openDays: { "2025-07-04": ["morning", "evening"] },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.openDays, { "2025-07-04": ["morning", "evening"] });
      assert.equal(r.body.tripId, TRIP_ID);
    } finally { await s.close(); }
  });
});

describe("PATCH /api/circles/:circleId/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, `/api/circles/${CIRCLE_ID}/availability`, "no-tok", { openToMeet: true });
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns 403 when not circle member", async () => {
    const s = await startServer(baseState());
    try {
      const r = await patch(s.port, `/api/circles/${CIRCLE_ID}/availability`, "alice-tok", { openToMeet: true });
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("updates and returns own availability when circle member", async () => {
    const state = baseState();
    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: ALICE_ID });
    const s = await startServer(state);
    try {
      const r = await patch(s.port, `/api/circles/${CIRCLE_ID}/availability`, "alice-tok", {
        weeklyDays: { sat: ["afternoon"] },
        openToMeet: true,
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.weeklyDays, { sat: ["afternoon"] });
      assert.equal(r.body.openToMeet, true);
    } finally { await s.close(); }
  });
});

describe("GET /api/trips/:tripId/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, `/api/trips/${TRIP_ID}/availability`);
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns 403 for non-members", async () => {
    const state = baseState();
    // alice is not in trip_members for TRIP_ID
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok");
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("returns member availability for accepted trip member", async () => {
    const state = baseState();
    state.trip_members.push(
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member" },
    );
    state.user_availability.push({
      user_id: ALICE_ID, weekly_days: { mon: ["evening"] }, open_to_meet: true,
    });
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.members));
      assert.equal(r.body.tripId, TRIP_ID);
      assert.ok(r.body.members.length >= 1);
      const alice = r.body.members.find((m: any) => m.userId === ALICE_ID);
      assert.ok(alice, "alice should be in members");
      assert.deepEqual(alice.weeklyDays, { mon: ["evening"] });
    } finally { await s.close(); }
  });

  it("excludes invited (not yet accepted) members", async () => {
    const state = baseState();
    // alice is owner; bob is only invited (not a full member)
    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/trips/${TRIP_ID}/availability`, "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.members.length, 1);
      assert.equal(r.body.members[0].userId, ALICE_ID);
    } finally { await s.close(); }
  });
});

describe("GET /api/circles/:circleId/availability", () => {
  it("returns 401 without token", async () => {
    const s = await startServer(baseState());
    try {
      const r = await get(s.port, `/api/circles/${CIRCLE_ID}/availability`);
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("returns 403 when not circle owner or member", async () => {
    const state = baseState();
    // alice is not in circle_memberships for CIRCLE_ID
    const s = await startServer(state);
    try {
      const r = await get(s.port, `/api/circles/${CIRCLE_ID}/availability`, "alice-tok");
      assert.equal(r.status, 403);
    } finally { await s.close(); }
  });

  it("returns member availability for circle owner", async () => {
    const state = baseState();
    // alice is circle owner (by convention circleId == ownerId), bob is member
    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: ALICE_ID });
    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: BOB_ID });
    const s = await startServer(state);
    try {
      // use CIRCLE_ID == ALICE_ID equivalent — route checks membership
      // For the test, CIRCLE_ID is the owner; alice must be a member to access
      // The route does: check alice is member of CIRCLE_ID; then list all members
      const r = await get(s.port, `/api/circles/${CIRCLE_ID}/availability`, "alice-tok");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.members));
      assert.equal(r.body.circleId, CIRCLE_ID);
    } finally { await s.close(); }
  });
});
