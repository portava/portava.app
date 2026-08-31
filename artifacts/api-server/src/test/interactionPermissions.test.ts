/**
 * Interaction Permission Engine — 22 safety tests
 *
 * Tests the GET /api/users/:targetUserId/interaction-context endpoint.
 * All 22 named tests must pass — this is a SAFETY-CRITICAL gate.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/interactionPermissions.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";

// ── Shared UUIDs ──────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID  = "cccccccc-0000-0000-0000-000000000003";
const DAVE_ID   = "dddddddd-0000-0000-0000-000000000004";
const EVE_ID    = "eeeeeeee-0000-0000-0000-000000000005";
const TRIP_ID   = "f0f0f0f0-0000-0000-0000-000000000001";
const EVENT_ID  = "e0e0e0e0-0000-0000-0000-000000000001";

// ── Fake Supabase client factory ──────────────────────────────────────────────

interface FakeState {
  users?: Record<string, { id: string } | null>;
  profiles?: Array<Record<string, any>>;
  blocks?: Array<Record<string, any>>;
  user_follows?: Array<Record<string, any>>;
  user_friendships?: Array<Record<string, any>>;
  friend_requests?: Array<Record<string, any>>;
  user_message_settings?: Array<Record<string, any>>;
  message_requests?: Array<Record<string, any>>;
  user_account_states?: Array<Record<string, any>>;
  user_privacy_settings?: Array<Record<string, any>>;
  profile_privacy_settings?: Array<Record<string, any>>;
  user_mutes?: Array<Record<string, any>>;
  user_restrictions?: Array<Record<string, any>>;
  trust_restrictions?: Array<Record<string, any>>;
  user_interaction_cooldowns?: Array<Record<string, any>>;
  availability_nudges?: Array<Record<string, any>>;
  moderation_actions?: Array<Record<string, any>>;
  trip_members?: Array<Record<string, any>>;
  circle_memberships?: Array<Record<string, any>>;
  rent_buddy_bookings?: Array<Record<string, any>>;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    profiles:                    state.profiles ?? [],
    blocks:                      state.blocks ?? [],
    user_follows:                state.user_follows ?? [],
    user_friendships:            state.user_friendships ?? [],
    friend_requests:             state.friend_requests ?? [],
    user_message_settings:       state.user_message_settings ?? [],
    message_requests:            state.message_requests ?? [],
    user_account_states:         state.user_account_states ?? [],
    user_privacy_settings:       state.user_privacy_settings ?? [],
    profile_privacy_settings:    state.profile_privacy_settings ?? [],
    user_mutes:                  state.user_mutes ?? [],
    user_restrictions:           state.user_restrictions ?? [],
    trust_restrictions:          state.trust_restrictions ?? [],
    user_interaction_cooldowns:  state.user_interaction_cooldowns ?? [],
    availability_nudges:         state.availability_nudges ?? [],
    moderation_actions:          state.moderation_actions ?? [],
    trip_members:                state.trip_members ?? [],
    circle_memberships:          state.circle_memberships ?? [],
    rent_buddy_bookings:         state.rent_buddy_bookings ?? [],
  };

  function from(table: string) {
    let active_filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;
    let upsertPayload: any = null;
    let _limit: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc: boolean = true;

    const b: any = {
      select()           { return b; },
      insert(row: any)   { insertPayload = row; return b; },
      update()           { return b; },
      delete()           { return b; },
      upsert(row: any)   { upsertPayload = row; return b; },
      eq(col: string, val: any)    { active_filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { active_filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { active_filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    {
        active_filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      or(expr: string) {
        // Split on top-level commas only (not inside parentheses).
        // e.g. "and(a.eq.1,b.eq.2),and(a.eq.3,b.eq.4)" → two clauses
        function splitTopLevel(s: string): string[] {
          const parts: string[] = [];
          let depth = 0;
          let start = 0;
          for (let i = 0; i < s.length; i++) {
            if (s[i] === "(") depth++;
            else if (s[i] === ")") depth--;
            else if (s[i] === "," && depth === 0) {
              parts.push(s.slice(start, i));
              start = i + 1;
            }
          }
          parts.push(s.slice(start));
          return parts;
        }

        const topClauses = splitTopLevel(expr);
        const matchers: Array<(r: any) => boolean> = [];
        for (const clause of topClauses) {
          const andMatch = clause.match(/^and\((.+)\)$/s);
          if (andMatch) {
            // inner terms are comma-separated col.op.val (no nested parens)
            const innerParts = andMatch[1].split(",");
            const subMatchers = innerParts.map((p: string) => {
              const m = p.match(/^(\w+)\.(eq|neq)\.(.+)$/);
              if (!m) return () => true;
              const [, col, op, rawVal] = m;
              if (op === "eq")  return (r: any) => String(r[col]) === rawVal;
              if (op === "neq") return (r: any) => String(r[col]) !== rawVal;
              return () => true;
            });
            matchers.push((r: any) => subMatchers.every((f: (r: any) => boolean) => f(r)));
          } else {
            // simple col.op.val
            const m = clause.match(/^(\w+)\.(eq|neq)\.(.+)$/);
            if (m) {
              const [, col, op, rawVal] = m;
              if (op === "eq")  matchers.push((r: any) => String(r[col]) === rawVal);
              if (op === "neq") matchers.push((r: any) => String(r[col]) !== rawVal);
            }
          }
        }
        if (matchers.length > 0) {
          active_filters.push((r: any) => matchers.some((f) => f(r)));
        }
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
        const col = _orderCol;
        const asc = _orderAsc;
        source = [...source].sort((a, b) =>
          asc
            ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
            : String(b[col] ?? "").localeCompare(String(a[col] ?? "")),
        );
      }
      if (_limit !== null) source = source.slice(0, _limit);
      return source;
    }

    async function resolveSingle(maybe: boolean) {
      if (upsertPayload) return { data: { id: "upserted-id", ...upsertPayload }, error: null };
      if (insertPayload) return { data: { id: "new-id", ...insertPayload }, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (insertPayload) return { data: [{ id: "new-id", ...insertPayload }], error: null };
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
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
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

// ── Default state helpers ─────────────────────────────────────────────────────

function baseState(extra: Partial<FakeState> = {}): FakeState {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
      "dave-tok":  { id: DAVE_ID },
      "eve-tok":   { id: EVE_ID },
    },
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", is_private: false, tag_permission: "everyone" },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   is_private: false, tag_permission: "everyone" },
      { id: CAROL_ID, handle: "carol", name: "Carol", is_private: true,  tag_permission: "friends_only" },
      { id: DAVE_ID,  handle: "dave",  name: "Dave",  is_private: false, tag_permission: "everyone" },
      { id: EVE_ID,   handle: "eve",   name: "Eve",   is_private: false, tag_permission: "everyone" },
    ],
    ...extra,
  };
}

// =============================================================================
// Tests 1–5: Block prevents all major social actions
// =============================================================================

describe("Block prevents all major social actions", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      blocks: [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("1. block prevents message — canMessage=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canMessage, false, "block must prevent messaging");
    assert.equal(body.relationshipLabel, "blocked");
  });

  it("2. block prevents friend request — canAddFriend=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    const body = await res.json() as any;
    assert.equal(body.canAddFriend, false, "block must prevent friend request");
  });

  it("3. block prevents tag — canTag=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    const body = await res.json() as any;
    assert.equal(body.canTag, false, "block must prevent tagging");
  });

  it("4. block prevents invite — canInviteToEvent=false, canInviteToCircle=false, canInviteToTripCrew=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    const body = await res.json() as any;
    assert.equal(body.canInviteToEvent, false, "block must prevent event invite");
    assert.equal(body.canInviteToCircle, false, "block must prevent circle invite");
    assert.equal(body.canInviteToTripCrew, false, "block must prevent trip crew invite");
  });

  it("5. block prevents booking — canBookBuddy=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    const body = await res.json() as any;
    assert.equal(body.canBookBuddy, false, "block must prevent RaB booking");
  });
});

// =============================================================================
// Test 6: Unblock does NOT auto-restore friendship
// =============================================================================

describe("Unblock does NOT auto-restore friendship", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // No block row (unblocked), but also no friendship (friendship was removed on block)
    const client = makeClient(baseState({
      blocks: [],
      user_friendships: [],
      friend_requests: [],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("6. unblock does NOT auto-restore friendship — canAddFriend=true, isFriend=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    // Unblocked: can now add friend again, but NOT already friends
    assert.equal(body.canAddFriend, true, "after unblock, canAddFriend should be true");
    assert.equal(body.relationshipLabel, "stranger", "after unblock, relationship is stranger");
    assert.equal(body.canSeeFriendOnlyPosts, false, "friendship was not restored");
  });
});

// =============================================================================
// Test 7: Unknown user (stranger) — can only send message request, not DM
// =============================================================================

describe("Stranger — message request only, not direct DM", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Dave is a stranger: public profile, no relationship.
    // His message_privacy='friends' means a stranger cannot DM directly — only request.
    const client = makeClient(baseState({
      user_message_settings: [
        { user_id: DAVE_ID, message_privacy: "friends", allow_message_requests: true },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("7. unknown user — canSendMessageRequest=true, canMessage depends on privacy default", async () => {
    const res = await fetch(`${url}/api/users/${DAVE_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    // Profile is visible (public) but stranger cannot DM directly (message_privacy='friends')
    assert.equal(body.canViewProfile, true, "public profile visible to stranger");
    assert.equal(body.relationshipLabel, "stranger");
    assert.equal(body.canMessage, false, "stranger cannot DM when message_privacy=friends");
    assert.equal(body.canSendMessageRequest, true, "stranger must be able to send a message request");
  });
});

// =============================================================================
// Test 8: Declined request creates cooldown — canSendMessageRequest=false
// =============================================================================

describe("Declined request cooldown", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      user_message_settings: [
        { user_id: BOB_ID, message_privacy: "everyone", allow_message_requests: true },
      ],
      user_interaction_cooldowns: [
        {
          user_id: ALICE_ID,
          target_user_id: BOB_ID,
          cooldown_type: "message_request",
          expires_at: new Date(Date.now() + 86400_000).toISOString(), // expires tomorrow
        },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("8. declined request creates cooldown — canSendMessageRequest=false during cooldown", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    // canMessage=true (everyone), canSendMessageRequest=false because of cooldown
    assert.equal(body.canSendMessageRequest, false, "cooldown must block message request");
    assert.equal(typeof body.reasonCodes, "object", "reasonCodes array present");
  });
});

// =============================================================================
// Test 9: One nudge max — nudge cooldown reported in safetyWarnings
// =============================================================================

describe("Nudge cooldown reported in safetyWarnings", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Alice already nudged Bob once — a user_interaction_cooldowns row with cooldown_type='nudge'
    // records the per-user nudge gate. The service checks this table (not availability_nudges).
    const client = makeClient(baseState({
      user_interaction_cooldowns: [
        {
          user_id: ALICE_ID,
          target_user_id: BOB_ID,
          cooldown_type: "nudge",
          expires_at: new Date(Date.now() + 86400_000).toISOString(), // active until tomorrow
        },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("9. one nudge max — safetyWarnings contains nudge_cooldown when nudge exists", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.safetyWarnings), "safetyWarnings is an array");
    assert.ok(body.safetyWarnings.includes("nudge_cooldown"), "nudge_cooldown must appear in safetyWarnings when cooldown row is active");
  });
});

// =============================================================================
// Test 10: Private profile hidden from stranger
// =============================================================================

describe("Private profile hidden from stranger", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Carol has is_private=true in base state
    const client = makeClient(baseState());
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("10. private profile hidden from stranger — canViewProfile=false", async () => {
    const res = await fetch(`${url}/api/users/${CAROL_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canViewProfile, false, "private profile must be hidden from stranger");
    assert.equal(body.canViewFullProfile, false);
    assert.equal(body.canSeeFriendOnlyPosts, false, "stranger cannot see friend-only posts");
  });
});

// =============================================================================
// Test 11: Friend sees friend-level profile
// =============================================================================

describe("Friend sees friend-level profile", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Alice and Carol are friends — Carol has private profile
    const client = makeClient(baseState({
      user_friendships: [
        { user_a: ALICE_ID, user_b: CAROL_ID }, // Alice < Carol alphabetically? No, use IDs
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("11. friend sees friend-level profile — canViewProfile=true, canSeeFriendOnlyPosts=true", async () => {
    const res = await fetch(`${url}/api/users/${CAROL_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canViewProfile, true, "friend can view private profile");
    assert.equal(body.canSeeFriendOnlyPosts, true, "friend can see friend-only posts");
    assert.equal(body.relationshipLabel, "friend");
  });
});

// =============================================================================
// Test 12: Suspended viewer cannot interact
// =============================================================================

describe("Suspended viewer cannot interact", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      user_account_states: [
        { user_id: ALICE_ID, state: "suspended" },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("12. suspended viewer cannot interact — canMessage=false, canAddFriend=false, canFollow=false", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canMessage, false, "suspended user cannot message");
    assert.equal(body.canAddFriend, false, "suspended user cannot add friend");
    assert.equal(body.canFollow, false, "suspended user cannot follow");
    assert.equal(body.canInviteToEvent, false, "suspended user cannot invite");
  });
});

// =============================================================================
// Test 13: Deleted / deactivated profile unavailable
// =============================================================================

describe("Deleted profile unavailable", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      user_account_states: [
        { user_id: BOB_ID, state: "deleted" },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("13. deleted profile is unavailable — canViewProfile=false, profileVisibility=unavailable", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canViewProfile, false, "deleted profile is not viewable");
    assert.equal(body.profileVisibility, "unavailable");
    assert.ok(body.reasonCodes.includes("target_deleted"), "reasonCodes includes target_deleted");
  });
});

// =============================================================================
// Test 14: Event attendee cannot DM before allowed (no shared trip, requires request)
// =============================================================================

describe("Event context: DM requires request before shared trip", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Alice and Bob are at same event but no prior relationship
    // Bob's message_privacy = 'friends' (only friends can DM)
    const client = makeClient(baseState({
      user_message_settings: [
        { user_id: BOB_ID, message_privacy: "friends", allow_message_requests: true },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("14. event attendee cannot DM before allowed — canMessage=false, canSendMessageRequest=true", async () => {
    const res = await fetch(
      `${url}/api/users/${BOB_ID}/interaction-context?sourceType=event&sourceId=${EVENT_ID}`,
      { headers: bearer("alice-tok") },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canMessage, false, "not friends — cannot DM even at same event");
    assert.equal(body.canSendMessageRequest, true, "can send message request");
  });
});

// =============================================================================
// Test 15: Same event shows "Same Event" in context
// =============================================================================

describe("Same event label in context", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState());
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("15. same event shows relationshipLabel=same_event or context.sharedEvent=true", async () => {
    const res = await fetch(
      `${url}/api/users/${DAVE_ID}/interaction-context?sourceType=event&sourceId=${EVENT_ID}`,
      { headers: bearer("alice-tok") },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.context.sharedEvent, true, "sharedEvent must be true when sourceType=event");
    // relationship label is same_event when strangers at same event
    assert.ok(
      body.relationshipLabel === "same_event" || body.context.sharedEvent,
      "label or context reflects shared event",
    );
  });
});

// =============================================================================
// Test 16: RaB pre-booking chat — off-app payment warning in safetyWarnings
// =============================================================================

describe("RaB pre-booking — off-app payment warning", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      rent_buddy_bookings: [
        {
          id: "booking-1",
          client_id: ALICE_ID,
          buddy_id: BOB_ID,
          status: "pre_booking",
        },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("16. RaB pre-booking — safetyWarnings contains rab_off_app_payment_risk", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(
      body.safetyWarnings.includes("rab_off_app_payment_risk"),
      "rab_off_app_payment_risk warning must appear for pre-booking sessions",
    );
    assert.equal(body.context.rabPreBooking, true, "context.rabPreBooking must be true");
  });
});

// =============================================================================
// Test 17: Report preserves evidence — canReport=true for any accessible profile
// =============================================================================

describe("Report preserves evidence — canReport always available", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState());
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("17. report preserves evidence — canReport=true for visible profiles", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canReport, true, "canReport must be true for any visible public profile");
  });
});

// =============================================================================
// Test 18: Restrict hides read receipts — context.readReceiptsHidden=true
// =============================================================================

describe("Restrict hides read receipts", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Bob has restricted Alice
    const client = makeClient(baseState({
      user_restrictions: [
        { restrictor_id: BOB_ID, restricted_id: ALICE_ID },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("18. restrict hides read receipts — context.readReceiptsHidden=true, safetyWarnings includes read_receipts_hidden", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.context.readReceiptsHidden, true, "readReceiptsHidden must be true when target restricts viewer");
    assert.ok(
      body.safetyWarnings.includes("read_receipts_hidden"),
      "safetyWarnings must include read_receipts_hidden",
    );
  });
});

// =============================================================================
// Test 19: Tag approval required for non-friend (tag_permission = friends_only)
// =============================================================================

describe("Tag approval required for non-friend", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Carol has tag_permission=friends_only and is_private=true (set in base)
    // Alice is NOT a friend of Carol
    const client = makeClient(baseState({
      user_friendships: [], // no friendship
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("19. tag approval required — canTag=false when tag_permission=friends_only and not a friend", async () => {
    // Carol has is_private=true — first check if profile is visible to Alice at all
    // Since Carol is private and Alice is not a friend, Alice cannot view the profile
    // So canTag must be false (all permissions are false for hidden profiles)
    const res = await fetch(`${url}/api/users/${CAROL_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canTag, false, "non-friend cannot tag when tag_permission=friends_only");
  });
});

// =============================================================================
// Test 20: Deep link respects block / privacy
// =============================================================================

describe("Deep link respects block and privacy", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    // Bob blocks Alice — deep link still blocked
    const client = makeClient(baseState({
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("20. deep link respects block — canViewProfile=false even with sourceType=deep_link", async () => {
    const res = await fetch(
      `${url}/api/users/${BOB_ID}/interaction-context?sourceType=deep_link&sourceId=some-link`,
      { headers: bearer("alice-tok") },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canViewProfile, false, "block wins over deep link — profile not visible");
    assert.equal(body.canMessage, false, "block wins over deep link — cannot message");
    assert.ok(
      body.relationshipLabel === "blocks_you" || body.reasonCodes.includes("blocked"),
      "block is reflected in label or reasonCodes",
    );
  });
});

// =============================================================================
// Test 21: Age restriction blocks event / circle invite
// =============================================================================

describe("Age restriction blocks event and circle invites", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      user_privacy_settings: [
        { user_id: BOB_ID, age_restriction_enabled: true },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("21. age restriction — canInviteToEvent=false, canInviteToCircle=false, reasonCodes includes age_restricted", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.canInviteToEvent, false, "age restriction blocks event invite");
    assert.equal(body.canInviteToCircle, false, "age restriction blocks circle invite");
    assert.ok(
      body.reasonCodes.includes("age_restricted"),
      "reasonCodes must include age_restricted",
    );
  });
});

// =============================================================================
// Test 22: Admin moderation action audited — safetyWarnings reflects moderation
// =============================================================================

describe("Admin moderation action audited", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      moderation_actions: [
        {
          id: "mod-1",
          target_user_id: BOB_ID,
          action_type: "content_removal",
          created_at: new Date().toISOString(),
        },
      ],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    url = srv.url; close = srv.close;
  });
  after(() => close());

  it("22. admin moderation action audited — safetyWarnings contains target_under_moderation", async () => {
    const res = await fetch(`${url}/api/users/${BOB_ID}/interaction-context`, {
      headers: bearer("alice-tok"),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(
      body.safetyWarnings.includes("target_under_moderation"),
      "safetyWarnings must include target_under_moderation when moderation_actions row exists",
    );
  });
});

// =============================================================================
// PRIV-3: profile_privacy_settings interaction opt-outs are enforced
// (allow_follow / allow_friend_requests / allow_tagging were advisory-only —
//  written by PATCH /me/privacy but never read by the permission resolver.)
// =============================================================================

describe("PRIV-3: interaction opt-outs are enforced by resolveInteractionPermissions", () => {
  async function ctxForTargetSettings(seed: Record<string, any>) {
    const { default: router } = await import("../routes/interactionContext.js");
    const client = makeClient(baseState({
      profile_privacy_settings: [{ user_id: ALICE_ID, ...seed }],
    }));
    _setTestClient(client, true);
    const srv = await startServer(makeApp(router));
    try {
      // Bob asks whether he can interact with Alice.
      const res = await fetch(`${srv.url}/api/users/${ALICE_ID}/interaction-context`, {
        headers: bearer("bob-tok"),
      });
      return (await res.json()) as any;
    } finally {
      await srv.close();
    }
  }

  it("allow_follow=false blocks canFollow", async () => {
    const body = await ctxForTargetSettings({ allow_follow: false });
    assert.equal(body.canFollow, false, "target opted out of follows → canFollow must be false");
  });

  it("with no follow opt-out, canFollow stays available (default allowed)", async () => {
    const body = await ctxForTargetSettings({ allow_friend_requests: true });
    assert.equal(body.canFollow, true, "no follow opt-out → follow allowed");
  });

  it("allow_friend_requests=false blocks canAddFriend", async () => {
    const body = await ctxForTargetSettings({ allow_friend_requests: false });
    assert.equal(body.canAddFriend, false, "target opted out of friend requests → canAddFriend must be false");
  });

  it("allow_tagging=false blocks canTag (overrides who_can_tag=everyone)", async () => {
    const body = await ctxForTargetSettings({ allow_tagging: false });
    assert.equal(body.canTag, false, "target opted out of tagging → canTag must be false");
  });
});
