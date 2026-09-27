/**
 * WatchFeedList — tap-to-play (census-media §34, F2: MEDIA_WATCH_TAP_TO_PLAY_ENABLED):
 * leaving the tab returns a started cell to "Tap to play", because with
 * autoplay off nothing resumes it on the way back; with the flag OFF the cell
 * does not listen at all, which is today.
 *
 * MEDIA_PAUSE_ALL is the event the Media tab emits on blur (app/(tabs)/media.tsx);
 * the real emitter is used. isActive is read through a prop-capturing stub.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

// NOTE: intentional stub — navigation context unavailable in Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (_cb: () => void) => {},
}));

// NOTE: intentional stub — insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: ({ children }: any) => <View>{children}</View> };
});

// NOTE: intentional stub — records each single-tap gesture's onEnd.
const mockSingleTaps: Array<() => void> = [];
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  class GestureClass {
    taps = 0;
    numberOfTaps = (n: number) => { this.taps = n; return this; };
    maxDuration = () => this; minDuration = () => this; minDistance = () => this;
    activeOffsetX = () => this; failOffsetY = () => this; requireExternalGestureToFail = () => this;
    runOnJS = () => this; onBegin = () => this; onChange = () => this; onStart = () => this; onFinalize = () => this;
    onEnd = (cb: () => void) => { if (this.taps === 1) mockSingleTaps.push(cb); return this; };
  }
  return {
    GestureDetector: ({ children }: any) => <View>{children}</View>,
    Gesture: {
      Tap: () => new GestureClass(),
      LongPress: () => new GestureClass(),
      Pan: () => new GestureClass(),
      Exclusive: (..._: any[]) => ({}),
      Simultaneous: (..._: any[]) => ({}),
    },
  };
});

// NOTE: intentional stub — captures isActive.
const mockIsActive: Record<string, boolean> = {};
jest.mock('../WatchVideoCell.tsx', () => {
  const { View } = require('react-native');
  return {
    WatchVideoCell: ({ id, isActive }: { id: string; isActive: boolean }) => {
      mockIsActive[id] = isActive;
      return <View />;
    },
  };
});

// NOTE: intentional stub — the overlay is not under test.
jest.mock('../WatchItemOverlay.tsx', () => ({
  WatchItemOverlay: () => null,
}));

// NOTE: exhaustive stub intentional — the manager's lifecycle is its own suite.
jest.mock('../../../hooks/useWatchPlayback', () => ({
  useWatchPlayback: () => ({ registerRef: jest.fn(), unregisterRef: jest.fn(), setActiveId: jest.fn() }),
}));

// NOTE: exhaustive stub intentional — each case sets the flag it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: false }),
}));

import { WatchFeedList } from '../WatchFeedList.tsx';
import { mediaEvents } from '../../../lib/mediaEvents.ts';
import type { MediaFeedItem } from '../../../types/media.ts';

function props(id: string) {
  const it: MediaFeedItem = {
    id, videoUrl: `https://example.com/${id}.mp4`, posterUrl: null, duration: null,
    creator: { id: 'c', displayName: 'Test', username: 'test', avatarUrl: null },
    caption: '', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
    likeCount: 0, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
  };
  return {
    items: [it], activeIndex: 0, currentUserId: undefined,
    onActiveIndexChange: jest.fn(), onEndReached: jest.fn(),
    onComment: jest.fn(), onSave: jest.fn(), onMore: jest.fn(), savedSet: {},
  };
}

describe('WatchFeedList — tap-to-play on leaving the tab', () => {
  it('OFF: the cell does not listen — leaving the tab changes nothing here, as today', async () => {
    mockFlags = {};
    await act(async () => { render(<WatchFeedList {...props('off-1')} />); });
    expect(mockIsActive['off-1']).toBe(true);
    await act(async () => { mediaEvents.emit('MEDIA_PAUSE_ALL'); });
    expect(mockIsActive['off-1']).toBe(true);
  });

  it('ON: a started cell returns to "Tap to play" when the tab is left', async () => {
    mockFlags = { MEDIA_WATCH_TAP_TO_PLAY_ENABLED: true };
    mockSingleTaps.length = 0;
    await act(async () => { render(<WatchFeedList {...props('on-1')} />); });
    await act(async () => { mockSingleTaps[mockSingleTaps.length - 1](); });
    expect(mockIsActive['on-1']).toBe(true);
    await act(async () => { mediaEvents.emit('MEDIA_PAUSE_ALL'); });
    expect(mockIsActive['on-1']).toBe(false);
  });
});
