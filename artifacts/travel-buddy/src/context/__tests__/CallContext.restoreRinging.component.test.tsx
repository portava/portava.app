/**
 * Component test: incoming call still rings after a dropped connection.
 *
 * Scenario: the callee's SSE stream was down when the call started, so the
 * `call.incoming` realtime event was lost. When telegraphRealtime reconnects,
 * CallRealtimeBinding calls restoreActiveCall(), which finds the still-ringing
 * session via GET /api/calls/active and surfaces the incoming banner
 * (phase = incoming_ringing) — not silence.
 *
 * Covered cases:
 *  - reconnect (polling → open) + ringing session where viewer is callee →
 *    incoming banner presented with the caller's id
 *  - ringing session where viewer is the CALLER → no incoming banner
 *  - active session path unchanged (join + connect flow is not hijacked)
 *  - initial status emission alone (no reconnect) does NOT trigger a restore
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { Text, View } from 'react-native';
import { render, screen, act, waitFor } from '@testing-library/react-native';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetActiveCall = jest.fn();
const mockJoinCall = jest.fn();

// NOTE: intentionally exhaustive — calls.ts imports the Supabase client at
// module level; spreading requireActual would execute that import chain.
jest.mock('../../services/calls.ts', () => ({
  startCall: jest.fn(),
  acceptCall: jest.fn(),
  declineCall: jest.fn(),
  endCall: jest.fn(),
  joinCall: (...args: unknown[]) => mockJoinCall(...args),
  leaveCall: jest.fn(),
  getActiveCall: (...args: unknown[]) => mockGetActiveCall(...args),
}));

const mockGetUser = jest.fn();
// NOTE: intentionally exhaustive — the real module creates a Supabase client
// at import time; only auth.getUser is consumed by CallContext.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: { auth: { getUser: (...args: unknown[]) => mockGetUser(...args) } },
}));

// Controllable fake telegraphRealtime: tests drive status transitions.
type StatusListener = (s: string) => void;
const mockStatusListeners = new Set<StatusListener>();
let mockCurrentStatus = 'connecting';
function emitStatus(s: string) {
  mockCurrentStatus = s;
  for (const l of [...mockStatusListeners]) l(s);
}
// NOTE: intentionally exhaustive — the real singleton opens an XHR/SSE stream
// on subscribe; the test must drive status transitions deterministically.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: jest.fn(() => () => {}),
    onStatus: (l: StatusListener) => {
      mockStatusListeners.add(l);
      l(mockCurrentStatus);
      return () => { mockStatusListeners.delete(l); };
    },
    getStatus: () => mockCurrentStatus,
  },
}));

import { CallProvider, useCallState } from '../CallContext.tsx';
import { CallRealtimeBinding } from '../../components/calls/CallRealtimeBinding.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CALLER_ID = 'user-caller';
const CALLEE_ID = 'user-callee';

const ringingSession = {
  id: 'call-77',
  callType: 'voice',
  contextType: 'telegraph_dm',
  contextId: 'ctx-1',
  threadId: 'thread-9',
  startedBy: CALLER_ID,
  status: 'ringing',
  startedAt: new Date('2026-07-19T10:00:00Z').toISOString(),
  connectedAt: null,
  endedAt: null,
};

function Probe() {
  const s = useCallState();
  return (
    <View>
      <Text testID="phase">{s.phase}</Text>
      <Text testID="incoming-call-id">{s.incoming?.callId ?? 'none'}</Text>
      <Text testID="incoming-caller-id">{s.incoming?.caller.id ?? 'none'}</Text>
    </View>
  );
}

async function mountApp() {
  await render(
    <CallProvider>
      <CallRealtimeBinding />
      <Probe />
    </CallProvider>,
  );
}

/** Simulate a dropped connection that comes back: open → polling → open. */
async function reconnect() {
  await act(async () => { emitStatus('polling'); });
  await act(async () => { emitStatus('open'); });
  // restoreActiveCall is async fire-and-forget — let it settle.
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStatusListeners.clear();
  mockCurrentStatus = 'connecting';
  mockGetUser.mockResolvedValue({ data: { user: { id: CALLEE_ID } } });
  mockJoinCall.mockResolvedValue({ ok: false, data: null, error: 'nope' });
});

describe('incoming call survives an SSE reconnect', () => {
  it('callee reconnecting mid-ring sees the incoming banner, not silence', async () => {
    mockGetActiveCall.mockResolvedValue({ ok: true, data: { session: ringingSession } });
    await mountApp();
    expect(screen.getByTestId('phase').props.children).toBe('idle');

    await reconnect();

    await waitFor(() => {
      expect(screen.getByTestId('phase').props.children).toBe('incoming_ringing');
    });
    expect(screen.getByTestId('incoming-call-id').props.children).toBe('call-77');
    expect(screen.getByTestId('incoming-caller-id').props.children).toBe(CALLER_ID);
    // A ringing restore must never try to join the room before accept.
    expect(mockJoinCall).not.toHaveBeenCalled();
  });

  it('the caller of a ringing session does NOT get an incoming banner', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: CALLER_ID } } });
    mockGetActiveCall.mockResolvedValue({ ok: true, data: { session: ringingSession } });
    await mountApp();

    await reconnect();

    expect(mockGetActiveCall).toHaveBeenCalled();
    expect(screen.getByTestId('phase').props.children).toBe('idle');
    expect(screen.getByTestId('incoming-call-id').props.children).toBe('none');
  });

  it('an active session still goes through the join/restore path', async () => {
    mockGetActiveCall.mockResolvedValue({
      ok: true,
      data: { session: { ...ringingSession, status: 'active' } },
    });
    await mountApp();

    await reconnect();

    await waitFor(() => { expect(mockJoinCall).toHaveBeenCalledWith('call-77'); });
    expect(screen.getByTestId('incoming-call-id').props.children).toBe('none');
  });

  it('the initial status emission alone does not trigger a restore', async () => {
    mockGetActiveCall.mockResolvedValue({ ok: true, data: { session: ringingSession } });
    mockCurrentStatus = 'open'; // already open when the binding mounts
    await mountApp();
    await act(async () => { await Promise.resolve(); });

    expect(mockGetActiveCall).not.toHaveBeenCalled();
    expect(screen.getByTestId('phase').props.children).toBe('idle');
  });
});
