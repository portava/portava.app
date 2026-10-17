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
  liveShare?: "nearby" | "city_only" | null; /** 3753: the share's purpose (absent = a legacy row with no purpose column). */ liveSharePurpose?: string | null; liveSharePurposeError?: boolean; /** an active row of THIS purpose listed before Alice's share */ liveShareOtherFirst?: string;
  restrictions?: string[];
  /** census-telegraph T320: the BOOKING_THREAD booking's status and stay-connected opt-ins. */
  bookingStatus?: string; bookingStayConnected?: [boolean, boolean];
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
      { id: "bk-1", telegraph_thread_id: BOOKING_THREAD, status: state.bookingStatus ?? "confirmed", buddy_id: BOB, traveler_id: ALICE,
        stay_connected_traveler: state.bookingStayConnected?.[0] ?? false, stay_connected_buddy: state.bookingStayConnected?.[1] ?? false },
    ],
    trip_crew_location_sessions: state.liveShare
      ? [...(state.liveShareOtherFirst ? [{ id: "ls-other", trip_id: TRIP_MINE, user_id: ALICE, visibility_level: "city_only", status: "active", expires_at: "2099-01-01T00:00:00.000Z", purpose: state.liveShareOtherFirst }] : []), { trip_id: TRIP_MINE, user_id: ALICE, visibility_level: state.liveShare, status: "active",
           expires_at: "2099-01-01T00:00:00.000Z", id: "ls-alice", ...(state.liveSharePurpose !== undefined ? { purpose: state.liveSharePurpose } : {}) }]
      : [],
  } as Record<string, any[]>;
}

interface Observed { selects: Array<{ table: string; sel: string }> }

function makeClient(state: State) {
  const db = fixture(state);
  const observed: Observed = { selects: [] };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null; let _sel = "";

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const limited = _limit !== null ? rows.slice(0, _limit) : rows;
      // census-telegraph T320: the booking row is PROJECTED to the columns asked for, so a policy that
      // stops selecting the stay-connected opt-ins reads none (other tables keep the whole row, as before).
      if (table !== "rent_buddy_bookings" || !_sel || /[()*]/.test(_sel)) return limited;
      const cols = _sel.split(",").map((c) => c.trim());
      return limited.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    };

    const injected = (): { message: string; code?: string } | null => {
      if (table === "message_threads" && state.threadError) return { message: "thread read blew up" };
      if (table === "trip_crew_location_sessions" && state.liveSharePurposeError && /\bpurpose\b/.test(_sel)) return { message: "statement timeout", code: "57014" };
      return null;
    };

    const target: any = {
      select(sel?: string) { _sel = sel ?? ""; observed.selects.push({ table, sel: sel ?? "" }); return proxy; },
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

  // CHANGED 2026-10-05 (lane T2, OD-TRUST-5): this case asserted that a messaging
  // restriction denies canSendMessage in a TRIP thread — a refusal no send door
  // performed, and broader than what the person is told the restriction means
  // ("You cannot initiate new conversations"). The projection now reads the send
  // guard's own decision (restrictionSendPolicy.ts): a trip thread's roster is the
  // source domain's, so writing there is continuing, not initiating. The refusal
  // the restriction DOES carry — opening contact in a DM — is asserted beside it,
  // and the whole agreement is driven in telegraphRestrictionSendGate.test.ts.
  // CHANGED 2026-10-07 (lane T, lead ruling D-24: "Anything not named in that sentence must not
  // be refused"): this case asserted that a messaging restriction refuses calls and group seen
  // state in a TRIP thread. Neither is named by the messaging sentence ("You cannot start new
  // conversations, …"). A call is refused exactly where a send is; seen state by no restriction.
  it("a messaging restriction refuses sends AND calls only where they would initiate contact, and never group seen state", async () => {
    const sc = makeClient({ restrictions: ["messaging"] });
    const r = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(r.capabilities.canSendMessage, true, "a trip thread is not a new conversation");
    assert.equal(r.capabilities.canCall, true, "D-24: a call in a trip thread starts no new conversation");
    assert.equal(r.capabilities.canSeeGroupReadReceipts, true,
      "D-24: no restriction sentence names seen state");
    // DM, and Bob has never written in it: sending — and calling — would initiate contact.
    const dm = await resolveConversationCapabilities(sc, { viewerId: ALICE, conversationId: DM });
    assert.equal(dm.capabilities.canSendMessage, false);
    assert.equal(dm.reasons.canSendMessage, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
    assert.equal(dm.capabilities.canCall, false);
    assert.equal(dm.reasons.canCall, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
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

  // CHANGED 2026-10-07 (lane T, census-telegraph §51, proposed ruling P-T6): was "returns every
  // active member's read position". CARL blocked ALICE in this fixture, and a read position is a
  // presence signal: it no longer crosses a block, in either direction.
  it("a group thread returns every active member's read position — except across a block", async () => {
    _setTestClient(makeClient({}), true);
    const { status, body } = await get(TRIP_THREAD, ALICE);
    assert.equal(status, 200);
    const users = body.receipts.map((r: any) => r.userId).sort();
    assert.deepEqual(users, [ALICE, BOB].sort(), "CARL blocked ALICE: his read position must not reach her");
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

// ── 3753 (census-telegraph T215): INPUT 8 reads the CREW live share only ─────
describe("canShareExactLocation's grant input is purpose-bound (3753)", () => {
  it("a share granted for another purpose is not the crew grant this capability reads", async () => {
    const crew = await resolveConversationCapabilities(makeClient({ liveShare: "nearby", liveSharePurpose: "live_session_sharing" }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(crew.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_PRECISION_CEILING");
    const other = await resolveConversationCapabilities(makeClient({ liveShare: "nearby", liveSharePurpose: "presence_in_context" }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(other.capabilities.canShareExactLocation, false);
    assert.equal(other.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT",
      "a presence_in_context share was read as the viewer's crew live-share grant");
    const legacy = await resolveConversationCapabilities(makeClient({ liveShare: "nearby", liveSharePurpose: null }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(legacy.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_PRECISION_CEILING", "a legacy row is still the crew grant (LSP-1)");
    const unreadable = await resolveConversationCapabilities(makeClient({ liveShare: "nearby", liveSharePurpose: "live_session_sharing", liveSharePurposeError: true }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(unreadable.capabilities.canShareExactLocation, false);
    assert.equal(unreadable.degraded, true, "an unreadable share purpose must degrade the answer, not read as a fact");
    const hidden = await resolveConversationCapabilities(makeClient({ liveShare: "nearby", liveSharePurpose: "live_session_sharing", liveShareOtherFirst: "presence_in_context" }),
      { viewerId: ALICE, conversationId: TRIP_THREAD });
    assert.equal(hidden.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_PRECISION_CEILING",
      "another purpose's active row read first must not hide the crew grant (no limit before the purpose filter)");
  });
});

// ── census-telegraph T320: "Buddy booking cancelled → booking-only actions disabled immediately" ──
//
// A booking's own thread is where a call is a booking-only action: the call gateway refuses one
// unless `isRabBookingCallEligible` admits the booking row (routes/calls.ts). §14.1's canCall said
// TRUE in that thread whatever the booking's state — so the capability every surface reads
// (GET /threads/:id/capabilities, the thread page's permissions block, Compass's gate) kept offering
// a call on a cancelled booking. It now asks the same function, on every read.
describe("T320 — in a booking's thread, canCall follows the booking", () => {
  const cap = async (state: State) =>
    resolveConversationCapabilities(makeClient(state), { viewerId: ALICE, conversationId: BOOKING_THREAD });

  for (const status of ["confirmed", "scheduled", "in_progress", "completed_pending_traveler_confirmation", "disputed"]) {
    it(`a ${status} booking: canCall`, async () => {
      const r = await cap({ bookingStatus: status });
      assert.equal(r.capabilities.canCall, true, status);
    });
  }
  for (const status of ["cancelled", "refunded", "pending", "expired"]) {
    it(`a ${status} booking: no call, and the reason says it is the booking`, async () => {
      const r = await cap({ bookingStatus: status });
      assert.equal(r.capabilities.canCall, false, status);
      assert.equal(r.reasons.canCall, "TELEGRAPH_POLICY_BOOKING_NOT_ACTIVE");
      assert.equal(r.capabilities.canSendMessage, true, "the conversation itself is not closed by it");
    });
  }
  it("a completed booking: callable only while BOTH parties opted to stay connected (the gateway's rule)", async () => {
    assert.equal((await cap({ bookingStatus: "completed" })).capabilities.canCall, false);
    assert.equal((await cap({ bookingStatus: "completed", bookingStayConnected: [true, false] })).capabilities.canCall, false);
    assert.equal((await cap({ bookingStatus: "completed", bookingStayConnected: [true, true] })).capabilities.canCall, true);
  });
  it("re-read every time: the same thread, cancelled after it was confirmed, stops offering the call on the next read", async () => {
    assert.equal((await cap({ bookingStatus: "confirmed" })).capabilities.canCall, true);
    assert.equal((await cap({ bookingStatus: "cancelled" })).capabilities.canCall, false);
  });
  it("a thread with no booking is untouched", async () => {
    const r = await resolveConversationCapabilities(makeClient({}), { viewerId: ALICE, conversationId: DM });
    assert.equal(r.capabilities.canCall, true);
  });
  it("the new reason is declared vocabulary", () => {
    assert.ok(isTelegraphReason("TELEGRAPH_POLICY_BOOKING_NOT_ACTIVE"));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// census-telegraph T439 — §30A.19 "Formalize a Context Kernel above transport:
// Relationship, Time, Proximity, Intent and Shared Objects feed Policy +
// Capabilities, which determine what the Telegraph surface may reveal and what
// actions it may offer." The policy (services/telegraph/contextKernelPolicy.ts),
// the gatherer (services/telegraph/contextKernel.ts) and the route
// (GET /threads/:id/context-kernel on the capability router), each tested here.
// ══════════════════════════════════════════════════════════════════════════════

import {
  ACTION_GOVERNING_CAPABILITY as K_GOVERNS,
  CONTEXT_KERNEL_INPUTS as K_INPUTS,
  contextKernelForWire as kWire,
  decideContextKernel as kDecide,
  intentAction as kIntentAction,
  proximityMayBeRead as kMayReadProximity,
  type ContextKernelFacts as KFacts,
} from "../services/telegraph/contextKernelPolicy.js";
import {
  assembleContextKernel as kAssemble,
  kernelProximityFrom as kProximityFrom,
  readKernelIntent as kReadIntent,
  readKernelProximity as kReadProximity,
  KERNEL_MAX_PARTICIPANTS as K_MAX_PARTICIPANTS,
} from "../services/telegraph/contextKernel.js";
import { MAX_RAIL_PARTICIPANTS as K_RAIL_MAX } from "../routes/telegraphSharedContext.js";
import { NOW_ACTIONS as K_NOW_ACTIONS } from "../services/telegraph/layers.js";
import { TELEGRAPH_ACTIONS as K_ACTIONS } from "../services/telegraph/vocabulary.js";
import { redactForWire as kRedact } from "../domain/telegraph/contracts/telegraphReasonCodes.js";

const K_NOW = Date.parse("2026-10-17T12:00:00.000Z");
const kIso = (deltaMin: number) => new Date(K_NOW + deltaMin * 60_000).toISOString();

/** §14.1's answer with every capability TRUE unless overridden — the policy's ceiling in a test. */
function kCaps(over: Partial<Record<string, false | string>> = {}): any {
  const capabilities: Record<string, boolean> = {};
  const reasons: Record<string, string | null> = {};
  for (const n of CONVERSATION_CAPABILITY_NAMES) {
    const o = over[n];
    capabilities[n] = o === undefined;
    reasons[n] = o === undefined ? null : (o === false ? "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED" : o);
  }
  return { conversationId: DM, viewerId: ALICE, conversationType: "direct", capabilities, reasons, inputsRead: [...CAPABILITY_INPUTS], degraded: false, degradedReasons: [] };
}

function kItem(objectType: string, objectId: string, orderBand: string, availableActions: string[], startsAt?: string): any {
  return { objectType, objectId, title: objectId, relationship: "BOTH_PARTICIPANTS", status: "going", availableActions, orderBand, ...(startsAt ? { startsAt } : {}) };
}

function kShared(items: { now?: any[]; upcoming?: any[]; unresolved?: any[]; past?: any[] } = {}, incomplete = false): any {
  return { status: "read", value: { incomplete, projection: { conversationId: DM, generatedAt: kIso(0), now: items.now ?? [], upcoming: items.upcoming ?? [], unresolved: items.unresolved ?? [], past: items.past ?? [] } } };
}

function kFacts(over: Partial<KFacts> = {}): KFacts {
  return {
    conversationId: DM, viewerId: ALICE, conversationType: "direct", member: true, capabilities: kCaps(),
    relationship: { status: "read", value: { state: "ACTIVE", origins: ["MUTUAL_FOLLOW"], expiredOrigins: [] } },
    proximity: { status: "read", value: { people: [{ userId: BOB, bucket: "same_area", travel: "walk", freshness: "live" } as any] } },
    intent: { status: "read", value: null },
    sharedObjects: kShared(),
    nowMs: K_NOW,
    ...over,
  };
}

const kOffered = (k: any) => k.offeredActions.map((a: any) => `${a.source}:${a.action}${a.objectId ? `@${a.objectId}` : ""}`).sort();

describe("T439 — the Context Kernel policy (§30A.19)", () => {
  it("names §30A.19's five inputs, in the spec's order, and answers every one for a member", () => {
    assert.deepEqual([...K_INPUTS], ["relationship", "time", "proximity", "intent", "sharedObjects"]);
    const k = kDecide(kFacts());
    assert.deepEqual(Object.keys(k.inputs), [...K_INPUTS]);
    for (const name of K_INPUTS) assert.equal((k.inputs as any)[name].revealed, true, `${name} should be revealed to a member here`);
    assert.deepEqual([...k.inputsRead], [...K_INPUTS]);
  });

  it("a non-member is shown NOTHING — not even the conversation's clock — and offered nothing", () => {
    const k = kDecide(kFacts({ member: false, sharedObjects: kShared({ now: [kItem("MEETUP", "m1", "HAPPENING_NOW", ["MEET_HERE"])] }) }));
    for (const name of K_INPUTS) {
      assert.equal((k.inputs as any)[name].revealed, false, name);
      assert.equal((k.inputs as any)[name].reason, "KERNEL_NOT_MEMBER", name);
    }
    assert.deepEqual(k.offeredActions, []);
    assert.deepEqual(k.inputsRead, []);
  });

  it("a block seen by §14.1 withholds the other person and everything shared, and offers nothing", () => {
    const k = kDecide(kFacts({
      capabilities: kCaps({ canSendMessage: "TELEGRAPH_AUTH_BLOCKED" }),
      intent: { status: "read", value: { intent: "create_meetup", confidence: 0.85, messageId: "msg-1", at: kIso(-1), sentByViewer: false } },
      sharedObjects: kShared({ now: [kItem("MEETUP", "m1", "HAPPENING_NOW", ["MEET_HERE"])] }),
    }));
    for (const name of K_INPUTS) { // T439 parity: ALL five, the clock included — a non-member is not shown the clock, so a blocked member is not either
      assert.equal((k.inputs as any)[name].revealed, false, name);
      assert.equal((k.inputs as any)[name].reason, "KERNEL_BLOCKED", name);
    }
    assert.equal(k.conversationType, "unknown", "the type is a member's fact"); assert.deepEqual([...k.inputsRead], []); assert.equal(k.degraded, false);
    assert.ok(CONVERSATION_CAPABILITY_NAMES.every((n) => k.capabilities[n] === false && k.capabilityReasons[n] === "TELEGRAPH_AUTH_BLOCKED"), "§14.1 still grants a blocked member canCreatePlan; a non-member has none");
    assert.deepEqual(k.offeredActions, []);
    assert.deepEqual(k.withheldActions, []);
  });

  it("a block seen only by the RELATIONSHIP input does the same (§15.3: no rediscovery across a block)", () => {
    const k = kDecide(kFacts({
      relationship: { status: "read", value: { state: "BLOCKED", origins: [], expiredOrigins: [] } },
      sharedObjects: kShared({ upcoming: [kItem("MEETUP", "m1", "UPCOMING", ["JOIN_PLAN"])] }),
    }));
    assert.equal(k.inputs.sharedObjects.reason, "KERNEL_BLOCKED");
    assert.equal(k.inputs.proximity.reason, "KERNEL_BLOCKED");
    assert.deepEqual(k.offeredActions, []);
  });

  it("an input that is off, not applicable or unreadable is WITHHELD with that reason — never published as a floor", () => {
    const k = kDecide(kFacts({
      relationship: { status: "off", detail: "flag off" },
      conversationType: "trip",
      proximity: { status: "unreadable", detail: "budget refused" },
      intent: { status: "not_applicable", detail: "e2ee" },
    }));
    assert.equal(k.inputs.relationship.reason, "KERNEL_INPUT_OFF");
    assert.equal(k.inputs.proximity.reason, "KERNEL_INPUT_UNREADABLE");
    assert.equal(k.inputs.intent.reason, "KERNEL_INPUT_NOT_APPLICABLE");
    assert.equal(k.inputs.proximity.value, null);
    assert.equal(k.degraded, true);
    assert.deepEqual([...k.degradedInputs], ["proximity"]);
    assert.ok(!k.inputsRead.includes("proximity") && !k.inputsRead.includes("relationship"));
  });

  it("an INCOMPLETE shared-object read is revealed as the floor it is, and marks the kernel degraded", () => {
    const k = kDecide(kFacts({ sharedObjects: kShared({}, true) }));
    assert.equal(k.inputs.sharedObjects.revealed, true);
    assert.equal(k.inputs.sharedObjects.value?.incomplete, true);
    assert.equal(k.degraded, true);
    assert.deepEqual([...k.degradedInputs], ["sharedObjects"]);
  });

  it("Relationship FEEDS the proximity decision in a direct conversation", () => {
    assert.equal(kDecide(kFacts()).inputs.proximity.revealed, true, "ACTIVE admits the bucket");
    assert.equal(kDecide(kFacts({ relationship: { status: "read", value: { state: "TEMPORARY", origins: ["EVENT"], expiredOrigins: [] } } })).inputs.proximity.revealed, true);
    for (const state of ["REQUEST_ONLY", "EXPIRED", "RESTRICTED"] as const) {
      const k = kDecide(kFacts({ relationship: { status: "read", value: { state, origins: [], expiredOrigins: [] } } }));
      assert.equal(k.inputs.proximity.revealed, false, state);
      assert.equal(k.inputs.proximity.reason, "KERNEL_RELATIONSHIP_REQUIRED", state);
    }
    for (const relationship of [{ status: "off", detail: "x" }, { status: "unreadable", detail: "x" }] as const) {
      const k = kDecide(kFacts({ relationship }));
      assert.equal(k.inputs.proximity.reason, "KERNEL_RELATIONSHIP_REQUIRED", `${relationship.status}: an unestablished relationship admits no bucket`);
    }
    const group = kDecide(kFacts({ conversationType: "trip", relationship: { status: "not_applicable", detail: "group" } }));
    assert.equal(group.inputs.proximity.revealed, true, "a group's proximity is the reachable projection's own (circle + crew) answer");
  });

  it("the gatherer reads proximity under the SAME rule the policy reveals it by", () => {
    const active = { status: "read", value: { state: "ACTIVE", origins: [], expiredOrigins: [] } } as const;
    const requestOnly = { status: "read", value: { state: "REQUEST_ONLY", origins: [], expiredOrigins: [] } } as const;
    assert.equal(kMayReadProximity("direct", active), true);
    assert.equal(kMayReadProximity("direct", requestOnly), false);
    assert.equal(kMayReadProximity("direct", { status: "off", detail: "x" }), false);
    assert.equal(kMayReadProximity("trip", { status: "not_applicable", detail: "x" }), true);
  });

  it("Time: the soonest revealed shared object's §3.3 band, stated in UTC; only HAPPENING_NOW offers §2.3's NOW actions", () => {
    const now = kDecide(kFacts({ proximity: { status: "read", value: { people: [] } }, sharedObjects: kShared({
      now: [kItem("MEETUP", "m-now", "HAPPENING_NOW", [])],
      upcoming: [kItem("MEETUP", "m-soon", "STARTING_SOON", [], kIso(30)), kItem("MEETUP", "m-later", "UPCOMING", [], kIso(600))],
    }) }));
    assert.equal(now.inputs.time.value?.frame, "UTC");
    assert.equal(now.inputs.time.value?.now, kIso(0));
    assert.equal(now.inputs.time.value?.band, "HAPPENING_NOW");
    assert.equal(now.inputs.time.value?.nextStartsAt, kIso(30));
    assert.deepEqual(kOffered(now), K_NOW_ACTIONS.map((a) => `time:${a}`).sort());

    const later = kDecide(kFacts({ proximity: { status: "read", value: { people: [] } }, sharedObjects: kShared({ upcoming: [kItem("MEETUP", "m-later", "UPCOMING", [], kIso(600))] }) }));
    assert.equal(later.inputs.time.value?.band, "UPCOMING");
    assert.deepEqual(kOffered(later), [], "nothing happening now offers no NOW action");
  });

  it("Proximity: somebody in the nearest bucket offers MEET_HERE; anybody further does not", () => {
    assert.deepEqual(kOffered(kDecide(kFacts())), ["proximity:MEET_HERE"]);
    const further = kDecide(kFacts({ proximity: { status: "read", value: { people: [{ userId: BOB, bucket: "nearby", travel: "short", freshness: "live" } as any] } } }));
    assert.deepEqual(kOffered(further), []);
  });

  it("Intent: every detectIntent label maps to a §8.1 action, and a plan intent is ADD_TO_TRIP only in a trip", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "telegraphIntent.ts"), "utf8");
    const union = src.slice(src.indexOf("export type IntentType ="), src.indexOf("export interface IntentResult"));
    const labels = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(labels.length >= 15, `read ${labels.length} intent labels`);
    for (const l of labels) assert.ok((K_ACTIONS as readonly string[]).includes(kIntentAction(l as any, "direct")), l);
    assert.equal(kIntentAction("add_to_plan", "trip"), "ADD_TO_TRIP");
    assert.equal(kIntentAction("add_to_plan", "direct"), "CREATE_PLAN");
    assert.equal(kIntentAction("time_poll", "direct"), "VOTE");
    const k = kDecide(kFacts({ proximity: { status: "read", value: { people: [] } }, intent: { status: "read", value: { intent: "create_meetup", confidence: 0.85, messageId: "msg-1", at: kIso(-5), sentByViewer: false } } }));
    assert.deepEqual(kOffered(k), ["intent:CREATE_PLAN"]);
  });

  it("Shared objects: each live object's own actions are offered with the object named; a PAST object offers none", () => {
    const k = kDecide(kFacts({ proximity: { status: "read", value: { people: [] } }, sharedObjects: kShared({
      upcoming: [kItem("MEETUP", "m1", "UPCOMING", ["JOIN_PLAN", "VOTE"], kIso(600))],
      past: [kItem("MEETUP", "m0", "PAST", ["JOIN_PLAN"])],
    }) }));
    assert.deepEqual(kOffered(k), ["sharedObjects:JOIN_PLAN@m1", "sharedObjects:VOTE@m1"]);
  });

  it("§14.1 DECIDES: a false capability withholds the action with its own reason, and nothing is ever granted", () => {
    const facts = kFacts({
      intent: { status: "read", value: { intent: "create_meetup", confidence: 0.85, messageId: "msg-1", at: kIso(-5), sentByViewer: true } },
      capabilities: kCaps({ canCreatePlan: "TELEGRAPH_AUTH_NOT_TRIP_MEMBER" }),
    });
    const k = kDecide(facts);
    assert.deepEqual(kOffered(k), ["proximity:MEET_HERE"]);
    assert.deepEqual(k.withheldActions.map((a) => [a.action, a.capability, a.reason]), [["CREATE_PLAN", "canCreatePlan", "TELEGRAPH_AUTH_NOT_TRIP_MEMBER"]]);

    const none = kDecide({ ...facts, capabilities: kCaps(Object.fromEntries(CONVERSATION_CAPABILITY_NAMES.map((n) => [n, "TELEGRAPH_POLICY_THREAD_ARCHIVED"]))) });
    assert.deepEqual(none.offeredActions, [], "with every capability false the kernel offers nothing");
    assert.equal(none.withheldActions.length, 2);
  });

  it("every §8.1 action has a governing §14.1 capability", () => {
    for (const a of K_ACTIONS) assert.ok((CONVERSATION_CAPABILITY_NAMES as readonly string[]).includes(K_GOVERNS[a]), a);
    assert.equal(K_GOVERNS.CREATE_PLAN, "canCreatePlan");
    assert.equal(K_GOVERNS.ADD_TO_TRIP, "canCreatePlan");
  });

  it("the wire tells a blocked viewer EXACTLY what it tells a non-member — the whole answer, byte for byte (T439)", () => {
    const rich = { intent: { status: "unreadable", detail: "x" }, sharedObjects: kShared({ now: [kItem("MEETUP", "m1", "HAPPENING_NOW", ["MEET_HERE"])] }, true) } as const; // a member here would be shown a band, offered actions, and told it is degraded
    const stranger = JSON.stringify(kWire(kDecide(kFacts({ member: false, conversationType: "unknown", capabilities: kCaps(Object.fromEntries(CONVERSATION_CAPABILITY_NAMES.map((n) => [n, "TELEGRAPH_AUTH_NOT_MEMBER"]))) })), kRedact)); // §14.1's answer for a stranger: allDenied(NOT_MEMBER)
    for (const [why, blocked] of [["§14.1 saw the block (and degraded)", kFacts({ ...rich, capabilities: { ...kCaps({ canSendMessage: "TELEGRAPH_AUTH_BLOCKED", canCall: "TELEGRAPH_AUTH_BLOCKED", canCreateBooking: "TELEGRAPH_AUTH_BLOCKED" }), degraded: true } })], ["only the relationship saw it", kFacts({ ...rich, relationship: { status: "read", value: { state: "BLOCKED", origins: [], expiredOrigins: [] } } })]] as const) {
      assert.equal(JSON.stringify(kWire(kDecide(blocked), kRedact)), stranger, `${why}: any byte that differs is an oracle for "this person blocked you"`);
    }
  });
});

/* ── the gatherer, over a generic fake ──────────────────────────────────── */

interface KState {
  flags?: Record<string, boolean>;
  errors?: string[];
  rows?: Record<string, any[]>;
}

/** Splits a PostgREST `or=` expression at depth 0 and evaluates it by meaning. */
function kOrMatch(expr: string, row: any): boolean {
  const parts: string[] = [];
  let depth = 0; let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  const cond = (c: string): boolean => {
    if (c.startsWith("and(") && c.endsWith(")")) {
      const inner = c.slice(4, -1);
      const sub: string[] = []; let d = 0; let s = "";
      for (const ch of inner) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { sub.push(s); s = ""; continue; } s += ch; }
      if (s) sub.push(s);
      return sub.every(cond);
    }
    const i = c.indexOf("."); const j = c.indexOf(".", i + 1);
    const col = c.slice(0, i); const op = c.slice(i + 1, j); const val = c.slice(j + 1);
    const v = row[col];
    if (op === "eq") return String(v) === val;
    if (op === "is") return val === "null" ? v == null : String(v) === val;
    if (op === "gte") return Date.parse(String(v)) >= Date.parse(val);
    if (op === "gt") return Date.parse(String(v)) > Date.parse(val);
    return false;
  };
  return parts.some(cond);
}

function kClient(state: KState) {
  const rows: Record<string, any[]> = { ...(state.rows ?? {}) };
  rows.feature_flags = Object.entries(state.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
  const reads: string[] = [];
  const writes: string[] = [];
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let lim: number | null = null; let order: { col: string; asc: boolean } | null = null; let mode: "select" | "delete" | "upsert" = "select";
    const result = () => {
      if ((state.errors ?? []).includes(table)) return { data: null, error: { message: `${table} unreadable` } };
      if (mode !== "select") return { data: null, error: null };
      let out = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) { const o = order; out = [...out].sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1)); }
      if (lim !== null) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    const t: any = {
      select() { reads.push(table); return p; },
      eq(c: string, v: any) { filters.push((r) => String(r[c]) === String(v)); return p; },
      neq(c: string, v: any) { filters.push((r) => String(r[c]) !== String(v)); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return p; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(r[c]))); return p; },
      gte(c: string, v: any) { filters.push((r) => Date.parse(String(r[c])) >= Date.parse(String(v))); return p; },
      lt(c: string, v: any) { filters.push((r) => Date.parse(String(r[c])) < Date.parse(String(v))); return p; },
      or(expr: string) { filters.push((r) => kOrMatch(expr, r)); return p; },
      order(col: string, o?: { ascending?: boolean }) { order = { col, asc: o?.ascending !== false }; return p; },
      limit(n: number) { lim = n; return p; },
      delete() { mode = "delete"; writes.push(`${table}:delete`); return p; },
      upsert() { mode = "upsert"; writes.push(`${table}:upsert`); return p; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: r.data ? (r.data[0] ?? null) : null, error: r.error }); },
      then(res: any, rej?: any) { return Promise.resolve(result()).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return { from, reads, writes, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }), auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) } } as any;
}

const K_MEETUP = "22222222-0000-4000-8000-000000000001";
function kBase(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    message_threads: [
      { id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: DM_BLOCKED, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
      { id: TRIP_THREAD, thread_type: "trip", status: "active", trip_id: TRIP_MINE, circle_owner_id: null, is_e2ee: false },
      { id: STRANGER, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: true },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, role: "member", left_at: null },
      { thread_id: DM, user_id: BOB, role: "member", left_at: null },
      { thread_id: DM_BLOCKED, user_id: ALICE, role: "member", left_at: null },
      { thread_id: DM_BLOCKED, user_id: CARL, role: "member", left_at: null },
      { thread_id: TRIP_THREAD, user_id: ALICE, role: "member", left_at: null },
      { thread_id: TRIP_THREAD, user_id: BOB, role: "member", left_at: null },
      { thread_id: TRIP_THREAD, user_id: CARL, role: "member", left_at: null },
      { thread_id: STRANGER, user_id: BOB, role: "member", left_at: null },
    ],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
    trips: [{ id: TRIP_MINE, owner_id: ALICE }],
    trip_members: [{ trip_id: TRIP_MINE, user_id: ALICE, role: "owner", status: "accepted" }],
    ...extra,
  };
}

describe("T439 — the gatherer reads the five inputs from the resolvers that exist", () => {
  it("a direct conversation with the relationship flag OFF: relationship off, and proximity never even READ", async () => {
    const c = kClient({ flags: { nearby_reachable_enabled: true }, rows: kBase() });
    const r = await kAssemble(c, { viewerId: ALICE, conversationId: DM, nowMs: K_NOW });
    assert.ok(r.ok);
    assert.equal(r.kernel.inputs.relationship.reason, "KERNEL_INPUT_OFF");
    assert.equal(r.kernel.inputs.proximity.reason, "KERNEL_RELATIONSHIP_REQUIRED");
    assert.ok(!c.reads.includes("nearby_proximity_observations"), "a bucket the kernel would withhold must not be observed");
    assert.ok(!c.reads.includes("location_preferences"));
  });

  it("the relationship flag ON and a friendship: ACTIVE, and the proximity pipeline runs (gated by its own flag)", async () => {
    const rows = kBase({ user_friendships: [{ user_a: ALICE < BOB ? ALICE : BOB, user_b: ALICE < BOB ? BOB : ALICE }] });
    const off = kClient({ flags: { telegraph_relationship_context_enabled: true }, rows });
    const r1 = await kAssemble(off, { viewerId: ALICE, conversationId: DM, nowMs: K_NOW });
    assert.ok(r1.ok);
    assert.equal(r1.kernel.inputs.relationship.value?.state, "ACTIVE");
    assert.equal(r1.kernel.inputs.proximity.reason, "KERNEL_INPUT_OFF", "nearby_reachable_enabled is off: no deployment publishes proximity");

    const on = kClient({ flags: { telegraph_relationship_context_enabled: true, nearby_reachable_enabled: true }, rows });
    const r2 = await kAssemble(on, { viewerId: ALICE, conversationId: DM, nowMs: K_NOW });
    assert.ok(r2.ok);
    assert.equal(r2.kernel.inputs.proximity.revealed, true);
    assert.deepEqual(r2.kernel.inputs.proximity.value?.people, [], "nobody is a circle or crew candidate here");
    assert.ok(on.reads.includes("nearby_proximity_observations"), "the read went through the §4.3 observation budget");
  });

  it("proximity: an unreadable flag is unreadable, not off", async () => {
    const r = await kReadProximity(kClient({ errors: ["feature_flags"], rows: kBase() }), ALICE, [BOB], K_NOW);
    assert.equal(r.status, "unreadable");
  });

  it("proximity is narrowed to this conversation's members, and to buckets the projection PUBLISHED", () => {
    const p = (id: string, bucket: string, published: boolean) => ({ personId: id, proximity: { bucket, travel: "walk", freshness: "live", precision: "bucket" }, privacy: { proximityPublished: published } }) as any;
    const out = kProximityFrom([p(BOB, "same_area", true), p(CARL, "same_area", true), p("dddddddd-0000-4000-8000-000000000004", "unknown", false)], [BOB, "dddddddd-0000-4000-8000-000000000004"]);
    assert.deepEqual(out.people.map((x) => x.userId), [BOB]);
    assert.deepEqual(Object.keys(out.people[0]).sort(), ["bucket", "freshness", "travel", "userId"], "bucket-only: no coordinate, no distance");
  });

  it("intent: the newest recognisable message, as a label — never the body", async () => {
    const rows = kBase({ messages: [
      { id: "m-old", thread_id: DM, sender_id: BOB, created_at: kIso(-30), msg_type: "text", body: "where should we eat tonight?", deleted_at: null },
      { id: "m-new", thread_id: DM, sender_id: BOB, created_at: kIso(-5), msg_type: "text", body: "let's meet up this weekend", deleted_at: null },
      { id: "m-stale", thread_id: DM, sender_id: BOB, created_at: kIso(-60 * 25), msg_type: "text", body: "what time works for everyone?", deleted_at: null },
    ] });
    const r = await kReadIntent(kClient({ rows }), { threadId: DM, viewerId: ALICE, visibleFrom: null, isE2ee: false }, K_NOW);
    assert.equal(r.status, "read");
    assert.deepEqual(r.status === "read" ? r.value : null, { intent: "create_meetup", confidence: 0.85, messageId: "m-new", at: kIso(-5), sentByViewer: false });
    assert.ok(!JSON.stringify(r).includes("meet up this weekend"), "the message body must not leave the gatherer");
  });

  it("intent: a blocked sender's message, a deleted one and one outside the §14.3 window are not read", async () => {
    const rows = kBase({ messages: [
      { id: "m-carl", thread_id: TRIP_THREAD, sender_id: CARL, created_at: kIso(-1), msg_type: "text", body: "let's meet up later", deleted_at: null },
      { id: "m-del", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-2), msg_type: "text", body: "any good bars nearby for tonight?", deleted_at: kIso(-1) },
      { id: "m-pre", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-120), msg_type: "text", body: "what time works for everyone?", deleted_at: null },
      { id: "m-ok", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-10), msg_type: "text", body: "where should we eat tonight?", deleted_at: null },
    ] });
    const r = await kReadIntent(kClient({ rows }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: kIso(-60), isE2ee: false }, K_NOW);
    assert.equal(r.status === "read" ? r.value?.messageId : r.status, "m-ok");
    // The only readable message says nothing: each excluded one, if read, would have been the answer.
    const quietRows = { ...rows, messages: rows.messages.map((m: any) => (m.id === "m-ok" ? { ...m, body: "sounds good" } : m)) };
    const quiet = await kReadIntent(kClient({ rows: quietRows }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: kIso(-60), isE2ee: false }, K_NOW);
    assert.deepEqual(quiet, { status: "read", value: null }, "a blocked, deleted or pre-window message was classified");
  });

  it("intent: unreadable messages or blocks are UNREADABLE; an E2EE thread is not applicable; nothing recognised is read-and-null", async () => {
    const msgs = { messages: [{ id: "m1", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-1), msg_type: "text", body: "let's meet up", deleted_at: null }] };
    assert.equal((await kReadIntent(kClient({ rows: kBase(msgs), errors: ["messages"] }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: null, isE2ee: false }, K_NOW)).status, "unreadable");
    assert.equal((await kReadIntent(kClient({ rows: kBase(msgs), errors: ["blocks"] }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: null, isE2ee: false }, K_NOW)).status, "unreadable");
    assert.equal((await kReadIntent(kClient({ rows: kBase(msgs) }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: null, isE2ee: true }, K_NOW)).status, "not_applicable");
    const quiet = await kReadIntent(kClient({ rows: kBase({ messages: [{ id: "m1", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-1), msg_type: "text", body: "ok", deleted_at: null }] }) }), { threadId: TRIP_THREAD, viewerId: ALICE, visibleFrom: null, isE2ee: false }, K_NOW);
    assert.deepEqual(quiet, { status: "read", value: null });
  });

  it("end to end in a trip conversation: a meetup happening now puts the meetup's actions, the NOW actions and the intent's action on offer — each admitted by §14.1", async () => {
    const rows = kBase({
      meetups: [{ id: K_MEETUP, creator_id: BOB, title: "Dinner", starts_at: kIso(-30), ends_at: kIso(60), status: "active", updated_at: kIso(-60) }],
      meetup_invites: [{ meetup_id: K_MEETUP, user_id: ALICE, status: "going" }, { meetup_id: K_MEETUP, user_id: BOB, status: "going" }],
      messages: [{ id: "m1", thread_id: TRIP_THREAD, sender_id: BOB, created_at: kIso(-3), msg_type: "text", body: "what's the plan for tomorrow", deleted_at: null }],
    });
    const r = await kAssemble(kClient({ rows }), { viewerId: ALICE, conversationId: TRIP_THREAD, nowMs: K_NOW });
    assert.ok(r.ok);
    const k = r.kernel;
    assert.equal(k.inputs.relationship.reason, "KERNEL_INPUT_NOT_APPLICABLE");
    assert.equal(k.inputs.time.value?.band, "HAPPENING_NOW");
    assert.equal(k.inputs.sharedObjects.value?.projection.now[0]?.objectId, K_MEETUP);
    assert.equal(k.inputs.intent.value?.intent, "general_plan");
    const offered = kOffered(k);
    for (const a of K_NOW_ACTIONS) assert.ok(offered.includes(`time:${a}`), a);
    assert.ok(offered.includes(`sharedObjects:CHECK_IN_SAFE@${K_MEETUP}`));
    assert.ok(offered.includes("intent:ADD_TO_TRIP"), "a plan intent in a trip conversation, and Alice is accepted crew");
    assert.equal(k.capabilities.canCreatePlan, true);
  });

  it("the membership the kernel rests on: unreadable REFUSES; absent withholds everything", async () => {
    const bad = await kAssemble(kClient({ rows: kBase(), errors: ["message_thread_members"] }), { viewerId: ALICE, conversationId: DM, nowMs: K_NOW });
    assert.equal(bad.ok, false);
    const stranger = await kAssemble(kClient({ rows: kBase() }), { viewerId: ALICE, conversationId: STRANGER, nowMs: K_NOW });
    assert.ok(stranger.ok);
    assert.equal(stranger.kernel.conversationType, "unknown", "a non-member is not told what kind of conversation it is");
    for (const name of K_INPUTS) assert.equal((stranger.kernel.inputs as any)[name].reason, "KERNEL_NOT_MEMBER");
  });

  it("intent: a message older than the recency horizon states no CURRENT intent", async () => {
    const rows = kBase({ messages: [{ id: "m-stale", thread_id: DM, sender_id: BOB, created_at: kIso(-60 * 25), msg_type: "text", body: "let's meet up this weekend", deleted_at: null }] });
    const r = await kReadIntent(kClient({ rows }), { threadId: DM, viewerId: ALICE, visibleFrom: null, isE2ee: false }, K_NOW);
    assert.deepEqual(r, { status: "read", value: null });
  });

  it("a member who LEFT the conversation is a non-member: nothing is gathered or shown", async () => {
    const rows = kBase();
    rows.message_thread_members = rows.message_thread_members.map((m) => (m.thread_id === DM && m.user_id === ALICE ? { ...m, left_at: kIso(-10) } : m));
    rows.messages = [{ id: "m1", thread_id: DM, sender_id: BOB, created_at: kIso(-1), msg_type: "text", body: "let's meet up", deleted_at: null }];
    const c = kClient({ rows });
    const r = await kAssemble(c, { viewerId: ALICE, conversationId: DM, nowMs: K_NOW });
    assert.ok(r.ok);
    for (const name of K_INPUTS) assert.equal((r.kernel.inputs as any)[name].reason, "KERNEL_NOT_MEMBER", name);
    assert.ok(!c.reads.includes("messages"), "a former member's kernel reads no message");
  });

  it("the participant cap is the rail's own", () => {
    assert.equal(K_MAX_PARTICIPANTS, K_RAIL_MAX);
  });
});

describe("T439 — GET /threads/:threadId/context-kernel is mounted on the capability router", () => {
  let server: any;
  let base = "";

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

  async function get(threadId: string, asUser: string) {
    const res = await fetch(`${base}/threads/${threadId}/context-kernel`, { headers: { authorization: `Bearer ${asUser}` } });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("a member gets the five inputs, the capabilities and the actions on offer", async () => {
    _setTestClient(kClient({ rows: kBase() }), true);
    const { status, body } = await get(DM, ALICE);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.inputs), [...K_INPUTS]);
    assert.equal(body.inputs.time.value.frame, "UTC");
    assert.equal(body.capabilities.canSendMessage, true);
    assert.ok(Array.isArray(body.offeredActions));
  });

  /**
   * T439 parity, asserted on the WHOLE response body, as bytes. Exactly one field
   * is normalised, and one more where two different conversations are compared:
   *   - `generatedAt` — the server's clock, quantised to the §4.5 poll quantum. It
   *     says WHEN the request was served, nothing about the conversation or the
   *     viewer, and two sequential requests can straddle a quantum boundary. It is
   *     still checked to be a well-formed instant in every answer.
   *   - `conversationId`, only when comparing two different conversations — it is
   *     the id the caller put in the URL, echoed back, so it tells them nothing.
   * Every other byte must match: any one that differs answers "did this person
   * block me?" (the verifier's finding: the clock, the real conversation type,
   * `inputsRead` and §14.1's grants all used to differ).
   */
  async function getRaw(threadId: string, asUser: string) {
    const res = await fetch(`${base}/threads/${threadId}/context-kernel`, { headers: { authorization: `Bearer ${asUser}` } });
    const text = await res.text();
    const served = /"generatedAt":"([^"]*)"/.exec(text);
    assert.ok(served && Number.isFinite(Date.parse(served[1])), `generatedAt is an instant: ${text}`);
    return { status: res.status, text: text.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<served-at>"') };
  }
  const rt = (deltaMin: number) => new Date(Date.now() + deltaMin * 60_000).toISOString(); // the route reads the real clock
  /** What a MEMBER of DM_BLOCKED would be shown: a meetup happening now with Carl, and a recent plan intent. */
  function richBlockedRows(extra: Record<string, any[]> = {}) {
    return kBase({
      meetups: [{ id: K_MEETUP, creator_id: CARL, title: "Dinner", starts_at: rt(-30), ends_at: rt(60), status: "active", updated_at: rt(-60) }],
      meetup_invites: [{ meetup_id: K_MEETUP, user_id: ALICE, status: "going" }, { meetup_id: K_MEETUP, user_id: CARL, status: "going" }],
      messages: [{ id: "m1", thread_id: DM_BLOCKED, sender_id: ALICE, created_at: rt(-3), msg_type: "text", body: "let's meet up later", deleted_at: null }],
      ...extra,
    });
  }

  it("a blocked viewer and a non-member get the same answer, and neither learns which", async () => {
    _setTestClient(kClient({ rows: richBlockedRows() }), true);
    const blocked = await getRaw(DM_BLOCKED, ALICE);   // a member; Carl blocked her
    const outsider = await getRaw(DM_BLOCKED, BOB);    // the same conversation, asked by someone never in it
    const stranger = await getRaw(STRANGER, ALICE);    // a conversation she was never in
    for (const r of [blocked, outsider, stranger]) assert.equal(r.status, 200, "200, not 403: the endpoint is not a thread-existence oracle");
    assert.deepEqual(JSON.parse(blocked.text), JSON.parse(outsider.text), "the same conversation: the blocked member's answer IS the outsider's");
    assert.equal(blocked.text, outsider.text, "…byte for byte, key order included");
    const unId = (t: string, id: string) => t.split(id).join("<conversation>");
    assert.equal(unId(blocked.text, DM_BLOCKED), unId(stranger.text, STRANGER), "a conversation she was never in: the same answer");
    assert.ok(!blocked.text.includes("BLOCKED"));
  });

  it("the blocked member's answer is decided before anything is gathered: no shared object, message or proximity is read", async () => {
    // The relationship flag OFF, as seeded on every deployment: only §14.1 sees the block, so nothing downstream can catch it instead.
    const c = kClient({ rows: richBlockedRows(), flags: { nearby_reachable_enabled: true } });
    _setTestClient(c, true);
    const blocked = await getRaw(DM_BLOCKED, ALICE);
    assert.equal(blocked.status, 200);
    for (const t of ["meetups", "meetup_invites", "messages", "nearby_proximity_observations", "location_preferences"]) assert.ok(!c.reads.includes(t), `${t} was read for a viewer who is shown nothing`);
  });

  it("a block seen ONLY by the relationship read (an archived DM: §14.1 reports the archive first) is the same non-member answer, gathered no further", async () => {
    const archived = () => { const rows = richBlockedRows(); rows.message_threads = rows.message_threads.map((t: any) => (t.id === DM_BLOCKED ? { ...t, status: "archived" } : t)); return rows; };
    const flags = { telegraph_relationship_context_enabled: true, nearby_reachable_enabled: true };
    const c = kClient({ rows: archived(), flags });
    _setTestClient(c, true);
    const blocked = await getRaw(DM_BLOCKED, ALICE);
    for (const t of ["meetups", "meetup_invites", "messages", "nearby_proximity_observations"]) assert.ok(!c.reads.includes(t), `${t} was read across a block`);
    _setTestClient(kClient({ rows: archived(), flags }), true);
    const outsider = await getRaw(DM_BLOCKED, BOB);
    assert.equal(blocked.status, outsider.status);
    assert.equal(blocked.text, outsider.text);
  });

  it("an unreadable membership is a retryable 503, never an empty context", async () => {
    _setTestClient(kClient({ rows: kBase(), errors: ["message_thread_members"] }), true);
    const { status, body } = await get(DM, ALICE);
    assert.equal(status, 503);
    assert.equal(body.error, "degraded_unavailable");
  });
});
