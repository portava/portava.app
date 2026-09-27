/**
 * WatchFeedList — the autoplay half of the owner's surface decision F2 as a
 * flag (census-media §34): MEDIA_WATCH_TAP_TO_PLAY_ENABLED, seeded OFF (3342).
 *
 *   OFF — exactly today: the viewable cell plays at once, and the playback
 *         manager is asked to autoplay.
 *   ON  — the viewable cell waits paused under "Tap to play", the manager is
 *         told not to autoplay, and the single tap that pauses today is what
 *         starts it.
 *
 * The cell's `isActive` is read through a prop-capturing stub, which sees every
 * render even where this renderer stalls a visual commit
 * (.agents/memory/rntl-react19-renderer-budget.md rule 6). The query-only
 * cases run before the one tap.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

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

// NOTE: intentional stub — the gesture layer is replaced by one that records
// each single-tap gesture's onEnd, so the test can perform "the tap".
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

// NOTE: intentional stub — captures isActive, the prop the real cell plays on.
const mockIsActive: Record<string, boolean> = {};
jest.mock('../WatchVideoCell.tsx', () => {
  const { View } = require('react-native');
  return {
    WatchVideoCell: ({ id, isActive }: { id: string; isActive: boolean }) => {
      mockIsActive[id] = isActive;
      return <View testID={`cell-${id}`} />;
    },
  };
});

// NOTE: intentional stub — the overlay is not under test.
jest.mock('../WatchItemOverlay.tsx', () => ({
  WatchItemOverlay: () => null,
}));

// NOTE: exhaustive stub intentional — captures the options the list hands the
// playback manager; the real hook's focus/AppState lifecycle is its own suite.
let mockPlaybackOptions: unknown = 'not called';
jest.mock('../../../hooks/useWatchPlayback', () => ({
  useWatchPlayback: (opts: unknown) => {
    mockPlaybackOptions = opts;
    return { registerRef: jest.fn(), unregisterRef: jest.fn(), setActiveId: jest.fn() };
  },
}));

// NOTE: exhaustive stub intentional — each case sets the flag it is about.
let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => mockFlags[key] ?? false, loading: false }),
}));

import { WatchFeedList } from '../WatchFeedList.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';

function item(id: string): MediaFeedItem {
  return {
    id, videoUrl: `https://example.com/${id}.mp4`, posterUrl: null, duration: null,
    creator: { id: 'c', displayName: 'Test', username: 'test', avatarUrl: null },
    caption: '', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
    likeCount: 0, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
  };
}

function props(id: string) {
  return {
    items: [item(id)], activeIndex: 0, currentUserId: undefined,
    onActiveIndexChange: jest.fn(), onEndReached: jest.fn(),
    onComment: jest.fn(), onSave: jest.fn(), onMore: jest.fn(), savedSet: {},
  };
}

describe('WatchFeedList — tap-to-play flag', () => {
  it('OFF (the seed): the viewable cell plays at once, and the manager autoplays — today', async () => {
    mockFlags = {};
    await act(async () => { render(<WatchFeedList {...props('off-1')} />); });
    expect(mockIsActive['off-1']).toBe(true);
    expect(mockPlaybackOptions).toEqual({ autoplay: true });
    expect(screen.queryByTestId('watch-tap-to-play')).toBeNull();
  });

  it('ON: the viewable cell waits paused under "Tap to play", and the manager does not autoplay', async () => {
    mockFlags = { MEDIA_WATCH_TAP_TO_PLAY_ENABLED: true };
    await act(async () => { render(<WatchFeedList {...props('on-1')} />); });
    expect(mockIsActive['on-1']).toBe(false);
    expect(mockPlaybackOptions).toEqual({ autoplay: false });
    expect(screen.getByTestId('watch-tap-to-play')).toBeTruthy();
  });

  it('ON: the single tap starts it', async () => {
    mockFlags = { MEDIA_WATCH_TAP_TO_PLAY_ENABLED: true };
    mockSingleTaps.length = 0;
    await act(async () => { render(<WatchFeedList {...props('on-2')} />); });
    expect(mockIsActive['on-2']).toBe(false);
    const tap = mockSingleTaps[mockSingleTaps.length - 1];
    expect(typeof tap).toBe('function');
    await act(async () => { tap(); });
    expect(mockIsActive['on-2']).toBe(true);
  });
});
