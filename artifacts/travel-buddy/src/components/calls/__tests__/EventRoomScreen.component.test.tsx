/**
 * EventRoomScreen — role-aware event voice-room controls (spec Phase 5):
 * listeners get a Raise-hand button with the mic disabled; speakers get the
 * mic without the hand bar; hosts get the moderation sheet + End room.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

import { EventRoomScreen } from '../EventRoomScreen.tsx';

afterEach(async () => { await act(async () => {}); });

function participant(userId: string, role: string, extra: Partial<any> = {}) {
  return {
    userId, role, status: 'joined', joinedAt: '2026-07-19T10:00:00Z', leftAt: null,
    handRaisedAt: null, name: `Name ${userId}`, handle: userId, avatarUrl: null,
    ...extra,
  };
}

const baseProps = {
  visible: true,
  phase: 'connected' as const,
  elapsedSec: 65,
  participants: [
    participant('host-1', 'host'),
    participant('spk-1', 'speaker'),
    participant('lst-1', 'listener', { handRaisedAt: '2026-07-19T10:05:00Z' }),
    participant('lst-2', 'listener'),
  ],
  activeSpeakerIds: ['spk-1'],
  micMuted: false,
  speakerOn: true,
  onToggleMute: jest.fn(),
  onToggleSpeaker: jest.fn(),
  onToggleHand: jest.fn(),
  onHangUp: jest.fn(),
  onMinimize: jest.fn(),
};

test('listener: raise-hand control shown, mic disabled, no End room', async () => {
  const onToggleHand = jest.fn();
  const view = await render(
    <EventRoomScreen
      {...baseProps}
      myRole="listener"
      myUserId="lst-2"
      handRaised={false}
      micMuted
      onToggleHand={onToggleHand}
    />,
  );
  fireEvent.press(view.getByLabelText('Raise hand'));
  expect(onToggleHand).toHaveBeenCalled();
  expect(view.getByText("You're listening")).toBeTruthy();
  expect(view.queryByLabelText('End room')).toBeNull();
  // Mic control is disabled for subscribe-only listeners.
  const mic = view.getByLabelText('Unmute microphone');
  expect(mic.props.accessibilityState?.disabled).toBe(true);
});

test('listener with hand up sees Lower hand', async () => {
  const view = await render(
    <EventRoomScreen {...baseProps} myRole="listener" myUserId="lst-1" handRaised micMuted />,
  );
  expect(view.getByLabelText('Lower hand')).toBeTruthy();
});

test('speaker: no hand bar, mic enabled', async () => {
  const view = await render(
    <EventRoomScreen {...baseProps} myRole="speaker" myUserId="spk-1" handRaised={false} />,
  );
  expect(view.queryByLabelText('Raise hand')).toBeNull();
  const mic = view.getByLabelText('Mute microphone');
  expect(mic.props.accessibilityState?.disabled).toBe(false);
  fireEvent.press(mic);
  expect(baseProps.onToggleMute).toHaveBeenCalled();
});

test('non-moderator gets no moderation sheet on long-press', async () => {
  const alertSpy = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  try {
    const view = await render(
      <EventRoomScreen {...baseProps} myRole="listener" myUserId="lst-2" handRaised={false} micMuted />,
    );
    await act(async () => {}); // let the section list settle
    fireEvent(view.getByLabelText('Name spk-1, speaking'), 'longPress');
    expect(alertSpy).not.toHaveBeenCalled();
  } finally {
    alertSpy.mockRestore();
  }
});

// NOTE: kept last — the Alert-driven moderation flow corrupts later renders
// in this file under React 19 + RNTL scheduling.
test('host: speakers/listeners sections, hand indicator, End room + moderation sheet', async () => {
  const moderation = {
    promote: jest.fn(), demote: jest.fn(), mute: jest.fn(), remove: jest.fn(), endRoom: jest.fn(),
  };
  const alertSpy = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  try {
    const view = await render(
      <EventRoomScreen
        {...baseProps}
        myRole="host"
        myUserId="host-1"
        handRaised={false}
        moderation={moderation}
      />,
    );
    expect(view.getByText('Speakers')).toBeTruthy();
    expect(view.getByText('Listening · 2')).toBeTruthy();
    expect(view.getByLabelText('Name lst-1, hand raised')).toBeTruthy();
    expect(view.getByLabelText('End room')).toBeTruthy();

    // Long-press a listener → moderation sheet with promote/mute/remove.
    fireEvent(view.getByLabelText('Name lst-2'), 'longPress');
    expect(alertSpy).toHaveBeenCalled();
    const [title, , buttons] = alertSpy.mock.calls.at(-1)!;
    expect(title).toBe('Name lst-2');
    const labels = (buttons as any[]).map((b) => b.text);
    expect(labels).toEqual(['Invite to speak', 'Mute', 'Remove from room', 'Cancel']);
    (buttons as any[]).find((b) => b.text === 'Invite to speak').onPress();
    expect(moderation.promote).toHaveBeenCalledWith('lst-2');

    // Long-press a speaker → demote option.
    fireEvent(view.getByLabelText('Name spk-1, speaking'), 'longPress');
    const [, , spkButtons] = alertSpy.mock.calls.at(-1)!;
    (spkButtons as any[]).find((b) => b.text === 'Move to listeners').onPress();
    expect(moderation.demote).toHaveBeenCalledWith('spk-1');

    // End room goes through a confirm.
    fireEvent.press(view.getByLabelText('End room'));
    const [, , endButtons] = alertSpy.mock.calls.at(-1)!;
    (endButtons as any[]).find((b) => b.text === 'End room').onPress();
    expect(moderation.endRoom).toHaveBeenCalled();
    // Let pressability timers land inside this test (see card test note).
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  } finally {
    alertSpy.mockRestore();
  }
});
