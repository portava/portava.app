/**
 * Telegraph §24 / §14.1 — census T290, the half of `ConversationProjection`
 * that was never sent.
 *
 * The requirement, verbatim:
 *   §24  "ConversationProjection — renderable ordered thread WITH CURRENT
 *         PERMISSIONS"
 *   §14.1 ConversationCapabilities: canSendMessage, canCall, canCreatePlan,
 *         canShareExactLocation, canInvite, canRequestPayment, canCreateBooking,
 *         canBroadcast, canViewPreMembershipHistory, canSeeGroupReadReceipts —
 *         "computed, never assumed", from membership, block state, trip/crew
 *         membership, booking state, age policy, location scope, safety state
 *         and conversation type.
 *
 * THE DEFECT UNDER TEST. `GET /threads/:id/messages` answered
 * `{ messages, threadId }`. The renderable half was careful — per-viewer
 * identity sanitisation, per-recipient translations, reply context, mention
 * enrichment, the §14.3 history bound — and the permissions half was simply
 * absent. The capabilities themselves were built and proved (T207) and lived
 * behind a separate route nothing in the conversation read called, so the two
 * clauses of one requirement were on opposite sides of the API.
 *
 * WHAT A MISSING PERMISSIONS BLOCK COSTS, concretely. A client rendering a
 * thread has to decide whether to draw Call, Create Plan and Share Location. It
 * had three options and all three are bad: draw them all and let the action be
 * refused after the tap; draw none; or RE-DERIVE the rules from membership and
 * block state on the client — which is §30A.1's anti-pattern ("so eligibility,
 * calling, Nearby, location ... do not independently infer relationship state")
 * arriving by the back door.
 *
 * TWO THINGS THIS FILE ASSERTS THAT A SHAPE TEST WOULD NOT:
 *
 *   1. THE BLOCK AGREES WITH THE RESOLVER, NOT WITH ITSELF. The projection's
 *      answer is compared field-by-field against
 *      `resolveConversationCapabilities` run directly on the same fixture. A
 *      projection that computed its own booleans would pass a "has ten keys"
 *      test and fail this one, which is the whole point: the failure mode being
 *      guarded is a SECOND implementation of the rules, not an absent one.
 *
 *   2. A DEGRADED ANSWER SAYS SO. A capability set computed over an unreadable
 *      input is a floor, not the truth. With `blocks` unreadable the projection
 *      must still answer — the thread is readable and the messages are real —
 *      but it must carry `degraded: true`, because shipping the booleans alone
 *      hands the client a confident false and rebuilds §30A.16's defect one
 *      layer up.
 *
 * AND WHAT IT DELIBERATELY DOES NOT ASSERT: that the block gates anything.
 * §14.1's final sentence is that capabilities are computed and separately
 * enforced at each operation; `CAPABILITY_ENFORCEMENT_SITES` names the sites.
 * The last test pins that reading — every capability is either enforced
 * somewhere named, or declared to have no operation to gate.
 *
 * SHOWN RED before green — see docs/architecture/census-telegraph.md §15.4.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphProjectionPermissions.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type InjectedError,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";
import {
  CONVERSATION_CAPABILITY_NAMES,
  CAPABILITY_ENFORCEMENT_SITES,
} from "../domain/telegraph/contracts/conversationCapabilities.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const TRIP_THREAD = "00000000-0000-4000-8000-00000000000a";
const DM_BLOCKED = "00000000-0000-4000-8000-00000000000b";
const TRIP = "00000000-0000-4000-8000-0000000000b1";
const M1 = "11111111-0000-4000-8000-000000000001";
const M2 = "11111111-0000-4000-8000-000000000002";

const DOWN: InjectedError = { message: "permission denied for relation", code: "42501" };

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", show_name: true },
      { id: BOB, handle: "bob", name: "Bob", show_name: true },
      { id: CAROL, handle: "carol", name: "Carol", show_name: true },
    ],
    blocks: [{ blocker_id: CAROL, blocked_id: ALICE }],
    message_threads: [
      {
        id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Cebu crew", status: "active", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
      {
        id: DM_BLOCKED, thread_type: "direct", trip_id: null, circle_owner_id: null,
        title: null, status: "active", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      { thread_id: TRIP_THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: TRIP_THREAD, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM_BLOCKED, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM_BLOCKED, user_id: CAROL, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      { id: M1, thread_id: TRIP_THREAD, sender_id: ALICE, body: "nos vemos en el muelle", created_at: "2026-03-11T00:00:00.000Z", deleted_at: null, edited_at: null, original_language: "es", msg_type: "text", subtype: null, media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
      { id: M2, thread_id: DM_BLOCKED, sender_id: CAROL, body: "hi", created_at: "2026-03-11T00:00:00.000Z", deleted_at: null, edited_at: null, original_language: "en", msg_type: "text", subtype: null, media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
    ],
    message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
    ],
    message_requests: [],
    user_privacy_settings: [],
    // BOB is under a hosting restriction and ALICE is not. This is the ONLY
    // asymmetry in the fixture that is not symmetric between two people (a
    // block is), and it is what makes "resolved for the caller" distinguishable
    // from "resolved for somebody else in the thread" — see the mutation P5
    // note in §15.4.
    trust_restrictions: [
      { id: "77770000-0000-4000-8000-000000000001", user_id: BOB, restriction_type: "hosting", lifted_at: null, expires_at: null },
    ],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
  };
}

let harness: RouterHarness;

function use(state: Record<string, any[]>, errors?: Record<string, InjectedError>): FakeClient {
  const c = makeFakeClient(state, errors ? { errors } : undefined);
  _setTestClient(c, true);
  return c;
}

before(async () => {
  harness = await startRouter(messagingRouter);
});
after(async () => {
  await harness.close();
});
beforeEach(() => {
  resetFakeIds();
});

// ── §24: the projection carries permissions at all ───────────────────────────

describe("T290 — the ConversationProjection carries CURRENT PERMISSIONS", () => {
  it("the thread read answers a permissions block, not just messages", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.messages), "the renderable half is still there");
    assert.ok(
      r.body.permissions,
      "EXPECTED: §24's 'renderable ordered thread WITH CURRENT PERMISSIONS'. " +
        `ACTUAL: ${JSON.stringify(Object.keys(r.body))} — the permissions half is absent.`,
    );
  });

  it("all ten of §14.1's capabilities are present and are booleans", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    const caps = r.body.permissions.capabilities;
    assert.deepEqual(
      Object.keys(caps).sort(),
      [...CONVERSATION_CAPABILITY_NAMES].sort(),
      "the block must be §14.1's ten, no more and no fewer",
    );
    for (const name of CONVERSATION_CAPABILITY_NAMES) {
      assert.equal(typeof caps[name], "boolean", `${name} is not a boolean`);
    }
  });

  it("a false capability carries a REASON, so a client can say why", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/messages`, ALICE);
    assert.equal(r.status, 200);
    const { capabilities, reasons } = r.body.permissions;
    assert.equal(capabilities.canSendMessage, false, "a blocked DM must not report canSendMessage");
    assert.ok(reasons.canSendMessage, "a denial with no reason is not actionable");
    for (const name of CONVERSATION_CAPABILITY_NAMES) {
      if (capabilities[name] === false) {
        assert.ok(
          reasons[name] !== undefined,
          `${name} is false and has no reasons entry`,
        );
      }
    }
  });
});

// ── the block is the resolver's answer, not a second implementation ──────────

describe("T290 / §30A.1 — one implementation, not two", () => {
  it("the projection's block EQUALS resolveConversationCapabilities on the same fixture", async () => {
    const c = use(seed());
    const direct = await resolveConversationCapabilities(c as any, {
      viewerId: ALICE,
      conversationId: TRIP_THREAD,
    });
    // The route re-reads through its own client; re-seed so both see the same
    // database rather than a mutated one.
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    assert.deepEqual(
      r.body.permissions.capabilities,
      direct.capabilities,
      "the projection disagrees with the resolver — that is two implementations of §14.1, which is the defect §30A.1 names",
    );
    assert.deepEqual(r.body.permissions.reasons, direct.reasons);
    assert.deepEqual(r.body.permissions.inputsRead, direct.inputsRead);
  });

  it("the block is per VIEWER and per THREAD, not one answer for the endpoint", async () => {
    use(seed());
    const inTrip = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    use(seed());
    const inBlockedDm = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/messages`, ALICE);
    assert.equal(inTrip.status, 200);
    assert.equal(inBlockedDm.status, 200);
    assert.equal(inTrip.body.permissions.viewerId, undefined, "the viewer is implied by auth, not echoed");
    assert.notDeepEqual(
      inTrip.body.permissions.capabilities,
      inBlockedDm.body.permissions.capabilities,
      "one person got identical capabilities in a live trip thread and in a blocked DM — " +
        "the block is not being computed for THIS conversation",
    );
    assert.equal(inTrip.body.permissions.capabilities.canSendMessage, true);
    assert.equal(inBlockedDm.body.permissions.capabilities.canSendMessage, false);
  });

  it("the block is resolved for the CALLER, not for anybody else in the thread", async () => {
    // ALICE is the only sender in this thread and is unrestricted; BOB is the
    // caller and is under a hosting restriction. A block resolved for the wrong
    // member would report BOB as able to create a plan.
    use(seed());
    const asBob = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, BOB);
    use(seed());
    const asAlice = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    assert.equal(asBob.status, 200);
    assert.equal(asAlice.status, 200);
    assert.equal(
      asBob.body.permissions.capabilities.canCreatePlan, false,
      "BOB is trust-restricted from hosting and the block says he may create a plan — " +
        "it was resolved for somebody else",
    );
    assert.equal(asBob.body.permissions.reasons.canCreatePlan, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
    assert.equal(
      asAlice.body.permissions.capabilities.canCreatePlan, true,
      "ALICE is unrestricted and an accepted member of the trip",
    );
  });

  it("it names WHICH of §14.1's eight inputs were actually read", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    const read: string[] = r.body.permissions.inputsRead;
    assert.ok(Array.isArray(read) && read.length > 0, "inputsRead is empty or missing");
    assert.ok(read.includes("membership"), "membership is always read");
    assert.ok(read.includes("conversationType"), "conversation type is always read");
  });
});

// ── a degraded answer says so ────────────────────────────────────────────────

describe("T290 / §30A.16 — a capability set over an unreadable input is a FLOOR", () => {
  it("the normal case carries degraded:false and NO degraded reasons", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    assert.equal(r.body.permissions.degraded, false);
    assert.deepEqual(r.body.permissions.degradedReasons, []);
  });

  it("an unreadable trust table marks the block degraded rather than reporting a confident false", async () => {
    use(seed(), { trust_restrictions: DOWN });
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    assert.equal(r.status, 200, "the thread is readable; the messages are real; this is not a refusal");
    assert.equal(
      r.body.permissions.degraded, true,
      "EXPECTED: degraded:true. ACTUAL: a capability set computed over an unreadable input, " +
        "shipped as though it were the truth — which is §30A.16's defect one layer up.",
    );
    assert.ok(
      r.body.permissions.degradedReasons.length > 0,
      "degraded with no reason tells a client nothing it can act on",
    );
  });

  it("an unreadable thread row does not silently become an empty capability set", async () => {
    use(seed(), { message_threads: DOWN });
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, ALICE);
    if (r.status === 200) {
      assert.equal(
        r.body.permissions.degraded, true,
        "the thread row could not be read and the block does not say so",
      );
    }
  });
});

// ── the block is not the gate ────────────────────────────────────────────────

describe("§14.1 — the projection reports capabilities; it does not enforce them", () => {
  it("every capability is either enforced at a named site or declared to have no operation", () => {
    for (const name of CONVERSATION_CAPABILITY_NAMES) {
      const site = CAPABILITY_ENFORCEMENT_SITES[name];
      assert.ok(
        site === null || (typeof site === "string" && site.length > 0),
        `${name} has neither an enforcement site nor a declared absence — the projection would be the only thing saying no`,
      );
    }
  });

  it("the projection's own endpoint is NOT listed as the enforcement site for anything it cannot refuse", () => {
    // canSendMessage is enforced by POST, not by the GET that reports it. If
    // this ever named the projection route, the block would have become the
    // gate — which §14.1's final sentence forbids.
    assert.ok(
      String(CAPABILITY_ENFORCEMENT_SITES.canSendMessage).includes("POST /threads/:threadId/messages"),
      "canSendMessage must be enforced at the send, not at the read that reports it",
    );
  });
});
