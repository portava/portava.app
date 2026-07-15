/**
 * Access Control & Privacy Tests — Phase 3 stabilization audit.
 *
 * Covers:
 *  A. Admin trust routes — unauthenticated → 401, regular user → 403, admin → 200
 *  B. Block/unblock routes — auth guard, self-block, invalid UUID
 *  C. Trip chat membership — non-member → 403, invited-only → 403;
 *     removed member (left_at set) → 200 with memberAccess:'removed' + empty messages
 *  D. Safe Return — auth guard on every user-facing endpoint
 *  E. Follows — auth guard, self-follow validation
 *  F. Telegraph suggestions — removed thread member (left_at set) → 403
 *  G. Blocked user — canMessage() unit test: block → denied/blocked verdict
 *  H. Blocked user — POST /open-thread: block prevents creating a direct thread (403)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * A real Express server starts on a random port per describe block; fetch() makes HTTP calls.
 * The fake Supabase client is injected via http.ts _setTestClient test slot.
 * _setTestClient(client, true) sets both the user auth slot AND the service client slot.
 *
 * Run: node --import tsx/esm --test src/test/accessControl.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Shared constants ──────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID  = "cccccccc-0000-0000-0000-000000000003";
const TRIP_ID   = "d1d1d1d1-0000-0000-0000-000000000001";
const THREAD_ID = "e2e2e2e2-0000-0000-0000-000000000001";

// ── Fake Supabase client factory ──────────────────────────────────────────────

interface FakeState {
  users?: Record<string, { id: string } | null>;
  profiles?: Array<Record<string, any>>;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  tripMembers?: Array<{ trip_id: string; user_id: string; role: string }>;
  threadMembers?: Array<{ thread_id: string; user_id: string; left_at: null | string }>;
  threads?: Array<Record<string, any>>;
  messages?: Array<Record<string, any>>;
  featureFlags?: Array<{ flag: string; enabled: boolean }>;
  safeReturnSessions?: Array<Record<string, any>>;
  telegraphSuggestions?: Array<Record<string, any>>;
  userFollows?: Array<Record<string, any>>;
  userFriendships?: Array<Record<string, any>>;
  userMessageSettings?: Array<Record<string, any>>;
  messageRequests?: Array<Record<string, any>>;
  messageThreadMembers?: Array<Record<string, any>>;
  circleMemberships?: Array<Record<string, any>>;
  circleInvites?: Array<Record<string, any>>;
  trustRestrictions?: Array<Record<string, any>>;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    profiles:                  state.profiles ?? [],
    blocks:                    state.blocks ?? [],
    trip_members:              state.tripMembers ?? [],
    message_thread_members:    state.threadMembers ?? (state.messageThreadMembers ?? []),
    message_threads:           state.threads ?? [],
    messages:                  state.messages ?? [],
    feature_flags:             state.featureFlags ?? [{ flag: "safe_return_enabled", enabled: true }],
    safe_return_sessions:      state.safeReturnSessions ?? [],
    telegraph_chat_suggestions: state.telegraphSuggestions ?? [],
    user_follows:              state.userFollows ?? [],
    user_friendships:          state.userFriendships ?? [],
    user_message_settings:     state.userMessageSettings ?? [],
    message_requests:          state.messageRequests ?? [],
    circle_memberships:        state.circleMemberships ?? [],
    circle_invites:            state.circleInvites ?? [],
    trust_restrictions:        state.trustRestrictions ?? [],
    // Additional tables that routes may query — return empty by default
    trip_plan_items:           [],
    geo_zones:                 [],
  };

  function from(table: string) {
    const active_filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;
    let upsertPayload: any = null;

    const b: any = {
      select()          { return b; },
      insert(row: any)  { insertPayload = row; return b; },
      update()          { return b; },
      delete()          { return b; },
      upsert(row: any)  { upsertPayload = row; return b; },
      eq(col: string, val: any)   { active_filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)  { active_filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { active_filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)   {
        active_filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      or()     { return b; },
      not()    { return b; },
      limit()  { return b; },
      order()  { return b; },
      range()  { return b; },
      ilike()  { return b; },
      gte()    { return b; },
      lte()    { return b; },
      gt()     { return b; },
      lt()     { return b; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const source: any[] = db[table] ?? [];
      return source.filter((r) => active_filters.every((f) => f(r)));
    }

    async function resolveSingle(maybe: boolean) {
      if (upsertPayload) return { data: { id: "upserted-id", ...upsertPayload }, error: null };
      if (insertPayload) return { data: { id: "new-id", ...insertPayload }, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (insertPayload) return { data: { id: "new-id", ...insertPayload }, error: null };
      return { data: rows(), error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = (state.users ?? {})[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id: u.id } }, error: null };
      },
    },
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function makeApp(router: any): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", router);
  return app;
}

// =============================================================================
// Section A — Admin trust routes: access control
// =============================================================================

describe("A — Admin trust routes: access control", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/trust-admin.js");
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID }, "bob-tok": { id: BOB_ID } },
      profiles: [
        { id: ALICE_ID, role: "admin" },
        { id: BOB_ID,   role: "user"  },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("GET /admin/trust/settings — no auth → 401", async () => {
    const res = await fetch(`${url}/api/admin/trust/settings`);
    assert.equal(res.status, 401);
  });

  it("GET /admin/trust/settings — regular user → 403", async () => {
    const res = await fetch(`${url}/api/admin/trust/settings`, { headers: bearer("bob-tok") });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.ok(body.error, "error field present");
  });

  it("GET /admin/trust/settings — admin → 200", async () => {
    const res = await fetch(`${url}/api/admin/trust/settings`, { headers: bearer("alice-tok") });
    assert.equal(res.status, 200);
  });

  it("GET /admin/trust/gaming-flags — no auth → 401", async () => {
    const res = await fetch(`${url}/api/admin/trust/gaming-flags`);
    assert.equal(res.status, 401);
  });

  it("GET /admin/trust/gaming-flags — regular user → 403", async () => {
    const res = await fetch(`${url}/api/admin/trust/gaming-flags`, { headers: bearer("bob-tok") });
    assert.equal(res.status, 403);
  });

  it("GET /admin/trust/reviews — no auth → 401", async () => {
    const res = await fetch(`${url}/api/admin/trust/reviews`);
    assert.equal(res.status, 401);
  });
});

// =============================================================================
// Section B — Block/unblock routes: access control
// =============================================================================

describe("B — Block/unblock routes: access control", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/blocks.js");
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID } },
      profiles: [{ id: ALICE_ID }, { id: BOB_ID }],
      blocks: [],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("POST /users/:id/block — no auth → 401", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/block`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("POST /users/:id/block — self-block → 400", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/block`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 400);
  });

  it("POST /users/:id/block — invalid UUID → 400", async () => {
    const res = await fetch(`${url}/api/users/not-a-uuid/block`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 400);
  });

  it("POST /users/:id/block — valid block → 200 with blocked:true", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/block`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.blocked, true);
    assert.equal(body.userId, BOB_ID);
  });

  it("DELETE /users/:id/block — no auth → 401", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/block`, { method: "DELETE" });
    assert.equal(res.status, 401);
  });
});

// =============================================================================
// Section C — Trip chat: membership access control + removed-member response
// =============================================================================

describe("C — Trip chat: membership access control", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/groupChat.js");
    const client = makeClient({
      users: {
        "alice-tok": { id: ALICE_ID }, // accepted trip member
        "bob-tok":   { id: BOB_ID },   // invited (not accepted)
        "carol-tok": { id: CAROL_ID }, // not a member at all
        "dave-tok":  { id: "d4d4d4d4-0000-0000-0000-000000000004" }, // removed (left_at set)
      },
      tripMembers: [
        { trip_id: TRIP_ID, user_id: ALICE_ID, role: "member" },
        { trip_id: TRIP_ID, user_id: BOB_ID,   role: "invited" },
        { trip_id: TRIP_ID, user_id: "d4d4d4d4-0000-0000-0000-000000000004", role: "member" },
      ],
      threads:       [{ id: THREAD_ID, trip_id: TRIP_ID, thread_type: "trip", title: "Trip Chat", status: "active" }],
      threadMembers: [
        { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null },
        { thread_id: THREAD_ID, user_id: "d4d4d4d4-0000-0000-0000-000000000004", left_at: "2026-06-01T00:00:00Z" },
      ],
      messages: [],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("GET /trips/:id/chat — no auth → 401", async () => {
    const res = await fetch(`${url}/api/trips/${TRIP_ID}/chat`);
    assert.equal(res.status, 401);
  });

  it("GET /trips/:id/chat — non-member → 403 not_member", async () => {
    const res = await fetch(`${url}/api/trips/${TRIP_ID}/chat`, { headers: bearer("carol-tok") });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.error, "not_member");
  });

  it("GET /trips/:id/chat — invited-but-not-accepted → 403 pending_invite", async () => {
    const res = await fetch(`${url}/api/trips/${TRIP_ID}/chat`, { headers: bearer("bob-tok") });
    assert.equal(res.status, 403);
    const body = await res.json() as any;
    assert.equal(body.error, "pending_invite");
  });

  it("GET /trips/:id/chat — removed member returns 200 with memberAccess:'removed' and empty messages", async () => {
    const DAVE_ID = "d4d4d4d4-0000-0000-0000-000000000004";
    const res = await fetch(`${url}/api/trips/${TRIP_ID}/chat`, {
      headers: { Authorization: `Bearer dave-tok` },
    });
    // Route returns 200 for removed members — messages are empty, memberAccess signals removal
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.thread.memberAccess, "removed", "removed member sees memberAccess:removed");
    assert.deepEqual(body.messages, [], "removed member sees no messages");
  });

  it("GET /trips/:id/chat — invalid UUID → 400", async () => {
    const res = await fetch(`${url}/api/trips/not-a-uuid/chat`, { headers: bearer("alice-tok") });
    assert.equal(res.status, 400);
  });
});

// =============================================================================
// Section D — Safe Return: auth guard on all user-facing endpoints
// =============================================================================

describe("D — Safe Return routes: auth guard", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/safeReturn.js");
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID } },
      featureFlags: [
        { flag: "safe_return_enabled",            enabled: true },
        { flag: "safe_return_live_share_enabled", enabled: true },
      ],
      profiles: [{ id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("GET  /me/safe-return/history — no auth → 401",          async () => {
    assert.equal((await fetch(`${url}/api/me/safe-return/history`)).status, 401);
  });
  it("GET  /me/safe-return/sessions/active — no auth → 401",  async () => {
    assert.equal((await fetch(`${url}/api/me/safe-return/sessions/active`)).status, 401);
  });
  it("POST /me/safe-return/sessions — no auth → 401",         async () => {
    const res = await fetch(`${url}/api/me/safe-return/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planItemId: "plan-123" }),
    });
    assert.equal(res.status, 401);
  });
  it("GET  /me/safe-return/trusted-contacts — no auth → 401", async () => {
    assert.equal((await fetch(`${url}/api/me/safe-return/trusted-contacts`)).status, 401);
  });
});

// =============================================================================
// Section E — Follows routes: auth guard and self-follow prevention
// =============================================================================

describe("E — Follows routes: auth guard and self-follow prevention", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/follows.js");
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID } },
      profiles: [{ id: ALICE_ID }, { id: BOB_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("POST /users/:id/follow — no auth → 401", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/follow`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("POST /users/:id/follow — self-follow → 400", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 400);
  });

  it("DELETE /users/:id/follow — no auth → 401", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/follow`, { method: "DELETE" });
    assert.equal(res.status, 401);
  });
});

// =============================================================================
// Section F — Telegraph suggestions: removed thread member is denied
// =============================================================================

describe("F — Telegraph suggestions: removed-member access control", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/telegraphChat.js");
    const client = makeClient({
      users: {
        "alice-tok": { id: ALICE_ID }, // active thread member
        "bob-tok":   { id: BOB_ID },   // left the thread (left_at set)
        "carol-tok": { id: CAROL_ID }, // not a thread member at all
      },
      threadMembers: [
        { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null },
        { thread_id: THREAD_ID, user_id: BOB_ID,   left_at: "2026-06-01T00:00:00Z" },
      ],
      telegraphSuggestions: [],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("GET /threads/:id/telegraph/suggestions — no auth → 401", async () => {
    const res = await fetch(`${url}/api/threads/${THREAD_ID}/telegraph/suggestions`);
    assert.equal(res.status, 401);
  });

  it("GET /threads/:id/telegraph/suggestions — non-member → 403", async () => {
    const res = await fetch(`${url}/api/threads/${THREAD_ID}/telegraph/suggestions`, {
      headers: bearer("carol-tok"),
    });
    assert.equal(res.status, 403, "non-member should be denied");
    const body = await res.json() as any;
    assert.ok(body.error, "error field present");
  });

  it("GET /threads/:id/telegraph/suggestions — removed member (left_at set) → 403", async () => {
    const res = await fetch(`${url}/api/threads/${THREAD_ID}/telegraph/suggestions`, {
      headers: bearer("bob-tok"),
    });
    assert.equal(res.status, 403, "user who left the thread should be denied");
  });

  it("GET /threads/:id/telegraph/suggestions — active member → 200", async () => {
    const res = await fetch(`${url}/api/threads/${THREAD_ID}/telegraph/suggestions`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200, "active member should get suggestions list");
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.suggestions), "response has suggestions array");
  });

  it("GET /threads/:id/telegraph/suggestions — invalid UUID → 400", async () => {
    const res = await fetch(`${url}/api/threads/not-a-uuid/telegraph/suggestions`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 400);
  });
});

// =============================================================================
// Section G — canMessage() unit: block between users → verdict denied/blocked
// =============================================================================

describe("G — canMessage(): blocked user gets denied verdict", () => {
  it("canMessage returns denied/blocked when a block row exists between users", async () => {
    const { canMessage } = await import("../lib/messagingPermissions.js");

    const SENDER    = "aaaa0000-0000-0000-0000-000000000001";
    const RECIPIENT = "bbbb0000-0000-0000-0000-000000000002";

    // Fake client: blocks table has a row between sender and recipient.
    // canMessage calls .or() then .limit(1).maybeSingle() — our fake client
    // returns the first matching row from the blocks array regardless of .or()
    // (or() is a no-op in the fake client, which is acceptable for the block
    // table query since only one row exists).
    const fakeClient = {
      from(table: string) {
        const b: any = {
          select()  { return b; },
          eq()      { return b; },
          or()      { return b; },
          not()     { return b; },
          limit()   { return b; },
          in()      { return b; },
          maybeSingle: async () => {
            if (table === "blocks") {
              // Return a block row — sender blocked recipient
              return { data: { blocker_id: SENDER, blocked_id: RECIPIENT }, error: null };
            }
            return { data: null, error: null };
          },
          then: async (onF: any) => onF({ data: [], error: null }),
        };
        return b;
      },
    };

    const verdict = await canMessage(fakeClient as any, SENDER, RECIPIENT);
    assert.equal(verdict.verdict,  "denied",  "verdict should be denied");
    assert.equal(verdict.allowed,  false,     "allowed should be false");
    assert.equal(verdict.reason,   "blocked", "reason should be blocked");
  });

  it("canMessage returns denied/self when sender and recipient are the same", async () => {
    const { canMessage } = await import("../lib/messagingPermissions.js");
    const fakeClient = { from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    const verdict = await canMessage(fakeClient as any, ALICE_ID, ALICE_ID);
    assert.equal(verdict.verdict, "denied");
    assert.equal(verdict.reason,  "self");
  });
});

// =============================================================================
// Section H — open-thread: blocked user cannot create a direct thread
// =============================================================================

describe("H — open-thread: block prevents creating a direct thread", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/messaging.js");
    const client = makeClient({
      users: { "alice-tok": { id: ALICE_ID }, "bob-tok": { id: BOB_ID } },
      profiles: [{ id: ALICE_ID }, { id: BOB_ID }],
      // Bob has blocked Alice — block exists in both directions for the service client check
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
      userMessageSettings: [],
      userFriendships: [],
      userFollows: [],
      messageThreadMembers: [],
      trustRestrictions: [],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("POST /users/:id/open-thread — no auth → 401", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/open-thread`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  it("POST /users/:id/open-thread — self-message → 400", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/open-thread`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 400);
  });

  it("POST /users/:id/open-thread — blocked user → 403 forbidden", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/open-thread`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    // canMessage finds the block and returns denied → route returns 403
    assert.equal(res.status, 403, "blocked user should not be able to open a thread");
    const body = await res.json() as any;
    assert.ok(body.error, "error field present");
  });
});
