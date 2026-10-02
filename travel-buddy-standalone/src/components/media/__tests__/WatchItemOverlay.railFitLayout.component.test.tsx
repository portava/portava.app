/**
 * WatchItemOverlay — on a short screen the rail's gaps shrink so it fits under
 * the header and the mode selector (census-media §40.11). One layout event, so
 * one file (.agents/memory/rntl-react19-renderer-budget.md).
 *
 * At a 667-px window with insets 0 the rail's budget is 667 − 172 (its bottom:
 * the FAB's top plus space.sm) − 156 (the header's 98, the selector's 4 + 46,
 * space.sm) = 339. The rail's natural height at space.xl gaps is 421 (the web
 * probe's number), so its content is 421 − 5 × 24 = 301 and it cannot keep
 * space.xl. After the layout event the rail's gap is the one that fits, and
 * the rail's top edge is at or below the header-and-selector line.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — a 375×667 window (the short screen under test).
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
}));

// NOTE: intentional exhaustive stub — only router.push is needed.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// NOTE: intentional stub — insets are 0 here (the web probe's case).
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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

import { WatchItemOverlay } from '../WatchItemOverlay.tsx';
import type { MediaFeedItem } from '../../../types/media.ts';
import { getOverlayHeaderTotalHeight } from '../../ui/AppHeader.tsx';
import { space } from '../../../theme/tokens.ts';

const WINDOW_H = 667;

it('667-px window, flag off: after the rail is measured its gap shrinks and its top clears the header and the selector', async () => {
  await render(
    <WatchItemOverlay
      item={{
        id: 'item-1', videoUrl: 'https://example.com/v.mp4', posterUrl: null, duration: null,
        creator: { id: 'c-1', displayName: 'Jane Doe', username: 'janedoe', avatarUrl: null, isFollowing: false },
        caption: 'Sunset', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
        likeCount: 10, commentCount: 23, saveCount: 31, likedByMe: false, savedByMe: false, stampItCount: 44,
      } as MediaFeedItem}
      currentUserId="viewer-1" isSaved={false} onComment={jest.fn()} onSave={jest.fn()} onMore={jest.fn()}
      stampGroupRef={React.createRef<View>()} stampVisualIsStamped={false} stampVisualCount={5}
      stampButtonStyle={{}} onStampPress={jest.fn()}
    />,
  );
  const before = StyleSheet.flatten(screen.getByTestId('watch-action-rail').props.style);
  expect(before.gap).toBe(space.xl);
  const natural = 421; // the probe's rail height at space.xl gaps, 5 gaps
  await act(async () => {
    fireEvent(screen.getByTestId('watch-action-rail'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 52, height: natural } } });
  });
  const after = StyleSheet.flatten(screen.getByTestId('watch-action-rail').props.style);
  const gap = after.gap as number;
  expect(gap).toBeLessThan(space.xl);
  expect(gap).toBeGreaterThanOrEqual(space.xs);
  const content = natural - 5 * space.xl;
  const railBottom = 120 + (after.marginBottom as number);
  const railTop = WINDOW_H - railBottom - (content + 5 * gap);
  expect(railTop).toBeGreaterThanOrEqual(getOverlayHeaderTotalHeight(0) + 4 + 46 + space.sm);
});
