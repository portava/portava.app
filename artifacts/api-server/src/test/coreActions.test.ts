/**
 * Core Actions — Phase 4 tests (13 tests)
 *
 * Verifies that every social-action endpoint routes through the Phase 3
 * permission engine and that blocks/cooldowns are enforced end-to-end.
 *
 * Covered endpoints:
 *   POST /users/:id/friend-request  — permission engine blocks when blocked
 *   POST /users/:id/follow          — permission engine blocks when blocked
 *   POST /users/:id/mute            — mute + list + unmute
 *   POST /users/:id/save            — save + list + unsave
 *   POST /reports                   — create report + fetch own report
 *   GET  /users/:id/interaction-context — block is app-wide (all caps false)
 *   Anti-retaliation cooldown: friend_request cooldown prevents re-request
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run:
 *   node --import tsx/esm --test src/test/coreActions.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Shared UUIDs ──────────────────────────────────────────────────────────────

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID = "cccccccc-0000-0000-0000-000000000003";

// ── Fake Supabase client ──────────────────────────────────────────────────────
// Mirrors the fake client from interactionPermissions.test.ts; includes all
// tables that resolveInteractionPermissions queries plus the Phase 4 tables.

interface FakeState {
  users?:                   Record<string, { id: string } | null>;
  profiles?:                Array<Record<string, any>>;
  blocks?:                  Array<Record<string, any>>;
  user_follows?:            Array<Record<string, any>>;
  user_friendships?:        Array<Record<string, any>>;
  friend_requests?:         Array<Record<string, any>>;
  user_message_settings?:   Array<Record<string, any>>;
  message_requests?:        Array<Record<string, any>>;
  user_account_states?:     Array<Record<string, any>>;
  user_privacy_settings?:   Array<Record<string, any>>;
  user_mutes?:              Array<Record<string, any>>;
  user_restrictions?:       Array<Record<string, any>>;
  trust_restrictions?:      Array<Record<string, any>>;
  user_interaction_cooldowns?: Array<Record<string, any>>;
  moderation_actions?:      Array<Record<string, any>>;
  trip_members?:            Array<Record<string, any>>;
  circle_memberships?:      Array<Record<string, any>>;
  rent_buddy_bookings?:     Array<Record<string, any>>;
  user_saves?:              Array<Record<string, any>>;
  reports?:                 Array<Record<string, any>>;
  tags?:                    Array<Record<string, any>>;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    profiles:                   state.profiles ?? [],
    blocks:                     state.blocks ?? [],
    user_follows:               state.user_follows ?? [],
    user_friendships:           state.user_friendships ?? [],
    friend_requests:            state.friend_requests ?? [],
    user_message_settings:      state.user_message_settings ?? [],
    message_requests:           state.message_requests ?? [],
    user_account_states:        state.user_account_states ?? [],
    user_privacy_settings:      state.user_privacy_settings ?? [],
    user_mutes:                 state.user_mutes ?? [],
    user_restrictions:          state.user_restrictions ?? [],
    trust_restrictions:         state.trust_restrictions ?? [],
    user_interaction_cooldowns: state.user_interaction_cooldowns ?? [],
    moderation_actions:         state.moderation_actions ?? [],
    trip_members:               state.trip_members ?? [],
    circle_memberships:         state.circle_memberships ?? [],
    rent_buddy_bookings:        state.rent_buddy_bookings ?? [],
    user_saves:                 state.user_saves ?? [],
    reports:                    state.reports ?? [],
    tags:                       state.tags ?? [],
  };

  function from(table: string) {
    let active_filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;
    let upsertPayload: any = null;
    let updatePayload: any = null;
    let deleteOp = false;
    let _limit: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;

    const b: any = {
      select()              { return b; },
      insert(row: any)      { insertPayload = row; return b; },
      update(patch: any)    { updatePayload = patch; return b; },
      delete()              { deleteOp = true; return b; },
      upsert(row: any)      { upsertPayload = row; return b; },
      eq(col: string, val: any)    { active_filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { active_filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { active_filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        active_filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      or(expr: string) {
        function splitTop(s: string): string[] {
          const parts: string[] = [];
          let depth = 0, start = 0;
          for (let i = 0; i < s.length; i++) {
            if (s[i] === "(") depth++;
            else if (s[i] === ")") depth--;
            else if (s[i] === "," && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
          }
          parts.push(s.slice(start));
          return parts;
        }
        const topClauses = splitTop(expr);
        const matchers: Array<(r: any) => boolean> = [];
        for (const clause of topClauses) {
          const andM = clause.match(/^and\((.+)\)$/s);
          if (andM) {
            const subs = andM[1].split(",").map((p: string) => {
              const m = p.match(/^(\w+)\.(eq|neq)\.(.+)$/);
              if (!m) return () => true;
              const [, col, op, rawVal] = m;
              return op === "eq"
                ? (r: any) => String(r[col]) === rawVal
                : (r: any) => String(r[col]) !== rawVal;
            });
            matchers.push((r: any) => subs.every((f: (r: any) => boolean) => f(r)));
          } else {
            const m = clause.match(/^(\w+)\.(eq|neq)\.(.+)$/);
            if (m) {
              const [, col, op, rawVal] = m;
              if (op === "eq")  matchers.push((r: any) => String(r[col]) === rawVal);
              if (op === "neq") matchers.push((r: any) => String(r[col]) !== rawVal);
            }
          }
        }
        if (matchers.length > 0) active_filters.push((r) => matchers.some((f) => f(r)));
        return b;
      },
      not()    { return b; },
      limit(n: number) { _limit = n; return b; },
      order(col: string, opts: any) { _orderCol = col; _orderAsc = opts?.ascending ?? true; return b; },
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
      let source: any[] = db[table] ?? [];
      source = source.filter((r) => active_filters.every((f) => f(r)));
      if (_orderCol !== null) {
        const col = _orderCol, asc = _orderAsc;
        source = [...source].sort((a, bv) =>
          asc
            ? String(a[col] ?? "").localeCompare(String(bv[col] ?? ""))
            : String(bv[col] ?? "").localeCompare(String(a[col] ?? "")),
        );
      }
      if (_limit !== null) source = source.slice(0, _limit);
      return source;
    }

    async function resolveSingle(maybe: boolean) {
      if (upsertPayload) return { data: { id: "upserted-id", ...upsertPayload }, error: null };
      if (insertPayload) return { data: { id: "new-id", ...insertPayload }, error: null };
      if (updatePayload) {
        const matched = rows();
        return { data: matched[0] ? { ...matched[0], ...updatePayload } : null, error: null };
      }
      if (deleteOp) return { data: null, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (insertPayload) return { data: [{ id: "new-id", ...insertPayload }], error: null };
      if (upsertPayload) {
        const rows = Array.isArray(upsertPayload) ? upsertPayload : [upsertPayload];
        return { data: rows.map((r: any) => ({ id: "upserted-id", ...r })), error: null };
      }
      if (updatePayload) return { data: [], error: null };
      if (deleteOp) return { data: [], error: null };
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

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }

async function startServer(app: Express) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function makeApp(...routers: any[]): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  for (const router of routers) app.use("/api", router);
  return app;
}

// ── Default state helpers ─────────────────────────────────────────────────────

function baseProfiles(): Array<Record<string, any>> {
  return [
    { id: ALICE_ID, handle: "alice", name: "Alice", is_private: false, tag_permission: "everyone" },
    { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false, tag_permission: "everyone" },
    { id: CAROL_ID, handle: "carol", name: "Carol", is_private: false, tag_permission: "everyone" },
  ];
}

function baseUsers(): Record<string, { id: string }> {
  return {
    "alice-tok": { id: ALICE_ID },
    "bob-tok":   { id: BOB_ID },
    "carol-tok": { id: CAROL_ID },
  };
}

// =============================================================================
// Tests 1–3: Block is app-wide
// =============================================================================

describe("Block is app-wide — friend-request denied at the action endpoint", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: friendsRouter } = await import("../routes/friends.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Bob blocks Alice — so Alice's attempts to act on Bob are forbidden
      blocks:   [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(friendsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("1. blocked user's friend-request returns 403", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/friend-request`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
    });
    assert.equal(res.status, 403, "block must prevent friend request at the action endpoint");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("Block is app-wide — follow denied at the action endpoint", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: followsRouter } = await import("../routes/follows.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Alice blocks Bob — Bob cannot follow Alice
      blocks: [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(followsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("2. blocked user's follow attempt returns 403", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("bob-tok"),
    });
    assert.equal(res.status, 403, "block must prevent follow at the action endpoint");
  });
});

describe("Block is app-wide — all capabilities false via interaction-context", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: ctxRouter } = await import("../routes/interactionContext.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      blocks:   [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(ctxRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("3. block disables message, invite, booking, tag, friend in one context check", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    // All capabilities must be false for the blocker's view of blocked user
    assert.equal(body.canMessage,          false, "block prevents message");
    assert.equal(body.canAddFriend,        false, "block prevents friend request");
    assert.equal(body.canTag,              false, "block prevents tag");
    assert.equal(body.canInviteToEvent,    false, "block prevents event invite");
    assert.equal(body.canInviteToCircle,   false, "block prevents circle invite");
    assert.equal(body.canInviteToTripCrew, false, "block prevents trip crew invite");
    assert.equal(body.canBookBuddy,        false, "block prevents booking");
    assert.equal(body.relationshipLabel, "blocked", "label must reflect blocked");
  });
});

// =============================================================================
// Tests 4–6: Mute routes
// =============================================================================

describe("Mute — mute a user", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: mutesRouter } = await import("../routes/mutes.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(mutesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("4. POST /users/:id/mute returns 200 with muted=true", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/mute`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ mute_types: ["messages", "posts"] }),
    });
    assert.equal(res.status, 200, "mute should succeed");
    const body = await res.json() as any;
    assert.equal(body.muted, true);
    assert.equal(body.userId, BOB_ID);
    assert.deepEqual(body.muteTypes, ["messages", "posts"]);
  });

  it("5. GET /me/mutes lists pre-populated mute rows", async () => {
    // Re-use server with a client that has a mute pre-populated
    const { default: router } = await import("../routes/mutes.js");
    const client2 = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_mutes: [{
        id: "m1", muter_id: ALICE_ID, muted_id: BOB_ID,
        mute_types: ["all"], created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client2, true);
    const { url: url2, close: close2 } = await startServer(makeApp(router));
    const res = await fetch(`${url2}/api/me/mutes`, { headers: bearer("alice-tok") });
    await close2();
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.muted), "muted must be an array");
    assert.equal(body.muted.length, 1, "one muted user in list");
    assert.equal(body.muted[0].id, BOB_ID);
  });

  it("6. DELETE /users/:id/mute returns 200 with muted=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/mute`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.muted, false);
    assert.equal(body.userId, BOB_ID);
  });
});

// =============================================================================
// Tests 7–9: Save routes
// =============================================================================

describe("Save — save a profile", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: savesRouter } = await import("../routes/saves.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(savesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("7. POST /users/:id/save returns 200 with saved=true", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/save`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200, "save should succeed");
    const body = await res.json() as any;
    assert.equal(body.saved, true);
    assert.equal(body.userId, BOB_ID);
  });

  it("8. GET /me/saves lists pre-populated save rows", async () => {
    const { default: router } = await import("../routes/saves.js");
    const client2 = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_saves: [{
        id: "s1", saver_id: ALICE_ID, saved_id: BOB_ID,
        created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client2, true);
    const { url: url2, close: close2 } = await startServer(makeApp(router));
    const res = await fetch(`${url2}/api/me/saves`, { headers: bearer("alice-tok") });
    await close2();
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.saves), "saves must be an array");
    assert.equal(body.saves.length, 1, "one saved profile");
    assert.equal(body.saves[0].id, BOB_ID);
  });

  it("9. DELETE /users/:id/save returns 200 with saved=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/save`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.saved, false);
    assert.equal(body.userId, BOB_ID);
  });
});

// =============================================================================
// Tests 10–11: Save blocked when target has blocked saver
// =============================================================================

describe("Save — blocked when target blocks saver", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: savesRouter } = await import("../routes/saves.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Bob has blocked Alice — Alice cannot save Bob
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(savesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("10. POST /users/:id/save returns 403 when target has blocked saver", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/save`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 403, "block must prevent save");
  });
});

// =============================================================================
// Tests 11–12: Report routes
// =============================================================================

describe("Report — create and fetch a report", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: reportsRouter } = await import("../routes/reports.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(reportsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("11. POST /reports creates a report and returns reportId + status", async () => {
    const res = await fetch(`${url}/api/reports`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({
        target_type: "user",
        target_id:   BOB_ID,
        reason_code: "spam",
        reason_detail: "Keeps spamming with promotional content",
      }),
    });
    assert.equal(res.status, 201, "report creation should return 201");
    const body = await res.json() as any;
    assert.ok(body.reportId, "reportId must be present");
    assert.equal(body.status, "open");
    assert.ok(body.severity, "severity must be present");
  });

  it("12. GET /reports/:id returns own report (pre-populated)", async () => {
    const { default: router } = await import("../routes/reports.js");
    const REPORT_ID = "a1b2c3d4-0000-0000-0000-000000000001";
    const client2 = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      reports: [{
        id: "a1b2c3d4-0000-0000-0000-000000000001", reporter_id: ALICE_ID, target_type: "user",
        target_id: BOB_ID, reason_code: "spam", severity: "normal",
        status: "open", created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client2, true);
    const { url: url2, close: close2 } = await startServer(makeApp(router));
    const res = await fetch(`${url2}/api/reports/${REPORT_ID}`, {
      headers: bearer("alice-tok"),
    });
    await close2();
    assert.equal(res.status, 200, "reporter can read their own report");
    const body = await res.json() as any;
    assert.equal(body.id, REPORT_ID);
    assert.equal(body.reason_code, "spam");
  });
});

// =============================================================================
// Test 13: Anti-retaliation cooldown blocks friend request
// =============================================================================

describe("Anti-retaliation — friend_request cooldown blocks re-request", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: friendsRouter } = await import("../routes/friends.js");
    // State: Alice's previous request was declined → active cooldown row exists
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_interaction_cooldowns: [
        {
          user_id:        ALICE_ID,
          target_user_id: BOB_ID,
          cooldown_type:  "friend_request",
          expires_at:     new Date(Date.now() + 86_400_000).toISOString(), // expires tomorrow
        },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(friendsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("13. friend request blocked during active anti-retaliation cooldown", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/friend-request`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
    });
    // canAddFriend=false because friend_request cooldown is active (Phase 3 engine)
    assert.notEqual(res.status, 201, "should NOT create a new friend request during cooldown");
    const body = await res.json() as any;
    // Either 400 invalid_payload or 403 forbidden — both are acceptable rejections
    assert.ok(res.status === 400 || res.status === 403,
      `expected 400 or 403 but got ${res.status}: ${JSON.stringify(body)}`);
  });
});
// =============================================================================
// Tests 14–18: Extended block-app-wide + restrict + mute-update
// =============================================================================

describe("Block is app-wide — message-request denied at the action endpoint", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: messagingRouter } = await import("../routes/messaging.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Bob has blocked Alice — Alice cannot send him a message request
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(messagingRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("14. blocked user's message-request returns 403", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/message-request`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ previewText: "Hi!" }),
    });
    assert.equal(res.status, 403, "block must prevent message-request at the action endpoint");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("Restrict — restrict and unrestrict a user", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: restrictRouter } = await import("../routes/restrict.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(restrictRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("15. POST /users/:id/restrict returns 200 with restricted=true", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/restrict`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "unwanted contact" }),
    });
    assert.equal(res.status, 200, "restrict should succeed");
    const body = await res.json() as any;
    assert.equal(body.restricted, true);
    assert.equal(body.userId, BOB_ID);
  });

  it("16. DELETE /users/:id/restrict returns 200 with restricted=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/restrict`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.restricted, false);
    assert.equal(body.userId, BOB_ID);
  });
});

describe("Block is app-wide — restrict denied when blocked", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: restrictRouter } = await import("../routes/restrict.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Bob has blocked Alice — permission engine ALL_FALSE → canRestrict=false
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(restrictRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("17. POST /users/:id/restrict returns 403 when blocked", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/restrict`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
    });
    assert.equal(res.status, 403, "block must prevent restrict action");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("Mute — update mute_types on an existing mute (idempotent)", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: mutesRouter } = await import("../routes/mutes.js");
    // Pre-populate an existing mute row for Alice muting Bob
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_mutes: [{
        id: "m1", muter_id: ALICE_ID, muted_id: BOB_ID,
        mute_types: ["all"], created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(mutesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("18. POST /users/:id/mute with updated types returns 200 when already muted", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/mute`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ mute_types: ["messages", "posts"] }),
    });
    assert.equal(res.status, 200, "should allow updating mute types on existing mute");
    const body = await res.json() as any;
    assert.equal(body.muted, true);
    assert.deepEqual(body.muteTypes, ["messages", "posts"]);
  });
});

describe("Block is app-wide — requests.ts friend_request accept denied when requester blocked", () => {
  let url: string;
  let close: () => Promise<void>;

  const FR_ID = "f1111111-0000-0000-0000-000000000001";

  before(async () => {
    const { default: requestsRouter } = await import("../routes/requests.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Bob sent a friend request to Alice but has since blocked Alice
      friend_requests: [{
        id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending",
        created_at: new Date().toISOString(),
      }],
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(requestsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("19. requests.ts friend_request accept returns 403 when requester has blocked recipient", async () => {
    const res = await fetch(`${url}/api/me/requests/friend_request/${FR_ID}/accept`, {
      method: "POST",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 403, "block must prevent friend-request acceptance via requests.ts");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

// =============================================================================
// Tests 20–22: Tag action gating + follow cooldown
// =============================================================================

const SOURCE_UUID = "d1d1d1d1-0000-0000-0000-000000000001";

describe("Tag action — blocked user cannot tag", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: tagsRouter } = await import("../routes/tags.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      // Alice blocks Bob — Bob cannot tag Alice
      blocks: [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(tagsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("20. POST /tags returns 403 when tagger is blocked by target", async () => {
    const res = await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { ...bearer("bob-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "post", source_id: SOURCE_UUID, tagged_user_id: ALICE_ID }),
    });
    assert.equal(res.status, 403, "block must prevent tagging at the action endpoint");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("Tag action — tag_permission='no_one' blocks tag", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: tagsRouter } = await import("../routes/tags.js");
    // Carol sets tag_permission to 'no_one'
    const profiles = baseProfiles().map((p) =>
      p.id === CAROL_ID ? { ...p, tag_permission: "no_one" } : p,
    );
    const client = makeClient({ users: baseUsers(), profiles });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(tagsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("21. POST /tags returns 403 when target tag_permission is no_one", async () => {
    const res = await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "post", source_id: SOURCE_UUID, tagged_user_id: CAROL_ID }),
    });
    assert.equal(res.status, 403, "tag_permission=no_one must prevent tagging");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("Tag action — approval_required tag_permission returns 202 pending", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: tagsRouter } = await import("../routes/tags.js");
    // Carol's tag_permission is 'approval_required' — tag inserts as pending
    const profiles = baseProfiles().map((p) =>
      p.id === CAROL_ID ? { ...p, tag_permission: "approval_required" } : p,
    );
    const client = makeClient({ users: baseUsers(), profiles });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(tagsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("23. POST /tags with approval_required returns 202 with status=pending", async () => {
    const res = await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { ...bearer("alice-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "post", source_id: SOURCE_UUID, tagged_user_id: CAROL_ID }),
    });
    assert.equal(res.status, 202, "approval_required must return 202 Accepted (pending)");
    const body = await res.json() as any;
    assert.equal(body.status, "pending", "response must include status=pending");
    assert.ok(body.tagId, "response must include tagId");
  });
});

describe("Tag action — location source requires friendship", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: tagsRouter } = await import("../routes/tags.js");
    // Alice and Bob are NOT friends — Bob cannot location-tag Alice
    const client = makeClient({ users: baseUsers(), profiles: baseProfiles() });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(tagsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("24. POST /tags with place_checkin source_type returns 403 when not friends", async () => {
    const res = await fetch(`${url}/api/tags`, {
      method: "POST",
      headers: { ...bearer("bob-tok"), "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "place_checkin", source_id: SOURCE_UUID, tagged_user_id: ALICE_ID }),
    });
    assert.equal(res.status, 403, "location tag must require friendship");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("DELETE /users/:id/mute proceeds when blocked (undo-own-action)", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: mutesRouter } = await import("../routes/mutes.js");
    // Alice has Bob muted AND Bob has now blocked Alice — Alice can still unmute
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      blocks:   [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
      user_mutes: [{
        id: "m1", muter_id: ALICE_ID, muted_id: BOB_ID,
        mute_types: ["all"], created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(mutesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("25. DELETE /users/:id/mute returns 200 even when target has blocked caller (canUnsaveProfile=true)", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/mute`, {
      method: "DELETE",
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200, "unmute must succeed even when target blocked caller");
    const body = await res.json() as any;
    assert.equal(body.muted, false);
  });
});

describe("Follow cooldown — active follow cooldown blocks follow attempt", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: followsRouter } = await import("../routes/follows.js");
    // Bob has an active follow cooldown toward Alice (set when a block was removed)
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_interaction_cooldowns: [{
        user_id:        BOB_ID,
        target_user_id: ALICE_ID,
        cooldown_type:  "follow",
        expires_at:     new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(followsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("22. POST /users/:id/follow returns 403 during active follow cooldown", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("bob-tok"),
    });
    assert.equal(res.status, 403, "follow cooldown must prevent follow at the action endpoint");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

// =============================================================================
// Tests 26–29: Status/list endpoints for mute, save, restrict
// (Verifies GET /me/restrictions, /users/:id/mute-status, /users/:id/save-status,
//  /users/:id/restrict-status — routes implemented in Phase 5/6, confirmed here)
// =============================================================================

describe("Mute — GET /users/:id/mute-status reflects active mute", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: mutesRouter } = await import("../routes/mutes.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_mutes: [{
        id: "ms1", muter_id: ALICE_ID, muted_id: BOB_ID,
        mute_types: ["messages", "posts"], created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(mutesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("26. GET /users/:id/mute-status returns muted=true with muteTypes when mute exists", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/mute-status`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.userId, BOB_ID);
    assert.equal(body.muted, true);
    assert.deepEqual(body.muteTypes, ["messages", "posts"]);
  });
});

describe("Save — GET /users/:id/save-status reflects active save", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: savesRouter } = await import("../routes/saves.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_saves: [{
        id: "sv1", saver_id: ALICE_ID, saved_id: BOB_ID,
        created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(savesRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("27. GET /users/:id/save-status returns saved=true when save row exists", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/save-status`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.userId, BOB_ID);
    assert.equal(body.saved, true);
  });
});

describe("Restrict — GET /me/restrictions lists restricted users", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: restrictRouter } = await import("../routes/restrict.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_restrictions: [{
        id: "r1", restrictor_id: ALICE_ID, restricted_id: BOB_ID,
        options: { reason: "unwanted contact" }, created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(restrictRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("28. GET /me/restrictions returns list including pre-populated restriction", async () => {
    const res = await fetch(`${url}/api/me/restrictions`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.restricted), "should return restricted array");
    assert.equal(body.restricted.length, 1);
    assert.equal(body.restricted[0].id, BOB_ID);
    assert.equal(body.restricted[0].restrictionReason, "unwanted contact");
  });
});

describe("Restrict — GET /users/:id/restrict-status reflects active restriction", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: restrictRouter } = await import("../routes/restrict.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_restrictions: [{
        id: "r2", restrictor_id: ALICE_ID, restricted_id: BOB_ID,
        options: { reason: "manual" }, created_at: new Date().toISOString(),
      }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(restrictRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("29. GET /users/:id/restrict-status returns restricted=true when restriction exists", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/restrict-status`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.userId, BOB_ID);
    assert.equal(body.restricted, true);
    assert.equal(body.restrictionReason, "manual");
  });
});

// =============================================================================
// Tests 30–33: interaction-context extended response fields
// Verifies the augmented fields (iBlocked, theyBlockedMe, iMuted, iRestricted,
// context.isFriend, context.areMutualFollowers) that the mobile permission
// engine and relationship-label hook depend on directly.
// =============================================================================

describe("interaction-context — iBlocked / theyBlockedMe derived from relationshipLabel", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: ctxRouter } = await import("../routes/interactionContext.js");
    // Viewer (alice) blocks target (bob) → iBlocked=true, theyBlockedMe=false
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      blocks:   [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(ctxRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("30. iBlocked=true and theyBlockedMe=false when viewer blocks target", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.iBlocked,      true,  "viewer blocks target → iBlocked");
    assert.equal(body.theyBlockedMe, false, "viewer blocks target → theyBlockedMe=false");
    assert.equal(body.canViewProfile, false, "block hides profile");
  });
});

describe("interaction-context — theyBlockedMe when target is the blocker", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: ctxRouter } = await import("../routes/interactionContext.js");
    // Target (bob) blocks viewer (alice) → theyBlockedMe=true, iBlocked=false
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      blocks:   [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(ctxRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("31. theyBlockedMe=true and iBlocked=false when target blocks viewer", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.theyBlockedMe, true,  "target blocks viewer → theyBlockedMe");
    assert.equal(body.iBlocked,      false, "target blocks viewer → iBlocked=false");
  });
});

describe("interaction-context — iMuted and iRestricted from interaction tables", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: ctxRouter } = await import("../routes/interactionContext.js");
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_mutes: [
        { id: "m1", muter_id: ALICE_ID, muted_id: BOB_ID,
          mute_types: ["all"], created_at: new Date().toISOString() },
      ],
      user_restrictions: [
        { id: "r1", restrictor_id: ALICE_ID, restricted_id: BOB_ID,
          options: {}, created_at: new Date().toISOString() },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(ctxRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("32. iMuted=true and iRestricted=true when both interaction rows exist", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.iMuted,      true, "mute row exists → iMuted");
    assert.equal(body.iRestricted, true, "restriction row exists → iRestricted");
  });
});

describe("interaction-context — context.areMutualFollowers and context.isFriend", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: ctxRouter } = await import("../routes/interactionContext.js");
    // Mutual follows: alice→bob and bob→alice → areMutualFollowers=true, isFriend=false
    const client = makeClient({
      users:    baseUsers(),
      profiles: baseProfiles(),
      user_follows: [
        { follower_id: ALICE_ID, following_id: BOB_ID, created_at: new Date().toISOString() },
        { follower_id: BOB_ID,   following_id: ALICE_ID, created_at: new Date().toISOString() },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(ctxRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("33. areMutualFollowers=true and isFriend=false for mutual-follow relationship", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.context.areMutualFollowers, true,  "mutual follows → areMutualFollowers");
    assert.equal(body.context.isFriend,           false, "mutual follows only → isFriend=false");
    assert.equal(body.iBlocked,                   false, "no block");
    assert.equal(body.iMuted,                     false, "no mute row");
    assert.equal(body.iRestricted,                false, "no restriction row");
  });
});

// =============================================================================
// Tests 34–36: SEC-01 — private-profile follow → friend-request redirect
// =============================================================================

describe("SEC-01 — follow of private profile creates a friend request", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: followsRouter } = await import("../routes/follows.js");
    // Alice is private; Bob (stranger, not suspended) follows her
    const client = makeClient({
      users:    baseUsers(),
      profiles: [
        { id: ALICE_ID, handle: "alice", name: "Alice", is_private: true, tag_permission: "everyone" },
        { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false, tag_permission: "everyone" },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(followsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("34. POST /users/:id/follow on a private profile returns 201 with friendRequest=true", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("bob-tok"),
    });
    assert.equal(res.status, 201, "private-profile follow must create a friend request (201)");
    const body = await res.json() as any;
    assert.equal(body.friendRequest,  true,               "friendRequest must be true");
    assert.equal(body.following,      false,              "follow must NOT be set");
    assert.equal(body.status,         "outgoing_pending", "request must start as outgoing_pending");
  });
});

describe("SEC-01 — suspended user cannot create friend request via follow on private profile", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: followsRouter } = await import("../routes/follows.js");
    // Alice is private; Bob is suspended
    const client = makeClient({
      users:    baseUsers(),
      profiles: [
        { id: ALICE_ID, handle: "alice", name: "Alice", is_private: true, tag_permission: "everyone" },
        { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false, tag_permission: "everyone" },
      ],
      user_account_states: [{ user_id: BOB_ID, state: "suspended" }],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(followsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("35. suspended user's follow of a private profile is rejected (400)", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("bob-tok"),
    });
    assert.equal(res.status, 400, "suspended user must not be able to send a friend request via follow");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});

describe("SEC-01 — follow of private profile blocked when outgoing request already pending", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: followsRouter } = await import("../routes/follows.js");
    // Alice is private; Bob already has a pending outgoing request.
    // canAddFriend=false (!hasOutgoingFriendReq), canAcceptFriendRequest=false
    // → same behaviour as friends.ts: invalid_payload (400).
    const client = makeClient({
      users:    baseUsers(),
      profiles: [
        { id: ALICE_ID, handle: "alice", name: "Alice", is_private: true, tag_permission: "everyone" },
        { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false, tag_permission: "everyone" },
      ],
      friend_requests: [
        { id: "req-001", requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: new Date().toISOString() },
      ],
    });
    _setTestClient(client, true);
    const srv = await startServer(makeApp(followsRouter));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("36. follow with existing pending request returns 400 — same gate as friends route", async () => {
    const res = await fetch(`${url}/api/users/${ALICE_ID}/follow`, {
      method: "POST",
      headers: bearer("bob-tok"),
    });
    // canAddFriend=false because a pending outgoing request already exists;
    // canAcceptFriendRequest=false (no incoming request). Permission gate fires.
    assert.equal(res.status, 400, "must not create a duplicate request when one is already pending");
    const body = await res.json() as any;
    assert.ok(body.error, "error body must have an error code");
  });
});
