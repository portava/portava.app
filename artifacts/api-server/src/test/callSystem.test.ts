/**
 * Calling core tests — permission matrix (spec §32) + lifecycle + reconciler.
 * Run: node --import tsx/esm --test src/test/callSystem.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canUserStartCall, canUserStartGroupCall, canUserJoinCall,
  type CallContextGateway, type CallPreferences,
} from '../lib/calls/callPermissionEngine';
import {
  transition, ringExpired, maxDurationReached, callHistoryLine, isTerminal,
} from '../lib/calls/callStateMachine';
import { reconcileWebhookEvent, sweepOpenSessions, type CallStore } from '../lib/calls/callReconciler';
import { isRabBookingCallEligible, makeCallGateway } from '../lib/calls/callGatewayAdapter';
import { CALL_CONFIG } from '../lib/calls/callTypes';

/** Fake trust_restrictions query builder — mirrors trust.test.ts's shape. */
function makeRestrictionQueryClient(outcome:
  | { kind: 'tuple'; data: any; error: any }
  | { kind: 'throw'; err: any }
): any {
  const builder: any = {
    select: () => builder,
    eq:     () => builder,
    is:     () => builder,
    or:     () => builder,
    then(onF: any, onR: any) {
      const p = outcome.kind === 'throw'
        ? Promise.reject(outcome.err)
        : Promise.resolve({ data: outcome.data, error: outcome.error });
      return p.then(onF, onR);
    },
  };
  return { from: () => builder };
}

const NOW = Date.parse('2026-07-18T12:00:00Z');
const ISO = new Date(NOW).toISOString();

const DEFAULT_PREFS: CallPreferences = {
  whoCanCall: 'people_i_message', allowRentABuddyCalls: true, allowVideoCalls: true,
};

/** Fake gateway with per-test overrides. */
function gw(over: Partial<CallContextGateway> = {}): CallContextGateway {
  return {
    getThreadParticipants: async () => ['caller', 'callee'],
    canMessage: async () => true,
    isBlockedEither: async () => false,
    getCallPreferences: async () => ({ ...DEFAULT_PREFS }),
    isEligibleRabConversation: async () => true,
    isActiveCrewMember: async () => true,
    eventRoomIneligibility: async () => null,
    isCallRestricted: async () => ({ restricted: false }),
    isSessionTerminated: async () => false,
    wasRemovedFromCall: async () => false,
    lastDeclineAt: async () => null,
    startsInLastHour: async () => 0,
    ...over,
  };
}

const start = (over: Partial<Parameters<typeof canUserStartCall>[1]> = {}) =>
  canUserStartCall(gw((over as any).__gw ?? {}), {
    callerId: 'caller', calleeId: 'callee', threadId: 't1',
    contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW, ...over,
  });

describe('permission engine — direct calls', () => {
  it('valid DM participant → allowed', async () => {
    assert.deepEqual(await canUserStartCall(gw(), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1',
      contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    }), { allowed: true });
  });

  it('unauthenticated → denied', async () => {
    const r = await canUserStartCall(gw(), { callerId: null, calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW });
    assert.deepEqual(r, { allowed: false, reason: 'unauthenticated' });
  });

  it('stranger (not in thread) → denied', async () => {
    const r = await canUserStartCall(gw({ getThreadParticipants: async () => ['someone', 'callee'] }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: false, reason: 'not_a_participant' });
  });

  it('blocked either direction → denied', async () => {
    const r = await canUserStartCall(gw({ isBlockedEither: async () => true }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: false, reason: 'blocked' });
  });

  it('messaging not permitted → denied', async () => {
    const r = await canUserStartCall(gw({ canMessage: async () => false }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: false, reason: 'messaging_not_permitted' });
  });

  it('invalid thread → denied', async () => {
    const r = await canUserStartCall(gw({ getThreadParticipants: async () => null }), {
      callerId: 'caller', calleeId: 'callee', threadId: 'nope', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: false, reason: 'context_not_found' });
  });

  it('callee disabled calls → denied; RAB-only callee denies plain DM calls', async () => {
    const nobody = await canUserStartCall(gw({ getCallPreferences: async () => ({ ...DEFAULT_PREFS, whoCanCall: 'nobody' }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(nobody, { allowed: false, reason: 'callee_calls_disabled' });
    const rabOnly = await canUserStartCall(gw({ getCallPreferences: async () => ({ ...DEFAULT_PREFS, whoCanCall: 'rab_contacts' }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(rabOnly, { allowed: false, reason: 'callee_calls_disabled' });
  });

  it('video call blocked by allow_video_calls=false, voice still fine', async () => {
    const g = gw({ getCallPreferences: async () => ({ ...DEFAULT_PREFS, allowVideoCalls: false }) });
    const video = await canUserStartCall(g, { callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'video', nowMs: NOW });
    assert.deepEqual(video, { allowed: false, reason: 'video_calls_disabled' });
    const voice = await canUserStartCall(g, { callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW });
    assert.deepEqual(voice, { allowed: true });
  });

  it('valid RAB contact → allowed; ineligible RAB context → denied; RAB calls off → denied', async () => {
    const ok = await canUserStartCall(gw(), { callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW });
    assert.deepEqual(ok, { allowed: true });
    const bad = await canUserStartCall(gw({ isEligibleRabConversation: async () => false }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(bad, { allowed: false, reason: 'rab_context_ineligible' });
    const off = await canUserStartCall(gw({ getCallPreferences: async () => ({ ...DEFAULT_PREFS, allowRentABuddyCalls: false }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(off, { allowed: false, reason: 'rab_calls_disabled' });
  });

  it('blocked in a RAB context → denied (blocks beat booking eligibility)', async () => {
    const r = await canUserStartCall(gw({ isBlockedEither: async () => true }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: false, reason: 'blocked' });
  });

  it("callee 'rab_contacts' preference admits eligible RAB calls", async () => {
    const g = gw({ getCallPreferences: async () => ({ ...DEFAULT_PREFS, whoCanCall: 'rab_contacts' }) });
    const r = await canUserStartCall(g, {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(r, { allowed: true });
  });

  it('restricted caller, redial cooldown, and rate limit → denied', async () => {
    const restricted = await canUserStartCall(gw({ isCallRestricted: async () => ({ restricted: true }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(restricted, { allowed: false, reason: 'caller_restricted' });
    // A real restriction and a degraded (could-not-check) read must deny with
    // DIFFERENT reasons — showing "caller_restricted" for the degraded case
    // would tell the caller they're moderation-restricted when the truth is
    // the check itself failed.
    const degraded = await canUserStartCall(gw({ isCallRestricted: async () => ({ restricted: true, degraded: true }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(degraded, { allowed: false, reason: 'degraded_unavailable' });
    const notRestricted = await canUserStartCall(gw({ isCallRestricted: async () => ({ restricted: false }) }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(notRestricted, { allowed: true }, 'normal-allowed: not restricted, no other blocker, call proceeds');
    const redial = await canUserStartCall(gw({ lastDeclineAt: async () => NOW - 10_000 }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(redial, { allowed: false, reason: 'redial_cooldown' });
    const limited = await canUserStartCall(gw({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't1', contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(limited, { allowed: false, reason: 'rate_limited' });
  });
});

describe('RAB booking-state call eligibility (adapter matrix)', () => {
  it('thread-live statuses are call-eligible; pre-thread and dead statuses are not', () => {
    for (const status of ['confirmed', 'scheduled', 'in_progress', 'completed_pending_traveler_confirmation', 'disputed']) {
      assert.equal(isRabBookingCallEligible({ status }), true, status);
    }
    for (const status of ['pending', 'requested', 'cancelled', 'no_show_pending']) {
      assert.equal(isRabBookingCallEligible({ status }), false, status);
    }
  });

  it('all cancellation variants are start-ineligible (policy: only NEW calls are denied)', () => {
    for (const status of ['cancelled', 'cancelled_by_traveler', 'cancelled_by_buddy']) {
      assert.equal(isRabBookingCallEligible({ status }), false, status);
    }
  });

  it('completed bookings stay callable only while BOTH parties stay connected', () => {
    assert.equal(isRabBookingCallEligible({ status: 'completed', stay_connected_traveler: true, stay_connected_buddy: true }), true);
    assert.equal(isRabBookingCallEligible({ status: 'completed', stay_connected_traveler: true, stay_connected_buddy: false }), false);
    assert.equal(isRabBookingCallEligible({ status: 'completed', stay_connected_traveler: false, stay_connected_buddy: true }), false);
    assert.equal(isRabBookingCallEligible({ status: 'completed' }), false);
  });
});

describe('permission engine — groups & join', () => {
  it('crew member joins; non-member denied', async () => {
    const ok = await canUserStartGroupCall(gw(), { userId: 'u1', contextType: 'trip_crew', contextId: 'trip1', nowMs: NOW });
    assert.deepEqual(ok, { allowed: true });
    const no = await canUserStartGroupCall(gw({ isActiveCrewMember: async () => false }), { userId: 'u1', contextType: 'trip_crew', contextId: 'trip1', nowMs: NOW });
    assert.deepEqual(no, { allowed: false, reason: 'not_crew_member' });
  });

  it('group start: a degraded restriction check denies with degraded_unavailable, not caller_restricted', async () => {
    const restricted = await canUserStartGroupCall(gw({ isCallRestricted: async () => ({ restricted: true }) }), {
      userId: 'u1', contextType: 'trip_crew', contextId: 'trip1', nowMs: NOW,
    });
    assert.deepEqual(restricted, { allowed: false, reason: 'caller_restricted' });
    const degraded = await canUserStartGroupCall(gw({ isCallRestricted: async () => ({ restricted: true, degraded: true }) }), {
      userId: 'u1', contextType: 'trip_crew', contextId: 'trip1', nowMs: NOW,
    });
    assert.deepEqual(degraded, { allowed: false, reason: 'degraded_unavailable' });
  });

  describe('makeCallGateway(sc).isCallRestricted — the real adapter, not a fake', () => {
    it('normal-allowed: an empty trust_restrictions read is not restricted', async () => {
      const sc = makeRestrictionQueryClient({ kind: 'tuple', data: [], error: null });
      const result = await makeCallGateway(sc).isCallRestricted('u1');
      assert.deepEqual(result, { restricted: false, degraded: false });
    });

    it('a real messaging restriction denies as restricted, not degraded', async () => {
      const sc = makeRestrictionQueryClient({
        kind: 'tuple', data: [{ restriction_type: 'messaging' }], error: null,
      });
      const result = await makeCallGateway(sc).isCallRestricted('u1');
      assert.deepEqual(result, { restricted: true, degraded: false });
    });

    it('fail-open-silent: a missing table is not restricted at all', async () => {
      const sc = makeRestrictionQueryClient({
        kind: 'tuple', data: null,
        error: { code: '42P01', message: 'relation "trust_restrictions" does not exist' },
      });
      const result = await makeCallGateway(sc).isCallRestricted('u1');
      assert.deepEqual(result, { restricted: false, degraded: false }, 'fail-open must never deny a call');
    });

    it('fail-closed-message: a read error denies as degraded, never caller_restricted', async () => {
      const sc = makeRestrictionQueryClient({
        kind: 'throw', err: new Error('connection terminated unexpectedly'),
      });
      const result = await makeCallGateway(sc).isCallRestricted('u1');
      assert.deepEqual(result, { restricted: true, degraded: true });
    });
  });

  it('event eligibility delegates to canonical service (age/trust/attendance)', async () => {
    for (const reason of ['not_event_eligible', 'age_ineligible', 'trust_ineligible'] as const) {
      const r = await canUserStartGroupCall(gw({ eventRoomIneligibility: async () => reason }), {
        userId: 'u1', contextType: 'event', contextId: 'e1', nowMs: NOW,
      });
      assert.deepEqual(r, { allowed: false, reason });
    }
  });

  it('terminated session admits no one; removed participants cannot rejoin; block re-checked at join', async () => {
    const dead = await canUserJoinCall(gw({ isSessionTerminated: async () => true }), {
      userId: 'u1', callId: 'c1', contextType: 'trip_crew', contextId: 'trip1', threadId: null, nowMs: NOW,
    });
    assert.deepEqual(dead, { allowed: false, reason: 'room_terminated' });
    const removed = await canUserJoinCall(gw({ wasRemovedFromCall: async () => true }), {
      userId: 'u1', callId: 'c1', contextType: 'trip_crew', contextId: 'trip1', threadId: null, nowMs: NOW,
    });
    assert.deepEqual(removed, { allowed: false, reason: 'removed_from_room' });
    const blocked = await canUserJoinCall(gw({ isBlockedEither: async () => true }), {
      userId: 'caller', callId: 'c1', contextType: 'telegraph_dm', contextId: 't1', threadId: 't1', otherPartyId: 'callee', nowMs: NOW,
    });
    assert.deepEqual(blocked, { allowed: false, reason: 'blocked' });
  });
});

describe('state machine', () => {
  it('ringing → active → ended writes timestamps and tears down the room', () => {
    const a = transition({ status: 'ringing' }, { type: 'ACCEPT' }, ISO);
    assert.equal(a.status, 'active');
    assert.equal(a.patch.connectedAt, ISO);
    const e = transition({ status: 'active' }, { type: 'END' }, ISO);
    assert.equal(e.status, 'ended');
    assert.equal(e.patch.endedAt, ISO);
    assert.equal(e.terminateRoom, true);
  });

  it('ringing → declined / missed / canceled; terminal states are frozen', () => {
    assert.equal(transition({ status: 'ringing' }, { type: 'DECLINE' }, ISO).status, 'declined');
    assert.equal(transition({ status: 'ringing' }, { type: 'RING_TIMEOUT' }, ISO).status, 'missed');
    assert.equal(transition({ status: 'ringing' }, { type: 'CANCEL' }, ISO).status, 'canceled');
    for (const s of ['ended', 'missed', 'declined', 'canceled', 'failed'] as const) {
      assert.equal(isTerminal(s), true);
      const r = transition({ status: s }, { type: 'END' }, ISO);
      assert.equal(r.ok, false);
      assert.equal(r.status, s);
    }
  });

  it('room_finished from LiveKit does not re-terminate the room', () => {
    const r = transition({ status: 'active' }, { type: 'ROOM_FINISHED' }, ISO);
    assert.equal(r.status, 'ended');
    assert.equal(r.terminateRoom, false);
  });

  it('ring expiry and 4h cap trigger at the configured thresholds', () => {
    const started = new Date(NOW - CALL_CONFIG.RING_TIMEOUT_MS - 1).toISOString();
    assert.equal(ringExpired({ status: 'ringing', startedAt: started }, NOW), true);
    assert.equal(ringExpired({ status: 'ringing', startedAt: new Date(NOW - 1000).toISOString() }, NOW), false);
    const connected = new Date(NOW - CALL_CONFIG.MAX_CALL_DURATION_MS - 1).toISOString();
    assert.equal(maxDurationReached({ status: 'active', connectedAt: connected, startedAt: connected }, NOW), true);
  });

  it('history lines match the spec examples', () => {
    assert.equal(callHistoryLine({ callType: 'voice', status: 'missed', connectedAt: null, endedAt: null }), 'Missed voice call');
    assert.equal(callHistoryLine({ callType: 'video', status: 'ended', connectedAt: new Date(NOW - 18 * 60_000).toISOString(), endedAt: ISO }), 'Video call · 18 min');
    assert.equal(callHistoryLine({ callType: 'voice', status: 'declined', connectedAt: null, endedAt: null }), 'Call declined');
  });
});

describe('reconciler', () => {
  function makeStore(session: any) {
    const calls: string[] = [];
    const store: CallStore = {
      getSessionByRoom: async () => session,
      getSession: async () => session,
      applyTransition: async (_id, from, to) => {
        calls.push(`${from}->${to}`);
        if (session.status !== from) return false; // CAS
        session.status = to;
        return true;
      },
      markParticipantJoined: async () => { calls.push('pjoin'); },
      markParticipantLeft: async () => { calls.push('pleft'); },
      listOpenSessions: async () => [session],
      writeCallHistoryMessage: async () => { calls.push('history'); },
    };
    return { store, session, calls };
  }
  const admin = { endRoom: async () => {} };

  it('duplicate room_finished webhooks are idempotent', async () => {
    const { store, session } = makeStore({
      id: 'c1', roomName: 'pcall_x', status: 'active', callType: 'voice', contextType: 'telegraph_dm',
      contextId: 't1', threadId: 't1', startedBy: 'u', startedAt: ISO, connectedAt: ISO, endedAt: null,
    });
    await reconcileWebhookEvent(store, admin, { event: 'room_finished', room: { name: 'pcall_x' } }, ISO);
    assert.equal(session.status, 'ended');
    await reconcileWebhookEvent(store, admin, { event: 'room_finished', room: { name: 'pcall_x' } }, ISO);
    assert.equal(session.status, 'ended'); // second delivery: no-op, no corruption
  });

  it('sweep expires overdue rings to missed', async () => {
    const { store, session } = makeStore({
      id: 'c2', roomName: 'pcall_y', status: 'ringing', callType: 'voice', contextType: 'telegraph_dm',
      contextId: 't1', threadId: 't1', startedBy: 'u',
      startedAt: new Date(NOW - CALL_CONFIG.RING_TIMEOUT_MS - 5_000).toISOString(),
      connectedAt: null, endedAt: null,
    });
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'missed');
    assert.equal(res.missed, 1);
  });

  it('POLICY: a mid-call booking cancellation rides out — the active session is NOT killed, only the next start is denied', async () => {
    // Simulate the moment a RAB booking is cancelled while its call is live:
    // eligibility flips to false, but nothing feeds the reconciler an event.
    const { store, session, calls } = makeStore({
      id: 'c_rab', roomName: 'pcall_rab', status: 'active', callType: 'voice', contextType: 'rent_a_buddy',
      contextId: 't_rab', threadId: 't_rab', startedBy: 'caller', startedAt: ISO, connectedAt: ISO, endedAt: null,
    });
    // The booking cancel handler triggers no call transition; a sweep finds
    // nothing to expire (ring not overdue, cap not reached) → session stays active.
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'active');
    assert.deepEqual(res, { missed: 0, capped: 0, ghosted: 0 });
    assert.equal(calls.length, 0); // no transition, no history line written

    // But a NEW start attempt on the now-cancelled booking is denied.
    const denied = await canUserStartCall(gw({ isEligibleRabConversation: async () => false }), {
      callerId: 'caller', calleeId: 'callee', threadId: 't_rab',
      contextType: 'rent_a_buddy', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(denied, { allowed: false, reason: 'rab_context_ineligible' });
  });

  it('unknown webhook events are safe no-ops', async () => {
    const { store, session } = makeStore({
      id: 'c3', roomName: 'pcall_z', status: 'active', callType: 'voice', contextType: 'telegraph_dm',
      contextId: 't1', threadId: 't1', startedBy: 'u', startedAt: ISO, connectedAt: ISO, endedAt: null,
    });
    await reconcileWebhookEvent(store, admin, { event: 'some_future_event', room: { name: 'pcall_z' } }, ISO);
    assert.equal(session.status, 'active');
  });
});
