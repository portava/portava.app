/**
 * Component test: call.room_updated → immediate roster refresh wiring.
 *
 * The server publishes `call.room_updated` when a listener raises/lowers a
 * hand (or the roster changes). CallRealtimeBinding must route that signal to
 * CallContext's noteRoomUpdated(callId) so hosts see raised hands instantly —
 * not on the next periodic group poll.
 *
 * Covered cases:
 *  - call.room_updated with a callId → noteRoomUpdated(callId) called once
 *  - callId resolved from payload.session.id when payload.callId is absent
 *  - event without any call id → ignored (no action call)
 *  - non-call events → ignored
 *
 * NOTE: render() must be awaited in this env (RNTL 14 + React 19 + jest-expo).
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Controllable fake telegraphRealtime: the test emits events directly.
type EventListener = (evt: unknown) => void;
const mockEventListeners = new Set<EventListener>();
function emitEvent(evt: unknown) {
  for (const l of [...mockEventListeners]) l(evt);
}
// NOTE: intentionally exhaustive — the real singleton opens an XHR/SSE stream
// on subscribe; the test must drive events deterministically.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: {
    subscribe: (l: EventListener) => {
      mockEventListeners.add(l);
      return () => { mockEventListeners.delete(l); };
    },
    onStatus: jest.fn(() => () => {}),
    getStatus: () => 'open',
  },
}));

const mockActions = {
  startDirectCall: jest.fn(),
  startCrewCall: jest.fn(),
  startEventRoom: jest.fn(),
  joinEventRoom: jest.fn(),
  setHandRaised: jest.fn(),
  noteRoleChanged: jest.fn(),
  noteRemovedFromRoom: jest.fn(),
  noteRoomUpdated: jest.fn(),
  presentIncomingCall: jest.fn(),
  dismissIncoming: jest.fn(),
  noteAccepted: jest.fn(),
  endLocallyWithNotice: jest.fn(),
  dismissError: jest.fn(),
  accept: jest.fn(),
  decline: jest.fn(),
  hangUp: jest.fn(),
  toggleMute: jest.fn(),
  toggleCamera: jest.fn(),
  flipCamera: jest.fn(),
  toggleSpeaker: jest.fn(),
  setMinimized: jest.fn(),
  restoreActiveCall: jest.fn(),
};

const mockState = {
  phase: 'connected',
  session: { id: 'call-room-1' },
  incoming: null,
};

// NOTE: intentionally exhaustive — the real provider imports the Supabase
// client at module level; the binding only consumes the two hooks.
jest.mock('../../../context/CallContext.tsx', () => ({
  useCallActions: () => mockActions,
  useCallState: () => mockState,
}));

import { CallRealtimeBinding } from '../CallRealtimeBinding.tsx';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CallRealtimeBinding — call.room_updated', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes call.room_updated to noteRoomUpdated with the callId', async () => {
    await render(<CallRealtimeBinding />);
    await act(async () => {
      emitEvent({ type: 'call.room_updated', payload: { callId: 'call-room-1' }, ts: 't' });
    });
    expect(mockActions.noteRoomUpdated).toHaveBeenCalledTimes(1);
    expect(mockActions.noteRoomUpdated).toHaveBeenCalledWith('call-room-1');
  });

  it('falls back to payload.session.id when callId is absent', async () => {
    await render(<CallRealtimeBinding />);
    await act(async () => {
      emitEvent({ type: 'call.room_updated', payload: { session: { id: 'call-room-2' } }, ts: 't' });
    });
    expect(mockActions.noteRoomUpdated).toHaveBeenCalledWith('call-room-2');
  });

  it('ignores a room_updated event without any call id', async () => {
    await render(<CallRealtimeBinding />);
    await act(async () => {
      emitEvent({ type: 'call.room_updated', payload: {}, ts: 't' });
    });
    expect(mockActions.noteRoomUpdated).not.toHaveBeenCalled();
  });

  it('ignores non-call events entirely', async () => {
    await render(<CallRealtimeBinding />);
    await act(async () => {
      emitEvent({ type: 'message.created', payload: { callId: 'call-room-1' }, ts: 't' });
    });
    expect(mockActions.noteRoomUpdated).not.toHaveBeenCalled();
  });
});
