import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render } from '@testing-library/react-native';
import type { MediaFeedItem } from '../../../types/media.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useFocusEffect: () => {},
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockTapToPlay = false;
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({
    isEnabled: (key: string) => key === 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' && mockTapToPlay,
    loading: false,
  }),
}));

type GestureCallbacks = { start: () => void; end: () => void; finalize: () => void };
let mockSingleTap: () => void;
let mockHold: GestureCallbacks;
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  class GestureClass {
    taps = 0;
    callbacks = { start: () => {}, end: () => {}, finalize: () => {} };
    numberOfTaps = (count: number) => { this.taps = count; return this; };
    maxDuration = () => this;
    minDuration = () => this;
    minDistance = () => this;
    activeOffsetX = () => this;
    failOffsetY = () => this;
    requireExternalGestureToFail = () => this;
    runOnJS = () => this;
    onBegin = () => this;
    onChange = () => this;
    onStart = (handler: () => void) => { this.callbacks.start = handler; return this; };
    onEnd = (handler: () => void) => {
      this.callbacks.end = handler;
      if (this.taps === 1) mockSingleTap = handler;
      return this;
    };
    onFinalize = (handler: () => void) => { this.callbacks.finalize = handler; return this; };
  }
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    Gesture: {
      Tap: () => new GestureClass(),
      LongPress: () => {
        const gesture = new GestureClass();
        mockHold = gesture.callbacks;
        return gesture;
      },
      Pan: () => new GestureClass(),
      Exclusive: () => ({}),
    },
  };
});

const mockVideoStates: boolean[] = [];
const mockPlayer = {
  playAsync: jest.fn().mockResolvedValue(undefined),
  pauseAsync: jest.fn().mockResolvedValue(undefined),
  setPositionAsync: jest.fn().mockResolvedValue(undefined),
};
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef(({ shouldPlay }: { shouldPlay: boolean }, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => mockPlayer, []);
    mockVideoStates.push(shouldPlay);
    return <View testID="policy-video" />;
  });
  Video.displayName = 'PolicyVideo';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain', STRETCH: 'stretch' } };
});

jest.mock('../WatchItemOverlay.tsx', () => ({
  ...jest.requireActual('../WatchItemOverlay.tsx'),
  WatchItemOverlay: () => null,
}));

let mockDismiss: () => void;
jest.mock('../WatchRadialMenu.tsx', () => ({
  ...jest.requireActual('../WatchRadialMenu.tsx'),
  WatchRadialMenu: ({ onDismiss }: { onDismiss: () => void }) => {
    mockDismiss = onDismiss;
    return null;
  },
}));

import { WatchFeedList } from '../WatchFeedList.tsx';
import { mediaEvents } from '../../../lib/mediaEvents.ts';

const item: MediaFeedItem = {
  id: 'policy-cell', videoUrl: 'https://example.com/policy.mp4', posterUrl: null, duration: null,
  creator: { id: 'creator', displayName: 'Test', username: 'test', avatarUrl: null },
  caption: '', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
  likeCount: 0, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
};
const feedProps = {
  items: [item], activeIndex: 0, savedSet: {},
  onActiveIndexChange: jest.fn(), onEndReached: jest.fn(),
  onComment: jest.fn(), onSave: jest.fn(), onMore: jest.fn(),
};
let mockAppStateListeners: Set<(state: AppStateStatus) => void>;

beforeEach(() => {
  mockTapToPlay = false;
  mockVideoStates.length = 0;
  jest.clearAllMocks();
  mockAppStateListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateListeners.add(listener);
    return { remove: () => { mockAppStateListeners.delete(listener); } };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function expectPlaying(expected: boolean) {
  expect(mockVideoStates.length).toBeGreaterThan(0);
  expect(mockVideoStates[mockVideoStates.length - 1]).toBe(expected);
}

async function appState(state: AppStateStatus) {
  await act(async () => { mockAppStateListeners.forEach((listener) => listener(state)); });
}

describe('WatchFeedList mounted playback policy', () => {
  it('OFF → ON stops the mounted active player before another playing render and permits an explicit tap', async () => {
    const view = await render(<WatchFeedList {...feedProps} />);
    expectPlaying(true);
    expect(mockPlayer.playAsync).toHaveBeenCalled();
    mockVideoStates.length = 0;
    mockPlayer.pauseAsync.mockClear();
    mockTapToPlay = true;
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(false);
    expect(mockVideoStates).not.toContain(true);
    expect(mockPlayer.pauseAsync).toHaveBeenCalled();
    expect(view.getByTestId('watch-tap-to-play')).toBeTruthy();
    await act(async () => { mockSingleTap(); });
    expectPlaying(true);
    await view.rerender(<WatchFeedList {...feedProps} currentUserId="viewer" />);
    expectPlaying(true);
  });

  it.each(['end', 'finalize', 'dismiss'] as const)('a pending OFF hold cannot restore autoplay through stale %s after ON', async (completion) => {
    const view = await render(<WatchFeedList {...feedProps} />);
    const pendingHold = mockHold;
    const pendingDismiss = mockDismiss;
    await act(async () => { pendingHold.start(); });
    expectPlaying(false);
    mockTapToPlay = true;
    await view.rerender(<WatchFeedList {...feedProps} />);
    mockPlayer.playAsync.mockClear();
    await act(async () => { completion === 'dismiss' ? pendingDismiss() : pendingHold[completion](); });
    expectPlaying(false);
    expect(mockPlayer.playAsync).not.toHaveBeenCalled();
    await act(async () => { mockSingleTap(); });
    expectPlaying(true);
  });

  it('an OFF gesture starting late after ON snapshots the current paused state', async () => {
    const view = await render(<WatchFeedList {...feedProps} />);
    const pendingHold = mockHold;
    mockTapToPlay = true;
    await view.rerender(<WatchFeedList {...feedProps} />);
    await act(async () => { pendingHold.start(); });
    await act(async () => { pendingHold.end(); pendingHold.finalize(); });
    expectPlaying(false);
  });

  it('ON hold restores an explicitly started video, but never undoes a later pause or a failed hold', async () => {
    mockTapToPlay = true;
    await render(<WatchFeedList {...feedProps} />);
    await act(async () => { mockSingleTap(); });
    expectPlaying(true);
    await act(async () => { mockHold.finalize(); });
    expectPlaying(true);
    const held = mockHold;
    await act(async () => { held.start(); });
    expectPlaying(false);
    await act(async () => { held.end(); });
    expectPlaying(true);
    await act(async () => { mockSingleTap(); });
    expectPlaying(false);
    await act(async () => { held.finalize(); mockDismiss(); });
    expectPlaying(false);
  });

  it('OFF keeps autoplay, manual pause/toggle, hold restoration and scroll behavior', async () => {
    const view = await render(<WatchFeedList {...feedProps} />);
    expectPlaying(true);
    await act(async () => { mockSingleTap(); });
    expectPlaying(false);
    const held = mockHold;
    await act(async () => { held.start(); held.end(); held.finalize(); mockDismiss(); });
    expectPlaying(true);
    await view.rerender(<WatchFeedList {...feedProps} activeIndex={-1} />);
    expectPlaying(false);
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(true);
  });

  it('an inactive cell receiving ON stays paused when scrolled back into view', async () => {
    const view = await render(<WatchFeedList {...feedProps} activeIndex={-1} />);
    mockTapToPlay = true;
    await view.rerender(<WatchFeedList {...feedProps} activeIndex={-1} />);
    await act(async () => { mockSingleTap(); });
    expectPlaying(false);
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(false);
    await act(async () => { mockSingleTap(); });
    expectPlaying(true);
    const held = mockHold;
    await act(async () => { held.start(); });
    await view.rerender(<WatchFeedList {...feedProps} activeIndex={-1} />);
    await act(async () => { held.end(); held.finalize(); });
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(false);
  });

  it.each(['background', 'inactive', 'blur'] as const)('ON %s invalidates pending hold restoration and requires a new tap', async (leave) => {
    mockTapToPlay = true;
    await render(<WatchFeedList {...feedProps} />);
    await act(async () => { mockSingleTap(); });
    const held = mockHold;
    const pendingDismiss = mockDismiss;
    await act(async () => { held.start(); });
    if (leave === 'blur') await act(async () => { mediaEvents.emit('MEDIA_PAUSE_ALL'); });
    else await appState(leave);
    await act(async () => { held.end(); held.finalize(); pendingDismiss(); });
    await appState('active');
    expectPlaying(false);
    await act(async () => { mockSingleTap(); });
    expectPlaying(true);
  });

  it('a second rising policy cancels earlier tap permission without resetting ordinary ON rerenders', async () => {
    mockTapToPlay = true;
    const view = await render(<WatchFeedList {...feedProps} />);
    await act(async () => { mockSingleTap(); });
    await view.rerender(<WatchFeedList {...feedProps} currentUserId="viewer" />);
    expectPlaying(true);
    mockTapToPlay = false;
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(true);
    mockTapToPlay = true;
    await view.rerender(<WatchFeedList {...feedProps} />);
    expectPlaying(false);
  });
});
