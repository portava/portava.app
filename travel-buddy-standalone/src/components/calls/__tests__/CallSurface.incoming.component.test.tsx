/**
 * CallSurface — incoming-call flow: full-screen ringing UI, accept (voice /
 * video, permission-gated), and decline all route through CallContext.
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

const mockEnsurePerms = jest.fn(async (req: 'voice' | 'video') => req as 'voice' | 'video' | null);
// NOTE: exhaustive by design — module exports only permission helpers; the test controls grant/deny outcomes.
jest.mock('../../../services/callPermissions.ts', () => ({
  ensureCallMediaPermissions: (req: 'voice' | 'video') => mockEnsurePerms(req),
}));

import { CallSurface } from '../CallSurface.tsx';

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsurePerms.mockImplementation(async (req) => req);
  mockState = {
    phase: 'incoming_ringing',
    session: null,
    incoming: {
      callId: 'c1', callType: 'video', contextType: 'telegraph_dm', threadId: 't1',
      caller: { id: 'u2', name: 'Alex Rivera', handle: null, avatarUrl: null },
    },
    peer: null,
    minimized: false, micMuted: false, cameraOn: false, speakerOn: false,
    elapsedSec: 0, error: null,
  };
});

afterEach(async () => { await act(async () => {}); });

test('incoming video call: accept paths are permission-gated; decline routes through context', async () => {
  const view = await render(<CallSurface />);
  expect(view.getByText('Alex Rivera')).toBeTruthy();

  // — Accept as voice: never requests/enables the camera —
  fireEvent.press(view.getByLabelText('Accept as voice'));
  await act(async () => {});
  expect(mockEnsurePerms).toHaveBeenCalledWith('voice');
  expect(mockActions.accept).toHaveBeenCalledWith(false);

  // — Accept with video: requests camera, accepts as video —
  jest.clearAllMocks();
  mockEnsurePerms.mockImplementation(async (req) => req);
  fireEvent.press(view.getByLabelText('Accept with video'));
  await act(async () => {});
  expect(mockEnsurePerms).toHaveBeenCalledWith('video');
  expect(mockActions.accept).toHaveBeenCalledWith(true);

  // — Camera denied: accept-with-video downgrades to voice —
  jest.clearAllMocks();
  mockEnsurePerms.mockImplementation(async () => 'voice');
  fireEvent.press(view.getByLabelText('Accept with video'));
  await act(async () => {});
  expect(mockActions.accept).toHaveBeenCalledWith(false);

  // — Mic denied: accepting is blocked, call keeps ringing —
  jest.clearAllMocks();
  mockEnsurePerms.mockImplementation(async () => null);
  fireEvent.press(view.getByLabelText('Accept as voice'));
  await act(async () => {});
  expect(mockActions.accept).not.toHaveBeenCalled();

  // — Decline —
  fireEvent.press(view.getByLabelText('Decline'));
  await act(async () => {});
  expect(mockActions.decline).toHaveBeenCalledTimes(1);
});
