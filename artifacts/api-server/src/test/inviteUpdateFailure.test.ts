/**
 * Failure-path tests for circle_invites / trip_members status updates.
 *
 * Same regression guard as friendRequestUpdateFailure.test.ts: schema drift
 * (e.g. PGRST204 on a missing column) must surface db_error instead of a
 * success payload, and dependent side effects (circle_memberships upsert)
 * must not run.
 *
 * Run: node --import tsx/esm --test src/test/inviteUpdateFailure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import requestsRouter from "../routes/requests.js";

// ── Fake state ────────────────────────────────────────────────────────────────

interface State {
  users: Record<string, { id: string } | null>;
  circle_invites: any[];
  circle_memberships: any[];
  trip_members: any[];
  circle_age_settings: any[];
  profiles: any[];
  user_interaction_cooldowns: any[];
  /** tables whose update() should fail with a PGRST204-style error */
  failUpdateTables: Set<string>;
  /** tables whose delete() should fail with a PGRST204-style error */
  failDeleteTables: Set<string>;
  /** tables whose upsert() should fail with a PGRST204-style error */
  failUpsertTables: Set<string>;
}

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const RECIP_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const CI_ID    = "11111111-0000-0000-0000-000000000001";
const TRIP_ID  = "22222222-0000-0000-0000-000000000002";
const T1 = "2026-06-01T00:00:00Z";

function baseState(): State {
  return {
    users: {
      "owner-tok": { id: OWNER_ID },
      "recip-tok": { id: RECIP_ID },
    },
    circle_invites: [],
    circle_memberships: [],
    trip_members: [],
    circle_age_settings: [],
    profiles: [
      { id: OWNER_ID, handle: "owner", name: "Owner", avatar_url: null, date_of_birth: null },
      { id: RECIP_ID, handle: "recip", name: "Recip", avatar_url: null, date_of_birth: null },
    ],
    user_interaction_cooldowns: [],
    failUpdateTables: new Set(),
    failDeleteTables: new Set(),
    failUpsertTables: new Set(),
  };
}

const DRIFT_ERROR = {
  message: "Could not find the 'responded_at' column of 'circle_invites' in the schema cache",
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
        if (state.failUpsertTables?.has(table)) {
          return Promise.resolve({ data: null, error: DRIFT_ERROR });
        }
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
      if (state.failDeleteTables.has(table)) {
        return { data: null, error: DRIFT_ERROR };
      }
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
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, state, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

async function post(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function pendingInvite() {
  return { id: CI_ID, owner_id: OWNER_ID, recipient_id: RECIP_ID, status: "pending", created_at: T1 };
}

function invitedTripMember() {
  return { trip_id: TRIP_ID, user_id: RECIP_ID, role: "invited" };
}

// ── circle_invites routes ─────────────────────────────────────────────────────

describe("circle_invite update failure surfaces db_error", () => {
  it("accept returns db_error and does not create a membership", async () => {
    const state = baseState();
    state.circle_invites.push(pendingInvite());
    state.failUpdateTables.add("circle_invites");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/accept`, "recip-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.circle_invites[0].status, "pending", "row must remain pending on failed update");
      assert.equal(state.circle_memberships.length, 0, "no membership row on failed accept");
    } finally { await srv.close(); }
  });

  it("cancel returns db_error", async () => {
    const state = baseState();
    state.circle_invites.push(pendingInvite());
    state.failUpdateTables.add("circle_invites");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/cancel`, "owner-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.circle_invites[0].status, "pending");
    } finally { await srv.close(); }
  });

  it("decline returns db_error and writes no cooldown", async () => {
    const state = baseState();
    state.circle_invites.push(pendingInvite());
    state.failUpdateTables.add("circle_invites");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/decline`, "recip-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.circle_invites[0].status, "pending");
      assert.equal(state.user_interaction_cooldowns.length, 0, "no cooldown row on failed decline");
    } finally { await srv.close(); }
  });

  it("accept still succeeds when the update succeeds (control)", async () => {
    const state = baseState();
    state.circle_invites.push(pendingInvite());
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/accept`, "recip-tok");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.circle_invites[0].status, "accepted");
      assert.equal(state.circle_memberships.length, 1, "membership row created on success");
    } finally { await srv.close(); }
  });

  it("accept returns db_error when circle_memberships upsert fails after status update", async () => {
    const state = baseState();
    state.circle_invites.push(pendingInvite());
    state.failUpsertTables.add("circle_memberships");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/circle_invite/${CI_ID}/accept`, "recip-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.circle_memberships.length, 0, "no membership row when upsert fails");
    } finally { await srv.close(); }
  });
});

// ── trip_members routes ───────────────────────────────────────────────────────

describe("trip_invite update failure surfaces db_error", () => {
  it("accept returns db_error and role stays invited", async () => {
    const state = baseState();
    state.trip_members.push(invitedTripMember());
    state.failUpdateTables.add("trip_members");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/accept`, "recip-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.trip_members[0].role, "invited", "role must remain invited on failed update");
    } finally { await srv.close(); }
  });

  it("accept still succeeds when the update succeeds (control)", async () => {
    const state = baseState();
    state.trip_members.push(invitedTripMember());
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/accept`, "recip-tok");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.trip_members[0].role, "member");
    } finally { await srv.close(); }
  });

  it("decline returns db_error, row survives, and no cooldown is written", async () => {
    const state = baseState();
    state.trip_members.push(invitedTripMember());
    state.failDeleteTables.add("trip_members");
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/decline`, "recip-tok");
      assert.equal(r.status, 500, `expected 500, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.equal(state.trip_members.length, 1, "trip_members row must survive failed delete");
      assert.equal(state.trip_members[0].role, "invited");
      assert.equal(state.user_interaction_cooldowns.length, 0, "no cooldown row on failed decline");
    } finally { await srv.close(); }
  });

  it("decline still succeeds when the delete succeeds (control)", async () => {
    const state = baseState();
    state.trip_members.push(invitedTripMember());
    const srv = await startServer(state);
    try {
      const r = await post(srv.port, `/api/me/requests/trip_invite/${TRIP_ID}/decline`, "recip-tok");
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(state.trip_members.length, 0, "invite row removed on successful decline");
    } finally { await srv.close(); }
  });
});
