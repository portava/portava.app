/**
 * GroupCallScreen — group room in-room UI: title + participant count,
 * participant list with active-speaker indication, and voice-only controls.
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

import { GroupCallScreen } from '../GroupCallScreen.tsx';
import type { CallParticipantDto } from '../../../services/calls.ts';

afterEach(async () => { await act(async () => {}); });

const participants: CallParticipantDto[] = [
  { userId: 'u1', role: 'host', status: 'joined', joinedAt: null, leftAt: null, name: 'Sam Rivera', handle: 'sam', avatarUrl: null },
  { userId: 'u2', role: 'participant', status: 'joined', joinedAt: null, leftAt: null, name: null, handle: 'wander_ana', avatarUrl: null },
  { userId: 'u3', role: 'participant', status: 'joined', joinedAt: null, leftAt: null, name: null, handle: null, avatarUrl: null },
];

test('count, participant list, active speaker, and voice-only controls', async () => {
  const onToggleMute = jest.fn();
  const onHangUp = jest.fn();
  const view = await render(
    <GroupCallScreen
      visible phase="connected" elapsedSec={125}
      participants={participants} participantCount={3} activeSpeakerIds={['u2']}
      micMuted={false} speakerOn
      onToggleMute={onToggleMute} onToggleSpeaker={jest.fn()}
      onHangUp={onHangUp} onMinimize={jest.fn()}
    />,
  );
  expect(view.getByText('Crew Call')).toBeTruthy();
  expect(view.getByText('3 people')).toBeTruthy();
  expect(view.getByText('02:05')).toBeTruthy();

  // Identity fallbacks: real name → @handle → Traveler (privacy rule).
  expect(view.getByText('Sam Rivera')).toBeTruthy();
  expect(view.getByText('@wander_ana')).toBeTruthy();
  expect(view.getByText('Traveler')).toBeTruthy();

  // Active-speaker indication only on the speaking participant.
  expect(view.getByLabelText('@wander_ana, speaking')).toBeTruthy();
  expect(view.queryByLabelText('Sam Rivera, speaking')).toBeNull();

  // Voice-only room: no camera controls, but mute/end wired.
  expect(view.queryByLabelText('Turn camera on')).toBeNull();
  fireEvent.press(view.getByLabelText('Mute microphone'));
  expect(onToggleMute).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('End call'));
  expect(onHangUp).toHaveBeenCalledTimes(1);

  // Single participant renders the singular count.
  await view.rerender(
    <GroupCallScreen
      visible phase="connecting" elapsedSec={0}
      participants={[participants[0]]} participantCount={1} activeSpeakerIds={[]}
      micMuted speakerOn={false}
      onToggleMute={onToggleMute} onToggleSpeaker={jest.fn()}
      onHangUp={onHangUp} onMinimize={jest.fn()}
    />,
  );
  expect(view.getByText('1 person')).toBeTruthy();
  expect(view.getByText('Connecting…')).toBeTruthy();
});
