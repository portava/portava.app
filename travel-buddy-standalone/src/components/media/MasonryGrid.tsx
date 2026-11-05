/**
 * MasonryGrid — responsive 2-column masonry grid for the Grid feed.
 *
 * Uses a ScrollView with two column Views.  Items are distributed using the
 * "shortest column next" algorithm so the columns stay balanced.
 * Each tile's height is derived from the item's natural aspect ratio
 * (clamped to [90, 340] px so extreme panoramas or tall portraits don't
 * distort the layout).  Falls back to a 4:5 ratio when dimensions are null.
 *
 * Pull-to-refresh: standard RefreshControl on the ScrollView.
 * Infinite scroll: onScroll detects when the user is within 300 px of the
 * bottom and calls onLoadMore (debounced by the hook's own loading guard).
 *
 * Scroll restoration: exposed via the MasonryGridHandle ref — callers can
 * call scrollToOffset(y) after items load.
 *
 * Video autoplay: each tile's y offset within the ScrollView is computed
 * deterministically from the layout algorithm. Combined with the current
 * scroll offset and the ScrollView's own height, isVisible is derived per-tile
 * (≥50 % in viewport) and passed down so video tiles autoplay while in view.
 *
 * Sizing: column width comes from the width the grid is actually given
 * (onLayout), not the window. On a tablet or the web the tabs sit beside a
 * 220 px sidebar in a content column capped at 720 px, so window-width columns
 * ran past the right edge and the second column was cut off. Until the first
 * layout the window width stands in, which is exact on a phone.
 *
 * Bottom clearance: the content ends above the floating tab pill (and the
 * layover pill when one is showing), the same inset the Roam tab's FAB uses,
 * so the last row can be scrolled fully into view.
 */

import React, {
  forwardRef,
  useImperativeHandle,
  useCallback,
  useRef,
  useState,
} from 'react';
import {
  ScrollView,
  View,
  StyleSheet,
  RefreshControl,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { GridTile } from './GridTile.tsx';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { useLayoverAwareBottomInset } from '../../hooks/useBottomInset.ts';
import type { MediaGridItem } from '../../types/media.ts';
import { color } from '../../theme/tokens.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const GUTTER = 2;           // px between columns and at edges
const NUM_COLS = 2;
const MIN_TILE_H = 90;      // px
const MAX_TILE_H = 340;     // px
const LOAD_MORE_THRESHOLD = 400; // px from bottom before triggering loadMore

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MasonryGridHandle {
  scrollToOffset(offset: number): void;
}

export interface MasonryGridProps {
  items: MediaGridItem[];
  loading: boolean;
  refreshing: boolean;
  onRefresh(): void;
  onLoadMore(): void;
  onTilePress(item: MediaGridItem, index: number): void;
  onScrollOffsetChange?(offset: number): void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tileHeight(item: MediaGridItem, colWidth: number): number {
  if (item.width && item.height && item.width > 0) {
    const ratio = item.height / item.width;
    return Math.round(Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, colWidth * ratio)));
  }
  // Fallback: 4:5 portrait ratio
  return Math.round(Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, colWidth * 1.25)));
}

/** Column width for a grid `width` px wide: GUTTER at both edges and between columns. */
function columnWidth(width: number): number {
  return Math.max(0, Math.floor((width - GUTTER * (NUM_COLS + 1)) / NUM_COLS));
}

/**
 * The grid's own laid-out size. Width falls back to the window width and
 * height to the window height until the first onLayout.
 */
function useGridBox() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const width = Math.round(e.nativeEvent.layout.width);
    const height = Math.round(e.nativeEvent.layout.height);
    setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);
  return {
    width: box?.width || windowWidth,
    height: box?.height || windowHeight,
    onLayout,
  };
}

/** Returns true when at least 50 % of the tile is within the visible viewport. */
function isTileVisible(tileY: number, tileH: number, scrollY: number, viewportH: number): boolean {
  const visibleTop = Math.max(tileY, scrollY);
  const visibleBottom = Math.min(tileY + tileH, scrollY + viewportH);
  const visiblePx = Math.max(0, visibleBottom - visibleTop);
  return visiblePx >= tileH * 0.5;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const MasonryGrid = forwardRef<MasonryGridHandle, MasonryGridProps>(
  function MasonryGrid(
    { items, refreshing, onRefresh, onLoadMore, onTilePress, onScrollOffsetChange },
    ref,
  ) {
    const { width: gridWidth, height: viewportHeight, onLayout } = useGridBox();
    const colWidth = columnWidth(gridWidth);
    const bottomInset = useLayoverAwareBottomInset();

    const scrollViewRef = useRef<ScrollView>(null);

    // ── Current scroll position (updated on every scroll event) ──────────────
    const [scrollY, setScrollY] = useState(0);

    useImperativeHandle(
      ref,
      () => ({
        scrollToOffset: (offset: number) => {
          scrollViewRef.current?.scrollTo({ y: offset, animated: false });
        },
      }),
      [],
    );

    // ── Distribute items into columns (shortest-column-next algorithm) ────────
    //
    // We also track each tile's absolute y offset within the ScrollView so we
    // can compute visibility without any onLayout calls.

    const columns: {
      item: MediaGridItem;
      globalIndex: number;
      h: number;
      /** Absolute y offset of this tile within the ScrollView content. */
      tileY: number;
    }[][] = Array.from({ length: NUM_COLS }, () => []);
    const colHeights = new Array<number>(NUM_COLS).fill(GUTTER); // start at top gutter

    items.forEach((item, i) => {
      const h = tileHeight(item, colWidth);
      // Find the shortest column
      let shortest = 0;
      for (let c = 1; c < NUM_COLS; c++) {
        if (colHeights[c] < colHeights[shortest]) shortest = c;
      }
      columns[shortest].push({ item, globalIndex: i, h, tileY: colHeights[shortest] });
      colHeights[shortest] += h + GUTTER;
    });

    // ── Scroll handlers ───────────────────────────────────────────────────────

    const lastSaveRef = useRef(0);

    const handleScroll = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        const y = contentOffset.y;

        setScrollY(y);

        // Offset save (throttled to 200 ms)
        const now = Date.now();
        if (now - lastSaveRef.current >= 200) {
          lastSaveRef.current = now;
          onScrollOffsetChange?.(y);
        }

        // Infinite scroll trigger
        if (
          y + layoutMeasurement.height >=
          contentSize.height - LOAD_MORE_THRESHOLD
        ) {
          onLoadMore();
        }
      },
      [onLoadMore, onScrollOffsetChange],
    );

    // ── Render ────────────────────────────────────────────────────────────────

    return (
      <ScrollView
        ref={scrollViewRef}
        style={st.scroll}
        testID="masonry-grid-scroll"
        onLayout={onLayout}
        contentContainerStyle={[
          st.content,
          { paddingHorizontal: GUTTER, paddingBottom: bottomInset },
        ]}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={color.signal}
            colors={[color.signal]}
          />
        }
      >
        <View style={st.row}>
          {columns.map((col, colIdx) => (
            <View
              key={colIdx}
              style={[st.col, { width: colWidth }]}
            >
              {col.map(({ item, globalIndex, h, tileY }) => (
                <View key={item.id} style={[st.tileWrap, { marginBottom: GUTTER }]}>
                  <GridTile
                    item={item}
                    index={globalIndex}
                    cellWidth={colWidth}
                    cellHeight={h}
                    onPress={onTilePress}
                    isVisible={isTileVisible(tileY, h, scrollY, viewportHeight)}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  },
);

// ── Loading skeleton ──────────────────────────────────────────────────────────

// Tile heights as a share of the column width: a mix of the 4:5 fallback,
// squares and landscape, staggered so the two columns don't line up.
const SKELETON_RATIOS: number[][] = [
  [1.25, 0.8, 1.25, 1],
  [1, 1.25, 0.8, 1.25],
];

/**
 * Loading placeholder drawn with the grid's own geometry (same gutter, column
 * width and tile proportions), so the real tiles land where the placeholders
 * were instead of the screen jumping from a padded, gapped grid of short
 * landscape boxes to an edge-to-edge masonry.
 */
export function MasonryGridSkeleton() {
  const { width, onLayout } = useGridBox();
  const colWidth = columnWidth(width);
  return (
    <View
      style={[st.skeleton, { paddingHorizontal: GUTTER }]}
      onLayout={onLayout}
      accessibilityLabel="Loading posts"
      testID="masonry-grid-skeleton"
    >
      <View style={st.row}>
        {SKELETON_RATIOS.map((ratios, c) => (
          <View key={c} style={[st.col, { width: colWidth }]}>
            {ratios.map((r, i) => (
              <ShimmerBox
                key={i}
                width={colWidth}
                height={Math.round(Math.max(MIN_TILE_H, Math.min(MAX_TILE_H, colWidth * r)))}
                borderRadius={2}
                style={{ marginBottom: GUTTER }}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  skeleton: {
    flex: 1,
    overflow: 'hidden',
    paddingTop: GUTTER,
    backgroundColor: color.paper,
  },
  scroll: {
    flex: 1,
    backgroundColor: color.paper,
  },
  content: {
    paddingTop: GUTTER,
  },
  row: {
    flexDirection: 'row',
    gap: GUTTER,
    alignItems: 'flex-start',
  },
  col: {
    flexDirection: 'column',
  },
  tileWrap: {
    overflow: 'hidden',
    borderRadius: 2,
  },
});
