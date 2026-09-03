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
  FlatList,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  type ViewToken,
} from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import { WallObjectRenderer } from './WallObjectRenderer.tsx';
import { CaughtUpState } from './CaughtUpState.tsx';
import { trackImpression } from '../services/wallAnalytics.ts';
import type { WallMode, WallProjection } from '../types/wallProjection.ts';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 55 };

export function WallFeed({
  items,
  mode,
  loading,
  refreshing,
  loadingMore,
  caughtUp,
  onEndReached,
  onRefresh,
  ListHeaderComponent,
}: {
  items: WallProjection[];
  mode: WallMode;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  caughtUp: boolean;
  onEndReached: () => void;
  onRefresh: () => void;
  ListHeaderComponent?: React.ReactElement | null;
}) {
  // De-dup impressions across the session — record each projection once.
  const seenImpressions = React.useRef<Set<string>>(new Set());
  const onViewableItemsChanged = React.useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      for (const token of viewableItems) {
        const projection = token.item as WallProjection | undefined;
        if (!projection || !token.isViewable) continue;
        if (seenImpressions.current.has(projection.projectionId)) continue;
        seenImpressions.current.add(projection.projectionId);
        trackImpression(projection);
      }
    },
  );

  const renderItem = React.useCallback(
    ({ item }: { item: WallProjection }) => (
      <View style={s.itemWrap}>
        <WallObjectRenderer projection={item} />
      </View>
    ),
    [],
  );

  return (
    <FlatList
      testID="wall-feed"
      data={items}
      keyExtractor={(item) => item.projectionId}
      renderItem={renderItem}
      ListHeaderComponent={ListHeaderComponent}
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
  );
}

const s = StyleSheet.create({
  content: { paddingBottom: 120, gap: space.md },
  emptyContent: { flexGrow: 1 },
  itemWrap: { paddingHorizontal: space.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: space.xxxl },
  footer: { paddingVertical: space.xl, alignItems: 'center' },
});
