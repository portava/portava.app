/**
 * WallFeed — the vertical social feed itself (Wall spec §7/§28/§32).
 *
 * A plain, scrollable list of one social object at a time (spec §35). It owns:
 *   - pagination (onEndReached → loadMore), append-only so page 1 never
 *     reshuffles (the cursor stability lives in useWallFeed);
 *   - pull-to-refresh (new rank session);
 *   - impression analytics via viewability (ids only — spec §32);
 *   - the end states (caught-up / safe empty).
 *
 * If everything intelligent is stripped away, THIS still works as social media
 * (spec §40 non-negotiable #1 and #7): the list renders whatever projections
 * arrived, in order, and never depends on the live strip or context threads.
 */

import React from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  type ViewToken,
} from 'react-native';
import { color, space, radius, type as typeScale } from '../../../theme/tokens.ts';
import { WallObjectRenderer } from './WallObjectRenderer.tsx';
import { CaughtUpState } from './CaughtUpState.tsx';
import { NotInterestedControl } from './objects/wallItemShared.tsx';
import { WallItemVisibilityProvider } from '../hooks/useWallItemVisibility.tsx';
import { trackCaughtUp, trackImpression } from '../services/wallAnalytics.ts';
import { formatCacheAge } from '../services/wallPrefetch.ts';
import type { WallMode, WallProjection } from '../types/wallProjection.ts';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 55 };
const EMPTY_VISIBLE: ReadonlySet<string> = new Set();

export function WallFeed({
  items,
  mode,
  loading,
  refreshing,
  loadingMore,
  caughtUp,
  stale = false,
  cachedAt = null,
  onEndReached,
  onRefresh,
  onHide,
  ListHeaderComponent,
}: {
  items: WallProjection[];
  mode: WallMode;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  caughtUp: boolean;
  /** Items are the offline cached page — render a saved/stale label (§31/§37). */
  stale?: boolean;
  /** Epoch-ms the cached page was saved, for the "saved N ago" label. */
  cachedAt?: number | null;
  onEndReached: () => void;
  onRefresh: () => void;
  /** Drop an object the viewer marked "not interested" (spec §7/§32). */
  onHide?: (projectionId: string) => void;
  ListHeaderComponent?: React.ReactElement | null;
}) {
  // De-dup impressions across the session — record each projection once.
  const seenImpressions = React.useRef<Set<string>>(new Set());
  // The set of currently-viewable projectionIds, shared with the item renderers
  // so inline video autoplays only while on-screen and pauses when scrolled away
  // (spec §11). `setVisibleIds` is a stable identity, so capturing it once in the
  // ref callback keeps `onViewableItemsChanged` stable across renders (RN warns
  // when that callback's identity changes).
  const [visibleIds, setVisibleIds] = React.useState<ReadonlySet<string>>(EMPTY_VISIBLE);
  const onViewableItemsChanged = React.useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const nextVisible = new Set<string>();
      for (const token of viewableItems) {
        const projection = token.item as WallProjection | undefined;
        if (!projection || !token.isViewable) continue;
        nextVisible.add(projection.projectionId);
        if (seenImpressions.current.has(projection.projectionId)) continue;
        seenImpressions.current.add(projection.projectionId);
        trackImpression(projection);
      }
      setVisibleIds(nextVisible);
    },
  );

  // Caught-up rate (spec §32) — record once when the viewer reaches the end of
  // eligible Following content. Re-arms if new content pushes them off the end.
  const caughtUpLogged = React.useRef(false);
  React.useEffect(() => {
    const atEnd = caughtUp && mode === 'following' && items.length > 0;
    if (atEnd && !caughtUpLogged.current) {
      caughtUpLogged.current = true;
      trackCaughtUp(mode);
    } else if (!atEnd) {
      caughtUpLogged.current = false;
    }
  }, [caughtUp, mode, items.length]);

  const renderItem = React.useCallback(
    ({ item }: { item: WallProjection }) => (
      <View style={s.itemWrap}>
        <WallObjectRenderer projection={item} />
        <NotInterestedControl projection={item} onHide={onHide} />
      </View>
    ),
    [onHide],
  );

  // Offline stale banner (§31/§37). Rendered ABOVE the caller's header so it is
  // the first thing seen, and never relies on color alone (§36): it carries an
  // explicit "Offline · saved feed" text with the last-saved time.
  const staleBanner =
    stale && items.length > 0 ? (
      <View style={s.staleBanner} testID="wall-stale-banner" accessibilityRole="text">
        <Text style={s.staleText}>
          {`Offline · saved feed${cachedAt != null ? ` · ${formatCacheAge(Date.now() - cachedAt)}` : ''}`}
        </Text>
      </View>
    ) : null;

  const header =
    staleBanner != null ? (
      <>
        {staleBanner}
        {ListHeaderComponent}
      </>
    ) : (
      ListHeaderComponent
    );

  return (
    <WallItemVisibilityProvider visibleIds={visibleIds}>
    <FlatList
      testID="wall-feed"
      data={items}
      keyExtractor={(item) => item.projectionId}
      renderItem={renderItem}
      ListHeaderComponent={header}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      onViewableItemsChanged={onViewableItemsChanged.current}
      viewabilityConfig={VIEWABILITY_CONFIG}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />
      }
      contentContainerStyle={items.length === 0 ? s.emptyContent : s.content}
      ListEmptyComponent={
        loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <CaughtUpState variant="empty" onRefresh={onRefresh} />
        )
      }
      ListFooterComponent={
        loadingMore ? (
          <View style={s.footer}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : caughtUp && mode === 'following' && items.length > 0 ? (
          <CaughtUpState variant="caught_up" onRefresh={onRefresh} />
        ) : null
      }
      showsVerticalScrollIndicator={false}
    />
    </WallItemVisibilityProvider>
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: 120, gap: space.md },
  emptyContent: { flexGrow: 1 },
  itemWrap: { paddingHorizontal: space.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: space.xxxl },
  footer: { paddingVertical: space.xl, alignItems: 'center' },
  staleBanner: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  staleText: { ...typeScale.small, color: color.mute, textAlign: 'center' },
});
