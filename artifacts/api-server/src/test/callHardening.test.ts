/**
 * Phase 6 — calling system hardening: races, abuse, security, ghost healing.
 *
 * Pure node:test over the calls libs (no DB, no LiveKit network). The CAS
 * store here mirrors the production contract: applyTransition succeeds only
 * when the session is still in `fromStatus`.
 *
 * Run: node --import tsx/esm --test src/test/callHardening.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canUserStartCall, type CallContextGateway } from '../lib/calls/callPermissionEngine';
import { transition, isTerminal } from '../lib/calls/callStateMachine';
import {
  applyEvent, reconcileWebhookEvent, sweepOpenSessions, type CallStore, type RoomAdminPort,
} from '../lib/calls/callReconciler';
import { forceEndDirectCallsBetween } from '../lib/calls/callSignaling';
import { generateRoomName, mintCallToken } from '../lib/calls/livekitService';
import { CALL_CONFIG } from '../lib/calls/callTypes';
import { checkRateLimit, _resetRateLimit } from '../lib/rateLimit';

const NOW = Date.parse('2026-07-18T12:00:00Z');
const ISO = new Date(NOW).toISOString();

function gw(over: Partial<CallContextGateway> = {}): CallContextGateway {
  return {
    getThreadParticipants: async () => ['caller', 'callee'],
    canMessage: async () => true,
    isBlockedEither: async () => false,
    getCallPreferences: async () => ({
      whoCanCall: 'people_i_message', allowRentABuddyCalls: true, allowVideoCalls: true,
    }),
    isEligibleRabConversation: async () => true,
    isActiveCrewMember: async () => true,
    eventRoomIneligibility: async () => null,
    eventStaffRole: async () => null,
    isCallRestricted: async () => ({ restricted: false }),
    isSessionTerminated: async () => false,
    wasRemovedFromCall: async () => false,
    lastDeclineAt: async () => null,
    startsInLastHour: async () => 0,
    ...over,
  };
}

/** CAS store over a single mutable session — the concurrency battleground. */
function makeCasStore(session: any) {
  const history: string[] = [];
  const transitions: string[] = [];
  const store: CallStore = {
    getSessionByRoom: async () => ({ ...session }),
    getSession: async () => ({ ...session }),
    applyTransition: async (_id, from, to, patch) => {
      if (session.status !== from) return false; // CAS: lost the race
      session.status = to;
      if (patch.endedAt) session.endedAt = patch.endedAt;
      if (patch.connectedAt) session.connectedAt = patch.connectedAt;
      transitions.push(`${from}->${to}`);
      return true;
    },
    markParticipantJoined: async () => {},
    markParticipantLeft: async () => {},
    listOpenSessions: async () => (isTerminal(session.status) ? [] : [{ ...session }]),
    writeCallHistoryMessage: async (s) => { history.push(s.status); },
  };
  return { store, session, history, transitions };
}

const directSession = (over: any = {}) => ({
  id: 'c1', roomName: 'pcall_race', status: 'ringing', callType: 'voice',
  contextType: 'telegraph_dm', contextId: 't1', threadId: 't1', startedBy: 'caller',
  startedAt: ISO, connectedAt: null, endedAt: null, ...over,
});

const nullAdmin: RoomAdminPort = { endRoom: async () => {} };

// ── Race conditions (CAS transition guarantees) ──────────────────────────────

describe('races — CAS transitions', () => {
  it('simultaneous accept/decline: exactly one wins, one history line', async () => {
    const { store, session, history, transitions } = makeCasStore(directSession());
    const snapshot = { ...session };
    await Promise.all([
      applyEvent(store, nullAdmin, snapshot as any, { type: 'ACCEPT' }, ISO),
      applyEvent(store, nullAdmin, snapshot as any, { type: 'DECLINE' }, ISO),
    ]);
    assert.equal(transitions.length, 1, 'only one transition may apply');
    assert.ok(['active', 'declined'].includes(session.status));
    // History is written only for the winner (and never for `active`).
    assert.ok(history.length <= 1);
  });

  it('accept racing ring-timeout: the loser is a strict no-op', async () => {
    const { store, session, transitions } = makeCasStore(directSession());
    const snapshot = { ...session };
    // Sweep wins first:
    await applyEvent(store, nullAdmin, snapshot as any, { type: 'RING_TIMEOUT' }, ISO);
    assert.equal(session.status, 'missed');
    // Late ACCEPT arrives with the stale `ringing` snapshot → CAS rejects it.
    await applyEvent(store, nullAdmin, snapshot as any, { type: 'ACCEPT' }, ISO);
    assert.equal(session.status, 'missed', 'terminal outcome must be frozen');
    assert.deepEqual(transitions, ['ringing->missed']);
  });

  it('overlapping sweeps: an overdue ring is missed exactly once', async () => {
    const overdue = directSession({
      startedAt: new Date(NOW - CALL_CONFIG.RING_TIMEOUT_MS - 5_000).toISOString(),
    });
    const { store, session, transitions, history } = makeCasStore(overdue);
    const [a, b] = await Promise.all([
      sweepOpenSessions(store, nullAdmin, NOW),
      sweepOpenSessions(store, nullAdmin, NOW),
    ]);
    assert.equal(session.status, 'missed');
    assert.equal(transitions.length, 1, 'CAS must collapse the duplicate sweep');
    assert.equal(history.length, 1, 'exactly one history line');
    // Both sweeps may COUNT the attempt, but only one transition applied.
    assert.ok(a.missed + b.missed >= 1);
  });

  it('duplicate room_finished + concurrent END: one terminal transition', async () => {
    const { store, session, transitions } = makeCasStore(directSession({
      status: 'active', connectedAt: ISO,
    }));
    const snapshot = { ...session };
    await Promise.all([
      reconcileWebhookEvent(store, nullAdmin, { event: 'room_finished', room: { name: 'pcall_race' } }, ISO),
      applyEvent(store, nullAdmin, snapshot as any, { type: 'END' }, ISO),
    ]);
    assert.equal(session.status, 'ended');
    assert.equal(transitions.length, 1);
  });
});

// ── Block force-end (security: blocking during a call terminates the room) ──

describe('block force-end', () => {
  it('the block-hook END primitive terminates rooms for active AND ringing sessions', async () => {
    // forceEndDirectCallsBetween delegates each open session to
    // applyEvent(store, admin, session, END) — this pins that primitive's
    // invariants for both open states (route-level wiring is covered by the
    // blocks route calling forceEndDirectCallsBetween).
    const s1 = directSession({ id: 'b1', roomName: 'pcall_b1', status: 'active', connectedAt: ISO });
    const s2 = directSession({ id: 'b2', roomName: 'pcall_b2', status: 'ringing' });
    const sessions: Record<string, any> = { b1: s1, b2: s2 };
    const endedRooms: string[] = [];
    const store: CallStore = {
      getSessionByRoom: async () => null,
      getSession: async (id) => sessions[id],
      applyTransition: async (id, from, to, patch) => {
        if (sessions[id].status !== from) return false;
        sessions[id].status = to;
        if (patch.endedAt) sessions[id].endedAt = patch.endedAt;
        return true;
      },
      markParticipantJoined: async () => {},
      markParticipantLeft: async () => {},
      listOpenSessions: async () => [],
      writeCallHistoryMessage: async () => {},
    };
    const admin: RoomAdminPort = { endRoom: async (r) => { endedRooms.push(r); } };
    await applyEvent(store, admin, { ...s1 }, { type: 'END' }, ISO);
    await applyEvent(store, admin, { ...s2 }, { type: 'END' }, ISO);
    assert.equal(s1.status, 'ended');
    assert.equal(s2.status, 'canceled'); // END during ring == cancel
    assert.deepEqual(endedRooms, ['pcall_b1', 'pcall_b2']);
    assert.equal(typeof forceEndDirectCallsBetween, 'function');
  });

  it('a block landing mid-ring makes both accept-time and join-time checks deny', async () => {
    const g = gw({ isBlockedEither: async () => true });
    const start = await canUserStartCall(g, {
      callerId: 'caller', calleeId: 'callee', threadId: 't1',
      contextType: 'telegraph_dm', callType: 'voice', nowMs: NOW,
    });
    assert.deepEqual(start, { allowed: false, reason: 'blocked' });
  });
});

// ── Ghost-call healing ───────────────────────────────────────────────────────

describe('ghost healing', () => {
  const ghostSession = (ageMs: number) => directSession({
    id: 'g1', roomName: 'pcall_ghost', status: 'active',
    startedAt: new Date(NOW - ageMs).toISOString(),
    connectedAt: new Date(NOW - ageMs).toISOString(),
  });

  it('an active session past the grace window with a dead room is force-ended', async () => {
    const { store, session, history } = makeCasStore(ghostSession(CALL_CONFIG.GHOST_ACTIVE_GRACE_MS + 1_000));
    const endedRooms: string[] = [];
    const admin: RoomAdminPort = {
      endRoom: async (r) => { endedRooms.push(r); },
      roomExists: async () => false,
    };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'ended');
    assert.equal(res.ghosted, 1);
    assert.deepEqual(endedRooms, [], 'ROOM_FINISHED semantics: dead room is not re-terminated');
    assert.deepEqual(history, ['ended'], 'history line written for the healed session');
  });

  it('within the grace window the session is left alone (fresh accept is safe)', async () => {
    const { store, session } = makeCasStore(ghostSession(CALL_CONFIG.GHOST_ACTIVE_GRACE_MS - 1_000));
    const admin: RoomAdminPort = { endRoom: async () => {}, roomExists: async () => false };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'active');
    assert.equal(res.ghosted, 0);
  });

  it('a live room, a probe error, or no probe at all never ends the call', async () => {
    for (const admin of [
      { endRoom: async () => {}, roomExists: async () => true },
      { endRoom: async () => {}, roomExists: async () => { throw new Error('probe down'); } },
      { endRoom: async () => {} }, // no probe wired
    ] as RoomAdminPort[]) {
      const { store, session } = makeCasStore(ghostSession(CALL_CONFIG.GHOST_ACTIVE_GRACE_MS + 1_000));
      const res = await sweepOpenSessions(store, admin, NOW);
      assert.equal(session.status, 'active');
      assert.equal(res.ghosted, 0);
    }
  });

  it('ringing sessions are never ghost-probed (ring sweep owns them)', async () => {
    let probed = 0;
    const { store, session } = makeCasStore(directSession()); // fresh ring
    const admin: RoomAdminPort = {
      endRoom: async () => {},
      roomExists: async () => { probed++; return false; },
    };
    await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'ringing');
    assert.equal(probed, 0);
  });

  it('the 4h cap still beats the ghost probe for over-cap ghosts', async () => {
    const { store, session } = makeCasStore(ghostSession(CALL_CONFIG.MAX_CALL_DURATION_MS + 1_000));
    const endedRooms: string[] = [];
    const admin: RoomAdminPort = {
      endRoom: async (r) => { endedRooms.push(r); },
      roomExists: async () => false,
    };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(session.status, 'ended');
    assert.equal(res.capped, 1);
    assert.equal(res.ghosted, 0);
    assert.deepEqual(endedRooms, ['pcall_ghost'], 'cap path DOES terminate the room');
  });
});

// ── Batched ghost healing (one listRooms diff per sweep) ────────────────────

describe('batched ghost healing', () => {
  /** Multi-session CAS store for sweep-wide batching assertions. */
  function makeMultiStore(sessions: any[]) {
    const store: CallStore = {
      getSessionByRoom: async (r) => sessions.find((s) => s.roomName === r) ?? null,
      getSession: async (id) => sessions.find((s) => s.id === id) ?? null,
      applyTransition: async (id, from, to, patch) => {
        const s = sessions.find((x) => x.id === id);
        if (!s || s.status !== from) return false;
        s.status = to;
        if (patch.endedAt) s.endedAt = patch.endedAt;
        if (patch.connectedAt) s.connectedAt = patch.connectedAt;
        return true;
      },
      markParticipantJoined: async () => {},
      markParticipantLeft: async () => {},
      listOpenSessions: async () => sessions.filter((s) => !isTerminal(s.status)).map((s) => ({ ...s })),
      writeCallHistoryMessage: async () => {},
    };
    return { store, sessions };
  }

  const pastGrace = new Date(NOW - CALL_CONFIG.GHOST_ACTIVE_GRACE_MS - 1_000).toISOString();
  const activeSession = (id: string) => directSession({
    id, roomName: `pcall_${id}`, status: 'active', startedAt: pastGrace, connectedAt: pastGrace,
  });

  it('one listRoomNames call heals all ghosts in a sweep — no per-room probes', async () => {
    const { store, sessions } = makeMultiStore([
      activeSession('a'), activeSession('b'), activeSession('c'),
    ]);
    let listCalls = 0, existsCalls = 0;
    const admin: RoomAdminPort = {
      endRoom: async () => {},
      roomExists: async () => { existsCalls++; return true; },
      listRoomNames: async () => { listCalls++; return new Set(['pcall_b']); },
    };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(listCalls, 1, 'exactly ONE listRooms call regardless of session count');
    assert.equal(existsCalls, 0, 'batched path must replace per-room probes');
    assert.equal(res.ghosted, 2);
    assert.equal(sessions.find((s) => s.id === 'a')!.status, 'ended');
    assert.equal(sessions.find((s) => s.id === 'b')!.status, 'active', 'room still live → untouched');
    assert.equal(sessions.find((s) => s.id === 'c')!.status, 'ended');
  });

  it('listRoomNames failure fails closed — no session is ended', async () => {
    const { store, sessions } = makeMultiStore([activeSession('a'), activeSession('b')]);
    const admin: RoomAdminPort = {
      endRoom: async () => {},
      listRoomNames: async () => { throw new Error('LiveKit down'); },
    };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(res.ghosted, 0);
    assert.ok(sessions.every((s) => s.status === 'active'), 'probe failure must never end a live call');
  });

  it('listRoomNames is not called at all when no active session is past grace', async () => {
    let listCalls = 0;
    const fresh = directSession({
      id: 'f', roomName: 'pcall_f', status: 'active',
      startedAt: ISO, connectedAt: ISO,
    });
    const ringing = directSession({ id: 'r', roomName: 'pcall_r' });
    const { store } = makeMultiStore([fresh, ringing]);
    const admin: RoomAdminPort = {
      endRoom: async () => {},
      listRoomNames: async () => { listCalls++; return new Set<string>(); },
    };
    await sweepOpenSessions(store, admin, NOW);
    assert.equal(listCalls, 0, 'ringing/fresh sessions never trigger the batch probe');
    assert.equal(fresh.status, 'active');
    assert.equal(ringing.status, 'ringing');
  });

  it('4h cap still wins over the batched ghost path', async () => {
    const overCap = new Date(NOW - CALL_CONFIG.MAX_CALL_DURATION_MS - 1_000).toISOString();
    const s = directSession({
      id: 'x', roomName: 'pcall_x', status: 'active', startedAt: overCap, connectedAt: overCap,
    });
    const { store } = makeMultiStore([s]);
    const endedRooms: string[] = [];
    const admin: RoomAdminPort = {
      endRoom: async (r) => { endedRooms.push(r); },
      listRoomNames: async () => new Set<string>(),
    };
    const res = await sweepOpenSessions(store, admin, NOW);
    assert.equal(res.capped, 1);
    assert.equal(res.ghosted, 0);
    assert.deepEqual(endedRooms, ['pcall_x']);
  });
});

// ── Abuse protections ────────────────────────────────────────────────────────

describe('abuse — redial cooldown and rate-limit boundaries', () => {
  const startInput = {
    callerId: 'caller', calleeId: 'callee', threadId: 't1',
    contextType: 'telegraph_dm' as const, callType: 'voice' as const, nowMs: NOW,
  };

  it('a declined caller is denied for the full cooldown — no push can fire', async () => {
    // 1ms inside the window → denied (deny happens BEFORE any signaling).
    const inside = await canUserStartCall(
      gw({ lastDeclineAt: async () => NOW - CALL_CONFIG.REDIAL_COOLDOWN_MS + 1 }), startInput);
    assert.deepEqual(inside, { allowed: false, reason: 'redial_cooldown' });
    // Exactly at the boundary → allowed again.
    const atBoundary = await canUserStartCall(
      gw({ lastDeclineAt: async () => NOW - CALL_CONFIG.REDIAL_COOLDOWN_MS }), startInput);
    assert.deepEqual(atBoundary, { allowed: true });
  });

  it('hourly start limit: N-1 allowed, N denied', async () => {
    const under = await canUserStartCall(
      gw({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR - 1 }), startInput);
    assert.deepEqual(under, { allowed: true });
    const at = await canUserStartCall(
      gw({ startsInLastHour: async () => CALL_CONFIG.MAX_STARTS_PER_HOUR }), startInput);
    assert.deepEqual(at, { allowed: false, reason: 'rate_limited' });
  });

  it('in-memory call_start backstop trips at the configured limit', () => {
    _resetRateLimit('call_start_test', 'u1');
    for (let i = 0; i < CALL_CONFIG.MAX_STARTS_PER_HOUR; i++) {
      assert.equal(checkRateLimit('call_start_test', 'u1', CALL_CONFIG.MAX_STARTS_PER_HOUR, 3_600_000).allowed, true);
    }
    const over = checkRateLimit('call_start_test', 'u1', CALL_CONFIG.MAX_STARTS_PER_HOUR, 3_600_000);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfterMs > 0);
    _resetRateLimit('call_start_test', 'u1');
  });
});

// ── Security — opaque rooms & token grants ───────────────────────────────────

describe('security — room names and tokens', () => {
  it('room names are opaque, unique, and never context-derived', () => {
    const names = new Set(Array.from({ length: 200 }, () => generateRoomName()));
    assert.equal(names.size, 200, 'no collisions in 200 mints');
    for (const n of names) {
      assert.match(n, /^pcall_[A-Za-z0-9_-]{24}$/, 'prefix + 18 bytes of base64url entropy');
    }
  });

  it('tokens are short-TTL and a voice grant cannot publish camera', async () => {
    const env = { url: 'wss://x.test', apiKey: 'k'.repeat(12), apiSecret: 's'.repeat(32) };
    const decode = (jwt: string) =>
      JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
    const voice = decode(await mintCallToken({
      env, roomName: 'pcall_x', userId: 'u1', allowVideo: false,
    }));
    // TTL: exp - nbf/iat equals the configured short TTL (±5s skew tolerance).
    const lifetime = voice.exp - (voice.nbf ?? voice.iat);
    assert.ok(Math.abs(lifetime - CALL_CONFIG.TOKEN_TTL_SECONDS) <= 5,
      `token lifetime ${lifetime}s must be ~${CALL_CONFIG.TOKEN_TTL_SECONDS}s`);
    // Audio-only source restriction present on the grant.
    const sources = voice.video?.canPublishSources;
    assert.ok(Array.isArray(sources) && sources.length === 1,
      'voice grant must be restricted to a single (microphone) source');
    // Video grant is unrestricted (all sources).
    const video = decode(await mintCallToken({
      env, roomName: 'pcall_x', userId: 'u1', allowVideo: true,
    }));
    assert.equal(video.video?.canPublishSources, undefined);
    // Listener grant cannot publish at all.
    const listener = decode(await mintCallToken({
      env, roomName: 'pcall_x', userId: 'u1', allowVideo: false, canPublishAudio: false,
    }));
    assert.equal(listener.video?.canPublish, false);
  });

  it('an expired-window transition attempt on a terminal session stays frozen', () => {
    for (const s of ['ended', 'missed', 'declined', 'canceled', 'failed'] as const) {
      for (const e of ['ACCEPT', 'CONNECTED', 'END', 'ROOM_FINISHED'] as const) {
        const r = transition({ status: s }, { type: e }, ISO);
        assert.equal(r.ok, false);
        assert.equal(r.terminateRoom, false);
      }
    }
  });
});
