/**
 * Blocks route tests
 *
 * Tests the full set of block/unblock/list routes WITHOUT a live database.
 * Uses the node:test + fake-client pattern.
 *
 * Run: node --import tsx/esm --test src/test/blocks.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import blocksRouter from "../routes/blocks.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN   = "blocks-test-token";
const OTHER_TOKEN  = "blocks-other-token";
const USER_ID      = "aabbccdd-0001-0002-0003-aabbccdd0001";
const TARGET_ID    = "aabbccdd-0001-0002-0003-aabbccdd0002";
const OTHER_ID     = "aabbccdd-0001-0002-0003-aabbccdd0003";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
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
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

interface FakeState {
  blocks?: Record<string, any>[];
  profiles?: Record<string, any>[];
  user_account_states?: Record<string, any>[];
  profile_privacy_settings?: Record<string, any>[];
}

function makeFakeClient(state: FakeState = {}) {
  const inserted: Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "blocks")              return (state.blocks ?? []).map((r) => ({ ...r }));
    if (table === "profiles")            return (state.profiles ?? []).map((r) => ({ ...r }));
    if (table === "user_account_states") return (state.user_account_states ?? []).map((r) => ({ ...r }));
    if (table === "profile_privacy_settings") return (state.profile_privacy_settings ?? []).map((r) => ({ ...r }));
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const filters: Array<(r: any) => boolean> = [];
    let _single = false;
    let _maybe  = false;

    const b: any = {
      select(_cols?: string, _opts?: any) { return b; },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push(row);
        return b;
      },
      update(patch: any) { pendingUpdate = patch; return b; },
      upsert(row: any, _opts?: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push({ ...row });
        return b;
      },
      delete() { return b; },
      eq(col: string, val: any)           { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)          { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[])        { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)           { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      or(_filter: string)                 { return b; },
      limit(_n: number)                   { return b; },
      order()                             { return b; },
      range()                             { return b; },
      maybeSingle() { _maybe = true; _single = true; return resolve(); },
      single()      { _single = true; return resolve(); },
      then(onF: any, onR: any)            { return resolveList().then(onF, onR); },
    };

    async function resolve() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert)
          ? { id: `gen-${Math.random()}`, ...pendingInsert[0] }
          : { id: `gen-${Math.random()}`, ...pendingInsert };
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        const row = matched[0] ? { ...matched[0], ...pendingUpdate } : null;
        return { data: row, error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (_maybe) return { data: matched[0] ?? null, error: null };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        const row = Array.isArray(pendingInsert)
          ? { id: `gen-${Math.random()}`, ...pendingInsert[0] }
          : { id: `gen-${Math.random()}`, ...pendingInsert };
        return { data: [row], error: null, count: 1 };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched, error: null, count: matched.length };
    }

    return b;
  }

  function authGetUser(token: string) {
    if (token === FAKE_TOKEN)  return { data: { user: { id: USER_ID } },  error: null };
    if (token === OTHER_TOKEN) return { data: { user: { id: OTHER_ID } }, error: null };
    return { data: { user: null }, error: { message: "invalid" } };
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: { getUser: async (token: string) => authGetUser(token) },
    __inserted: inserted,
  };
  return client;
}

function setClients(c: ReturnType<typeof makeFakeClient>) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => new Promise<void>((resolve) => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/", blocksRouter);
  server = app.listen(0, "127.0.0.1", () => {
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    resolve();
  });
}));

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  server.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────
// All suites wrapped in one outer describe so node:test runs them sequentially
// (top-level describes run in parallel by default, which would race on the
// shared _setTestClient global).

describe("blocks routes", () => {
  describe("POST /users/:userId/block", () => {
    it("1a. self-block returns 400 invalid_payload", async () => {
      setClients(makeFakeClient());
      const r = await req("POST", `/users/${USER_ID}/block`);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("1b. invalid UUID returns 400", async () => {
      setClients(makeFakeClient());
      const r = await req("POST", `/users/not-a-uuid/block`);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("1c. unauthenticated returns 401", async () => {
      setClients(makeFakeClient());
      const r = await req("POST", `/users/${TARGET_ID}/block`, undefined, "bad-token");
      assert.equal(r.status, 401);
    });

    it("1d. block succeeds for valid user pair (no existing block)", async () => {
      // Use is_private: true so the permission engine hits the priority-6 gate
      // (canViewProfile=false) and returns early with canBlock: true, without
      // reaching the context-queries section (circle_memberships, trip_members,
      // rent_buddy_bookings) that would need additional table stubs.
      setClients(makeFakeClient({
        blocks:   [],
        profiles: [{ id: TARGET_ID, is_private: true }],
      }));
      const r = await req("POST", `/users/${TARGET_ID}/block`);
      assert.equal(r.status, 200);
      assert.equal(r.body.blocked, true);
      assert.equal(r.body.userId, TARGET_ID);
    });
  });

  describe("DELETE /users/:userId/block", () => {
    it("2a. self-unblock returns 400", async () => {
      setClients(makeFakeClient());
      const r = await req("DELETE", `/users/${USER_ID}/block`);
      assert.equal(r.status, 400);
    });

    it("2b. invalid UUID returns 400", async () => {
      setClients(makeFakeClient());
      const r = await req("DELETE", `/users/not-a-uuid/block`);
      assert.equal(r.status, 400);
    });

    it("2c. unauthenticated returns 401", async () => {
      setClients(makeFakeClient());
      const r = await req("DELETE", `/users/${TARGET_ID}/block`, undefined, "bad-token");
      assert.equal(r.status, 401);
    });

    it("2d. unblock succeeds when caller has an existing block", async () => {
      setClients(makeFakeClient({
        blocks: [{ blocker_id: USER_ID, blocked_id: TARGET_ID, created_at: new Date().toISOString() }],
        profiles: [{ id: TARGET_ID, is_private: false }],
      }));
      const r = await req("DELETE", `/users/${TARGET_ID}/block`);
      assert.equal(r.status, 200);
      assert.equal(r.body.blocked, false);
    });
  });

  describe("GET /me/blocks", () => {
    it("3a. returns empty array when no blocks exist", async () => {
      setClients(makeFakeClient({ blocks: [], profiles: [] }));
      const r = await req("GET", "/me/blocks");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.blocked));
      assert.equal(r.body.blocked.length, 0);
    });

    it("3b. returns list of blocked users with profile data", async () => {
      const blockedAt = new Date().toISOString();
      setClients(makeFakeClient({
        blocks:   [{ blocker_id: USER_ID, blocked_id: TARGET_ID, created_at: blockedAt }],
        profiles: [{ id: TARGET_ID, handle: "target_user", name: "Target User", avatar_url: null }],
        // target_user opted in to real-name visibility so the name is not redacted.
        profile_privacy_settings: [{ user_id: TARGET_ID, show_real_name: true }],
      }));
      const r = await req("GET", "/me/blocks");
      assert.equal(r.status, 200);
      assert.equal(r.body.blocked.length, 1);
      assert.equal(r.body.blocked[0].id, TARGET_ID);
      assert.equal(r.body.blocked[0].handle, "target_user");
      assert.equal(r.body.blocked[0].name, "Target User");
      assert.equal(r.body.blocked[0].blockedAt, blockedAt);
    });

    it("3c. unauthenticated returns 401", async () => {
      setClients(makeFakeClient());
      const r = await req("GET", "/me/blocks", undefined, "bad-token");
      assert.equal(r.status, 401);
    });
  });

  describe("GET /me/blocker-ids", () => {
    it("4a. returns empty array when nobody has blocked the caller", async () => {
      setClients(makeFakeClient({ blocks: [] }));
      const r = await req("GET", "/me/blocker-ids");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.ids));
      assert.equal(r.body.ids.length, 0);
    });

    it("4b. returns IDs of users who have blocked the caller", async () => {
      setClients(makeFakeClient({
        blocks: [{ blocker_id: OTHER_ID, blocked_id: USER_ID }],
      }));
      const r = await req("GET", "/me/blocker-ids");
      assert.equal(r.status, 200);
      assert.ok(r.body.ids.includes(OTHER_ID));
    });

    it("4c. does not include IDs the caller blocked (only inbound blocks)", async () => {
      setClients(makeFakeClient({
        blocks: [{ blocker_id: USER_ID, blocked_id: TARGET_ID }],
      }));
      const r = await req("GET", "/me/blocker-ids");
      assert.equal(r.status, 200);
      assert.equal(r.body.ids.length, 0, "outbound block should not appear in blocker-ids");
    });

    it("4d. unauthenticated returns 401", async () => {
      setClients(makeFakeClient());
      const r = await req("GET", "/me/blocker-ids", undefined, "bad-token");
      assert.equal(r.status, 401);
    });
  });

  describe("GET /users/:userId/block-status", () => {
    it("5a. returns iBlocked=false, theyBlockedMe=false when no blocks exist", async () => {
      setClients(makeFakeClient({ blocks: [] }));
      const r = await req("GET", `/users/${TARGET_ID}/block-status`);
      assert.equal(r.status, 200);
      assert.equal(r.body.iBlocked, false);
      assert.equal(r.body.theyBlockedMe, false);
      assert.equal(r.body.userId, TARGET_ID);
    });

    it("5b. returns iBlocked=true when caller has blocked the target", async () => {
      setClients(makeFakeClient({
        blocks: [{ blocker_id: USER_ID, blocked_id: TARGET_ID }],
      }));
      const r = await req("GET", `/users/${TARGET_ID}/block-status`);
      assert.equal(r.status, 200);
      assert.equal(r.body.iBlocked, true);
      assert.equal(r.body.theyBlockedMe, false);
    });

    it("5c. returns theyBlockedMe=true when target has blocked the caller", async () => {
      setClients(makeFakeClient({
        blocks: [{ blocker_id: TARGET_ID, blocked_id: USER_ID }],
      }));
      const r = await req("GET", `/users/${TARGET_ID}/block-status`);
      assert.equal(r.status, 200);
      assert.equal(r.body.iBlocked, false);
      assert.equal(r.body.theyBlockedMe, true);
    });

    it("5d. returns both flags true for a mutual block", async () => {
      setClients(makeFakeClient({
        blocks: [
          { blocker_id: USER_ID,   blocked_id: TARGET_ID },
          { blocker_id: TARGET_ID, blocked_id: USER_ID   },
        ],
      }));
      const r = await req("GET", `/users/${TARGET_ID}/block-status`);
      assert.equal(r.status, 200);
      assert.equal(r.body.iBlocked, true);
      assert.equal(r.body.theyBlockedMe, true);
    });

    it("5e. invalid UUID returns 400", async () => {
      setClients(makeFakeClient());
      const r = await req("GET", "/users/not-a-uuid/block-status");
      assert.equal(r.status, 400);
    });

    it("5f. unauthenticated returns 401", async () => {
      setClients(makeFakeClient());
      const r = await req("GET", `/users/${TARGET_ID}/block-status`, undefined, "bad-token");
      assert.equal(r.status, 401);
    });
  });
});
