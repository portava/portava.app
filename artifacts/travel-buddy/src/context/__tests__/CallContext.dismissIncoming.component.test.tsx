/**
 * Component test: CallContext.dismissIncoming().
 *
 * Task: a stale incoming-call banner must be dismissible WITHOUT hanging up
 * an unrelated live call. Previously CallRealtimeBinding cleared a remotely
 * canceled banner via hangUp(), which only worked because no session existed
 * yet — dismissIncoming() removes that footgun.
 *
 * Covered cases:
 *  - incoming_ringing banner → dismissIncoming() → banner cleared, phase idle
 *  - live call (connected session) → dismissIncoming() → session untouched,
 *    no bridge.disconnect(), no endCall API call (banner-dismiss-while-in-call)
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { Text, Pressable } from 'react-native';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react-native';

const mockStartCall = jest.fn();
const mockEndCall = jest.fn();

// NOTE: intentionally exhaustive — calls.ts imports the API client chain at
// module level; spreading requireActual would execute that import chain and
// crash the JSDOM suite. Only the functions CallContext uses are stubbed.
jest.mock('../../services/calls.ts', () => ({
  startCall: (...args: unknown[]) => mockStartCall(...args),
  acceptCall: jest.fn(),
  declineCall: jest.fn().mockResolvedValue({ ok: true }),
  endCall: (...args: unknown[]) => mockEndCall(...args),
  joinCall: jest.fn(),
  leaveCall: jest.fn(),
  getActiveCall: jest.fn().mockResolvedValue({ ok: false, data: null }),
}));

import {
  CallProvider, useCallActions, useCallState, type LiveKitBridge,
} from '../CallContext.tsx';

const SESSION = {
  id: 'call-live-1',
  callType: 'voice',
  contextType: 'telegraph_dm',
  threadId: 'thread-1',
  startedBy: 'me',
  status: 'active',
} as const;

const INCOMING = {
  callId: 'call-stale-9',
  callType: 'voice' as const,
  contextType: 'telegraph_dm' as const,
  threadId: 'thread-2',
  caller: { id: 'u2', name: 'Bo', handle: null, avatarUrl: null },
};

function makeBridge(): LiveKitBridge & { disconnect: jest.Mock } {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    setMicEnabled: jest.fn().mockResolvedValue(undefined),
    setCameraEnabled: jest.fn().mockResolvedValue(undefined),
    flipCamera: jest.fn().mockResolvedValue(undefined),
    setSpeakerphone: jest.fn().mockResolvedValue(undefined),
  };
}

function Harness() {
  const state = useCallState();
  const actions = useCallActions();
  return (
    <>
      <Text testID="phase">{state.phase}</Text>
      <Text testID="incoming">{state.incoming?.callId ?? 'none'}</Text>
      <Text testID="session">{state.session?.id ?? 'none'}</Text>
      <Pressable testID="present" onPress={() => actions.presentIncomingCall(INCOMING)} />
      <Pressable testID="dismiss" onPress={() => actions.dismissIncoming()} />
      <Pressable
        testID="start"
        onPress={() => {
          void actions.startDirectCall({
            threadId: 'thread-1', calleeId: 'u3',
            contextType: 'telegraph_dm', callType: 'voice',
          });
        }}
      />
      <Pressable
        testID="noteAccepted"
        onPress={() => actions.noteAccepted(SESSION.id)}
      />
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStartCall.mockResolvedValue({
    ok: true,
    data: { session: SESSION, livekitUrl: 'wss://x', token: 't' },
  });
  // Must resolve: the 45s ring-timeout mirror calls endCall(...).catch(...) —
  // an undefined return would crash the worker when the timer fires.
  mockEndCall.mockResolvedValue({ ok: true });
});

describe('CallContext.dismissIncoming', () => {
  it('clears an incoming banner back to idle without any API/bridge calls', async () => {
    await render(
      <CallProvider bridge={makeBridge()}>
        <Harness />
      </CallProvider>,
    );

    await act(async () => { fireEvent.press(screen.getByTestId('present')); });
    expect(screen.getByTestId('phase').props.children).toBe('incoming_ringing');
    expect(screen.getByTestId('incoming').props.children).toBe(INCOMING.callId);

    await act(async () => { fireEvent.press(screen.getByTestId('dismiss')); });
    expect(screen.getByTestId('phase').props.children).toBe('idle');
    expect(screen.getByTestId('incoming').props.children).toBe('none');
    expect(mockEndCall).not.toHaveBeenCalled();
  });

  it('never hangs up a live call: session and media stay untouched', async () => {
    const bridge = makeBridge();
    await render(
      <CallProvider bridge={bridge}>
        <Harness />
      </CallProvider>,
    );

    // startDirectCall connects to the room immediately but waits in
    // outgoing_ringing until the server publishes call.accepted — the phase
    // never reaches 'connected' on the caller side without noteAccepted.
    // The active session is already live at outgoing_ringing, so dismissing
    // a stale incoming banner must not hang it up.
    fireEvent.press(screen.getByTestId('start'));
    await act(async () => {}); // flush startDirectCall + connectMedia
    // awaitAccept keeps the caller in 'outgoing_ringing' until call.accepted.
    expect(screen.getByTestId('phase').props.children).toBe('outgoing_ringing');
    expect(screen.getByTestId('session').props.children).toBe(SESSION.id);

    // A stale banner-dismiss arrives while the outgoing call is in-progress.
    fireEvent.press(screen.getByTestId('dismiss'));

    // Phase and session are unchanged; bridge and API are untouched.
    expect(screen.getByTestId('phase').props.children).toBe('outgoing_ringing');
    expect(screen.getByTestId('session').props.children).toBe(SESSION.id);
    expect(bridge.disconnect).not.toHaveBeenCalled();
    expect(mockEndCall).not.toHaveBeenCalled();
  });
});
