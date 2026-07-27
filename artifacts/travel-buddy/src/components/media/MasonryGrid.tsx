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
 */

import React, {
  forwardRef,
  useImperativeHandle,
  useCallback,
  useRef,
} from 'react';
import {
  ScrollView,
  View,
  StyleSheet,
  RefreshControl,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { GridTile } from './GridTile.tsx';
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

// ── Component ─────────────────────────────────────────────────────────────────

export const MasonryGrid = forwardRef<MasonryGridHandle, MasonryGridProps>(
  function MasonryGrid(
    { items, refreshing, onRefresh, onLoadMore, onTilePress, onScrollOffsetChange },
    ref,
  ) {
    const { width: screenWidth } = useWindowDimensions();
    const colWidth = Math.floor(
      (screenWidth - GUTTER * (NUM_COLS + 1)) / NUM_COLS,
    );

    const scrollViewRef = useRef<ScrollView>(null);

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

    const columns: { item: MediaGridItem; globalIndex: number; h: number }[][] =
      Array.from({ length: NUM_COLS }, () => []);
    const colHeights = new Array<number>(NUM_COLS).fill(0);

    items.forEach((item, i) => {
      const h = tileHeight(item, colWidth);
      // Find the shortest column
      let shortest = 0;
      for (let c = 1; c < NUM_COLS; c++) {
        if (colHeights[c] < colHeights[shortest]) shortest = c;
      }
      columns[shortest].push({ item, globalIndex: i, h });
      colHeights[shortest] += h + GUTTER;
    });

    // ── Scroll handlers ───────────────────────────────────────────────────────

    const lastSaveRef = useRef(0);

    const handleScroll = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;

        // Offset save (throttled to 200 ms)
        const now = Date.now();
        if (now - lastSaveRef.current >= 200) {
          lastSaveRef.current = now;
          onScrollOffsetChange?.(contentOffset.y);
        }

        // Infinite scroll trigger
        if (
          contentOffset.y + layoutMeasurement.height >=
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
        contentContainerStyle={[
          st.content,
          { paddingHorizontal: GUTTER },
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
              {col.map(({ item, globalIndex, h }) => (
                <View key={item.id} style={[st.tileWrap, { marginBottom: GUTTER }]}>
                  <GridTile
                    item={item}
                    index={globalIndex}
                    cellWidth={colWidth}
                    cellHeight={h}
                    onPress={onTilePress}
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

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: color.paper,
  },
  content: {
    paddingTop: GUTTER,
    paddingBottom: 24,
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
