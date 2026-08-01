/**
 * GridFeed — two-column masonry grid feed for Grid mode.
 *
 * Layout:
 *   - Two-column masonry via MasonryGrid.  Each tile height is derived from
 *     the media item's natural aspect ratio (clamped to [90, 340] px).
 *   - Tiles are distributed to whichever column is shorter.
 *
 * Data:
 *   - Fetches from GET /api/media/feed?mode=grid via useGridFeed.
 *   - Filter state is owned here; the GridFilterBar controls it.
 *   - Pagination: loadMore is called from MasonryGrid's onScroll near-bottom.
 *
 * Pull-to-refresh: RefreshControl wired through MasonryGrid.
 *
 * Scroll restoration:
 *   - scrollOffset is saved to mediaStore.grid.scrollOffset on scroll events.
 *   - On mount, after the first page loads, scrollToOffset is called to restore
 *     the saved position.
 *
 * Navigation:
 *   - Tapping a tile sets the viewerContext (full items list + initial ID)
 *     then navigates to /media-viewer/[id] so the viewer can page between
 *     all currently-loaded grid items.
 *   - On back navigation, the grid position is restored from the store.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  View,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { Film, WifiOff } from 'lucide-react-native';
import { MasonryGrid, type MasonryGridHandle } from './MasonryGrid.tsx';
import { GridFilterBar } from './GridFilterBar.tsx';
import { MediaGridSkeleton } from '../loading/MediaGridSkeleton.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { useGridFeed } from '../../hooks/useGridFeed.ts';
import { useMediaStore } from '../../stores/mediaStore.ts';
import { setViewerContext } from '../../lib/viewerContext.ts';
import type { MediaGridItem, GridFilter } from '../../types/media.ts';
import { color } from '../../theme/tokens.ts';

// ── GridFeed ──────────────────────────────────────────────────────────────────

export function GridFeed() {
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

  // ── Pull-to-refresh ─────────────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadFeed();
    } finally {
      setRefreshing(false);
    }
  }, [loadFeed]);

  // ── Initial load ────────────────────────────────────────────────────────────
  const hasFetched = useRef(false);
  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      loadFeed();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll restoration ──────────────────────────────────────────────────────
  const masonryRef = useRef<MasonryGridHandle>(null);
  const hasRestored = useRef(false);

  useEffect(() => {
    if (items.length > 0 && !hasRestored.current) {
      hasRestored.current = true;
      const savedOffset = getModeState('grid').scrollOffset;
      if (savedOffset > 0) {
        setTimeout(() => {
          masonryRef.current?.scrollToOffset(savedOffset);
        }, 60);
      }
    }
  }, [items.length, getModeState]);

  const handleScrollOffsetChange = useCallback(
    (offset: number) => {
      setModeState('grid', { scrollOffset: offset });
    },
    [setModeState],
  );

  // ── Tile press → fullscreen viewer ──────────────────────────────────────────
  const handleTilePress = useCallback(
    (item: MediaGridItem, _index: number) => {
      // Store the full items list so the viewer can page between them.
      setViewerContext(
        items.map((i) => ({
          id: i.id,
          posterUrl: i.posterUrl,
          thumbnailUrl: i.thumbnailUrl,
          mediaType: i.mediaType,
          locationVerified: i.locationVerified,
          locationName: i.locationLabel,
        })),
        item.id,
      );
      router.push(`/media-viewer/${item.id}` as any);
    },
    [items],
  );

  // ── Filter change ───────────────────────────────────────────────────────────
  const handleFilterChange = useCallback(
    (f: GridFilter, coords?: { lat: number; lng: number }) => {
      hasRestored.current = false;
      setModeState('grid', { scrollOffset: 0 });
      setFilter(f, coords);
    },
    [setFilter, setModeState],
  );

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading && items.length === 0) {
    return (
      <View style={styles.container}>
        <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
        <MediaGridSkeleton columns={2} count={6} />
      </View>
    );
  }

  if (error && items.length === 0) {
    const isNetworkError = error.toLowerCase().includes('network');
    return (
      <View style={styles.container}>
        <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
        <View style={styles.center}>
          <EmptyState
            icon={isNetworkError ? WifiOff : Film}
            title={isNetworkError ? 'No connection' : "Couldn\u2019t load feed"}
            description={isNetworkError
              ? 'Check your connection and try again.'
              : 'Something went wrong on our end.'}
            primaryAction={{ label: 'Try again', onPress: loadFeed }}
          />
        </View>
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
        <View style={styles.center}>
          <EmptyState icon={Film} title={msg.title} description={msg.sub} />
        </View>
      </View>
    );
  }

  // ── Main masonry grid ────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <GridFilterBar selectedFilter={filter} onFilterChange={handleFilterChange} />
      <MasonryGrid
        ref={masonryRef}
        items={items}
        loading={loading}
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onLoadMore={loadMore}
        onTilePress={handleTilePress}
        onScrollOffsetChange={handleScrollOffsetChange}
      />
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
});
