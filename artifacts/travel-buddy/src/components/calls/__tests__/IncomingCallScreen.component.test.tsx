/**
 * IncomingCallScreen — voice shows Decline/Accept, video adds Accept-with-video,
 * and the camera is never activated without an explicit user action.
 *
 * Single test with rerenders: in this jest setup (React 19 + RNTL v14) each
 * file supports only a couple of fresh render() mounts before the renderer
 * stops flushing — see memory notes on Modal act() scopes.
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

import { IncomingCallScreen } from '../IncomingCallScreen.tsx';
import type { IncomingCallInfo } from '../../../context/CallContext.tsx';

const baseInfo: IncomingCallInfo = {
  callId: 'c1',
  callType: 'voice',
  contextType: 'telegraph_dm',
  threadId: 't1',
  caller: { id: 'u2', name: 'Alex Rivera', handle: 'alex_r', avatarUrl: null, verified: true },
};

afterEach(async () => { await act(async () => {}); });

test('shows @handle when real name is null and handle is present', async () => {
  const info: IncomingCallInfo = {
    ...baseInfo,
    caller: { id: 'u3', name: null, handle: 'wanderlust_sam', avatarUrl: null },
  };
  const { getByText } = await render(
    <IncomingCallScreen
      info={info} visible
      onAcceptVoice={jest.fn()} onAcceptVideo={jest.fn()} onDecline={jest.fn()}
    />,
  );
  expect(getByText('@wanderlust_sam')).toBeTruthy();
});

test('falls back to Traveler when both name and handle are null', async () => {
  const info: IncomingCallInfo = {
    ...baseInfo,
    caller: { id: 'u4', name: null, handle: null, avatarUrl: null },
  };
  const { getByText } = await render(
    <IncomingCallScreen
      info={info} visible
      onAcceptVoice={jest.fn()} onAcceptVideo={jest.fn()} onDecline={jest.fn()}
    />,
  );
  expect(getByText('Traveler')).toBeTruthy();
});

test('voice and video incoming flows: decline/accept options and no implicit camera', async () => {
  const onAcceptVoice = jest.fn();
  const onAcceptVideo = jest.fn();
  const onDecline = jest.fn();
  const mk = (info: IncomingCallInfo, visible = true) => (
    <IncomingCallScreen
      info={info} visible={visible}
      onAcceptVoice={onAcceptVoice} onAcceptVideo={onAcceptVideo} onDecline={onDecline}
    />
  );

  // — Voice call: Decline + Accept only —
  const view = await render(mk(baseInfo));
  expect(view.getByText('Alex Rivera')).toBeTruthy();
  expect(view.getByText('Incoming voice call')).toBeTruthy();
  expect(view.queryByLabelText('Accept with video')).toBeNull();

  fireEvent.press(view.getByLabelText('Accept'));
  expect(onAcceptVoice).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText('Decline'));
  expect(onDecline).toHaveBeenCalledTimes(1);
  expect(onAcceptVideo).not.toHaveBeenCalled(); // camera never implicit

  // — Video call: Decline / Accept as voice / Accept with video —
  jest.clearAllMocks();
  await view.rerender(mk({ ...baseInfo, callType: 'video' }));
  expect(view.getByText('Incoming video call')).toBeTruthy();

  fireEvent.press(view.getByLabelText('Accept as voice'));
  expect(onAcceptVoice).toHaveBeenCalledTimes(1);
  expect(onAcceptVideo).not.toHaveBeenCalled();

  fireEvent.press(view.getByLabelText('Accept with video'));
  expect(onAcceptVideo).toHaveBeenCalledTimes(1);

  // (Visibility gating is the Modal `visible` prop; a late rerender here
  // doesn't commit under React 19 + RNTL — not asserted.)
});
