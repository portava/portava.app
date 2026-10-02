/**
 * WatchItemOverlay — the two controls the context-first overlay adds
 * (census-media §34, F2: MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED), pressed.
 *
 *   Ask Compass → Compass with this media's id and the §15 rail's prompt (§32).
 *   The place   → that place's perspectives through the §14 entry context,
 *                 opened on THIS perspective; the place screen when the place
 *                 has nothing to stage.
 *
 * Two presses, and the only flush comes after the last one: this renderer's
 * per-file press budget (.agents/memory/rntl-react19-renderer-budget.md). The
 * "opened, so no fallback" case is WatchItemOverlay.contextPlaceOpened.
 */
import React from 'react';
import { View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — insets are not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => {
  const { View: V } = require('react-native');
  return { LinearGradient: ({ children, ...rest }: any) => <V {...rest}>{children}</V> };
});

// NOTE: intentional stub — follow network/auth is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, loading: false, toggling: false, followsYou: false, followersCount: 0, followingCount: 0, toggle: jest.fn() }),
}));

// NOTE: exhaustive stub intentional — the context-first overlay is ON here.
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (key: string) => key === 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED', loading: false }),
}));

const mockOpenPlace = jest.fn();
jest.mock('../../../features/media/services/perspectiveOpeners.ts', () => ({
  ...jest.requireActual('../../../features/media/services/perspectiveOpeners.ts'),
  openPlaceByIdPerspectives: (...a: unknown[]) => mockOpenPlace(...a),
}));

import { router } from 'expo-router';
import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import { ASK_COMPASS_DEFAULT_PROMPT } from '../../../features/media/services/mediaActions.ts';
import type { MediaFeedItem } from '../../../types/media.ts';

const pushMock = router.push as jest.Mock;

const item = {
  id: 'item-9',
  videoUrl: 'https://example.com/v.mp4',
  posterUrl: null,
  duration: null,
  creator: { id: 'c', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
  caption: 'x',
  hashtags: [],
  place: { id: 'place-abc', name: 'An Thuong', city: 'Da Nang', country: 'Vietnam' },
  linkedEntity: null,
  audioLabel: null,
  likeCount: 0,
  commentCount: 0,
  saveCount: 0,
  likedByMe: false,
  savedByMe: false,
} as MediaFeedItem;

describe('WatchItemOverlay — context-first controls, pressed', () => {
  it('Ask Compass hands the media to Compass; the place opens its perspectives, else the place screen', async () => {
    mockOpenPlace.mockResolvedValue(false); // the place has nothing to stage → fallback
    await render(
      <WatchItemOverlay
        item={item}
        currentUserId="viewer-1"
        isSaved={false}
        onComment={jest.fn()}
        onSave={jest.fn()}
        onMore={jest.fn()}
        stampGroupRef={React.createRef<View>()}
        stampVisualIsStamped={false}
        stampVisualCount={0}
        stampButtonStyle={undefined}
        onStampPress={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByLabelText('Ask Compass about this'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/(tabs)/ai',
      params: { mediaId: 'item-9', prefillMessage: ASK_COMPASS_DEFAULT_PROMPT },
    });

    pushMock.mockClear();
    fireEvent.press(screen.getByLabelText("See An Thuong's perspectives"));
    expect(mockOpenPlace).toHaveBeenCalledTimes(1);
    expect(mockOpenPlace.mock.calls[0][0]).toBe('place-abc');
    expect(mockOpenPlace.mock.calls[0][1]).toEqual({ id: 'item-9' });

    await act(async () => { await Promise.resolve(); });
    expect(pushMock).toHaveBeenCalledWith('/place/place-abc');
  });
});
