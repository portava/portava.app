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
import type { CallSession } from './callTypes';

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
}

async function applyEvent(
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
): Promise<{ missed: number; capped: number }> {
  const nowIso = new Date(nowMs).toISOString();
  let missed = 0, capped = 0;
  const open = await store.listOpenSessions();
  for (const session of open) {
    if (ringExpired(session, nowMs)) {
      await applyEvent(store, admin, session, { type: 'RING_TIMEOUT' }, nowIso);
      missed++;
    } else if (maxDurationReached(session, nowMs)) {
      await applyEvent(store, admin, session, { type: 'MAX_DURATION' }, nowIso);
      capped++;
    }
  }
  return { missed, capped };
}
