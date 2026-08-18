/**
 * Messaging routes — backend tests
 *
 * Tests:
 *   1. GET /api/me/message-settings    — returns defaults / stored settings
 *   2. GET /api/users/:id/outgoing-request — pending status lookup
 *   3. POST /api/users/:id/open-thread — blocked users get 403, invalid ids get 400
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run:
 *   node --import tsx/esm --test src/test/messaging.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const REQ_ID    = "rrrrrrrr-0000-0000-0000-000000000001";
const THREAD_ID = "tttttttt-0000-0000-0000-000000000001";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  user_message_settings?: any[];
  message_requests?: any[];
  blocks?: any[];
  user_account_states?: any[];
  user_restrictions?: any[];
  trust_restrictions?: any[];
  user_follows?: any[];
  user_friendships?: any[];
  trip_members?: any[];
  circle_memberships?: any[];
  rent_buddy_bookings?: any[];
  message_threads?: any[];
  message_thread_members?: any[];
  messages?: any[];
  message_translations?: any[];
  profiles?: any[];
  feature_flags?: any[];
  user_privacy_settings?: any[];
  profile_privacy_settings?: any[];
  /**
   * Injects a query error on trust_restrictions specifically, to exercise
   * getRestrictionState's fail-closed path. { code: '42P01' } instead
   * exercises the fail-open (missing-table) path.
   */
  trust_restrictions_error?: { code?: string; message: string };
  /**
   * 1-indexed call number (across all trust_restrictions reads in this
   * request) from which trust_restrictions_error starts firing. Default 1
   * (every read fails). Set to 2 to let the first read (
   * resolveInteractionPermissions) succeed and only fail the second
   * (getRestrictionState) — isolating the read this change added.
   */
  trust_restrictions_error_from_call?: number;
}

function makeClient(state: FakeState = {}, authUserId = ALICE_ID) {
  const db: Record<string, any[]> = {
    user_message_settings:  state.user_message_settings  ?? [],
    message_requests:       state.message_requests        ?? [],
    blocks:                 state.blocks                  ?? [],
    user_account_states:    state.user_account_states     ?? [],
    user_restrictions:      state.user_restrictions       ?? [],
    trust_restrictions:     state.trust_restrictions      ?? [],
    user_follows:           state.user_follows            ?? [],
    user_friendships:       state.user_friendships        ?? [],
    trip_members:           state.trip_members            ?? [],
    circle_memberships:     state.circle_memberships      ?? [],
    rent_buddy_bookings:    state.rent_buddy_bookings     ?? [],
    message_threads:        state.message_threads         ?? [],
    message_thread_members: state.message_thread_members  ?? [],
    messages:               state.messages                ?? [],
    message_translations:   state.message_translations    ?? [],
    profiles: state.profiles ?? [
      { id: ALICE_ID, handle: "alice", name: "Alice" },
      { id: BOB_ID,   handle: "bob",   name: "Bob"   },
    ],
    feature_flags:             state.feature_flags             ?? [],
    user_privacy_settings:     state.user_privacy_settings     ?? [],
    profile_privacy_settings:  state.profile_privacy_settings  ?? [],
  };

  // POST /users/:userId/message-request reads trust_restrictions TWICE:
  // resolveInteractionPermissions reads it first (its own, separate
  // concern), TrustRestrictionService.getRestrictionState reads it second
  // (what this change wires up). Injecting the error unconditionally would
  // make BOTH reads fail identically, so a real HTTP test could never reach
  // — or distinguish a mutation in — the second read's branch specifically.
  // Firing the injected error from the Nth trust_restrictions call onward
  // isolates the read this change actually touches.
  let trustRestrictionsCallCount = 0;

  function parseOrFilter(expr: string): (r: any) => boolean {
    const rawGroups = expr.split(/\),\s*(?:and|or)\(/);
    const groups = rawGroups.map((g) =>
      g.replace(/^(?:and|or)\(/, "").replace(/\)$/, ""),
    );
    return (r: any) =>
      groups.some((group) =>
        group.split(",").every((cond) => {
          const idx = cond.indexOf(".eq.");
          if (idx === -1) return true;
          const col = cond.slice(0, idx).trim();
          const val = cond.slice(idx + 4).trim();
          return String(r[col]) === String(val);
        }),
      );
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _insertResult: any = null;
    let _inserted = false;
    let _limit: number | null = null;

    const b: any = {
      select()                     { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      or(expr: string)             { filters.push(parseOrFilter(expr)); return b; },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.map(String).includes(String(r[col])));
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      like()                       { return b; },
      limit(n: number)             { _limit = n; return b; },
      order()                      { return b; },
      insert(payload: any) {
        _inserted = true;
        if (Array.isArray(payload)) {
          const rows = payload.map((r, i) => ({ id: `auto-${i}`, ...r }));
          (db[table] ??= []).push(...rows);
          _insertResult = rows[0];
        } else {
          const row = { id: THREAD_ID, ...payload };
          (db[table] ??= []).push(row);
          _insertResult = row;
        }
        return b;
      },
      update(patch: any) {
        (db[table] ?? [])
          .filter((r) => filters.every((f) => f(r)))
          .forEach((r) => Object.assign(r, patch));
        return b;
      },
      upsert(payload: any) {
        _inserted = true;
        const row = Array.isArray(payload)
          ? { id: THREAD_ID, ...payload[0] }
          : { id: THREAD_ID, ...payload };
        (db[table] ??= []).push(row);
        _insertResult = row;
        return b;
      },
      maybeSingle(): Promise<{ data: any; error: any }> {
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const sliced = _limit !== null ? rows.slice(0, _limit) : rows;
        return Promise.resolve({ data: sliced[0] ?? null, error: null });
      },
      single(): Promise<{ data: any; error: any }> {
        if (_inserted) return Promise.resolve({ data: _insertResult, error: null });
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (table === "trust_restrictions" && state.trust_restrictions_error) {
          trustRestrictionsCallCount += 1;
          const threshold = state.trust_restrictions_error_from_call ?? 1;
          if (trustRestrictionsCallCount >= threshold) {
            return Promise.resolve({ data: null, error: state.trust_restrictions_error }).then(resolve, reject);
          }
        }
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const sliced = _limit !== null ? rows.slice(0, _limit) : rows;
        return Promise.resolve({ data: sliced, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from,
    auth: {
      getUser: async (_token: string) => ({
        data: { user: { id: authUserId } },
        error: null,
      }),
    },
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

let baseUrl = "";
let httpServer: ReturnType<typeof createServer>;

function callApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", messagingRouter);
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(async () => {
  _setTestClient(null as any);
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/me/threads — Telegraph 'Unknown' display-name bug", () => {
  it("resolves the other participant's real name (display_name) for a direct thread, not 'Unknown'", async () => {
    _setTestClient(
      makeClient({
        message_threads: [
          {
            id: THREAD_ID,
            thread_type: "direct",
            trip_id: null,
            circle_owner_id: null,
            title: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            status: "active",
          },
        ],
        message_thread_members: [
          { user_id: ALICE_ID, thread_id: THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
          { user_id: BOB_ID,   thread_id: THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
        ],
        // profiles.name does not exist on the live schema — only
        // display_name/handle do. This regression guards against the API
        // silently returning "Unknown" when it selects a nonexistent
        // "name" column instead of "display_name".
        profiles: [
          { id: ALICE_ID, handle: "alice", display_name: "Alice Traveler", avatar_url: null },
          { id: BOB_ID,   handle: "bob",   display_name: "Bob Explorer",   avatar_url: null },
        ],
        profile_privacy_settings: [
          { user_id: ALICE_ID, show_real_name: true },
          { user_id: BOB_ID,   show_real_name: true },
        ],
      }, ALICE_ID) as any,
      true,
    );

    const res = await callApi("GET", "/api/me/threads");
    assert.equal(res.status, 200);
    const thread = res.body.threads.find((t: any) => t.id === THREAD_ID);
    assert.ok(thread, "thread must be present in the list");
    const other = thread.otherMembers?.[0];
    assert.ok(other, "otherMembers must include Bob for this direct thread");
    assert.equal(other.id, BOB_ID);
    assert.equal(other.name, "Bob Explorer", `expected Bob's display_name, got: ${JSON.stringify(other)}`);
    assert.notEqual(other.name, null, "must not fall back to Unknown when display_name is opted-in and present");
  });

  it("falls back to @handle (not a null name) when the other participant has not opted in to showing their real name", async () => {
    _setTestClient(
      makeClient({
        message_threads: [
          {
            id: THREAD_ID,
            thread_type: "direct",
            trip_id: null,
            circle_owner_id: null,
            title: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            status: "active",
          },
        ],
        message_thread_members: [
          { user_id: ALICE_ID, thread_id: THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
          { user_id: BOB_ID,   thread_id: THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
        ],
        profiles: [
          { id: ALICE_ID, handle: "alice", display_name: "Alice Traveler", avatar_url: null },
          { id: BOB_ID,   handle: "bob",   display_name: "Bob Explorer",   avatar_url: null },
        ],
        // Bob has NOT opted in — name must be redacted, but handle must
        // still be present so the client shows "@bob", never "Unknown".
        profile_privacy_settings: [
          { user_id: ALICE_ID, show_real_name: true },
        ],
      }, ALICE_ID) as any,
      true,
    );

    const res = await callApi("GET", "/api/me/threads");
    assert.equal(res.status, 200);
    const thread = res.body.threads.find((t: any) => t.id === THREAD_ID);
    const other = thread.otherMembers?.[0];
    assert.ok(other, "otherMembers must include Bob for this direct thread");
    assert.equal(other.handle, "bob", "handle must always be present so the client can fall back to @handle");
    assert.equal(other.name, null, "name must be redacted (null) when not opted in — client falls back to @handle, not the API");
  });
});

describe("GET /api/me/message-settings", () => {
  it("returns defaults when no settings row exists", async () => {
    _setTestClient(makeClient({ user_message_settings: [] }) as any, true);
    const { status, body } = await callApi("GET", "/api/me/message-settings");
    assert.equal(status, 200);
    assert.equal(body.message_privacy, "everyone");
    assert.equal(body.allow_message_requests, true);
    assert.equal(body.allow_trip_member_messages, true);
    assert.equal(body.allow_circle_member_messages, true);
  });

  it("returns stored settings when a row exists", async () => {
    _setTestClient(
      makeClient({
        user_message_settings: [
          {
            user_id: ALICE_ID,
            message_privacy: "friends",
            allow_message_requests: false,
            allow_trip_member_messages: true,
            allow_circle_member_messages: false,
            updated_at: null,
          },
        ],
      }) as any,
      true,
    );
    const { status, body } = await callApi("GET", "/api/me/message-settings");
    assert.equal(status, 200);
    assert.equal(body.message_privacy, "friends");
    assert.equal(body.allow_message_requests, false);
    assert.equal(body.allow_circle_member_messages, false);
  });
});

describe("GET /api/users/:userId/outgoing-request", () => {
  it("returns pending:false when no request exists", async () => {
    _setTestClient(makeClient({ message_requests: [] }) as any, true);
    const { status, body } = await callApi(
      "GET",
      `/api/users/${BOB_ID}/outgoing-request`,
    );
    assert.equal(status, 200);
    assert.equal(body.pending, false);
    assert.equal(body.requestId, null);
  });

  it("returns pending:true with requestId when a pending request exists", async () => {
    _setTestClient(
      makeClient({
        message_requests: [
          { id: REQ_ID, sender_id: ALICE_ID, recipient_id: BOB_ID, status: "pending" },
        ],
      }) as any,
      true,
    );
    const { status, body } = await callApi(
      "GET",
      `/api/users/${BOB_ID}/outgoing-request`,
    );
    assert.equal(status, 200);
    assert.equal(body.pending, true);
    assert.equal(body.requestId, REQ_ID);
  });

  it("returns pending:false when the only request is accepted (not pending)", async () => {
    _setTestClient(
      makeClient({
        message_requests: [
          { id: REQ_ID, sender_id: ALICE_ID, recipient_id: BOB_ID, status: "accepted" },
        ],
      }) as any,
      true,
    );
    const { status, body } = await callApi(
      "GET",
      `/api/users/${BOB_ID}/outgoing-request`,
    );
    assert.equal(status, 200);
    assert.equal(body.pending, false);
  });

  it("returns 400 for an invalid user id", async () => {
    _setTestClient(makeClient() as any, true);
    const { status } = await callApi("GET", "/api/users/not-a-uuid/outgoing-request");
    assert.equal(status, 400);
  });
});

describe("POST /api/users/:userId/open-thread", () => {
  it("returns 400 for an invalid (non-UUID) user id", async () => {
    _setTestClient(makeClient() as any, true);
    const { status } = await callApi("POST", "/api/users/not-a-uuid/open-thread");
    assert.equal(status, 400);
  });

  it("returns 400 when the viewer tries to message themselves", async () => {
    _setTestClient(makeClient() as any, true);
    const { status } = await callApi("POST", `/api/users/${ALICE_ID}/open-thread`);
    assert.equal(status, 400);
  });

  it("returns 403 when viewer has blocked the target", async () => {
    _setTestClient(
      makeClient({ blocks: [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }] }) as any,
      true,
    );
    const { status } = await callApi("POST", `/api/users/${BOB_ID}/open-thread`);
    assert.equal(status, 403);
  });

  it("returns 403 when target has blocked the viewer", async () => {
    _setTestClient(
      makeClient({ blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }] }) as any,
      true,
    );
    const { status } = await callApi("POST", `/api/users/${BOB_ID}/open-thread`);
    assert.equal(status, 403);
  });
});

describe("POST /api/users/:userId/message-request — messaging restriction vs degraded-read wiring", () => {
  // NOTE ON SCOPE: this route calls resolveInteractionPermissions() BEFORE
  // reaching TrustRestrictionService's check (messaging.ts:441 runs before
  // messaging.ts:457). resolveInteractionPermissions independently reads
  // trust_restrictions for its own purpose (interactionPermissions.ts:311-326,
  // feeding canMessage/canSendMessageRequest at :547-554) and is NOT one of
  // the four getRestrictionState callers this change touches. A real
  // "messaging" restriction row makes IT deny first, with its own generic
  // "Cannot send a message request to this user" — not this change's
  // message. That means messaging.ts's own `else` branch (the ORIGINAL
  // "Your account is currently restricted..." message, unchanged by this
  // task) is effectively DEAD via this specific route today: by the time
  // canMessage is false at messaging.ts:457, it can only be because of a
  // fail_closed degraded read — a genuine, non-degraded restriction never
  // reaches that line, upstream already caught it. Mutation testing proved
  // this empirically: flipping the new condition to always-true survives
  // every test here, because no reachable request state exercises the
  // `else` path. This is a real, honest gap, reported rather than
  // papered over with an unreachable-in-production test — see the
  // mutation-testing table in the PR/commit description. The fail-closed
  // test below uses call-order isolation (see trust_restrictions_error_from_call)
  // to let resolveInteractionPermissions's read succeed while only
  // getRestrictionState's own read fails, which IS a realistic partial-
  // failure shape and is what actually proves this change's new branch.
  it("normal-allowed: an unrestricted sender sends a message request normally", async () => {
    _setTestClient(makeClient({}) as any, true);
    const { status, body } = await callApi("POST", `/api/users/${BOB_ID}/message-request`);
    assert.notEqual(status, 403, JSON.stringify(body));
    assert.notEqual(body?.error, "forbidden");
    assert.notEqual(body?.error, "degraded_unavailable");
  });

  it("fail-open-silent: a missing trust_restrictions table sends the message request normally — no message at all", async () => {
    _setTestClient(
      makeClient({ trust_restrictions_error: { code: "42P01", message: 'relation "trust_restrictions" does not exist' } }) as any,
      true,
    );
    const { status, body } = await callApi("POST", `/api/users/${BOB_ID}/message-request`);
    assert.notEqual(status, 403, "fail-open must not block sending a message");
    assert.notEqual(status, 503, "fail-open must not show the degraded message either");
  });

  it("fail-closed-message: getRestrictionState's own read failing (resolveInteractionPermissions's earlier read still clean) shows the exact retry string", async () => {
    _setTestClient(
      makeClient({
        trust_restrictions_error: { code: "57014", message: "canceling statement due to statement timeout" },
        // Let resolveInteractionPermissions's read (1st) succeed; fail only
        // getRestrictionState's read (2nd) — see the call-count comment above.
        trust_restrictions_error_from_call: 2,
      }) as any,
      true,
    );
    const { status, body } = await callApi("POST", `/api/users/${BOB_ID}/message-request`);
    assert.equal(status, 503);
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(
      body.message,
      "We could not verify your permissions right now. Please try again shortly.",
      "must show exactly this string — never the restriction message, never an improvised one",
    );
    assert.equal(body.retryable, true, "must carry a retry signal for the client to act on");
  });
});

describe("POST /api/threads/:threadId/media — Finding 14: E2EE plaintext-media bypass", () => {
  const SB = process.env.SUPABASE_URL ?? "http://localhost:54321";
  const MEDIA_URL = `${SB}/storage/v1/object/public/post-media/dm/photo.jpg`;
  // isUuid() requires actual hex digits — the shared THREAD_ID fixture
  // ("tttttttt-...") only ever reaches endpoints that don't validate the
  // path param, so this endpoint needs its own valid-format id.
  const E2EE_THREAD_ID = "eeeeeeee-0000-0000-0000-000000000099";

  function threadFixture(isE2ee: boolean) {
    return {
      message_threads: [
        {
          id: E2EE_THREAD_ID,
          thread_type: "direct",
          trip_id: null,
          circle_owner_id: null,
          title: null,
          is_e2ee: isE2ee,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
          status: "active",
        },
      ],
      message_thread_members: [
        { user_id: ALICE_ID, thread_id: E2EE_THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
        { user_id: BOB_ID,   thread_id: E2EE_THREAD_ID, muted_at: null, archived_at: null, left_at: null, last_read_at: null },
      ],
    };
  }

  it("rejects a media message on an E2EE thread instead of inserting a plaintext body/media_url", async () => {
    const client = makeClient(threadFixture(true), ALICE_ID);
    _setTestClient(client as any, true);

    const { status, body } = await callApi("POST", `/api/threads/${E2EE_THREAD_ID}/media`, {
      mediaUrl: MEDIA_URL,
      mediaType: "image",
      body: "look at this view",
    });

    // e2ee_thread maps to 422, same convention as the translate/retry endpoint's E2EE guard.
    assert.equal(status, 422, `expected the E2EE guard to reject the request, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, "e2ee_thread");
    void client;
  });

  it("still accepts a media message on a non-E2EE thread (no regression to the normal photo-send flow)", async () => {
    _setTestClient(makeClient(threadFixture(false), ALICE_ID) as any, true);

    const { status, body } = await callApi("POST", `/api/threads/${E2EE_THREAD_ID}/media`, {
      mediaUrl: MEDIA_URL,
      mediaType: "image",
      body: "look at this view",
    });

    assert.equal(status, 201, `expected a normal thread to still accept media, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.mediaUrl, MEDIA_URL);
    assert.equal(body.body, "look at this view");
  });
});
