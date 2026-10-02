/**
 * WatchItemOverlay — context-first overlay (census-media §34, F2): when the
 * place's perspectives open through the §14 entry context, the place screen is
 * NOT pushed on top of them. One press (renderer budget).
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
import type { MediaFeedItem } from '../../../types/media.ts';

describe('WatchItemOverlay — context-first place, opened', () => {
  it('opens the place perspectives and pushes nothing else', async () => {
    mockOpenPlace.mockResolvedValue(true);
    const item = {
      id: 'item-7', videoUrl: 'https://example.com/v.mp4', posterUrl: null, duration: null,
      creator: { id: 'c', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
      caption: 'x', hashtags: [], place: { id: 'place-xyz', name: 'My Khe', city: 'Da Nang', country: 'Vietnam' },
      linkedEntity: null, audioLabel: null, likeCount: 0, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
    } as MediaFeedItem;
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
    fireEvent.press(screen.getByLabelText("See My Khe's perspectives"));
    await act(async () => { await Promise.resolve(); });
    expect(mockOpenPlace).toHaveBeenCalledWith('place-xyz', { id: 'item-7' });
    expect(router.push as jest.Mock).not.toHaveBeenCalled();
  });
});
