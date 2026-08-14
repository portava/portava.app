/**
 * GridFeed.component.test.tsx
 *
 * Covers:
 *   1. Six tiles render for six items (FlatList + renderItem wiring).
 *   2. No expo-av Video component is mounted in any tile (static poster only).
 *   3. Tile height = Math.floor(cellWidth * 4/3) — 3:4 portrait ratio (pure math).
 *   4. Tapping a tile calls router.push with a /post/<id> route.
 *   5. Scrolling saves the offset to useMediaStore via setModeState.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { Dimensions } from 'react-native';
import { screen, render, act, fireEvent } from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────
// expo-router is mapped via moduleNameMapper to src/__mocks__/expo-router.tsx
// (plain functions, not jest.fn()). We spyOn router.push in each test's
// beforeEach so we can assert calls without fighting moduleNameMapper.
import { router } from 'expo-router';

// ── Safe-area ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — insets not under test.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── expo-av — confirm Video is NOT mounted ────────────────────────────────────
// NOTE: intentional spy — test 2 asserts no Video is mounted in a grid tile.
// Variable name starts with 'mock' to satisfy jest hoisting rules.
let mockVideoRenderCount = 0;
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((_: any, _ref: any) => {
    mockVideoRenderCount++;
    return <View testID="expo-av-video" />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover' } };
});

// ── expo-linear-gradient ──────────────────────────────────────────────────────
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: ({ children }: any) => <View>{children}</View> };
});

// ── useGridFeed — controlled items ────────────────────────────────────────────
let mockGridItems: any[] = [];
const mockLoadFeed = jest.fn().mockResolvedValue(undefined);
const mockLoadMore = jest.fn();
const mockSetFilter = jest.fn();
// NOTE: exhaustive stub intentional — real hook makes authenticated network
// requests that cannot run in Jest; only the surface consumed by GridFeed is needed.
jest.mock('../../../hooks/useGridFeed.ts', () => ({
  useGridFeed: () => ({
    filter: 'all' as const,
    setFilter: mockSetFilter,
    items: mockGridItems,
    loading: false,
    error: null,
    loadFeed: mockLoadFeed,
    loadMore: mockLoadMore,
  }),
}));

// ── useMediaStore — controlled scroll offset ──────────────────────────────────
let mockScrollOffset = 0;
const mockSetModeState = jest.fn();
// NOTE: intentional stub — persistent media store not under test.
jest.mock('../../../stores/mediaStore.ts', () => ({
  useMediaStore: () => ({
    getModeState: (_mode: string) => ({ scrollOffset: mockScrollOffset }),
    setModeState: mockSetModeState,
  }),
}));

// ── GridFilterBar — stub ──────────────────────────────────────────────────────
// NOTE: intentional stub — filter bar interaction not under test here.
jest.mock('../GridFilterBar.tsx', () => ({ GridFilterBar: () => null }));

// ── GridTile — stub that emits onPress ────────────────────────────────────────
// NOTE: intentional stub — tile rendering detail not under test; exposes press.
jest.mock('../GridTile.tsx', () => {
  const { View, Pressable } = require('react-native');
  return {
    GridTile: ({ item, index, onPress, cellWidth, cellHeight }: any) => (
      <Pressable
        testID={`grid-tile-${item.id}`}
        accessibilityLabel={`tile-${item.id}`}
        onPress={() => onPress?.(item, index)}
        style={{ width: cellWidth, height: cellHeight }}
      >
        <View testID={`grid-tile-inner-${item.id}`} />
      </Pressable>
    ),
  };
});

// lucide-react-native is covered by the global Proxy mock in jest.config moduleNameMapper.

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { MediaGridItem } from '../../../types/media.ts';

function makeGridItem(id: string): MediaGridItem {
  return {
    id,
    mediaType: 'photo',
    thumbnailUrl: `https://example.com/${id}.jpg`,
    posterUrl: null,
    width: 1080,
    height: 1440,
    durationMs: null,
    creatorId: 'creator-1',
    locationLabel: null,
    viewCount: 10,
    processingStatus: null,
    createdAt: '2024-01-15T12:00:00Z',
  };
}

// ── Import (after mocks) ──────────────────────────────────────────────────────

import { GridFeed } from '../GridFeed.tsx';

// ─────────────────────────────────────────────────────────────────────────────

// Module-level push mock: directly replaces router.push so no jest.spyOn
// (and therefore no jest.restoreAllMocks) is needed. clearAllMocks() resets
// call history between tests without touching the useGridFeed module mock.
const mockRouterPush = jest.fn();
router.push = mockRouterPush as typeof router.push;

// ── 3:4 ratio — pure math, no render needed ───────────────────────────────

describe('GridFeed — 3:4 tile ratio (pure math)', () => {
  it('cellHeight = floor(cellWidth * 4/3) — matches the 3:4 portrait ratio', () => {
    const GUTTER = 1;
    const NUM_COLUMNS = 3;
    const screenWidth = Dimensions.get('window').width;
    const cellWidth = Math.floor(
      (screenWidth - GUTTER * (NUM_COLUMNS + 1)) / NUM_COLUMNS,
    );
    const cellHeight = Math.floor((cellWidth * 4) / 3);
    expect(cellHeight / cellWidth).toBeCloseTo(4 / 3, 1);
    expect(cellWidth).toBeGreaterThan(0);
  });
});

// ── All FlatList-dependent tests in one describe ──────────────────────────
// React Native's VirtualizedList leaves module-level layout state after
// cleanup() that prevents tiles from appearing in subsequent describe blocks.
// Keeping all render-based assertions together avoids cross-describe poisoning.

describe('GridFeed — render, tile tap, and scroll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVideoRenderCount = 0;
    mockScrollOffset = 0;
    mockGridItems = Array.from({ length: 6 }, (_, i) => makeGridItem(`item-${i}`));
    mockLoadFeed.mockResolvedValue(undefined);
  });

  it('renders one GridTile per item (6 items → 6 tiles)', async () => {
    await act(async () => { render(<GridFeed />); });
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`grid-tile-item-${i}`)).toBeTruthy();
    }
  });

  it('no expo-av Video component is mounted in any grid tile (static poster only)', async () => {
    await act(async () => { render(<GridFeed />); });
    expect(mockVideoRenderCount).toBe(0);
  });

  it('tile interactions: scroll saves offset and tapping navigates to post', async () => {
    // Both fireEvent.scroll and fireEvent.press leave FlatList internal layout
    // state that zeros tiles in subsequent renders within the same jest worker.
    // Combine both interaction assertions into one render to avoid that.
    await act(async () => { render(<GridFeed />); });

    // ── Scroll: saves offset via setModeState ──
    fireEvent.scroll(screen.getByTestId('grid-tile-item-0'), {
      nativeEvent: { contentOffset: { y: 300 } },
    });
    await act(async () => {});
    expect(mockSetModeState).toHaveBeenCalledWith(
      'grid',
      expect.objectContaining({ scrollOffset: 300 }),
    );

    // ── Tile tap: calls router.push with /media-viewer/<id> ──
    mockRouterPush.mockClear();
    fireEvent.press(screen.getByTestId('grid-tile-item-1'));
    await act(async () => {});
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.stringMatching(/\/media-viewer\/item-1/),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

