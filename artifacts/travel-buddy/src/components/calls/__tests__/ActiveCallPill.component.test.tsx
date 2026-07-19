/**
 * ActiveCallPill — minimized-call bar: label + timer, mute shortcut,
 * end call, tap-to-restore, and reconnecting state.
 *
 * Single test with rerenders — see IncomingCallScreen test header for why.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { ActiveCallPill } from '../ActiveCallPill.tsx';

afterEach(async () => { await act(async () => {}); });

test('label, timer, restore / mute / end wiring, and reconnecting state', async () => {
  const onPress = jest.fn();
  const onToggleMute = jest.fn();
  const onHangUp = jest.fn();
  const view = await render(
    <ActiveCallPill
      label="Call with Alex" elapsedSec={263} micMuted={false}
      onPress={onPress} onToggleMute={onToggleMute} onHangUp={onHangUp}
    />,
  );
  expect(view.getByText('Call with Alex')).toBeTruthy();
  expect(view.getByText('04:23')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Mute'));
  expect(onToggleMute).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('End call'));
  expect(onHangUp).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Return to call. Call with Alex'));
  expect(onPress).toHaveBeenCalledTimes(1);

  // — Reconnecting replaces the timer; muted state flips the shortcut label —
  await view.rerender(
    <ActiveCallPill
      label="Call with Alex" elapsedSec={30} micMuted reconnecting
      onPress={onPress} onToggleMute={onToggleMute} onHangUp={onHangUp}
    />,
  );
  expect(view.getByText('Reconnecting…')).toBeTruthy();
  expect(view.queryByText('00:30')).toBeNull();
  expect(view.getByLabelText('Unmute')).toBeTruthy();
});
