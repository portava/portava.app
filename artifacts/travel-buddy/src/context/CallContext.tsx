/**
 * CallContext — the ONE client call manager (spec §30).
 *
 * Owns current call state, mic/camera/speaker flags, minimized state, ring
 * timeout, and the media connection lifecycle. Screens consume this context;
 * nothing else in the app may connect to LiveKit directly.
 *
 * Media is behind a LiveKitBridge port so this file has no native SDK
 * import: the app wires the real bridge (built on @livekit/react-native)
 * into <CallProvider bridge={...}> during Phase 2 integration. Until a
 * bridge is provided, calls fail gracefully with a clear error.
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  startCall as apiStart, acceptCall as apiAccept, declineCall as apiDecline,
  endCall as apiEnd, joinCall as apiJoin, leaveCall as apiLeave, getActiveCall,
  type CallJoinGrant, type CallSessionDto, type CallContextType as CallCtxType, type CallType,
} from '../services/calls.ts';

/** Ring window mirror of the server's CALL_CONFIG.RING_TIMEOUT_MS. */
const RING_TIMEOUT_MS = 45_000;

// ── Media bridge port (implemented with @livekit/react-native in Phase 2) ────

export interface LiveKitBridge {
  connect(opts: { url: string; token: string; videoEnabled: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  setMicEnabled(on: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  flipCamera(): Promise<void>;
  setSpeakerphone(on: boolean): Promise<void>;
  /** Fires on transport changes so the UI can show "Reconnecting…". */
  onConnectionState?(cb: (state: 'connected' | 'reconnecting' | 'disconnected') => void): () => void;
}

// ── Public state shape ───────────────────────────────────────────────────────

export type CallPhase =
  | 'idle'
  | 'outgoing_ringing'
  | 'incoming_ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export interface IncomingCallInfo {
  callId: string;
  callType: CallType;
  contextType: CallCtxType;
  threadId: string | null;
  caller: { id: string; name: string | null; avatarUrl: string | null; verified?: boolean };
}

export interface CallState {
  phase: CallPhase;
  session: CallSessionDto | null;
  incoming: IncomingCallInfo | null;
  minimized: boolean;
  micMuted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
  /** Elapsed seconds while connected (drives "04:23" in the pill). */
  elapsedSec: number;
  error: string | null;
}

export interface CallActions {
  startDirectCall(input: {
    threadId: string; calleeId: string;
    contextType: 'telegraph_dm' | 'rent_a_buddy';
    callType: 'voice' | 'video';
  }): Promise<boolean>;
  /** Realtime layer delivers incoming-call events here (spec §11). */
  presentIncomingCall(info: IncomingCallInfo): void;
  /**
   * Clear ONLY the incoming banner (remote cancel/decline/miss/end). Never
   * touches an in-progress call's session or media — unlike hangUp().
   */
  dismissIncoming(): void;
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
  phase: 'idle', session: null, incoming: null, minimized: false,
  micMuted: false, cameraOn: false, speakerOn: false, elapsedSec: 0, error: null,
};

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
}: {
  bridge?: LiveKitBridge | null;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<CallState>(INITIAL);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const unbindConn = useRef<(() => void) | null>(null);
  const sessionRef = useRef<CallSessionDto | null>(null);

  const patch = useCallback((p: Partial<CallState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const clearTimers = useCallback(() => {
    if (ringTimer.current) { clearTimeout(ringTimer.current); ringTimer.current = null; }
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
  }, []);

  const teardown = useCallback(async (error: string | null = null) => {
    clearTimers();
    unbindConn.current?.(); unbindConn.current = null;
    sessionRef.current = null;
    try { await bridge?.disconnect(); } catch { /* already down */ }
    setState({ ...INITIAL, error });
  }, [bridge, clearTimers]);

  useEffect(() => () => { clearTimers(); unbindConn.current?.(); }, [clearTimers]);

  const connectMedia = useCallback(async (grant: CallJoinGrant, videoEnabled: boolean): Promise<boolean> => {
    if (!bridge) {
      await apiEnd(grant.session.id).catch(() => {});
      patch({ phase: 'idle', error: 'Calling is not available in this build yet.' });
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
      else if (cs === 'connected') patch({ phase: 'connected' });
      else if (cs === 'disconnected') void teardown(null);
    }) ?? null;
    clearTimers();
    tick.current = setInterval(() => {
      setState((s) => (s.phase === 'connected' ? { ...s, elapsedSec: s.elapsedSec + 1 } : s));
    }, 1_000);
    patch({ phase: 'connected', cameraOn: videoEnabled, error: null });
    return true;
  }, [bridge, clearTimers, patch, teardown]);

  const actions = useMemo<CallActions>(() => ({
    async startDirectCall(input) {
      if (sessionRef.current) return false; // §23 — never silently drop a call
      const res = await apiStart(input);
      if (!res.ok || !res.data) {
        patch({ error: res.error ?? 'Could not start the call.' });
        return false;
      }
      patch({ phase: 'outgoing_ringing', session: res.data.session, error: null });
      sessionRef.current = res.data.session;
      const grant = res.data;
      // Ring timeout mirror — server sweep is authoritative; this keeps UI honest.
      ringTimer.current = setTimeout(() => {
        void apiEnd(grant.session.id).catch(() => {});
        void teardown(null);
      }, RING_TIMEOUT_MS);
      // Caller connects immediately and waits in-room for the callee.
      return connectMedia(grant, input.callType === 'video');
    },

    presentIncomingCall(info) {
      if (sessionRef.current) return; // already in a call → server marks missed
      patch({ phase: 'incoming_ringing', incoming: info, error: null });
      ringTimer.current && clearTimeout(ringTimer.current);
      ringTimer.current = setTimeout(() => {
        setState((s) => (s.phase === 'incoming_ringing' ? { ...INITIAL } : s));
      }, RING_TIMEOUT_MS);
    },

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

    async accept(asVideo = false) {
      const inc = state.incoming;
      if (!inc) return false;
      clearTimers();
      const res = await apiAccept(inc.callId, { asVideo });
      if (!res.ok || !res.data) {
        patch({ ...INITIAL, error: res.error ?? 'Could not join the call.' });
        return false;
      }
      patch({ incoming: null });
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
      if (!res.ok || !res.data?.session || res.data.session.status !== 'active') return;
      const joined = await apiJoin(res.data.session.id);
      if (joined.ok && joined.data) {
        await connectMedia(joined.data, false);
        patch({ minimized: true });
      }
    },
  }), [bridge, clearTimers, connectMedia, patch, state.cameraOn, state.incoming, state.micMuted, state.speakerOn, teardown]);

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}
