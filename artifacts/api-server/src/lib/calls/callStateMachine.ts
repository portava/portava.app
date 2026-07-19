/**
 * calls/callStateMachine — pure call-session lifecycle.
 *
 * Every status change in the calling system flows through transition() so
 * there is exactly one definition of what's legal (spec §35). Pure and
 * clock-injected: fully unit-testable, no DB or LiveKit dependencies.
 */
import { CALL_CONFIG, type CallSession, type CallStatus } from './callTypes';

export type CallEvent =
  | { type: 'ACCEPT' }            // callee accepted (direct)
  | { type: 'CONNECTED' }         // media confirmed (webhook participant_joined)
  | { type: 'DECLINE' }           // callee declined
  | { type: 'CANCEL' }            // caller hung up pre-answer
  | { type: 'END' }               // normal hangup / host end / block force-end / moderation
  | { type: 'RING_TIMEOUT' }      // ring window elapsed
  | { type: 'MAX_DURATION' }      // 4h cap reached
  | { type: 'ROOM_FINISHED' }     // LiveKit webhook: room closed
  | { type: 'FAIL' };             // infrastructure failure

const TERMINAL: ReadonlySet<CallStatus> = new Set(['ended', 'missed', 'declined', 'canceled', 'failed']);

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Legal transitions. Anything not listed is rejected — callers must treat a
 * rejection as a no-op (idempotency: duplicate webhooks/timeouts are safe).
 */
const TRANSITIONS: Record<CallStatus, Partial<Record<CallEvent['type'], CallStatus>>> = {
  ringing: {
    ACCEPT: 'active',
    CONNECTED: 'active',
    DECLINE: 'declined',
    CANCEL: 'canceled',
    RING_TIMEOUT: 'missed',
    END: 'canceled',          // caller-side end during ring == cancel
    FAIL: 'failed',
    ROOM_FINISHED: 'canceled',
  },
  active: {
    END: 'ended',
    MAX_DURATION: 'ended',
    ROOM_FINISHED: 'ended',
    FAIL: 'failed',
  },
  ended: {}, missed: {}, declined: {}, canceled: {}, failed: {},
};

export interface TransitionResult {
  ok: boolean;
  /** Next status when ok; unchanged current status when not. */
  status: CallStatus;
  /** True when the LiveKit room must be terminated server-side as a side effect. */
  terminateRoom: boolean;
  /** Field updates the storage layer should persist alongside the status. */
  patch: { connectedAt?: string; endedAt?: string };
}

export function transition(
  session: Pick<CallSession, 'status'>,
  event: CallEvent,
  nowIso: string,
): TransitionResult {
  const next = TRANSITIONS[session.status]?.[event.type];
  if (!next) {
    return { ok: false, status: session.status, terminateRoom: false, patch: {} };
  }
  const patch: TransitionResult['patch'] = {};
  if (next === 'active' && session.status !== 'active') patch.connectedAt = nowIso;
  if (isTerminal(next)) patch.endedAt = nowIso;
  // Any terminal outcome must tear the room down EXCEPT when LiveKit itself
  // reported the room finished (it's already gone).
  const terminateRoom = isTerminal(next) && event.type !== 'ROOM_FINISHED';
  return { ok: true, status: next, terminateRoom, patch };
}

// ── Time-based sweeps (called by the reconciler / scheduler) ─────────────────

/** True when a ringing session has outlived the ring window → RING_TIMEOUT. */
export function ringExpired(session: Pick<CallSession, 'status' | 'startedAt'>, nowMs: number): boolean {
  if (session.status !== 'ringing') return false;
  const started = new Date(session.startedAt).getTime();
  return Number.isFinite(started) && nowMs - started >= CALL_CONFIG.RING_TIMEOUT_MS;
}

/** True when an active session has hit the hard duration cap → MAX_DURATION. */
export function maxDurationReached(
  session: Pick<CallSession, 'status' | 'connectedAt' | 'startedAt'>, nowMs: number,
): boolean {
  if (session.status !== 'active') return false;
  const anchor = new Date(session.connectedAt ?? session.startedAt).getTime();
  return Number.isFinite(anchor) && nowMs - anchor >= CALL_CONFIG.MAX_CALL_DURATION_MS;
}

/** True when participants should get the "ending soon" warning. */
export function inMaxDurationWarningWindow(
  session: Pick<CallSession, 'status' | 'connectedAt' | 'startedAt'>, nowMs: number,
): boolean {
  if (session.status !== 'active') return false;
  const anchor = new Date(session.connectedAt ?? session.startedAt).getTime();
  if (!Number.isFinite(anchor)) return false;
  const elapsed = nowMs - anchor;
  return elapsed >= CALL_CONFIG.MAX_CALL_DURATION_MS - CALL_CONFIG.MAX_DURATION_WARNING_MS
    && elapsed < CALL_CONFIG.MAX_CALL_DURATION_MS;
}

/**
 * Group-room end summary line (spec Phase 4): written into the crew's group
 * conversation when the room closes, e.g. "Crew Call ended · 38 min · 7 participants".
 * `participantCount` is the number of distinct people who ever joined.
 */
export function groupCallEndLine(
  session: Pick<CallSession, 'connectedAt' | 'startedAt' | 'endedAt'>,
  participantCount: number,
): string {
  const anchorIso = session.connectedAt ?? session.startedAt;
  const anchor = new Date(anchorIso).getTime();
  const ended = session.endedAt ? new Date(session.endedAt).getTime() : NaN;
  const mins = Number.isFinite(anchor) && Number.isFinite(ended)
    ? Math.max(1, Math.round((ended - anchor) / 60_000))
    : 1;
  const people = `${participantCount} participant${participantCount === 1 ? '' : 's'}`;
  return `Crew Call ended · ${mins} min · ${people}`;
}

/** Human system-message line for contextual call history (spec §2/§17). */
export function callHistoryLine(
  session: Pick<CallSession, 'callType' | 'status' | 'connectedAt' | 'endedAt'>,
): string {
  const kind = session.callType === 'video' ? 'Video call'
    : session.callType === 'group_voice' ? 'Crew Call' : 'Voice call';
  switch (session.status) {
    case 'missed': return `Missed ${kind.toLowerCase()}`;
    case 'declined': return 'Call declined';
    case 'canceled': return 'Call canceled';
    case 'failed': return 'Call failed';
    case 'ended': {
      if (!session.connectedAt || !session.endedAt) return `${kind} ended`;
      const ms = new Date(session.endedAt).getTime() - new Date(session.connectedAt).getTime();
      const mins = Math.max(1, Math.round(ms / 60_000));
      return `${kind} · ${mins} min`;
    }
    default: return kind;
  }
}
