/**
 * FOUR GUARDS IN callPermissionEngine THAT NOTHING WAS TESTING.
 *
 * The existing calling suites — callRoutes (85), callHardening (21), callSystem
 * (32), callAnalytics (17) — all pass. That is not the same as covering what
 * they name. Each guard in callPermissionEngine.ts was DELETED one at a time and
 * all four suites re-run; four deletions left every suite at full green, exit 0:
 *
 *   canUserModerateCall
 *     isSessionTerminated -> 'room_terminated'
 *       A moderator could mute, remove and promote inside a room the server had
 *       already terminated. The docstring above the function says moderation
 *       rights exist "only while the room is alive"; nothing held it to that.
 *
 *     eventRoomIneligibility -> 'not_event_eligible' | 'age_ineligible' |
 *                              'trust_ineligible'
 *       This is the one that matters. Its own comment reads "Full event
 *       eligibility still applies to moderators (bans, blocks, trust)" — and a
 *       banned, blocked or trust-restricted event staffer kept full moderation
 *       power over everyone else in the room, with no test to notice. A comment
 *       asserting a security property is not the property.
 *
 *   canUserStartCall
 *     !participants.includes(calleeId) -> 'callee_not_participant'
 *       The caller-side twin of this check IS tested; the callee-side one was
 *       not, so a caller could ring someone who is not in the thread at all.
 *
 *   canUserJoinCall
 *     !participants.includes(input.userId) -> 'not_a_participant'
 *       Join-time thread membership. A user with a callId could walk into a
 *       direct room they were never party to. (The blocks re-check on the very
 *       next line IS tested — which is how a gap like this survives: its
 *       neighbours are covered.)
 *
 * Every test below is PAIRED: the deny case, and a control identical except for
 * the single gateway answer under test, which must ALLOW. A guard that simply
 * denied everything would fail the controls.
 *
 * Run: node --import tsx/esm --test src/test/callModerationGuards.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canUserStartCall, canUserJoinCall, canUserModerateCall,
  type CallContextGateway,
} from "../lib/calls/callPermissionEngine.js";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const CALLER = "caller";
const CALLEE = "callee";
const EVENT = "event-1";
const CALL = "call-1";

/** A gateway on which everything is permitted; each test flips exactly one answer. */
function gw(over: Partial<CallContextGateway> = {}): CallContextGateway {
  return {
    getThreadParticipants: async () => [CALLER, CALLEE],
    canMessage: async () => true,
    isBlockedEither: async () => false,
    getCallPreferences: async () => ({
      whoCanCall: "people_i_message", allowRentABuddyCalls: true, allowVideoCalls: true,
    }),
    isEligibleRabConversation: async () => true,
    isActiveCrewMember: async () => true,
    eventRoomIneligibility: async () => null,
    eventStaffRole: async () => "host",
    isCallRestricted: async () => ({ restricted: false }),
    isSessionTerminated: async () => false,
    wasRemovedFromCall: async () => false,
    lastDeclineAt: async () => null,
    startsInLastHour: async () => 0,
    ...over,
  };
}

const moderateInput = { userId: CALLER, callId: CALL, contextType: "event" as const, contextId: EVENT, nowMs: NOW };
const startInput = {
  callerId: CALLER, calleeId: CALLEE, threadId: "t1",
  contextType: "telegraph_dm" as const, callType: "voice" as const, nowMs: NOW,
};
const joinInput = {
  userId: CALLER, callId: CALL, contextType: "telegraph_dm" as const,
  contextId: "t1", threadId: "t1", otherPartyId: CALLEE, nowMs: NOW,
};

let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

// ── canUserModerateCall ─────────────────────────────────────────────────────

describe("canUserModerateCall — a terminated room admits no moderation", () => {
  it("POSITIVE CONTROL: an event host moderates a live room", async () => {
    const r = await canUserModerateCall(gw(), moderateInput);
    assert.deepEqual(checked(r), { allowed: true });
  });

  it("denies with room_terminated once the session is terminated", async () => {
    const r = await canUserModerateCall(gw({ isSessionTerminated: async () => true }), moderateInput);
    assert.deepEqual(checked(r), { allowed: false, reason: "room_terminated" });
  });

  it("checks the room state BEFORE the staff role, so a terminated room denies even a non-host", async () => {
    // Ordering matters: `room_terminated` must not be masked by
    // `not_room_moderator`, or the client cannot tell a dead room from a
    // permission problem and will keep retrying the wrong fix.
    const r = await canUserModerateCall(
      gw({ isSessionTerminated: async () => true, eventStaffRole: async () => null }),
      moderateInput,
    );
    assert.deepEqual(checked(r), { allowed: false, reason: "room_terminated" });
  });
});

describe("canUserModerateCall — event eligibility still binds moderators", () => {
  it("POSITIVE CONTROL: an eligible host is allowed", async () => {
    const r = await canUserModerateCall(gw({ eventRoomIneligibility: async () => null }), moderateInput);
    assert.deepEqual(checked(r), { allowed: true });
  });

  for (const reason of ["not_event_eligible", "age_ineligible", "trust_ineligible"] as const) {
    it(`denies a host who is ${reason} — bans, blocks and trust bind moderators too`, async () => {
      // Without this guard, a banned or blocked event staffer keeps full power
      // to mute, remove and promote everyone else in the room.
      const r = await canUserModerateCall(
        gw({ eventRoomIneligibility: async () => reason }),
        moderateInput,
      );
      assert.deepEqual(checked(r), { allowed: false, reason });
    });
  }

  it("eligibility is checked even when the staff role would allow it", async () => {
    // The failure mode this pins: an ineligible HOST. If eligibility were
    // checked only for non-staff, the guard would be decorative.
    const r = await canUserModerateCall(
      gw({ eventStaffRole: async () => "host", eventRoomIneligibility: async () => "trust_ineligible" }),
      moderateInput,
    );
    assert.equal(checked(r.allowed), false);
    assert.equal(checked((r as any).reason), "trust_ineligible");
  });
});

// ── canUserStartCall: the callee-side thread membership check ───────────────

describe("canUserStartCall — the CALLEE must be in the thread too", () => {
  it("POSITIVE CONTROL: both parties in the thread, the call is allowed", async () => {
    const r = await canUserStartCall(gw(), startInput);
    assert.deepEqual(checked(r), { allowed: true });
  });

  it("denies callee_not_participant when the callee is not in the thread", async () => {
    // The caller IS a participant here, so only the callee-side check can deny.
    const r = await canUserStartCall(
      gw({ getThreadParticipants: async () => [CALLER, "someone-else"] }),
      startInput,
    );
    assert.deepEqual(checked(r), { allowed: false, reason: "callee_not_participant" });
  });

  it("keeps the two membership denials distinct", async () => {
    // A single "not_a_participant" for both sides would tell the caller their
    // own access is the problem when it is the callee who is not in the thread.
    const callerOut = await canUserStartCall(
      gw({ getThreadParticipants: async () => [CALLEE, "someone-else"] }),
      startInput,
    );
    assert.deepEqual(checked(callerOut), { allowed: false, reason: "not_a_participant" });
  });
});

// ── canUserJoinCall: join-time thread membership ───────────────────────────

describe("canUserJoinCall — a callId is not an invitation", () => {
  it("POSITIVE CONTROL: a thread participant may join", async () => {
    const r = await canUserJoinCall(gw(), joinInput);
    assert.deepEqual(checked(r), { allowed: true });
  });

  it("denies not_a_participant when the joiner was never party to the thread", async () => {
    const r = await canUserJoinCall(
      gw({ getThreadParticipants: async () => [CALLEE, "someone-else"] }),
      joinInput,
    );
    assert.deepEqual(checked(r), { allowed: false, reason: "not_a_participant" });
  });

  it("denies context_not_found when the thread itself cannot be resolved", async () => {
    // Distinct from "you are not a participant": null means the thread is gone
    // or unreadable, and answering "not a participant" would be a claim about
    // this person derived from the absence of a thread.
    const r = await canUserJoinCall(gw({ getThreadParticipants: async () => null }), joinInput);
    assert.deepEqual(checked(r), { allowed: false, reason: "context_not_found" });
  });
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 15, `expected >=15 checked assertions, got ${inspected}`);
  });
});
