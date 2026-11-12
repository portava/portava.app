import React from 'react';
import { AppState, Text } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { FullscreenPhoto } from '../FullscreenPhoto.tsx';
import { SharedVideoPlayer } from '../SharedVideoPlayer.tsx';

const mockPlayers: Array<{ props: any; pauseAsync: jest.Mock }> = [];
const mockPause = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-av', () => {
  // NOTE: the native decoder is the boundary under test; navigation/lifecycle
  // and the actual photo/video components remain mounted implementations.
  const React = require('react');
  const { View } = require('react-native');
  return { ResizeMode: { COVER: 'cover', CONTAIN: 'contain' }, Video: React.forwardRef((props: any, ref: any) => {
    const player = React.useMemo(() => {
      const value = { props, pauseAsync: mockPause, playAsync: jest.fn().mockResolvedValue(undefined),
        setStatusAsync: jest.fn().mockResolvedValue(undefined), setPositionAsync: jest.fn().mockResolvedValue(undefined) };
      mockPlayers.push(value); return value;
    }, []);
    player.props = props;
    React.useImperativeHandle(ref, () => player, [player]);
    return <View testID="activity-video" {...props} />;
  }) };
});

function navigator(initial = true) {
  let focused = initial;
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  const navigation = {
    isFocused: () => focused,
    addListener: (name: keyof typeof listeners, callback: () => void) => {
      listeners[name].add(callback); return () => { listeners[name].delete(callback); };
    },
  } as React.ContextType<typeof NavigationContext>;
  return { navigation, change(value: boolean) { focused = value; for (const listener of listeners[value ? 'focus' : 'blur']) listener(); }, listeners };
}
const photo = <FullscreenPhoto uri="https://example.com/original.jpg"><Text>Preview</Text></FullscreenPhoto>;
const video = <SharedVideoPlayer uri="https://example.com/video.mp4" autoplay />;
beforeEach(() => { mockPlayers.length = 0; mockPause.mockReset().mockResolvedValue(undefined); });
afterEach(() => { jest.restoreAllMocks(); });

it('dismisses a photo on route blur while its preview remains mounted, and does not reopen on focus', async () => {
  const nav = navigator();
  await render(<NavigationContext.Provider value={nav.navigation}>{photo}</NavigationContext.Provider>);
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(screen.getByTestId('fullscreen-photo-canvas')).toBeTruthy();
  await act(async () => nav.change(false));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  expect(screen.getByText('Preview')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  await act(async () => nav.change(true));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  expect(screen.getByTestId('fullscreen-photo-canvas')).toBeTruthy();
});

it('does not load a video or open a photo on an initially covered screen', async () => {
  const nav = navigator(false);
  await render(<NavigationContext.Provider value={nav.navigation}>{photo}{video}</NavigationContext.Provider>);
  expect(screen.queryByTestId('activity-video')).toBeNull();
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  await fireEvent.press(screen.getByLabelText('View video full screen'));
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
});

it('pauses and removes a fullscreen decoder on blur, rejects its late callbacks, and refocuses paused', async () => {
  const nav = navigator(); const onEnd = jest.fn();
  await render(<NavigationContext.Provider value={nav.navigation}><SharedVideoPlayer uri="https://example.com/video.mp4" autoplay onEnd={onEnd} /></NavigationContext.Provider>);
  await fireEvent.press(screen.getByLabelText('View video full screen'));
  const retired = mockPlayers[mockPlayers.length - 1];
  await act(async () => nav.change(false));
  expect(mockPause).toHaveBeenCalled();
  expect(screen.queryByTestId('activity-video')).toBeNull();
  expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
  await act(async () => nav.change(true));
  expect(screen.getByTestId('activity-video').props.shouldPlay).toBe(false);
  expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
  await act(async () => {
    retired.props.onPlaybackStatusUpdate({ isLoaded: false, error: 'Old player' });
    retired.props.onPlaybackStatusUpdate({ isLoaded: true, positionMillis: 9000, isPlaying: true, didJustFinish: true });
  });
  expect(screen.queryByText('Video unavailable')).toBeNull();
  expect(screen.getByTestId('activity-video').props.shouldPlay).toBe(false);
  expect(onEnd).not.toHaveBeenCalled();
});

it('cannot reopen fullscreen when an old native pause settles after a batched blur and refocus', async () => {
  const nav = navigator(); let resolvePause: (() => void) | undefined;
  mockPause.mockImplementationOnce(() => new Promise<void>(resolve => { resolvePause = resolve; }));
  await render(<NavigationContext.Provider value={nav.navigation}>{video}</NavigationContext.Provider>);
  await fireEvent.press(screen.getByLabelText('View video full screen'));
  await act(async () => { nav.change(false); nav.change(true); });
  await act(async () => { resolvePause?.(); });
  expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
  expect(screen.getByTestId('activity-video').props.shouldPlay).toBe(false);
});

it('background dismisses standalone media and foreground does not restore fullscreen or autoplay', async () => {
  const listeners = new Set<(state: string) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, callback: any) => {
    listeners.add(callback); return { remove: () => { listeners.delete(callback); } };
  });
  const ui = await render(<>{photo}{video}</>);
  await fireEvent.press(screen.getByLabelText('View photo full screen'));
  await fireEvent.press(screen.getByLabelText('View video full screen'));
  await act(async () => { for (const listener of listeners) listener('background'); });
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
  expect(screen.queryByTestId('activity-video')).toBeNull();
  expect(mockPause).toHaveBeenCalled();
  await act(async () => { for (const listener of listeners) listener('active'); });
  expect(screen.getByTestId('activity-video').props.shouldPlay).toBe(false);
  expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull();
  await ui.unmount();
  expect(listeners.size).toBe(0);
});
