/**
 * Lead ruling D-24 (2026-10-06) on CALLS — the real call gateway, not a fake.
 *
 * "The sentence a restricted person is shown must name every capability that
 * restriction stops. Anything not named in that sentence must not be refused."
 * The messaging sentence is "You cannot start new conversations, propose
 * changes to a group trip, submit public content (…), or have your posts
 * boosted." It does not name calls. Before this change the call gateway
 * refused EVERY call by a messaging-restricted person ("audit M3: messaging
 * restriction implies calling restriction") — a call to the crew in a trip
 * thread, and a call back to someone who had written to them.
 *
 * Now `makeCallGateway(sc).isCallRestricted(userId, threadId)` asks the send
 * gate's own decision for that thread (`decideRestrictedSendInThread`): a call
 * is refused under messaging exactly where a message would be — a direct thread
 * the other person has never written in, accepted a request in, or booked.
 *
 * WHAT IS EXERCISED: the real adapter over the certification harness's
 * PostgREST fake, and the real permission engine over that adapter.
 *
 * Run: node --import tsx/esm --test src/test/telegraphCallRestrictionD24.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeCallGateway } from "../lib/calls/callGatewayAdapter.js";
import { canUserStartCall } from "../lib/calls/callPermissionEngine.js";
import { makeFakeClient, type FakeDbOptions, type InjectedError } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // the caller
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const T = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const DM_NEW = T("d1"); //     direct A+B, B has never written: a call would START contact
const DM_REPLY = T("d2"); //   direct A+B, B has written
const DM_BOOKING = T("d3"); // direct A+B, a booking owns it
const TRIP = T("d4"); //       trip thread A+B+C

const thread = (id: string, type: string) => ({ id, thread_type: type, trip_id: null, circle_owner_id: null, status: "active", is_e2ee: false });
const member = (thread_id: string, user_id: string) => ({ thread_id, user_id, role: "member", left_at: null });

type World = "none" | "messaging" | "hosting" | "fail_closed";

function client(w: World, extra: FakeDbOptions = {}) {
  const tables: Record<string, unknown[]> = {
    trust_restrictions: w === "messaging" || w === "hosting"
      ? [{ id: "33333333-0000-4000-8000-000000000001", user_id: A, restriction_type: w, lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z" }]
      : [],
    message_threads: [thread(DM_NEW, "direct"), thread(DM_REPLY, "direct"), thread(DM_BOOKING, "direct"), thread(TRIP, "trip")],
    message_thread_members: [
      member(DM_NEW, A), member(DM_NEW, B), member(DM_REPLY, A), member(DM_REPLY, B),
      member(DM_BOOKING, A), member(DM_BOOKING, B), member(TRIP, A), member(TRIP, B), member(TRIP, C),
    ],
    messages: [{ id: "11111111-0000-4000-8000-000000000001", thread_id: DM_REPLY, sender_id: B, body: "hi", created_at: "2026-05-02T00:00:00.000Z" }],
    message_requests: [],
    rent_buddy_bookings: [{ id: "22222222-0000-4000-8000-000000000001", telegraph_thread_id: DM_BOOKING, status: "confirmed" }],
  };
  const errors: Record<string, InjectedError> = w === "fail_closed" ? { trust_restrictions: { message: "trust_restrictions: connection reset" } } : {};
  return makeFakeClient(tables, { ...extra, errors: { ...errors, ...(extra.errors ?? {}) } }) as any;
}

describe("D-24 — the call gateway refuses a call exactly where a send would be refused", () => {
  it("messaging: a call that would START contact is refused as restricted", async () => {
    assert.deepEqual(await makeCallGateway(client("messaging")).isCallRestricted(A, DM_NEW), { restricted: true, degraded: false });
  });

  for (const [label, t] of [["a reply thread", DM_REPLY], ["a booked thread", DM_BOOKING], ["the crew's trip thread", TRIP]] as const) {
    it(`messaging: a call in ${label} starts no new conversation — not refused`, async () => {
      assert.deepEqual(await makeCallGateway(client("messaging")).isCallRestricted(A, t), { restricted: false });
    });
  }

  it("hosting does not reach a call at all, in any thread", async () => {
    for (const t of [DM_NEW, DM_REPLY, TRIP]) {
      assert.deepEqual(await makeCallGateway(client("hosting")).isCallRestricted(A, t), { restricted: false }, t);
    }
  });

  it("CONTROL: unrestricted — no call is refused", async () => {
    assert.deepEqual(await makeCallGateway(client("none")).isCallRestricted(A, DM_NEW), { restricted: false });
  });

  it("an unreadable restriction state refuses a contact-starting call as DEGRADED, never as restricted", async () => {
    assert.deepEqual(await makeCallGateway(client("fail_closed")).isCallRestricted(A, DM_NEW), { restricted: true, degraded: true });
  });

  it("an unreadable thread roster under a messaging restriction is degraded, not 'not restricted'", async () => {
    const r = await makeCallGateway(client("messaging", { errors: { message_thread_members: { message: "roster: timeout" } } })).isCallRestricted(A, DM_REPLY);
    assert.deepEqual(r, { restricted: true, degraded: true });
  });

  it("an unreadable 'has the other person written' read is degraded, never a guess", async () => {
    const r = await makeCallGateway(client("messaging", { errors: { messages: { message: "messages: timeout" } } })).isCallRestricted(A, DM_REPLY);
    assert.deepEqual(r, { restricted: true, degraded: true });
  });
});

describe("D-24 — through the real permission engine", () => {
  it("the engine hands the thread to the gate: a reply-thread call is not refused for the restriction, a new-contact call is", async () => {
    const real = makeCallGateway(client("messaging"));
    // Everything but the restriction gate is held open, so the verdict is the gate's.
    const gw = {
      ...real,
      startsInLastHour: async () => 0,
      getThreadParticipants: async () => [A, B],
      isBlockedEither: async () => false,
      canMessage: async () => true,
      getCallPreferences: async () => ({ whoCanCall: "people_i_message" as const, allowRentABuddyCalls: true, allowVideoCalls: true }),
      lastDeclineAt: async () => null,
    };
    const reply = await canUserStartCall(gw, { callerId: A, calleeId: B, threadId: DM_REPLY, contextType: "telegraph_dm", callType: "voice", nowMs: Date.now() });
    assert.deepEqual(reply, { allowed: true });
    const fresh = await canUserStartCall(gw, { callerId: A, calleeId: B, threadId: DM_NEW, contextType: "telegraph_dm", callType: "voice", nowMs: Date.now() });
    assert.deepEqual(fresh, { allowed: false, reason: "caller_restricted" });
  });
});

// census-telegraph T220 (lane T, 2026-10-07): the REAL adapter's block read, now the shared
// lib/exclusionSet.ts readPairExclusion. No call suite reached it — every engine suite uses a
// fake gateway — so a block read that answered "not blocked", or read an outage as "not
// blocked", stayed green. Here the adapter answers over the certification harness.
describe("T220 — the real adapter's isBlockedEither (the shared pair read)", () => {
  const withBlocks = (rows: Array<{ blocker_id: string; blocked_id: string }>, extra: FakeDbOptions = {}) => {
    const tables: Record<string, unknown[]> = { blocks: rows };
    return makeCallGateway(makeFakeClient(tables, extra) as any);
  };

  it("CONTROL: no block either way is not blocked", async () => {
    assert.equal(await withBlocks([{ blocker_id: A, blocked_id: C }]).isBlockedEither(A, B), false);
  });

  it("a block either way, or a mutual block (two rows), is blocked", async () => {
    assert.equal(await withBlocks([{ blocker_id: A, blocked_id: B }]).isBlockedEither(A, B), true);
    assert.equal(await withBlocks([{ blocker_id: B, blocked_id: A }]).isBlockedEither(A, B), true);
    assert.equal(await withBlocks([{ blocker_id: A, blocked_id: B }, { blocker_id: B, blocked_id: A }]).isBlockedEither(A, B), true);
  });

  it("an unreadable blocks table fails CLOSED (blocked), never 'not blocked'", async () => {
    const gw = withBlocks([], { errors: { blocks: { message: "blocks: connection reset" } } });
    assert.equal(await gw.isBlockedEither(A, B), true);
  });
});
