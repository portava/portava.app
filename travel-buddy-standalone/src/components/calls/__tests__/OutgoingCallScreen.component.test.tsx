/**
 * OutgoingCallScreen — phase-driven status copy (Calling… / Connecting… /
 * Reconnecting… / elapsed timer) and control wiring.
 *
 * Single test with rerenders — see IncomingCallScreen test header for why.
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

import { OutgoingCallScreen } from '../OutgoingCallScreen.tsx';
import type { CallPhase } from '../../../context/CallContext.tsx';

const handlers = {
  onToggleMute: jest.fn(),
  onToggleCamera: jest.fn(),
  onFlipCamera: jest.fn(),
  onToggleSpeaker: jest.fn(),
  onHangUp: jest.fn(),
  onMinimize: jest.fn(),
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    visible: true,
    phase: 'outgoing_ringing' as CallPhase,
    isVideo: false,
    elapsedSec: 0,
    peerName: 'Alex Rivera',
    peerAvatarUrl: null,
    micMuted: false,
    cameraOn: false,
    speakerOn: false,
    ...handlers,
    ...overrides,
  };
}

afterEach(async () => { await act(async () => {}); });

test('status copy per phase, voice vs video controls, and control wiring', async () => {
  // — Ringing → Connecting → Reconnecting → timer —
  const view = await render(<OutgoingCallScreen {...props()} />);
  expect(view.getByText('Calling…')).toBeTruthy();
  await view.rerender(<OutgoingCallScreen {...props({ phase: 'connecting' })} />);
  expect(view.getByText('Connecting…')).toBeTruthy();
  await view.rerender(<OutgoingCallScreen {...props({ phase: 'reconnecting' })} />);
  expect(view.getByText('Reconnecting…')).toBeTruthy();
  await view.rerender(<OutgoingCallScreen {...props({ phase: 'connected', elapsedSec: 263 })} />);
  expect(view.getByText('04:23')).toBeTruthy();

  // — Voice call: no camera controls; end + minimize wired —
  expect(view.queryByLabelText('Turn camera on')).toBeNull();
  expect(view.queryByLabelText('Flip camera')).toBeNull();
  fireEvent.press(view.getByLabelText('End call'));
  expect(handlers.onHangUp).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Minimize call'));
  expect(handlers.onMinimize).toHaveBeenCalledTimes(1);

  // — Video call: camera toggle + flip + mute —
  jest.clearAllMocks();
  await view.rerender(
    <OutgoingCallScreen {...props({ phase: 'connected', isVideo: true, cameraOn: true })} />,
  );
  fireEvent.press(view.getByLabelText('Turn camera off'));
  expect(handlers.onToggleCamera).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Flip camera'));
  expect(handlers.onFlipCamera).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Mute microphone'));
  expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);
});
