/**
 * CallContext — the ONE client call manager (spec §30).
 *
 * Owns current call state, mic/camera/speaker flags, minimized state, ring
 * timeout, and the media connection lifecycle. Screens consume this context;
 * nothing else in the app may connect to LiveKit directly.
 *
 * Media is behind a LiveKitBridge port so this file has no native SDK
 * import: the app wires the real bridge (built on @livekit/react-native)
 * into <CallProvider bridge={...}>. Until a bridge is provided, calls fail
 * gracefully with a clear error.
 *
 * Outgoing semantics: the caller connects to the room immediately but the
 * UI phase stays 'outgoing_ringing' until the server publishes
 * call.accepted (routed here via noteAccepted). The local ring timer is a
 * UI mirror of the server sweep — on expiry the call ends with "No answer"
 * so the user is never stuck.
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  startCall as apiStart, acceptCall as apiAccept, declineCall as apiDecline,
  endCall as apiEnd, joinCall as apiJoin, leaveCall as apiLeave, getActiveCall,
  startGroupCall as apiStartGroup, getCall as apiGetCall,
  setHandRaised as apiSetHand,
  type CallJoinGrant, type CallSessionDto, type CallContextType as CallCtxType, type CallType,
  type CallParticipantDto,
} from '../services/calls.ts';
import { supabase } from '../lib/supabase.ts';

/** Ring window mirror of the server's CALL_CONFIG.RING_TIMEOUT_MS. */
const RING_TIMEOUT_MS = 45_000;

// ── Media bridge port (implemented with @livekit/react-native) ──────────────

export interface LiveKitBridge {
  connect(opts: { url: string; token: string; videoEnabled: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  setMicEnabled(on: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  flipCamera(): Promise<void>;
  setSpeakerphone(on: boolean): Promise<void>;
  /** Fires on transport changes so the UI can show "Reconnecting…". */
  onConnectionState?(cb: (state: 'connected' | 'reconnecting' | 'disconnected') => void): () => void;
  /** Fires with the identities currently speaking (group active-speaker ring). */
  onActiveSpeakers?(cb: (userIds: string[]) => void): () => void;
}

// ── Public state shape ───────────────────────────────────────────────────────

export type CallPhase =
  | 'idle'
  | 'outgoing_ringing'
  | 'incoming_ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface CallPeerInfo {
  id: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  verified?: boolean;
}

export interface IncomingCallInfo {
  callId: string;
  callType: CallType;
  contextType: CallCtxType;
  threadId: string | null;
  caller: CallPeerInfo;
}

export interface CallState {
  phase: CallPhase;
  session: CallSessionDto | null;
  incoming: IncomingCallInfo | null;
  /** The other party of the current 1:1 call (drives call-screen identity). */
  peer: CallPeerInfo | null;
  minimized: boolean;
  micMuted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
  /** Elapsed seconds while connected (drives "04:23" in the pill). */
  elapsedSec: number;
  error: string | null;
  /** Group rooms: participants currently in the room (joined only). */
  participants: CallParticipantDto[];
  /** Group rooms: live participant count (drives "Crew Call · N people"). */
  participantCount: number;
  /** Group rooms: user ids currently speaking (active-speaker indicator). */
  activeSpeakerIds: string[];
  /** Event rooms: my room role (host | cohost | speaker | listener). */
  myRole: string | null;
  /** Event rooms: whether my own hand is raised. */
  handRaised: boolean;
}

export interface CallActions {
  startDirectCall(input: {
    threadId: string; calleeId: string;
    contextType: 'telegraph_dm' | 'rent_a_buddy';
    callType: 'voice' | 'video';
    peer?: CallPeerInfo;
  }): Promise<boolean>;
  /**
   * Start OR join the trip crew's voice room. The server resolves concurrent
   * starts: if a room is already live, this lands the caller in it.
   */
  startCrewCall(input: { tripId: string }): Promise<boolean>;
  /** Host/co-host: open the event's voice room (server enforces host-only). */
  startEventRoom(input: { eventId: string }): Promise<boolean>;
  /** Attendees: join a live event voice room by call id (listener by default). */
  joinEventRoom(input: { callId: string }): Promise<boolean>;
  /** Event rooms: raise or lower my hand. */
  setHandRaised(raised: boolean): Promise<void>;
  /** Realtime: my role changed (promotion/demotion) — refresh grant + media. */
  noteRoleChanged(callId: string, userId: string, role: string): void;
  /** Realtime: I was removed from the room — leave immediately. */
  noteRemovedFromRoom(callId: string): void;
  /** Realtime layer delivers incoming-call events here (spec §11). */
  presentIncomingCall(info: IncomingCallInfo): void;
  /**
   * Clear ONLY the incoming banner (remote cancel/decline/miss/end). Never
   * touches an in-progress call's session or media — unlike hangUp().
   */
  dismissIncoming(): void;
  /** Realtime call.accepted for our outgoing call — ringing → connected. */
  noteAccepted(callId: string): void;
  /** Remote outcome (declined / missed / canceled / ended) — end locally. */
  endLocallyWithNotice(notice: string | null): void;
  dismissError(): void;
  accept(asVideo?: boolean): Promise<boolean>;
  decline(): Promise<void>;
  hangUp(): Promise<void>;
  toggleMute(): Promise<void>;
  toggleCamera(): Promise<void>;
  flipCamera(): Promise<void>;
  toggleSpeaker(): Promise<void>;
  setMinimized(v: boolean): void;
  /** Restore an in-progress call after app relaunch (GET /calls/active). */
  restoreActiveCall(): Promise<void>;
}

const INITIAL: CallState = {
  phase: 'idle', session: null, incoming: null, peer: null, minimized: false,
  micMuted: false, cameraOn: false, speakerOn: false, elapsedSec: 0, error: null,
  participants: [], participantCount: 0, activeSpeakerIds: [],
  myRole: null, handRaised: false,
};

/** Poll cadence for the group participant list while in a crew room. */
const GROUP_ROSTER_POLL_MS = 15_000;

const StateCtx = createContext<CallState>(INITIAL);
const ActionsCtx = createContext<CallActions | null>(null);

export function useCallState(): CallState { return useContext(StateCtx); }
export function useCallActions(): CallActions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error('useCallActions must be used inside <CallProvider>');
  return a;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function CallProvider({
  bridge, children,
  ringTimeoutMs = RING_TIMEOUT_MS,
}: {
  bridge?: LiveKitBridge | null;
  children: React.ReactNode;
  /** Override the 45s ring mirror for unit tests (pass a small value). */
  ringTimeoutMs?: number;
}) {
  const [state, setState] = useState<CallState>(INITIAL);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const unbindConn = useRef<(() => void) | null>(null);
  const unbindSpeakers = useRef<(() => void) | null>(null);
  const groupPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<CallSessionDto | null>(null);
  /** While true, transport 'connected' events must not override ringing UI. */
  const holdRinging = useRef(false);

  const patch = useCallback((p: Partial<CallState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const clearRing = useCallback(() => {
    if (ringTimer.current) { clearTimeout(ringTimer.current); ringTimer.current = null; }
  }, []);
  const clearTimers = useCallback(() => {
    clearRing();
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
    if (groupPoll.current) { clearInterval(groupPoll.current); groupPoll.current = null; }
  }, [clearRing]);

  /** Refresh the group roster (participant list + live count) from the server. */
  const refreshGroupRoster = useCallback(async (callId: string) => {
    const res = await apiGetCall(callId);
    if (!res.ok || !res.data) return;
    if (sessionRef.current?.id !== callId) return; // call ended meanwhile
    const joined = res.data.participants.filter((p) => p.status === 'joined');
    patch({ participants: joined, participantCount: joined.length });
  }, [patch]);

  /** Start the periodic roster poll for a group room. */
  const startGroupRosterPoll = useCallback((callId: string) => {
    if (groupPoll.current) clearInterval(groupPoll.current);
    void refreshGroupRoster(callId);
    groupPoll.current = setInterval(() => { void refreshGroupRoster(callId); }, GROUP_ROSTER_POLL_MS);
  }, [refreshGroupRoster]);

  const teardown = useCallback(async (error: string | null = null) => {
    clearTimers();
    holdRinging.current = false;
    unbindConn.current?.(); unbindConn.current = null;
    unbindSpeakers.current?.(); unbindSpeakers.current = null;
    sessionRef.current = null;
    try { await bridge?.disconnect(); } catch { /* already down */ }
    setState({ ...INITIAL, error });
  }, [bridge, clearTimers]);

  useEffect(() => () => { clearTimers(); unbindConn.current?.(); unbindSpeakers.current?.(); }, [clearTimers]);

  const connectMedia = useCallback(async (
    grant: CallJoinGrant,
    videoEnabled: boolean,
    opts?: { awaitAccept?: boolean },
  ): Promise<boolean> => {
    if (!bridge) {
      await apiEnd(grant.session.id).catch(() => {});
      await teardown('Calling is not available in this build yet.');
      return false;
    }
    patch({ phase: 'connecting', session: grant.session });
    sessionRef.current = grant.session;
    try {
      await bridge.connect({ url: grant.livekitUrl, token: grant.token, videoEnabled });
    } catch {
      await apiEnd(grant.session.id).catch(() => {});
      await teardown('Could not connect the call. Please try again.');
      return false;
    }
    unbindConn.current = bridge.onConnectionState?.((cs) => {
      if (cs === 'reconnecting') patch({ phase: 'reconnecting' });
      else if (cs === 'connected') {
        if (!holdRinging.current) patch({ phase: 'connected' });
      } else if (cs === 'disconnected') void teardown(null);
    }) ?? null;
    unbindSpeakers.current?.();
    unbindSpeakers.current = bridge.onActiveSpeakers?.((ids) => {
      patch({ activeSpeakerIds: ids });
    }) ?? null;
    // Elapsed timer runs for the whole call; it only counts while connected.
    if (tick.current) clearInterval(tick.current);
    tick.current = setInterval(() => {
      setState((s) => (s.phase === 'connected' ? { ...s, elapsedSec: s.elapsedSec + 1 } : s));
    }, 1_000);
    if (opts?.awaitAccept) {
      // Caller waits in-room: keep showing "Ringing…" until call.accepted.
      holdRinging.current = true;
      patch({ phase: 'outgoing_ringing', cameraOn: videoEnabled, error: null });
    } else {
      patch({ phase: 'connected', cameraOn: videoEnabled, error: null });
    }
    return true;
  }, [bridge, patch, teardown]);

  const presentIncoming = useCallback((info: IncomingCallInfo) => {
    if (sessionRef.current) return; // already in a call → server marks missed
    patch({ phase: 'incoming_ringing', incoming: info, error: null });
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => {
      setState((s) => (s.phase === 'incoming_ringing' ? { ...INITIAL } : s));
    }, ringTimeoutMs);
  }, [patch, ringTimeoutMs]);

  const actions = useMemo<CallActions>(() => ({
    async startDirectCall(input) {
      if (sessionRef.current) return false; // §23 — never silently drop a call
      const res = await apiStart(input);
      if (!res.ok || !res.data) {
        patch({ error: friendlyStartError(res.error) });
        return false;
      }
      patch({
        phase: 'outgoing_ringing', session: res.data.session, error: null,
        peer: input.peer ?? { id: input.calleeId, name: null, handle: null, avatarUrl: null },
      });
      sessionRef.current = res.data.session;
      const grant = res.data;
      // Ring timeout mirror — server sweep is authoritative; this keeps UI honest.
      clearRing();
      ringTimer.current = setTimeout(() => {
        void apiEnd(grant.session.id).catch(() => {});
        void teardown('No answer');
      }, ringTimeoutMs);
      // Caller connects immediately and waits in-room for the callee.
      return connectMedia(grant, input.callType === 'video', { awaitAccept: true });
    },

    async startCrewCall(input) {
      if (sessionRef.current) return false; // never silently drop a live call
      const res = await apiStartGroup({ contextType: 'trip_crew', contextId: input.tripId });
      if (!res.ok || !res.data) {
        patch({ error: friendlyStartError(res.error) });
        return false;
      }
      const ok = await connectMedia(res.data, false);
      if (!ok) return false;
      // Group rooms default to speaker audio routing.
      await bridge?.setSpeakerphone(true).catch(() => {});
      patch({ speakerOn: true });
      startGroupRosterPoll(res.data.session.id);
      return true;
    },

    async startEventRoom(input) {
      if (sessionRef.current) return false; // multiple-call prevention
      const res = await apiStartGroup({ contextType: 'event', contextId: input.eventId });
      if (!res.ok || !res.data) {
        patch({ error: friendlyStartError(res.error) });
        return false;
      }
      const ok = await connectMedia(res.data, false);
      if (!ok) return false;
      await bridge?.setSpeakerphone(true).catch(() => {});
      patch({ speakerOn: true, myRole: res.data.role ?? 'host', handRaised: false });
      startGroupRosterPoll(res.data.session.id);
      return true;
    },

    async joinEventRoom(input) {
      if (sessionRef.current) return false; // multiple-call prevention
      const res = await apiJoin(input.callId);
      if (!res.ok || !res.data) {
        patch({ error: friendlyStartError(res.error) });
        return false;
      }
      const ok = await connectMedia(res.data, false);
      if (!ok) return false;
      // Listeners join subscribe-only; keep the local mic state honest.
      const listener = res.data.role === 'listener';
      if (listener) await bridge?.setMicEnabled(false).catch(() => {});
      await bridge?.setSpeakerphone(true).catch(() => {});
      patch({
        speakerOn: true, myRole: res.data.role ?? null,
        micMuted: listener, handRaised: false,
      });
      startGroupRosterPoll(res.data.session.id);
      return true;
    },

    async setHandRaised(raised) {
      const s = sessionRef.current;
      if (!s) return;
      const res = await apiSetHand(s.id, raised);
      if (res.ok) patch({ handRaised: raised });
    },

    noteRoleChanged(callId, userId, role) {
      const s = sessionRef.current;
      if (!s || s.id !== callId) return;
      void (async () => {
        let me: string | null = null;
        try {
          const { data } = await supabase.auth.getUser();
          me = data?.user?.id ?? null;
        } catch { me = null; }
        if (me && userId === me) {
          // My grant changed (promotion enables publishing; demotion revokes
          // it server-side). Re-join for a fresh token and reconnect media.
          const fresh = await apiJoin(callId);
          if (fresh.ok && fresh.data && sessionRef.current?.id === callId) {
            try {
              await bridge?.connect({ url: fresh.data.livekitUrl, token: fresh.data.token, videoEnabled: false });
            } catch { /* transport self-heals via onConnectionState */ }
            const listener = fresh.data.role === 'listener';
            if (listener) await bridge?.setMicEnabled(false).catch(() => {});
            patch({ myRole: fresh.data.role ?? null, handRaised: false, micMuted: listener });
          }
        }
        void refreshGroupRoster(callId);
      })();
    },

    noteRemovedFromRoom(callId) {
      if (sessionRef.current?.id !== callId) return;
      void teardown('You were removed from this room.');
    },

    presentIncomingCall(info) { presentIncoming(info); },

    dismissIncoming() {
      // Only the incoming-ring timer belongs to the banner; when a session is
      // live the ring timer (if any) belongs to that call — leave it alone.
      if (!sessionRef.current && ringTimer.current) {
        clearTimeout(ringTimer.current);
        ringTimer.current = null;
      }
      setState((s) => {
        if (!s.incoming) return s;
        return {
          ...s,
          incoming: null,
          phase: s.phase === 'incoming_ringing' ? 'idle' : s.phase,
        };
      });
    },

    noteAccepted(callId) {
      if (sessionRef.current?.id !== callId) return;
      holdRinging.current = false;
      clearRing();
      // Use patch (unconditional spread) rather than a conditional setState
      // updater. The sessionRef guard above already ensures we are in
      // outgoing_ringing when this fires; patch avoids a React 19 concurrent-
      // mode quirk where a conditional updater whose strict-mode double-invoke
      // returns the same reference as the first call can defer the commit.
      patch({ phase: 'connected' });
    },

    endLocallyWithNotice(notice) { void teardown(notice); },

    dismissError() { patch({ error: null }); },

    async accept(asVideo = false) {
      const inc = state.incoming;
      if (!inc) return false;
      clearRing();
      const res = await apiAccept(inc.callId, { asVideo });
      if (!res.ok || !res.data) {
        patch({ ...INITIAL, error: res.error ?? 'Could not join the call.' });
        return false;
      }
      patch({ incoming: null, peer: inc.caller });
      return connectMedia(res.data, asVideo && inc.callType === 'video');
    },

    async decline() {
      const inc = state.incoming;
      clearTimers();
      patch({ ...INITIAL });
      if (inc) await apiDecline(inc.callId).catch(() => {});
    },

    async hangUp() {
      const s = sessionRef.current;
      if (s) {
        const isGroup = s.callType === 'group_voice';
        await (isGroup ? apiLeave(s.id) : apiEnd(s.id)).catch(() => {});
      }
      await teardown(null);
    },

    async toggleMute() {
      const next = !state.micMuted;
      await bridge?.setMicEnabled(!next).catch(() => {});
      patch({ micMuted: next });
    },

    async toggleCamera() {
      const next = !state.cameraOn;
      await bridge?.setCameraEnabled(next).catch(() => {});
      patch({ cameraOn: next });
    },

    async flipCamera() { await bridge?.flipCamera().catch(() => {}); },

    async toggleSpeaker() {
      const next = !state.speakerOn;
      await bridge?.setSpeakerphone(next).catch(() => {});
      patch({ speakerOn: next });
    },

    setMinimized(v) { patch({ minimized: v }); },

    async restoreActiveCall() {
      if (sessionRef.current) return;
      const res = await getActiveCall();
      const session = res.ok ? res.data?.session ?? null : null;
      if (!session) return;

      if (session.status === 'ringing') {
        // Reconnect landed mid-ring (SSE was down when the call started).
        // If we're the callee, surface the incoming banner — not silence.
        // The caller's own ringing session is handled by its live UI.
        let me: string | null = null;
        try {
          const { data } = await supabase.auth.getUser();
          me = data?.user?.id ?? null;
        } catch { me = null; }
        if (!me || session.startedBy === me) return;
        // GET /calls/active includes the caller's privacy-safe identity when
        // the viewer is the callee — the restored banner matches call.incoming.
        const caller = res.ok ? res.data?.caller ?? null : null;
        presentIncoming({
          callId: session.id,
          callType: session.callType,
          contextType: session.contextType,
          threadId: session.threadId,
          caller: {
            id: session.startedBy,
            name: caller?.name ?? null,
            handle: caller?.handle ?? null,
            avatarUrl: caller?.avatarUrl ?? null,
          },
        });
        return;
      }

      if (session.status !== 'active') return;
      const joined = await apiJoin(session.id);
      if (joined.ok && joined.data) {
        const ok = await connectMedia(joined.data, false);
        if (ok && session.callType === 'group_voice') {
          await bridge?.setSpeakerphone(true).catch(() => {});
          patch({ speakerOn: true, minimized: true });
          startGroupRosterPoll(session.id);
          return;
        }
        patch({ minimized: true });
      }
    },
  }), [bridge, clearRing, clearTimers, connectMedia, patch, presentIncoming, refreshGroupRoster, ringTimeoutMs, startGroupRosterPoll, state.cameraOn, state.incoming, state.micMuted, state.speakerOn, teardown]);

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

/** Map stable server deny reasons to honest, human copy (spec §13). */
function friendlyStartError(reason: string | undefined): string {
  switch (reason) {
    case 'callee_calls_disabled':
    case 'callee_video_disabled':
    case 'not_permitted':
    case 'messaging_not_permitted':
    case 'blocked':
      return "This person can't receive calls right now.";
    case 'rab_context_ineligible':
      return 'Calls are available while you have an active booking together.';
    case 'rab_calls_disabled':
      return "They aren't taking calls about bookings right now. You can still message here.";
    case 'video_calls_disabled':
      return 'They only take voice calls. Try a voice call instead.';
    case 'callee_busy':
      return 'They are on another call. Try again later.';
    case 'rate_limited':
    case 'redial_cooldown':
      return 'Please wait a moment before calling again.';
    case 'Backend not configured':
    case 'Not authenticated':
      return 'Calling is unavailable right now.';
    case 'not_event_host':
      return 'Only the event host can start the voice room.';
    case 'not_event_eligible':
      return 'This voice room is for event attendees.';
    case 'age_ineligible':
      return "This event's voice room isn't available for your age group.";
    case 'trust_ineligible':
      return 'Voice rooms need a higher Trust Score.';
    case 'removed_from_room':
      return "You can't rejoin this room.";
    case 'room_terminated':
      return 'This voice room has ended.';
    default:
      return reason ?? 'Could not start the call.';
  }
}
