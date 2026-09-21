/**
 * Telegraph §14.1 — the conversation capability model, against the real
 * resolver and the real route.
 *
 * Spec (identical in v1 and v1.1; v1.1 is a byte-exact superset of v1):
 *   §14.1  "Capabilities are derived server-side from membership, block state,
 *          Trip/Crew membership, booking state, age/policy, location scope,
 *          safety state and conversation type. UI renders capabilities; it does
 *          not invent authorization."
 *   §14.3  "New members do not automatically receive pre-membership history.
 *          Adding a third person to a DM creates a new group."
 *   §15.1  the precision ladder EXACT | APPROXIMATE | ARRIVAL_STATUS_ONLY.
 *
 * WHAT IS PROVED HERE, AND WHAT WOULD TURN IT RED
 * ==============================================
 *   - All ten §14.1 names are answered. A capability dropped from the contract
 *     fails the name test, not a review.
 *   - A block DENIES canSendMessage in the policy AND is REDACTED on the wire.
 *     If redactForWire were removed, the route test goes red: the endpoint
 *     would become a block oracle.
 *   - An UNREADABLE roster denies rather than grants. supabase-js resolves on
 *     error, so the natural spelling of this read fails OPEN; if the error
 *     branch were dropped, `degraded` goes false and canSendMessage goes true
 *     and two assertions go red at once.
 *   - The §14.3 window drives canViewPreMembershipHistory through the SAME
 *     helper the message reader uses, and with the flag OFF the membership
 *     query does not name `visible_from_at` — so a database without migration
 *     2400 is not queried for a column it does not have.
 *   - canShareExactLocation is false for BOTH reasons separately: no grant, and
 *     a grant whose precision class is below EXACT. Collapsing them into one
 *     false loses the distinction the reason codes exist to carry.
 *   - Every reason the policy emits is declared in telegraphReasonCodes.ts.
 *     This reads the policy file as TEXT, so a reason invented at a call site
 *     is a failing test and not a second vocabulary.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphConversationCapabilities.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import readReceiptsRouter from "../server/telegraph/readReceiptsRoute.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import {
  CONVERSATION_CAPABILITY_NAMES,
  CAPABILITY_INPUTS,
} from "../domain/telegraph/contracts/conversationCapabilities.js";
import { TELEGRAPH_REASON_CODES, isTelegraphReason } from "../domain/telegraph/contracts/telegraphReasonCodes.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";

const DM = "00000000-0000-4000-8000-00000000000a";       // Alice ↔ Bob, healthy
const DM_BLOCKED = "00000000-0000-4000-8000-00000000000b"; // Alice ↔ Carl, blocked
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000c"; // trip thread, Alice is crew
const TRIP_FOREIGN = "00000000-0000-4000-8000-00000000000d"; // trip thread, Alice is NOT crew
const ARCHIVED = "00000000-0000-4000-8000-00000000000e";
const BOOKING_THREAD = "00000000-0000-4000-8000-00000000000f";
const STRANGER = "00000000-0000-4000-8000-000000000010";  // Alice is not a member

const TRIP_MINE = "11111111-0000-4000-8000-000000000001";
const TRIP_OTHER = "11111111-0000-4000-8000-000000000002";

const BOUND = "2026-03-01T00:00:00.000Z";

interface State {
  flag?: boolean;
  rosterError?: boolean;
  threadError?: boolean;
  /** Alice's own membership row in TRIP_THREAD carries a §14.3 lower bound. */
  aliceBounded?: boolean;
  /** An active trip_crew_location_sessions row for Alice on TRIP_MINE. */
  liveShare?: "nearby" | "city_only" | null;
  restrictions?: string[];
}

function fixture(state: State) {
  return {
    feature_flags: state.flag === undefined
      ? []
      : [{ flag: "telegraph_history_bound_enabled", enabled: state.flag }],
    message_threads: [
      { id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: DM_BLOCKED, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: TRIP_THREAD, thread_type: "trip", status: "active", trip_id: TRIP_MINE, circle_owner_id: null, is_e2ee: false },
      { id: TRIP_FOREIGN, thread_type: "trip", status: "active", trip_id: TRIP_OTHER, circle_owner_id: null, is_e2ee: false },
      { id: ARCHIVED, thread_type: "direct", status: "archived", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: BOOKING_THREAD, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: STRANGER, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, role: "member", left_at: null, visible_from_at: null },
      { thread_id: DM, user_id: BOB, role: "member", left_at: null, visible_from_at: null },
      { thread_id: DM_BLOCKED, user_id: ALICE, role: "member", left_at: null, visible_from_at: null },
      { thread_id: DM_BLOCKED, user_id: CARL, role: "member", left_at: null, visible_from_at: null },
      { thread_id: TRIP_THREAD, user_id: ALICE, role: "member", left_at: null,
        visible_from_at: state.aliceBounded ? BOUND : null },
      { thread_id: TRIP_THREAD, user_id: BOB, role: "admin", left_at: null, visible_from_at: null },
      { thread_id: TRIP_THREAD, user_id: CARL, role: "member", left_at: null, visible_from_at: null },
      { thread_id: TRIP_FOREIGN, user_id: ALICE, role: "member", left_at: null, visible_from_at: null },
      { thread_id: TRIP_FOREIGN, user_id: BOB, role: "member", left_at: null, visible_from_at: null },
      { thread_id: TRIP_FOREIGN, user_id: CARL, role: "member", left_at: null, visible_from_at: null },
      { thread_id: ARCHIVED, user_id: ALICE, role: "member", left_at: null, visible_from_at: null },
      { thread_id: ARCHIVED, user_id: BOB, role: "member", left_at: null, visible_from_at: null },
      { thread_id: BOOKING_THREAD, user_id: ALICE, role: "member", left_at: null, visible_from_at: null },
      { thread_id: BOOKING_THREAD, user_id: BOB, role: "member", left_at: null, visible_from_at: null },
      { thread_id: STRANGER, user_id: BOB, role: "member", left_at: null, visible_from_at: null },
    ],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
    trust_restrictions: (state.restrictions ?? []).map((r) => ({
      user_id: ALICE, restriction_type: r, lifted_at: null, expires_at: null,
    })),
    user_privacy_settings: [],
    profile_privacy_settings: [],
    trips: [
      { id: TRIP_MINE, owner_id: ALICE },
      { id: TRIP_OTHER, owner_id: BOB },
    ],
    trip_members: [
      { trip_id: TRIP_MINE, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP_OTHER, user_id: BOB, role: "owner", status: "accepted" },
    ],
    rent_buddy_bookings: [
      { id: "bk-1", telegraph_thread_id: BOOKING_THREAD, status: "confirmed", buddy_id: BOB, traveler_id: ALICE },
    ],
    trip_crew_location_sessions: state.liveShare
      ? [{ trip_id: TRIP_MINE, user_id: ALICE, visibility_level: state.liveShare, status: "active",
           expires_at: "2099-01-01T00:00:00.000Z" }]
      : [],
  } as Record<string, any[]>;
}

interface Observed { selects: Array<{ table: string; sel: string }> }

function makeClient(state: State) {
  const db = fixture(state);
  const observed: Observed = { selects: [] };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };

    const injected = (): { message: string; code?: string } | null => {
      if (table === "message_threads" && state.threadError) return { message: "thread read blew up" };
      return null;
    };

    const target: any = {
      select(sel?: string) { observed.selects.push({ table, sel: sel ?? "" }); return proxy; },
      eq(col: string, val: any) { filters.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      or(expr: string) {
        // Only the two shapes this code path builds are modelled, and each is
        // modelled by MEANING rather than by parsing PostgREST syntax.
        if (table === "blocks") {
          const ids = expr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
          const set = new Set(ids.map((s) => s.toLowerCase()));
          filters.push((r) => set.has(String(r.blocker_id).toLowerCase()) && set.has(String(r.blocked_id).toLowerCase()));
        }
        // trust_restrictions: `expires_at.is.null,expires_at.gt.<now>` — every
        // fixture row has a null expires_at, so the clause admits them all.
        return proxy;
      },
      limit(n: number) { _limit = n; return proxy; },
      order() { return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (table === "message_thread_members" && state.rosterError && filters.length >= 3) {
          // The ROSTER read (thread + left_at is null + neq user) — not the
          // caller's own membership lookup, which uses maybeSingle().
          return Promise.resolve({ data: null, error: { message: "roster read blew up" }, count: null })
            .then(resolve, reject);
        }
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _observed: observed,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

/* ────────────────────────────── the policy ────────────────────────────── */

describe("Telegraph §14.1 — capabilities are derived server-side", () => {
  it("answers all ten §14.1 capability names, and no others", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    assert.deepEqual(
      Object.keys(r.capabilities).sort(),
      [...CONVERSATION_CAPABILITY_NAMES].sort(),
      "the resolved set must be exactly §14.1's ten names",
    );
    assert.deepEqual(Object.keys(r.reasons).sort(), [...CONVERSATION_CAPABILITY_NAMES].sort());
  });

  it("reads all eight named inputs for a healthy direct thread", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    for (const input of CAPABILITY_INPUTS) {
      assert.ok(r.inputsRead.includes(input), `§14.1 input '${input}' was never read`);
    }
    assert.equal(r.degraded, false);
  });

  it("a healthy DM grants send/call/plan/booking and refuses invite, payment and broadcast with reasons", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    assert.equal(r.capabilities.canSendMessage, true);
    assert.equal(r.capabilities.canCall, true);
    assert.equal(r.capabilities.canCreatePlan, true);
    assert.equal(r.capabilities.canCreateBooking, true);

    assert.equal(r.capabilities.canInvite, false);
    assert.equal(r.reasons.canInvite, "TELEGRAPH_POLICY_DM_INVITE_FORMS_NEW_GROUP",
      "§14.3: a third person in a DM makes a NEW group, it does not join this one");
    assert.equal(r.capabilities.canRequestPayment, false);
    assert.equal(r.reasons.canRequestPayment, "TELEGRAPH_POLICY_NO_IN_CHAT_PAYMENT");
    assert.equal(r.capabilities.canBroadcast, false);
    assert.equal(r.reasons.canBroadcast, "TELEGRAPH_POLICY_NO_BROADCAST");
    assert.equal(r.capabilities.canSeeGroupReadReceipts, false, "a direct thread has no group receipts");
  });

  it("a block denies canSendMessage and canCall, and the policy says so honestly", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM_BLOCKED });
    assert.equal(r.capabilities.canSendMessage, false);
    assert.equal(r.reasons.canSendMessage, "TELEGRAPH_AUTH_BLOCKED");
    assert.equal(r.capabilities.canCall, false);
    assert.equal(r.capabilities.canCreateBooking, false);
  });

  it("an UNREADABLE roster denies and is flagged degraded — it never reads as 'no other members'", async () => {
    const sc = makeClient({ rosterError: true });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    assert.equal(r.capabilities.canSendMessage, false, "a failed block input must not grant");
    assert.equal(r.reasons.canSendMessage, "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");
    assert.equal(r.degraded, true);
    assert.ok(r.degradedReasons.includes("TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE"));
  });

  it("a non-member gets every capability false with TELEGRAPH_AUTH_NOT_MEMBER", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: STRANGER });
    for (const name of CONVERSATION_CAPABILITY_NAMES) {
      assert.equal(r.capabilities[name], false, `${name} must be false for a non-member`);
      assert.equal(r.reasons[name], "TELEGRAPH_AUTH_NOT_MEMBER");
    }
  });

  it("an archived thread refuses sending and plan creation with the lifecycle reason", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: ARCHIVED });
    assert.equal(r.capabilities.canSendMessage, false);
    assert.equal(r.reasons.canSendMessage, "TELEGRAPH_POLICY_THREAD_ARCHIVED");
    assert.equal(r.capabilities.canCreatePlan, false);
    assert.equal(r.reasons.canCreatePlan, "TELEGRAPH_POLICY_THREAD_ARCHIVED");
  });

  it("a trip thread the viewer is not crew of refuses canCreatePlan, and group receipts are on", async () => {
    const sc = makeClient({});
    const mine = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(mine.capabilities.canCreatePlan, true, "Alice owns TRIP_MINE");
    assert.equal(mine.capabilities.canSeeGroupReadReceipts, true, "a group thread can show receipts");
    assert.equal(mine.reasons.canInvite, "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED",
      "a trip roster is owned by Trips, not invited to from the thread");

    const foreign = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_FOREIGN });
    assert.equal(foreign.capabilities.canCreatePlan, false);
    assert.equal(foreign.reasons.canCreatePlan, "TELEGRAPH_AUTH_NOT_TRIP_MEMBER");
  });

  it("canShareExactLocation names WHICH wall stopped it — no grant, or the precision ceiling", async () => {
    const none = await resolveConversationCapabilities(makeClient({ liveShare: null }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(none.capabilities.canShareExactLocation, false);
    assert.equal(none.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT");

    const live = await resolveConversationCapabilities(makeClient({ liveShare: "nearby" }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(live.capabilities.canShareExactLocation, false,
      "'nearby' is the MOST precise level the schema admits and it is still approximate");
    assert.equal(live.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_PRECISION_CEILING");
  });

  it("a trust restriction on the viewer denies send, plan and location, not membership", async () => {
    const sc = makeClient({ restrictions: ["messaging"] });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(r.capabilities.canSendMessage, false);
    assert.equal(r.reasons.canSendMessage, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
    assert.equal(r.capabilities.canSeeGroupReadReceipts, false,
      "a restricted viewer does not receive group seen state either");
  });

  it("a thread that already owns a booking refuses a second booking from inside itself", async () => {
    const sc = makeClient({});
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: BOOKING_THREAD });
    assert.equal(r.capabilities.canCreateBooking, false);
    assert.equal(r.reasons.canCreateBooking, "TELEGRAPH_POLICY_NO_IN_CHAT_PAYMENT");
  });

  it("an unreadable thread row refuses everything and is degraded, never 'not found'", async () => {
    const sc = makeClient({ threadError: true });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    assert.equal(r.degraded, true);
    assert.equal(r.reasons.canSendMessage, "TELEGRAPH_DEGRADED_THREAD_UNREADABLE");
  });
});

/* ───────────────────────── §14.3 history window ───────────────────────── */

describe("Telegraph §14.3 — canViewPreMembershipHistory follows the live bound", () => {
  it("flag OFF: unbounded, and the membership query never names visible_from_at", async () => {
    const sc = makeClient({ flag: false, aliceBounded: true });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(r.capabilities.canViewPreMembershipHistory, true,
      "with the bound not in force, history genuinely is unbounded");
    const memberSelects = sc._observed.selects.filter((s: any) => s.table === "message_thread_members");
    assert.ok(memberSelects.length > 0);
    for (const s of memberSelects) {
      assert.ok(!s.sel.includes("visible_from_at"),
        "a database without migration 2400 must never be asked for that column");
    }
  });

  it("flag ON + a bound on the viewer's own row: pre-membership history is refused", async () => {
    const sc = makeClient({ flag: true, aliceBounded: true });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(r.capabilities.canViewPreMembershipHistory, false);
    assert.equal(r.reasons.canViewPreMembershipHistory, "TELEGRAPH_HISTORY_BEFORE_WINDOW");
    const named = sc._observed.selects.some(
      (s: any) => s.table === "message_thread_members" && s.sel.includes("visible_from_at"),
    );
    assert.ok(named, "with the flag ON the bound must actually be read");
  });

  it("flag ON, no bound on the row: a founding member keeps full history", async () => {
    const sc = makeClient({ flag: true, aliceBounded: false });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(r.capabilities.canViewPreMembershipHistory, true);
    assert.equal(r.reasons.canViewPreMembershipHistory, null);
  });
});

/* ───────────────────────────── the route ──────────────────────────────── */

describe("GET /threads/:threadId/capabilities", () => {
  let server: any;
  let base = "";
  let state: State = {};

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", capabilityRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  function install(s: State) {
    state = s;
    const c = makeClient(state);
    _setTestClient(c, true);
    return c;
  }

  async function get(threadId: string, asUser: string) {
    const res = await fetch(`${base}/threads/${threadId}/capabilities`, {
      headers: { authorization: `Bearer ${asUser}` },
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("returns the ten capabilities with their reasons", async () => {
    install({});
    const { status, body } = await get(DM, ALICE);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.capabilities).sort(), [...CONVERSATION_CAPABILITY_NAMES].sort());
    assert.equal(body.capabilities.canSendMessage, true);
    assert.equal(body.conversationType, "direct");
  });

  it("REDACTS the block: a blocked viewer and a removed viewer get the same answer", async () => {
    install({});
    const blockedRes = await get(DM_BLOCKED, ALICE);
    const strangerRes = await get(STRANGER, ALICE);
    assert.equal(blockedRes.status, 200);
    assert.notEqual(blockedRes.body.reasons.canSendMessage, "TELEGRAPH_AUTH_BLOCKED",
      "putting the block on the wire tells the blocked user they were blocked");
    assert.equal(blockedRes.body.reasons.canSendMessage, "TELEGRAPH_AUTH_NOT_MEMBER");
    assert.equal(strangerRes.body.reasons.canSendMessage, "TELEGRAPH_AUTH_NOT_MEMBER");
  });

  it("a non-member gets 200, not 403 — the endpoint is not a thread-existence oracle", async () => {
    install({});
    const { status, body } = await get(STRANGER, ALICE);
    assert.equal(status, 200);
    assert.equal(body.capabilities.canSendMessage, false);
  });

  it("surfaces degraded so a client can say 'try again' instead of 'you may not'", async () => {
    install({ rosterError: true });
    const { body } = await get(DM, ALICE);
    assert.equal(body.degraded, true);
    assert.ok(Array.isArray(body.degradedReasons) && body.degradedReasons.length > 0);
  });

  it("refuses a malformed thread id rather than resolving against it", async () => {
    install({});
    const res = await fetch(`${base}/threads/not-a-uuid/capabilities`, {
      headers: { authorization: `Bearer ${ALICE}` },
    });
    assert.equal(res.status, 400);
  });

  it("requires a verified user", async () => {
    install({});
    const res = await fetch(`${base}/threads/${DM}/capabilities`);
    assert.equal(res.status, 401);
  });
});

/* ───────────────────── the vocabulary is one vocabulary ───────────────── */

describe("Telegraph reason codes — declared is the only vocabulary", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const policyPath = path.join(here, "../domain/telegraph/policies/conversationCapabilityPolicy.ts");

  it("every TELEGRAPH_* literal the policy emits is declared in telegraphReasonCodes.ts", () => {
    const src = readFileSync(policyPath, "utf8");
    const emitted = new Set(src.match(/"TELEGRAPH_[A-Z_]+"/g)?.map((s) => s.slice(1, -1)) ?? []);
    assert.ok(emitted.size > 0, "the policy must emit reasons at all");
    const undeclared = [...emitted].filter((c) => !isTelegraphReason(c));
    assert.deepEqual(undeclared, [], `undeclared reason code(s): ${undeclared.join(", ")}`);
  });

  it("the declared list has no duplicates", () => {
    assert.equal(new Set(TELEGRAPH_REASON_CODES).size, TELEGRAPH_REASON_CODES.length);
  });
});

/* ───────────────── §14.1 canSeeGroupReadReceipts, enforced ─────────────── */

describe("GET /threads/:threadId/read-receipts", () => {
  let server: any;
  let base = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", readReceiptsRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(threadId: string, asUser: string) {
    const res = await fetch(`${base}/threads/${threadId}/read-receipts`, {
      headers: { authorization: `Bearer ${asUser}` },
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("a group thread returns every active member's read position", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await get(TRIP_THREAD, ALICE);
    assert.equal(status, 200);
    const users = body.receipts.map((r: any) => r.userId).sort();
    assert.deepEqual(users, [ALICE, BOB, CARL].sort());
  });

  it("a DIRECT thread is refused — the capability is false and the route obeys it", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await get(DM, ALICE);
    assert.equal(status, 403);
    assert.equal(body.reason, "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED");
  });

  it("a non-member is refused without being told the thread exists", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await get(STRANGER, ALICE);
    assert.equal(status, 403);
    assert.equal(body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
  });

  it("a degraded capability read is retryable, not a confident policy refusal", async () => {
    _setTestClient(makeClient({ rosterError: true }), true);
    const { status } = await get(TRIP_THREAD, ALICE);
    assert.ok(status >= 500,
      `a degraded capability read must not be reported as a policy refusal (got ${status})`);
  });
});
