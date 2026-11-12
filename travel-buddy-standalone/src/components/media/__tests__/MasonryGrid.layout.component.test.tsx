/**
 * MasonryGrid — the Roam tab's Grid fits the space it is given and its last
 * row ends above the floating tab bar.
 *
 * Pinned here:
 *   1. Column width follows the grid's own laid-out width (onLayout), not the
 *      window. On a tablet or the web the tabs sit beside a 220 px sidebar in
 *      a content column capped at 720 px, so window-width columns ran past
 *      the right edge and the second column was cut off. Before the first
 *      layout the window width stands in (exact on a phone).
 *   2. The scroll content's paddingBottom is useLayoverAwareBottomInset(), the
 *      same clearance the Roam tab's FAB uses: it was a flat 24 px, so the
 *      last row stayed under the tab pill (64 tall, 12 above insets.bottom).
 *   3. The loading skeleton uses the grid's own gutter and column width, so
 *      the real tiles land where the placeholders were.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentional exhaustive stub — each case sets the insets it is about.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentional exhaustive stub — the layover session is the other input
// of useLayoverAwareBottomInset; each case sets it.
let mockLayoverSession: object | null = null;
jest.mock('../../../context/LayoverSessionContext.tsx', () => ({
  useLayoverSessionContext: () => ({ session: mockLayoverSession }),
}));

// NOTE: intentional exhaustive stub — tile rendering is covered by the
// GridTile suites; here only the size the grid hands each tile matters.
jest.mock('../GridTile.tsx', () => {
  const { View } = require('react-native');
  return {
    GridTile: ({ item, cellWidth, cellHeight }: any) => (
      <View testID={`tile-${item.id}`} style={{ width: cellWidth, height: cellHeight }} />
    ),
  };
});

import { MasonryGrid, MasonryGridSkeleton } from '../MasonryGrid.tsx';
import { NAV_BAR_FILLER_HEIGHT } from '../../../hooks/useNavBarCollapse.ts';
import { LAYOVER_PILL_BOTTOM_OFFSET, LAYOVER_PILL_HEIGHT } from '../../layover/layoverPillGeometry.ts';
import type { MediaGridItem } from '../../../types/media.ts';

const GUTTER = 2;

function item(id: string, width: number | null = 1080, height: number | null = 1350): MediaGridItem {
  return {
    id, mediaType: 'image', thumbnailUrl: `https://example.com/${id}.jpg`, posterUrl: null,
    width, height, durationMs: null, contentType: null, creatorId: 'c-1',
    locationLabel: null, placeId: null, viewCount: 0, qualifiedViewCount: 0,
    processingStatus: null, videoUrl: null,
  };
}

const ITEMS = [item('a'), item('b'), item('c', 1600, 900), item('d', null, null)];

async function renderGrid() {
  await render(
    <MasonryGrid
      items={ITEMS}
      loading={false}
      refreshing={false}
      onRefresh={() => {}}
      onLoadMore={() => {}}
      onTilePress={() => {}}
    />,
  );
}

function tileWidth(id: string): number {
  return StyleSheet.flatten(screen.getByTestId(`tile-${id}`).props.style).width;
}

function scrollView() {
  return screen.getByTestId('masonry-grid-scroll');
}

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockLayoverSession = null;
});

describe('MasonryGrid — column width', () => {
  it('uses the window width until the grid is laid out (a phone)', async () => {
    await renderGrid();
    const windowWidth = Dimensions.get('window').width;
    expect(tileWidth('a')).toBe(Math.floor((windowWidth - GUTTER * 3) / 2));
  });

  it.each([
    ['a desktop content column', 720],
    ['an iPad portrait content column (834 - 220 sidebar)', 614],
    ['an iPhone SE / mini', 375],
    ['an iPhone 13–16', 390],
    ['an iPhone 16 Pro', 402],
    ['an iPhone 16 Plus / Pro Max', 430],
    ['an iPhone 17 Pro Max', 440],
  ])('fits two columns and three gutters inside %s (%i px)', async (_label, width) => {
    await renderGrid();
    await act(async () => {
      fireEvent(scrollView(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } });
    });
    const col = tileWidth('a');
    expect(col).toBe(Math.floor((width - GUTTER * 3) / 2));
    expect(col * 2 + GUTTER * 3).toBeLessThanOrEqual(width);
    expect(tileWidth('b')).toBe(col);
  });
});

describe('MasonryGrid — bottom clearance', () => {
  it.each([0, 34, 48])('ends the content above the tab pill (insets.bottom %i)', async (bottom) => {
    mockInsets = { top: 0, bottom, left: 0, right: 0 };
    await renderGrid();
    const content = StyleSheet.flatten(scrollView().props.contentContainerStyle);
    expect(content.paddingBottom).toBe(NAV_BAR_FILLER_HEIGHT + 13 + bottom);
    // Native Jest fixture uses fontScale=2: the tab label adds 13pt to its base height.
    expect(content.paddingBottom).toBeGreaterThanOrEqual(bottom + 12 + 64);
  });

  it('clears the layover pill too while a layover session shows it', async () => {
    mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
    mockLayoverSession = { id: 'layover-1' };
    await renderGrid();
    const content = StyleSheet.flatten(scrollView().props.contentContainerStyle);
    expect(content.paddingBottom).toBeGreaterThanOrEqual(34 + LAYOVER_PILL_BOTTOM_OFFSET + LAYOVER_PILL_HEIGHT);
  });
});

describe('MasonryGridSkeleton — same geometry as the grid', () => {
  it('draws two gutter-separated columns at the grid column width', async () => {
    await render(<MasonryGridSkeleton />);
    const skeleton = screen.getByTestId('masonry-grid-skeleton');
    await act(async () => {
      fireEvent(skeleton, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 440, height: 800 } } });
    });
    const style = StyleSheet.flatten(screen.getByTestId('masonry-grid-skeleton').props.style);
    expect(style.paddingHorizontal).toBe(GUTTER);
    const expectedCol = Math.floor((440 - GUTTER * 3) / 2);
    const columns = screen.getByTestId('masonry-grid-skeleton').children[0] as any;
    const colWidths = columns.props.children.map((c: any) => StyleSheet.flatten(c.props.style).width);
    expect(colWidths).toEqual([expectedCol, expectedCol]);
  });
});
