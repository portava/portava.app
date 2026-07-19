/**
 * CallSurface — minimized pill: one persistent bar with return-to-call,
 * mute shortcut, and end; full-screen call UI hidden while minimized.
 *
 * Single test — see IncomingCallScreen test header for the renderer limit.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: any) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: exhaustive by design — CallSurface only uses useSafeAreaInsets; a fixed inset object keeps the test hermetic.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockActions = {
  startDirectCall: jest.fn(async () => true),
  presentIncomingCall: jest.fn(),
  noteAccepted: jest.fn(),
  endLocallyWithNotice: jest.fn(),
  dismissError: jest.fn(),
  accept: jest.fn(async () => true),
  decline: jest.fn(async () => {}),
  hangUp: jest.fn(async () => {}),
  toggleMute: jest.fn(async () => {}),
  toggleCamera: jest.fn(async () => {}),
  flipCamera: jest.fn(async () => {}),
  toggleSpeaker: jest.fn(async () => {}),
  setMinimized: jest.fn(),
  restoreActiveCall: jest.fn(async () => {}),
};

let mockState: any;

// NOTE: exhaustive by design — the test drives CallSurface purely through mocked state/actions; real context would need a provider + bridge.
jest.mock('../../../context/CallContext.tsx', () => ({
  useCallState: () => mockState,
  useCallActions: () => mockActions,
}));

// NOTE: exhaustive by design — CallSurface reads only isAuthed from useSession.
jest.mock('../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ isAuthed: true, userId: 'me' }),
}));

// NOTE: exhaustive by design — module exports only permission helpers; the test controls grant/deny outcomes.
jest.mock('../../../services/callPermissions.ts', () => ({
  ensureCallMediaPermissions: jest.fn(async (req: any) => req),
}));

import { CallSurface } from '../CallSurface.tsx';

beforeEach(() => {
  jest.clearAllMocks();
  mockState = {
    phase: 'connected',
    session: {
      id: 'c1', callType: 'voice', contextType: 'telegraph_dm', contextId: 't1',
      threadId: 't1', startedBy: 'me', status: 'active',
      startedAt: '2026-07-19T10:00:00Z', connectedAt: '2026-07-19T10:00:05Z', endedAt: null,
    },
    incoming: null,
    peer: { id: 'u2', name: 'Alex', handle: null, avatarUrl: null },
    minimized: true, micMuted: false, cameraOn: false, speakerOn: false,
    elapsedSec: 263, error: null,
  };
});

afterEach(async () => { await act(async () => {}); });

test('minimized pill shows label + timer, restores, mutes, ends; restore-on-mount fires once', async () => {
  const view = await render(<CallSurface />);
  await act(async () => {});

  // Restores an in-progress call once on mount.
  expect(mockActions.restoreActiveCall).toHaveBeenCalledTimes(1);

  // "Call with Alex · 04:23" pill; full-screen call UI hidden while minimized.
  expect(view.getByText('Call with Alex')).toBeTruthy();
  expect(view.getByText('04:23')).toBeTruthy();
  expect(view.queryByLabelText('Minimize call')).toBeNull();

  fireEvent.press(view.getByLabelText('Return to call. Call with Alex'));
  expect(mockActions.setMinimized).toHaveBeenCalledWith(false);
  fireEvent.press(view.getByLabelText('Mute'));
  expect(mockActions.toggleMute).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('End call'));
  expect(mockActions.hangUp).toHaveBeenCalledTimes(1);
});
