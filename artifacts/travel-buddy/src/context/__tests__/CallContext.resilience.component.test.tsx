/**
 * Component test: CallContext client resilience (Phase 6 hardening).
 *
 * Covered scenarios
 * ─────────────────
 *  1. Multiple-call prevention: startDirectCall / startCrewCall while a
 *     session is live return false and never hit the API again.
 *  2. Minimize → restore: setMinimized flips the flag without touching the
 *     session, phase, or media.
 *  3. Reconnect: transport 'reconnecting' → phase 'reconnecting'; transport
 *     'connected' (post-accept) → phase 'connected'. Transport 'disconnected'
 *     tears the call down cleanly.
 *  4. Permission-denied / connect failure: bridge.connect rejects → the
 *     server call is ended (no ghost session), state resets with an error.
 *  5. No bridge wired: call fails gracefully with a clear error and the
 *     server session is ended.
 *
 * Harness follows CallContext.ringLifecycle.component.test.tsx: renderHook
 * (React 19 + jest-expo deferred-commit workaround), resolving bridge, and
 * `await act(async () => {})` to drain the start chain.
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

const LONG_RING_MS = 60_000;

// ── Module-level mock state ────────────────────────────────────────────────

const mockStartCall = jest.fn();
const mockEndCall = jest.fn();
const mockStartGroup = jest.fn();

// NOTE: intentionally exhaustive — calls.ts imports the API client chain at
// module level; spreading requireActual would execute that chain and crash.
jest.mock('../../services/calls.ts', () => ({
  startCall: (...a: unknown[]) => mockStartCall(...a),
  acceptCall: jest.fn(),
  declineCall: jest.fn().mockResolvedValue({ ok: true }),
  endCall: (...a: unknown[]) => mockEndCall(...a),
  joinCall: jest.fn(),
  leaveCall: jest.fn(),
  getActiveCall: jest.fn().mockResolvedValue({ ok: false, data: null }),
  startGroupCall: (...a: unknown[]) => mockStartGroup(...a),
  getCall: jest.fn().mockResolvedValue({ ok: false, data: null }),
  setHandRaised: jest.fn(),
}));

// NOTE: intentionally exhaustive — the real module creates a Supabase client
// at import time.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) },
  },
}));

import {
  CallProvider, useCallState, useCallActions, type LiveKitBridge,
} from '../CallContext.tsx';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SESSION = {
  id: 'r1', callType: 'voice', contextType: 'telegraph_dm',
  threadId: 't1', startedBy: 'me', status: 'ringing',
} as const;

type CS = 'connected' | 'reconnecting' | 'disconnected';

function makeBridge(over: Partial<LiveKitBridge> = {}) {
  let connCb: ((s: CS) => void) | null = null;
  const bridge: LiveKitBridge & { disconnect: jest.Mock; connect: jest.Mock } = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    setMicEnabled: jest.fn().mockResolvedValue(undefined),
    setCameraEnabled: jest.fn().mockResolvedValue(undefined),
    flipCamera: jest.fn().mockResolvedValue(undefined),
    setSpeakerphone: jest.fn().mockResolvedValue(undefined),
    onConnectionState: (cb) => { connCb = cb; return () => { connCb = null; }; },
    ...over,
  } as any;
  const emitConn = (s: CS) => connCb?.(s);
  return { bridge, emitConn };
}

function makeWrapper(bridge: LiveKitBridge | null, ringTimeoutMs: number) {
  return ({ children }: { children: React.ReactNode }) => (
    <CallProvider bridge={bridge} ringTimeoutMs={ringTimeoutMs}>
      {children}
    </CallProvider>
  );
}

function useCallHook() {
  return { state: useCallState(), actions: useCallActions() };
}

const START_INPUT = {
  threadId: 't1', calleeId: 'u2',
  contextType: 'telegraph_dm' as const, callType: 'voice' as const,
  peer: { id: 'u2', name: 'Bo', handle: null, avatarUrl: null },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStartCall.mockResolvedValue({
    ok: true,
    data: { session: SESSION, livekitUrl: 'wss://x', token: 't' },
  });
  mockEndCall.mockResolvedValue({ ok: true });
  mockStartGroup.mockResolvedValue({ ok: false, error: 'should_not_be_called' });
});

jest.setTimeout(10_000);

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CallContext resilience — multiple-call prevention', () => {
  it('a second start of ANY kind while a call is live is refused without an API call', async () => {
    const { bridge } = makeBridge();
    const { result } = await renderHook(useCallHook, { wrapper: makeWrapper(bridge, LONG_RING_MS) });

    void result.current.actions.startDirectCall(START_INPUT);
    await act(async () => {});
    expect(result.current.state.phase).toBe('outgoing_ringing');
    expect(mockStartCall).toHaveBeenCalledTimes(1);

    // Double-tap the same button:
    let second: boolean | undefined;
    await act(async () => { second = await result.current.actions.startDirectCall(START_INPUT); });
    expect(second).toBe(false);
    expect(mockStartCall).toHaveBeenCalledTimes(1); // no second API hit

    // Cross-surface: crew / event starts are refused too.
    let crew: boolean | undefined;
    await act(async () => { crew = await result.current.actions.startCrewCall({ tripId: 'trip1' }); });
    expect(crew).toBe(false);
    expect(mockStartGroup).not.toHaveBeenCalled();
  });
});

describe('CallContext resilience — minimize / restore', () => {
  it('minimizing never touches the session, phase, or media', async () => {
    const { bridge } = makeBridge();
    const { result } = await renderHook(useCallHook, { wrapper: makeWrapper(bridge, LONG_RING_MS) });

    void result.current.actions.startDirectCall(START_INPUT);
    await act(async () => {});
    await act(async () => { result.current.actions.noteAccepted(SESSION.id); });
    expect(result.current.state.phase).toBe('connected');

    await act(async () => { result.current.actions.setMinimized(true); });
    expect(result.current.state.minimized).toBe(true);
    expect(result.current.state.phase).toBe('connected');
    expect(result.current.state.session?.id).toBe(SESSION.id);
    expect(bridge.disconnect).not.toHaveBeenCalled();

    await act(async () => { result.current.actions.setMinimized(false); });
    expect(result.current.state.minimized).toBe(false);
    expect(result.current.state.phase).toBe('connected');
  });
});

describe('CallContext resilience — transport reconnect', () => {
  it("'reconnecting' surfaces, 'connected' recovers, 'disconnected' tears down", async () => {
    const { bridge, emitConn } = makeBridge();
    const { result } = await renderHook(useCallHook, { wrapper: makeWrapper(bridge, LONG_RING_MS) });

    void result.current.actions.startDirectCall(START_INPUT);
    await act(async () => {});
    await act(async () => { result.current.actions.noteAccepted(SESSION.id); });
    expect(result.current.state.phase).toBe('connected');

    await act(async () => { emitConn('reconnecting'); });
    expect(result.current.state.phase).toBe('reconnecting');

    await act(async () => { emitConn('connected'); });
    expect(result.current.state.phase).toBe('connected');

    // Hard transport loss → clean teardown (no zombie UI).
    await act(async () => {
      emitConn('disconnected');
      await new Promise<void>((r) => setTimeout(r, 80));
    });
    expect(result.current.state.phase).toBe('idle');
    expect(bridge.disconnect).toHaveBeenCalled();
  });
});

describe('CallContext resilience — connect failure / permission denied', () => {
  it('bridge.connect rejection ends the server call and resets with an error', async () => {
    const { bridge } = makeBridge({
      connect: jest.fn().mockRejectedValue(new Error('camera/mic permission denied')),
    });
    const { result } = await renderHook(useCallHook, { wrapper: makeWrapper(bridge, LONG_RING_MS) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.actions.startDirectCall(START_INPUT);
      await new Promise<void>((r) => setTimeout(r, 80));
    });
    expect(ok).toBe(false);
    expect(mockEndCall).toHaveBeenCalledWith(SESSION.id); // no ghost server session
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.error).toBe('Could not connect the call. Please try again.');

    // The user can dismiss the error and start fresh.
    await act(async () => { result.current.actions.dismissError(); });
    expect(result.current.state.error).toBeNull();
  });

  it('no bridge wired: fails gracefully with a clear error and ends the session', async () => {
    const { result } = await renderHook(useCallHook, { wrapper: makeWrapper(null, LONG_RING_MS) });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.actions.startDirectCall(START_INPUT);
      await new Promise<void>((r) => setTimeout(r, 80));
    });
    expect(ok).toBe(false);
    expect(mockEndCall).toHaveBeenCalledWith(SESSION.id);
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.error).toBe('Calling is not available in this build yet.');
  });
});
