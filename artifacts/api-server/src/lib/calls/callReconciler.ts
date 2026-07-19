/**
 * calls/callReconciler — keeps call_sessions truthful when clients can't.
 *
 * Two inputs, one truth:
 *  1. Verified LiveKit webhook events (room_finished / participant_joined /
 *     participant_left) reconcile session + participant state.
 *  2. A periodic sweep expires overdue rings, enforces the 4-hour cap, and
 *     heals ghost `active` sessions whose rooms no longer exist.
 *
 * All operations are IDEMPOTENT: duplicate webhook delivery and overlapping
 * sweeps cannot corrupt state (addendum B). Storage is a port so this logic
 * is unit-testable without a database.
 */
import { transition, ringExpired, maxDurationReached, type CallEvent } from './callStateMachine';
import { CALL_CONFIG, type CallSession } from './callTypes';

export interface CallStore {
  getSessionByRoom(roomName: string): Promise<(CallSession & { roomName: string }) | null>;
  getSession(callId: string): Promise<(CallSession & { roomName: string }) | null>;
  /** Persist a status change + patch. MUST be a compare-and-set on the old
   *  status so concurrent reconciliation can't double-apply. Returns false
   *  when the session was no longer in `fromStatus` (treat as already done). */
  applyTransition(callId: string, fromStatus: CallSession['status'], toStatus: CallSession['status'],
    patch: { connectedAt?: string; endedAt?: string }): Promise<boolean>;
  markParticipantJoined(callId: string, userId: string, atIso: string): Promise<void>;
  markParticipantLeft(callId: string, userId: string, atIso: string): Promise<void>;
  /** Sessions currently ringing or active (for sweeps). */
  listOpenSessions(): Promise<Array<CallSession & { roomName: string }>>;
  /** Write the contextual system message for a terminal outcome (spec §17). */
  writeCallHistoryMessage(session: CallSession & { roomName: string }): Promise<void>;
}

export interface RoomAdminPort {
  endRoom(roomName: string): Promise<void>;
  /**
   * Ghost healing probe: does the LiveKit room still exist? Optional — when
   * absent (or when it throws) the sweep skips ghost healing rather than
   * guessing; the 4h cap remains the hard backstop.
   */
  roomExists?(roomName: string): Promise<boolean>;
  /**
   * Batched ghost healing probe: ALL room names LiveKit currently knows about,
   * fetched with ONE API call. When present, the sweep prefers this over
   * per-room `roomExists` probes so a tick costs O(1) LiveKit calls no matter
   * how many calls are live (see docs/calling-load-review.md). Same fail-closed
   * contract: if it throws, ghost healing is skipped for the whole sweep.
   */
  listRoomNames?(): Promise<Set<string>>;
}

export async function applyEvent(
  store: CallStore, admin: RoomAdminPort,
  session: CallSession & { roomName: string },
  event: CallEvent, nowIso: string,
): Promise<void> {
  const result = transition(session, event, nowIso);
  if (!result.ok) return; // illegal for current state → duplicate/no-op
  const applied = await store.applyTransition(session.id, session.status, result.status, result.patch);
  if (!applied) return;   // lost the CAS race → someone else already did it
  if (result.terminateRoom) {
    await admin.endRoom(session.roomName).catch(() => { /* teardown retried by sweep */ });
  }
  if (result.status !== 'active') {
    await store.writeCallHistoryMessage({ ...session, status: result.status, endedAt: nowIso }).catch(() => {});
  }
}

// ── Webhook entry point ──────────────────────────────────────────────────────

export async function reconcileWebhookEvent(
  store: CallStore, admin: RoomAdminPort,
  evt: { event: string; room?: { name?: string }; participant?: { identity?: string } },
  nowIso: string,
): Promise<void> {
  const roomName = evt.room?.name;
  if (!roomName) return;
  const session = await store.getSessionByRoom(roomName);
  if (!session) return; // not one of ours (or already purged) — ignore

  switch (evt.event) {
    case 'participant_joined': {
      const userId = evt.participant?.identity;
      if (userId) await store.markParticipantJoined(session.id, userId, nowIso);
      // A direct call only becomes `active` when someone OTHER than the caller
      // joins. The caller's client joins the room immediately after starting
      // the call, and that self-join must not consume the `ringing` state —
      // otherwise ring-timeout sweeps (which only sweep `ringing`) can never
      // mark the call missed, and the callee's DECLINE (invalid from `active`)
      // is stranded. Group rooms activate on any join by design.
      const isDirect = session.callType === 'voice' || session.callType === 'video';
      if (isDirect && (!userId || userId === session.startedBy)) return;
      await applyEvent(store, admin, session, { type: 'CONNECTED' }, nowIso);
      return;
    }
    case 'participant_left': {
      const userId = evt.participant?.identity;
      if (userId) await store.markParticipantLeft(session.id, userId, nowIso);
      return; // room emptiness is handled by room_finished / the sweep
    }
    case 'room_finished': {
      await applyEvent(store, admin, session, { type: 'ROOM_FINISHED' }, nowIso);
      return;
    }
    default:
      return; // unknown/newer event names are safe no-ops (version drift)
  }
}

// ── Periodic sweep (ring expiry, duration cap, ghost healing) ────────────────

export async function sweepOpenSessions(
  store: CallStore, admin: RoomAdminPort, nowMs: number,
): Promise<{ missed: number; capped: number; ghosted: number }> {
  const nowIso = new Date(nowMs).toISOString();
  let missed = 0, capped = 0, ghosted = 0;
  const open = await store.listOpenSessions();

  // Batched ghost probe: ONE listRoomNames call per sweep, fetched lazily only
  // when at least one active session is past the grace window (ringing
  // sessions and fresh actives never trigger it). `null` = probe unavailable
  // or failed → fail closed, no ghost healing this tick (4h cap backstops).
  let liveRooms: Set<string> | null | undefined; // undefined = not fetched yet
  const getLiveRooms = async (): Promise<Set<string> | null> => {
    if (liveRooms !== undefined) return liveRooms;
    if (!admin.listRoomNames) return (liveRooms = null);
    try {
      liveRooms = await admin.listRoomNames();
    } catch {
      liveRooms = null; // probe failure must never end a live call
    }
    return liveRooms;
  };

  for (const session of open) {
    if (ringExpired(session, nowMs)) {
      await applyEvent(store, admin, session, { type: 'RING_TIMEOUT' }, nowIso);
      missed++;
    } else if (maxDurationReached(session, nowMs)) {
      await applyEvent(store, admin, session, { type: 'MAX_DURATION' }, nowIso);
      capped++;
    } else if (await isGhostActiveSession(admin, session, nowMs, getLiveRooms)) {
      // Ghost healing: active session, dead room (client killed / room
      // reaped without a webhook reaching us). ROOM_FINISHED semantics —
      // the room is already gone, so no re-termination attempt.
      await applyEvent(store, admin, session, { type: 'ROOM_FINISHED' }, nowIso);
      ghosted++;
    }
  }
  return { missed, capped, ghosted };
}

/**
 * True when an `active` session past the grace window has a room LiveKit no
 * longer knows about. Fails CLOSED to "not a ghost": no probe, probe error,
 * or a still-live room all leave the session alone (4h cap is the backstop).
 */
async function isGhostActiveSession(
  admin: RoomAdminPort,
  session: CallSession & { roomName: string },
  nowMs: number,
  getLiveRooms: () => Promise<Set<string> | null>,
): Promise<boolean> {
  if (session.status !== 'active') return false;
  const anchor = new Date(session.connectedAt ?? session.startedAt).getTime();
  if (!Number.isFinite(anchor) || nowMs - anchor < CALL_CONFIG.GHOST_ACTIVE_GRACE_MS) return false;
  // Preferred: batched diff against the single listRoomNames snapshot.
  if (admin.listRoomNames) {
    const live = await getLiveRooms();
    return live !== null && !live.has(session.roomName);
  }
  // Fallback: per-room probe (small deployments / legacy admin ports).
  if (!admin.roomExists) return false;
  try {
    return !(await admin.roomExists(session.roomName));
  } catch {
    return false; // probe failure must never end a live call
  }
}
