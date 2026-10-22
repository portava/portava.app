/**
 * WatchItemOverlay — the per-video Create button sits BELOW the Media tab's overlay header, where it can be pressed.
 *
 * It was at `insets.top + 12` — 74–104pt on the owner's iPhone 17 Pro Max (insets.top 62) — inside the overlay header's
 * bar (62–106pt, zIndex 20), which took every tap: the button could be seen and never pressed. It now sits at the
 * header's bottom (getOverlayHeaderTotalHeight) + space.md: 118pt, level with the mode selector's row (header + 4,
 * 46 tall) at the right edge, above the action rail's top line (header + 4 + 46 + space.sm).
 *
 * Run with:  pnpm test:component
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — the owner's iPhone 17 Pro Max insets.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — no layover session.
jest.mock('../../../context/LayoverSessionContext.tsx', () => ({
  useLayoverSessionContext: () => ({ session: null }),
}));

jest.mock('expo-linear-gradient', () => {
  const { View: V } = require('react-native');
  return { LinearGradient: ({ children, ...rest }: any) => <V {...rest}>{children}</V> };
});

// NOTE: intentional stub — follow network/auth is not under test.
jest.mock('../../../hooks/useFollow', () => ({
  useFollow: () => ({ isFollowing: false, loading: false, toggling: false, followsYou: false, followersCount: 0, followingCount: 0, toggle: jest.fn() }),
}));

import { router } from 'expo-router';
import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';
import { getOverlayHeaderTotalHeight } from '../../ui/AppHeader.tsx';

const ITEM = {
  id: 'item-1', videoUrl: 'https://example.com/v.mp4', posterUrl: null, duration: null,
  creator: { id: 'c-1', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
  caption: 'Sunset', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
  likeCount: 10, commentCount: 23, saveCount: 31, likedByMe: false, savedByMe: false, stampItCount: 44,
} as unknown as MediaFeedItem;

it('the Create button starts below the overlay header (insets.top 62) and opens the composer', async () => {
  await render(
    <WatchItemOverlay
      item={ITEM}
      currentUserId="viewer-1" isSaved={false} onComment={jest.fn()} onSave={jest.fn()} onMore={jest.fn()}
      stampGroupRef={React.createRef<View>()} stampVisualIsStamped={false} stampVisualCount={5}
      stampButtonStyle={{}} onStampPress={jest.fn()}
    />,
  );
  const btn = screen.getByLabelText('Create a post');
  const top = StyleSheet.flatten(btn.props.style).top as number;
  const headerBottom = getOverlayHeaderTotalHeight(62); // 106
  expect(top).toBeGreaterThanOrEqual(headerBottom);
  // ...and above the line the action rail is held under (the mode selector's row: header + 4, 46 tall, + space.sm).
  expect(top).toBeLessThan(headerBottom + 4 + 46);

  await fireEvent.press(btn);
  expect(router.push).toHaveBeenCalledWith('/create');
});
