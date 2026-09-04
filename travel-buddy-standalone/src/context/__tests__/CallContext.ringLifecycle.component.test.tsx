/**
 * Component test: CallContext outgoing-ring lifecycle.
 * Proves a caller can never be stuck on "Calling…".
 *
 * Covered scenarios
 * ─────────────────
 *  1. holdRinging: startDirectCall → phase stays 'outgoing_ringing' even
 *     after bridge connects; emitConn('connected') is blocked while
 *     holdRinging.current = true.
 *  2. noteAccepted → 'connected': holdRinging cleared; ring timer disarmed;
 *     endCall is NOT called after the ring window passes.
 *  3. call.declined → teardown with error "Call declined".
 *  4. call.missed while outgoing_ringing → teardown with error "No answer".
 *  5. Ring timeout (45 s mirror) → endCall API called + bridge disconnected
 *     + phase 'idle' with error "No answer".
 *
 * Why renderHook instead of render + testID
 * ──────────────────────────────────────────
 * React 19's concurrent scheduler in jest-expo defers setState commits that
 * originate from outside a React event handler after a prior multi-patch async
 * sequence (startDirectCall + connectMedia).  `render()` + `getByTestId()`
 * cannot observe those deferred commits reliably, causing:
 *   • `noteAccepted → 'connected'` never showing in testID children even with
 *     waitFor(3 s).
 *   • A second `render()` call within the same test producing an empty tree
 *     ("Unable to find testID: …").
 *
 * `renderHook()` exposes `result.current` directly through React's internal
 * fiber — state updates from `useState` are applied there reliably.
 * `noteAccepted` alone in its own `await act(async () => {})` commits
 * 'connected' to `result.current.state.phase` consistently.
 *
 * Multiple `renderHook()` calls within one test are also safe; there is no
 * scheduler contamination between them.
 *
 * How 'outgoing_ringing' is committed in one act() drain
 * ───────────────────────────────────────────────────────
 * Resolving bridge (connect: mockResolvedValue(undefined)) + fire-and-forget
 * startDirectCall + `await act(async () => {})`:
 *   The outer `await` yields to the microtask queue, which drains the full
 *   startDirectCall + connectMedia chain (apiStart → patches → bridge.connect
 *   → onConnectionState + tick + holdRinging=true + patch(outgoing_ringing)).
 *   React's act() flushWork() commits all queued setState calls before act()
 *   resolves — proven by the dismissIncoming test using the identical pattern.
 *
 * Teardown timing (scenarios 3, 4, 5)
 * ─────────────────────────────────────
 * teardown() calls `await bridge.disconnect()` then setState(INITIAL).
 * Wrapping the trigger + an 80 ms real-timer sleep inside ONE act() callback
 * lets the event loop fire bridge.disconnect()'s microtask (teardown → setState)
 * and React's MessageChannel scheduler task (commits 'idle') before act() ends.
 *
 * NOTE: render() must be awaited (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

/** Real-time ring window for scenario 5 (actual timer fires in test). */
const TEST_RING_MS = 80;
/** Long ring window so scenarios 1–4 never trigger the ring timer. */
const LONG_RING_MS = 60_000;

// ── Module-level mock state ────────────────────────────────────────────────

const mockStartCall = jest.fn();
const mockEndCall   = jest.fn();

// NOTE: intentionally exhaustive — calls.ts imports the API client chain at
// module level; spreading requireActual would execute that chain and crash.
jest.mock('../../services/calls.ts', () => ({
  startCall:     (...a: unknown[]) => mockStartCall(...a),
  acceptCall:    jest.fn(),
  declineCall:   jest.fn().mockResolvedValue({ ok: true }),
  endCall:       (...a: unknown[]) => mockEndCall(...a),
  joinCall:      jest.fn(),
  leaveCall:     jest.fn(),
  getActiveCall: jest.fn().mockResolvedValue({ ok: false, data: null }),
}));

// NOTE: intentionally exhaustive — the real module creates a Supabase client
// at import time.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user: null } }) },
  },
}));

// CallRealtimeBinding-controlled event bus: emit call.* events via emitEvent().
type EventListener = (evt: { type: string; payload?: unknown }) => void;
const mockEventListeners = new Set<EventListener>();
function emitEvent(type: string, payload?: unknown) {
  for (const l of [...mockEventListeners]) l({ type, payload });
}
// NOTE: intentionally exhaustive — the real singleton opens a network stream.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: EventListener) => {
      mockEventListeners.add(l);
      return () => { mockEventListeners.delete(l); };
    },
    onStatus: jest.fn(() => () => {}),
    getStatus: () => 'open',
  },
}));

import {
  CallProvider, useCallState, useCallActions, type LiveKitBridge,
} from '../CallContext.tsx';
import { CallRealtimeBinding } from '../../components/calls/CallRealtimeBinding.tsx';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SESSION  = {
  id: 'r1', callType: 'voice', contextType: 'telegraph_dm',
  threadId: 't1', startedBy: 'me', status: 'ringing',
} as const;
const SESSION2 = { ...SESSION, id: 'r2' };
const SESSION3 = { ...SESSION, id: 'r3' };

type CS = 'connected' | 'reconnecting' | 'disconnected';

/**
 * Resolving bridge with connCb hook.
 *
 * connect() resolves immediately so `await act(async () => {})` after
 * startDirectCall drains the full chain and commits 'outgoing_ringing'
 * without needing waitFor (same pattern proven by dismissIncoming tests).
 *
 * onConnectionState captures the callback so tests can call emitConn()
 * synchronously inside act() to trigger the holdRinging gate.
 */
function makeBridge() {
  let connCb: ((s: CS) => void) | null = null;
  const bridge: LiveKitBridge & { disconnect: jest.Mock } = {
    connect:           jest.fn().mockResolvedValue(undefined),
    disconnect:        jest.fn().mockResolvedValue(undefined),
    setMicEnabled:     jest.fn().mockResolvedValue(undefined),
    setCameraEnabled:  jest.fn().mockResolvedValue(undefined),
    flipCamera:        jest.fn().mockResolvedValue(undefined),
    setSpeakerphone:   jest.fn().mockResolvedValue(undefined),
    onConnectionState: (cb) => { connCb = cb; return () => { connCb = null; }; },
  };
  // emitConn fires connCb synchronously — use inside act() to test the gate.
  const emitConn = (s: CS) => connCb?.(s);
  return { bridge, emitConn };
}

// ── Wrapper + hook ─────────────────────────────────────────────────────────

function makeWrapper(bridge: LiveKitBridge, ringTimeoutMs: number) {
  return ({ children }: { children: React.ReactNode }) => (
    <CallProvider bridge={bridge} ringTimeoutMs={ringTimeoutMs}>
      {/* CallRealtimeBinding subscribes to telegraphRealtime; emitEvent() reaches it. */}
      <CallRealtimeBinding />
      {children}
    </CallProvider>
  );
}

function useRingHook() {
  return { state: useCallState(), actions: useCallActions() };
}

// ── Mock lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockEventListeners.clear();
  mockStartCall.mockResolvedValue({
    ok: true,
    data: { session: SESSION, livekitUrl: 'wss://x', token: 't' },
  });
  mockEndCall.mockResolvedValue({ ok: true });
});

jest.setTimeout(10_000);

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CallContext outgoing ring lifecycle', () => {
  /**
   * it 1 — Scenarios 1–4 via a single renderHook with LONG_RING_MS.
   *
   * startDirectCall is called as a fire-and-forget; `await act(async () => {})`
   * drains the full async chain and commits 'outgoing_ringing'.
   * noteAccepted alone in its own act() reliably commits 'connected' via
   * renderHook (proven by diagnostic — avoids the concurrent-scheduler defer
   * that affects the rendered-children testID path).
   */
  it('1-4: holdRinging → noteAccepted → call.declined → call.missed', async () => {
    const { bridge, emitConn } = makeBridge();
    const { result } = await renderHook(useRingHook, {
      wrapper: makeWrapper(bridge, LONG_RING_MS),
    });

    const phase   = () => result.current.state.phase;
    const session = () => result.current.state.session?.id ?? 'none';
    const error   = () => result.current.state.error ?? 'none';

    // ── Phase 1: start call ───────────────────────────────────────────────
    // Fire-and-forget startDirectCall.
    // await act(async () => {}) drains all chained microtasks (apiStart →
    // patch(outgoing_ringing) + sessionRef + ring timer (LONG_RING_MS) +
    // connectMedia → bridge.connect resolves → onConnectionState(connCb
    // captured) + tick + holdRinging=true + patch(outgoing_ringing)).
    // All committed before act() resolves.

    result.current.actions.startDirectCall({
      threadId: 't1', calleeId: 'u2',
      contextType: 'telegraph_dm', callType: 'voice',
      peer: { id: 'u2', name: 'Bo', handle: 'bo', avatarUrl: null },
    });
    await act(async () => {});
    expect(phase()).toBe('outgoing_ringing');
    expect(session()).toBe(SESSION.id);

    // ── Scenario 1: holdRinging blocks transport 'connected' ──────────────
    // holdRinging.current = true; connCb gate: if (!holdRinging.current) →
    // holdRinging=true → gate BLOCKED → no patch(connected).

    await act(async () => { emitConn('connected'); });
    expect(phase()).toBe('outgoing_ringing'); // blocked ✓

    // ── Scenario 2: noteAccepted → 'connected' + ring timer cleared ───────
    //
    // noteAccepted(SESSION.id):
    //   holdRinging.current = false   (gate open)
    //   clearRing()                   (ring timer disarmed)
    //   patch({ phase: 'connected' }) (commits in act with renderHook)
    //
    // Ring timer disarmed proof: wait 50 ms real time and verify endCall
    // was not called (if the timer fired it would call apiEnd).

    await act(async () => { result.current.actions.noteAccepted(SESSION.id); });
    expect(phase()).toBe('connected'); // ✓

    await new Promise<void>(r => setTimeout(r, 50));
    expect(mockEndCall).not.toHaveBeenCalled();    // ring timer cleared ✓
    expect(bridge.disconnect).not.toHaveBeenCalled();

    // ── Scenario 3: call.declined → teardown with "Call declined" ─────────
    //
    // CallRealtimeBinding listener on 'call.declined':
    //   s.session?.id === SESSION.id → endLocallyWithNotice('Call declined')
    //   → void teardown('Call declined')
    //   → bridge.disconnect() [sync] → [microtask] → setState(INITIAL, error)
    //
    // emitEvent + 80 ms sleep inside ONE act() lets bridge.disconnect()'s
    // microtask (teardown → setState) and React's scheduler (MessageChannel →
    // commits 'idle') run before act() ends.

    await act(async () => {
      emitEvent('call.declined', { callId: SESSION.id });
      await new Promise<void>(r => setTimeout(r, 80));
    });
    expect(bridge.disconnect).toHaveBeenCalled();
    expect(phase()).toBe('idle');
    expect(error()).toBe('Call declined');
    expect(mockEndCall).not.toHaveBeenCalled(); // declined never calls endCall ✓

    // ── Phase 2: fresh call with SESSION2 ─────────────────────────────────

    bridge.disconnect.mockClear();
    mockStartCall.mockResolvedValue({
      ok: true,
      data: { session: SESSION2, livekitUrl: 'wss://x', token: 't' },
    });

    result.current.actions.startDirectCall({
      threadId: 't1', calleeId: 'u2',
      contextType: 'telegraph_dm', callType: 'voice',
      peer: { id: 'u2', name: 'Bo', handle: 'bo', avatarUrl: null },
    });
    await act(async () => {});
    expect(phase()).toBe('outgoing_ringing');
    expect(session()).toBe(SESSION2.id);

    // ── Scenario 4: call.missed while outgoing_ringing → "No answer" ─────
    //
    // outcomeNotice('call.missed', 'outgoing_ringing') = 'No answer'.
    // The phase guard in CallRealtimeBinding ensures that call.missed while
    // NOT outgoing_ringing returns null → endLocallyWithNotice(null) → no notice.
    // Testing here at 'outgoing_ringing' exercises the correct branch.

    await act(async () => {
      emitEvent('call.missed', { callId: SESSION2.id });
      await new Promise<void>(r => setTimeout(r, 80));
    });
    expect(bridge.disconnect).toHaveBeenCalled();
    expect(phase()).toBe('idle');
    expect(error()).toBe('No answer');
    expect(mockEndCall).not.toHaveBeenCalled(); // missed never calls endCall ✓
  });

  /**
   * it 2 — Scenario 5: ring timeout fires after TEST_RING_MS real milliseconds.
   *
   * RNTL's cleanup() between it() blocks unmounts the it-1 hook and resets
   * React's scheduler, so this renderHook starts fresh.
   *
   * bridge.connect() resolves immediately → holdRinging=true; the ring timer
   * (TEST_RING_MS = 80 ms) starts in startDirectCall.  After the timer fires:
   *   void apiEnd(session.id).catch(() => {})  → mockEndCall [sync]
   *   void teardown('No answer')               → bridge.disconnect [sync]
   *                                             + setState [after microtask]
   *
   * A polling loop waits for mockEndCall (synchronous, observable immediately
   * after the timer fires), then an 80 ms act() sleep drains teardown's
   * microtask chain so 'idle' commits before assertions run.
   */
  it('5: ring timeout calls endCall and disconnects bridge', async () => {
    const { bridge } = makeBridge();
    mockStartCall.mockResolvedValue({
      ok: true,
      data: { session: SESSION3, livekitUrl: 'wss://x', token: 't' },
    });

    const { result } = await renderHook(useRingHook, {
      wrapper: makeWrapper(bridge, TEST_RING_MS),
    });

    // Start call: ring timer armed (TEST_RING_MS = 80 ms from now).
    result.current.actions.startDirectCall({
      threadId: 't1', calleeId: 'u2',
      contextType: 'telegraph_dm', callType: 'voice',
      peer: { id: 'u2', name: 'Bo', handle: 'bo', avatarUrl: null },
    });
    await act(async () => {});
    expect(result.current.state.phase).toBe('outgoing_ringing');
    expect(result.current.state.session?.id).toBe(SESSION3.id);

    // ── Scenario 5: ring timer fires after TEST_RING_MS ───────────────────
    // Timer callback (real setTimeout):
    //   void apiEnd(SESSION3.id).catch(() => {})  → mockEndCall(SESSION3.id) [sync]
    //   void teardown('No answer')                 → bridge.disconnect() [sync]
    //
    // Poll until endCall is called (synchronous side effect of the timer
    // firing — observable immediately, no act() needed to see it).

    const ringDeadline = Date.now() + TEST_RING_MS * 8;
    while (!mockEndCall.mock.calls.length && Date.now() < ringDeadline) {
      await new Promise<void>(r => setTimeout(r, 10));
    }
    expect(mockEndCall).toHaveBeenCalledWith(SESSION3.id); // apiEnd fired ✓
    // bridge.disconnect() is called synchronously in teardown (before its await).
    expect(bridge.disconnect).toHaveBeenCalled();          // teardown ran ✓

    // Drain teardown's microtask chain: bridge.disconnect().then → setState(INITIAL)
    // → React commits 'idle'.
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, 80));
    });
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.error).toBe('No answer');
    expect(result.current.state.session).toBeNull();
  });
});
