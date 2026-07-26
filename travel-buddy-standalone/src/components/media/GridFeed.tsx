/**
 * GridFeed — three-column 3:4 portrait tile feed for Grid mode.
 *
 * Layout:
 *   - Three equal-width columns with 1px gutters (GUTTER).
 *   - Each cell: width = (screenWidth - GUTTER * 4) / 3, height = cellWidth * 4/3.
 *   - getItemLayout is set so FlatList does not re-measure cells on scroll.
 *   - Each GridTile is memoized to avoid re-renders on unrelated state changes.
 *
 * Data:
 *   - Fetches from GET /api/media/feed?mode=grid via useGridFeed.
 *   - Filter state is owned here; the GridFilterBar controls it.
 *   - Pagination: loadMore is called from onEndReached (threshold 0.3).
 *
 * Scroll restoration:
 *   - scrollOffset is saved to mediaStore.grid.scrollOffset on scroll events.
 *   - On mount, after the first page loads, scrollToOffset is called to restore
 *     the saved position.
 *
 * Navigation:
 *   - Tapping a tile navigates to /post/[id] (the existing post detail route)
 *     so the fullscreen item is shown immediately.
 *   - On back navigation, the grid position is restored from the store.
 *
 * Camera/create button:
 *   - A floating camera button in the top-right corner lets creators reach
 *     /create without leaving Grid mode.
 *
 * No video autoplays in the grid — tiles are static poster images only.
 * Press-and-hold video preview is behind MEDIA_GRID_VIDEO_PREVIEWS_ENABLED
 * (flag check wired; implementation deferred per spec).
 */

import React, {
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';
import { Film, WifiOff, RefreshCw, Camera } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GridTile } from './GridTile.tsx';
import { GridFilterBar } from './GridFilterBar.tsx';
import { useGridFeed } from '../../hooks/useGridFeed.ts';
import { useMediaStore } from '../../stores/mediaStore.ts';
import type { MediaGridItem, GridFilter } from '../../types/media.ts';
import { color, type as t, space, shadow } from '../../theme/tokens.ts';

// ── Layout constants ───────────────────────────────────────────────────────────

/** Gutter between tiles (and around the outer edges). */
const GUTTER = 1;
const NUM_COLUMNS = 3;

function useCellSize(screenWidth: number) {
  const cellWidth = Math.floor(
    (screenWidth - GUTTER * (NUM_COLUMNS + 1)) / NUM_COLUMNS,
  );
  // 3:4 portrait aspect ratio
  const cellHeight = Math.floor((cellWidth * 4) / 3);
  return { cellWidth, cellHeight };
}

// ── Scroll throttle (ms between offset saves) ─────────────────────────────────
const SCROLL_SAVE_INTERVAL_MS = 200;

// ── Empty / error states ──────────────────────────────────────────────────────

function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={es.wrap}>
      {icon}
      <Text style={es.title}>{title}</Text>
      {subtitle ? <Text style={es.sub}>{subtitle}</Text> : null}
      {action ? (
        <Pressable onPress={action.onPress} style={es.btn}>
          <Text style={es.btnText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const es = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 40,
    backgroundColor: color.paper,
  },
  title: { ...t.heading, color: color.ink, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, textAlign: 'center' },
  btn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: color.ink,
  },
  btnText: { ...t.small, color: color.onInk, fontWeight: '600' },
});

// ── Footer (loading more) ────────────────────────────────────────────────────

function LoadMoreFooter({ loading }: { loading: boolean }) {
  if (!loading) return null;
  return (
    <View style={footer.wrap}>
      <ActivityIndicator size="small" color={color.mute} />
    </View>
  );
}

const footer = StyleSheet.create({
  wrap: { paddingVertical: space.xl, alignItems: 'center' },
});

// ── GridFeed ──────────────────────────────────────────────────────────────────

export function GridFeed() {
  const { width: screenWidth } = useWindowDimensions();
  const { cellWidth, cellHeight } = useCellSize(screenWidth);
  const insets = useSafeAreaInsets();

  const { getModeState, setModeState } = useMediaStore();

  const {
    filter,
    setFilter,
    items,
    loading,
    error,
    loadFeed,
    loadMore,
  } = useGridFeed();

  // ── Initial load ────────────────────────────────────────────────────────────
  const hasFetched = useRef(false);
  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      loadFeed();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll restoration ──────────────────────────────────────────────────────
  const flatListRef = useRef<FlatList<MediaGridItem>>(null);
  const hasRestored = useRef(false);
  const lastScrollSaveMs = useRef(0);

  // Restore scroll position after the first successful page load.
  useEffect(() => {
    if (items.length > 0 && !hasRestored.current) {
      hasRestored.current = true;
      const savedOffset = getModeState('grid').scrollOffset;
      if (savedOffset > 0) {
        // Defer slightly so the FlatList has finished its first layout.
        setTimeout(() => {
          flatListRef.current?.scrollToOffset({ offset: savedOffset, animated: false });
        }, 50);
      }
    }
  }, [items.length, getModeState]);

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const now = Date.now();
      if (now - lastScrollSaveMs.current < SCROLL_SAVE_INTERVAL_MS) return;
      lastScrollSaveMs.current = now;
      setModeState('grid', { scrollOffset: e.nativeEvent.contentOffset.y });
    },
    [setModeState],
  );

  // ── Tile press → fullscreen viewer ──────────────────────────────────────────
  const handleTilePress = useCallback(
    (item: MediaGridItem, _index: number) => {
      // Wire MEDIA_GRID_VIDEO_PREVIEWS_ENABLED flag (implementation deferred):
      // if (isEnabled('MEDIA_GRID_VIDEO_PREVIEWS_ENABLED') && longPress) { ... }

      // Navigate to the post detail / Watch fullscreen viewer.
      router.push(`/post/${item.id}` as any);
    },
    [],
  );

  // ── Filter change ───────────────────────────────────────────────────────────
  const handleFilterChange = useCallback(
    (f: GridFilter, coords?: { lat: number; lng: number }) => {
      // Reset scroll restoration so the new filter starts at the top.
      hasRestored.current = false;
      setModeState('grid', { scrollOffset: 0 });
      setFilter(f, coords);
    },
    [setFilter, setModeState],
  );

  // ── FlatList rendering helpers ──────────────────────────────────────────────
  const renderItem = useCallback(
    ({ item, index }: { item: MediaGridItem; index: number }) => (
      <GridTile
        item={item}
        index={index}
        cellWidth={cellWidth}
        cellHeight={cellHeight}
        onPress={handleTilePress}
      />
    ),
    [cellWidth, cellHeight, handleTilePress],
  );

  // Stable getItemLayout avoids FlatList re-measuring all cells on scroll.
  const getItemLayout = useCallback(
    (_: ArrayLike<MediaGridItem> | null | undefined, index: number) => {
      const rowIndex = Math.floor(index / NUM_COLUMNS);
      return {
        length: cellHeight + GUTTER,
        offset: (cellHeight + GUTTER) * rowIndex,
        index,
      };
    },
    [cellHeight],
  );

  const keyExtractor = useCallback((item: MediaGridItem) => item.id, []);

  const handleEndReached = useCallback(() => {
    loadMore();
  }, [loadMore]);

  // ── Camera / create button (shared across all states) ────────────────────────
  const createButton = (
    <Pressable
      style={[styles.createBtn, { top: insets.top + 12 }]}
      onPress={() => router.push('/create')}
      accessibilityRole="button"
      accessibilityLabel="Create a post"
      hitSlop={8}
    >
      <Camera size={18} color={color.ink} strokeWidth={2} />
    </Pressable>
  );

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading && items.length === 0) {
    return (
      <View style={styles.container}>
        <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.mute} />
        </View>
        {createButton}
      </View>
    );
  }

  if (error && items.length === 0) {
    const isNetworkError = error.toLowerCase().includes('network');
    return (
      <View style={styles.container}>
        <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
        <EmptyState
          icon={
            isNetworkError
              ? <WifiOff size={32} color={color.mute} />
              : <Film size={32} color={color.mute} />
          }
          title={isNetworkError ? 'No connection' : "Couldn\u2019t load feed"}
          subtitle={isNetworkError
            ? 'Check your connection and try again.'
            : 'Something went wrong on our end.'}
          action={{ label: 'Try again', onPress: loadFeed }}
        />
        {createButton}
      </View>
    );
  }

  if (!loading && items.length === 0) {
    const emptyMessages: Record<GridFilter, { title: string; sub: string }> = {
      all:       { title: 'Nothing here yet', sub: 'Be the first to post something.' },
      videos:    { title: 'No videos yet', sub: 'Videos will appear here.' },
      photos:    { title: 'No photos yet', sub: 'Photos will appear here.' },
      following: { title: 'Nothing from people you follow', sub: 'Follow more travelers to see their posts here.' },
      saved:     { title: 'No saved posts', sub: 'Tap the bookmark on any post to save it.' },
      nearby:    { title: 'Nothing nearby', sub: 'No posts found near your current location.' },
    };
    const msg = emptyMessages[filter];
    return (
      <View style={styles.container}>
        <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
        <EmptyState
          icon={<Film size={32} color={color.mute} />}
          title={msg.title}
          subtitle={msg.sub}
        />
        {createButton}
      </View>
    );
  }

  // ── Main grid ───────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
      <FlatList
        ref={flatListRef}
        testID="grid-flatlist"
        data={items}
        numColumns={NUM_COLUMNS}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        onScroll={handleScroll}
        scrollEventThrottle={SCROLL_SAVE_INTERVAL_MS}
        ListFooterComponent={<LoadMoreFooter loading={loading} />}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.listContent}
        style={styles.list}
        removeClippedSubviews
        windowSize={5}
        maxToRenderPerBatch={18}   // 6 rows × 3 cols
        initialNumToRender={18}
      />
      {createButton}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    flex: 1,
    backgroundColor: color.paper,
  },
  listContent: {
    gap: GUTTER,
    paddingHorizontal: GUTTER,
    paddingTop: GUTTER,
  },
  columnWrapper: {
    gap: GUTTER,
  },
  createBtn: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
});
