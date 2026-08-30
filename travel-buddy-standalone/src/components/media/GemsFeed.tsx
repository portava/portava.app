/**
 * GemsFeed — full-screen paging feed for the Gems (hidden gems) mode.
 *
 * One item per viewport, same paging list pattern as Watch.
 * GemsItemOverlay provides the place-dominant UI layer on top of each image.
 * GemsFilterBar (area + category chips) floats above the list.
 *
 * Near Me flow:
 *   1. User taps "Near Me" chip → onRequestNearMe fires
 *   2. expo-location permission is requested
 *   3. On grant, coords are stored in local state and forwarded to useGemsFeed
 *
 * Feature flags consumed:
 *   nearMeEnabled  — driven by MEDIA_HIDDEN_GEMS_NEARBY_ENABLED (prop)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  FlatList,
  Image,
  Text,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { getCurrentGps } from '../../services/location.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, type as t } from '../../theme/tokens.ts';
import { getOverlayHeaderTotalHeight } from '../ui/AppHeader.tsx';
import { useMediaStore, type GeoAreaMode, type GemCategory } from '../../stores/mediaStore.ts';
import { useGemsFeed, type GemsFeedItem } from '../../hooks/useGemsFeed.ts';
import { useMediaSave } from '../../hooks/useMediaSave.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { GemsFilterBar } from './GemsFilterBar.tsx';
import { GemsItemOverlay } from './GemsItemOverlay.tsx';
import { MediaCommentSheet } from './MediaCommentSheet.tsx';
import { MediaMoreMenu } from './MediaMoreMenu.tsx';
import { WhyThisSheet } from './WhyThisSheet.tsx';
import { recordMediaShare } from '../../services/mediaInteractions.ts';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GemsFeedProps {
  /**
   * Driven by MEDIA_HIDDEN_GEMS_NEARBY_ENABLED feature flag.
   * When false the Near Me chip is hidden.
   */
  nearMeEnabled?: boolean;
  /** Active trip ID for My Trip mode (from the user's trip store). */
  activeTripId?: string | null;
  /** Active city for This City mode (from resolved location). */
  activeCity?: string | null;
  /** Callbacks for item actions */
  onViewPlace?: (item: GemsFeedItem) => void;
  onAddToTrip?: (item: GemsFeedItem) => void;
  onDirections?: (item: GemsFeedItem) => void;
  onViewCreator?: (creatorId: string) => void;
  onWrongPlace?: (item: GemsFeedItem) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GemsFeed({
  nearMeEnabled = true,
  activeTripId,
  activeCity,
  onViewPlace,
  onAddToTrip,
  onDirections,
  onViewCreator,
  onWrongPlace,
}: GemsFeedProps) {
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { getGemsModeState, setGemsModeState } = useMediaStore();
  const session = useSession();
  const currentUserId = session?.userId ?? undefined;

  // ── Interaction hooks ────────────────────────────────────────────────────
  const saveHook = useMediaSave();

  // ── Sheet state ──────────────────────────────────────────────────────────
  const [commentItemId, setCommentItemId] = useState<string | null>(null);
  const [moreMenuItemId, setMoreMenuItemId] = useState<string | null>(null);
  const [whyThisItemId, setWhyThisItemId] = useState<string | null>(null);

  const gemsState = getGemsModeState();

  // ── Filter state (synced to store) ────────────────────────────────────────
  const [areaMode, setAreaMode] = useState<GeoAreaMode>(gemsState.areaMode);
  const [category, setCategory] = useState<GemCategory | null>(gemsState.category);
  const [nearMeLoading, setNearMeLoading] = useState(false);
  const [userLat, setUserLat] = useState<number | null>(null);
  const [userLng, setUserLng] = useState<number | null>(null);

  const handleAreaModeChange = useCallback((mode: GeoAreaMode) => {
    setAreaMode(mode);
    setGemsModeState({ areaMode: mode });
  }, [setGemsModeState]);

  const handleCategoryChange = useCallback((cat: GemCategory | null) => {
    setCategory(cat);
    setGemsModeState({ category: cat });
  }, [setGemsModeState]);

  // ── Near Me permission flow ───────────────────────────────────────────────
  const handleRequestNearMe = useCallback(async () => {
    setNearMeLoading(true);
    try {
      const gps = await getCurrentGps();
      if (!gps.granted || gps.lat == null || gps.lng == null) {
        // Permission denied or GPS failed — revert to "All"
        setAreaMode('all');
        setGemsModeState({ areaMode: 'all' });
        return;
      }
      setUserLat(gps.lat);
      setUserLng(gps.lng);
    } catch {
      setAreaMode('all');
      setGemsModeState({ areaMode: 'all' });
    } finally {
      setNearMeLoading(false);
    }
  }, [setGemsModeState]);

  // ── Resolve area-specific params ──────────────────────────────────────────
  const resolvedCity = areaMode === 'this_city' ? (activeCity ?? undefined) : undefined;
  const resolvedTripId = areaMode === 'my_trip' ? (activeTripId ?? undefined) : undefined;
  const resolvedLat = areaMode === 'near_me' ? userLat : null;
  const resolvedLng = areaMode === 'near_me' ? userLng : null;

  // ── Feed data ─────────────────────────────────────────────────────────────
  const { items, loading, loadingMore, error, errorKind, hasMore, refresh, loadMore } = useGemsFeed({
    areaMode,
    category,
    tripId: resolvedTripId,
    city: resolvedCity,
    userLat: resolvedLat,
    userLng: resolvedLng,
  });

  // ── Seed interaction state when feed items arrive ─────────────────────────
  useEffect(() => {
    if (items.length === 0) return;
    saveHook.seed(items.map((i) => ({
      id: i.id,
      savedByMe: i.viewerState?.hasSaved ?? false,
    })));
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Interaction handlers ──────────────────────────────────────────────────
  const handleSave = useCallback((item: GemsFeedItem) => {
    saveHook.toggleSave(item.id);
  }, [saveHook]);

  const handleComment = useCallback((item: GemsFeedItem) => {
    setCommentItemId(item.id);
  }, []);

  const handleShare = useCallback((item: GemsFeedItem) => {
    // Fire share record in background; native share sheet is client-only
    recordMediaShare(item.id, 'native');
  }, []);

  const handleMore = useCallback((item: GemsFeedItem) => {
    setMoreMenuItemId(item.id);
  }, []);

  // ── Viewability tracking ──────────────────────────────────────────────────
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useCallback(({ viewableItems }: any) => {
    const first = viewableItems[0];
    if (first) {
      setGemsModeState({ activeItemId: first.item.id });
    }
  }, [setGemsModeState]);

  // ── More-menu and Why This? resolution ───────────────────────────────────
  const moreMenuItem = items.find((i) => i.id === moreMenuItemId) ?? null;
  const whyThisItem = items.find((i) => i.id === whyThisItemId) ?? null;

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderItem = useCallback(({ item }: { item: GemsFeedItem }) => {
    const media = item.media[0];
    return (
      <View style={{ width: screenWidth, height: screenHeight }}>
        {/* Background image */}
        {media?.url ? (
          <Image
            source={{ uri: media.url }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            accessibilityLabel={item.location?.name ?? 'Gem image'}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.imageFallback]} />
        )}
        {/* Overlay */}
        <GemsItemOverlay
          item={item}
          onViewPlace={onViewPlace}
          onAddToTrip={onAddToTrip}
          onDirections={onDirections}
          onFollowCreator={onViewCreator}
          onSave={handleSave}
          isSaved={saveHook.isSaved(item.id)}
          onShare={handleShare}
          onMore={handleMore}
        />
      </View>
    );
  }, [screenWidth, screenHeight, onViewPlace, onAddToTrip, onDirections, onViewCreator, handleSave, handleShare, handleMore]);

  const keyExtractor = useCallback((item: GemsFeedItem) => item.id, []);

  const renderFooter = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <View style={[styles.footerLoader, { width: screenWidth, height: screenHeight }]}>
        <ActivityIndicator size="large" color={color.onInk} />
      </View>
    );
  }, [loadingMore, screenWidth, screenHeight]);

  // ── Empty / error states ──────────────────────────────────────────────────
  const renderEmpty = useCallback(() => {
    if (loading) return null;
    return (
      <View style={[styles.emptyState, { width: screenWidth, height: screenHeight }]}>
        {error ? (
          <>
            {/* Never render the server's own message. It is diagnostic text —
                the gems tab used to explain itself to users with "Missing or
                malformed Authorization header", which is both meaningless to
                them and an internals leak. */}
            <Text style={styles.emptyTitle}>
              {errorKind === 'unauthenticated' ? 'Sign in to see hidden gems' : "Couldn't load gems"}
            </Text>
            <Text style={styles.emptyBody}>
              {errorKind === 'unauthenticated'
                ? 'Gems are shared by travellers you can follow once you have an account.'
                : 'Something went wrong. Pull down to try again.'}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.emptyTitle}>No gems here yet</Text>
            <Text style={styles.emptyBody}>
              Try a different area or category.
            </Text>
          </>
        )}
      </View>
    );
  }, [loading, error, errorKind, screenWidth, screenHeight]);

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Full-screen paging list */}
      {loading && items.length === 0 ? (
        <View style={styles.initialLoader}>
          <ActivityIndicator size="large" color={color.onInk} />
        </View>
      ) : (
        <FlatList
          data={items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={screenHeight}
          snapToAlignment="start"
          decelerationRate={Platform.OS === 'ios' ? 'fast' : 0.98}
          getItemLayout={(_, index) => ({
            length: screenHeight,
            offset: screenHeight * index,
            index,
          })}
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={renderFooter}
          ListEmptyComponent={renderEmpty}
          onRefresh={refresh}
          refreshing={loading && items.length > 0}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={2}
          maxToRenderPerBatch={3}
          windowSize={5}
        />
      )}

      {/* Filter bar — floats above the list, cleared below the overlay header + mode selector */}
      <View
        style={[styles.filterBarWrapper, { top: getOverlayHeaderTotalHeight(insets.top) + 4 + MODE_SELECTOR_HEIGHT + FILTER_BAR_GAP }]}
        pointerEvents="box-none"
      >
        <GemsFilterBar
          areaMode={areaMode}
          category={category}
          onAreaModeChange={handleAreaModeChange}
          onCategoryChange={handleCategoryChange}
          nearMeEnabled={nearMeEnabled}
          onRequestNearMe={handleRequestNearMe}
          nearMeLoading={nearMeLoading}
        />
      </View>

      {/* ── Comment sheet ────────────────────────────────────────────────── */}
      <MediaCommentSheet
        mediaId={commentItemId}
        visible={commentItemId !== null}
        onClose={() => setCommentItemId(null)}
      />

      {/* ── More menu (viewer + owner + wrong-place) ────────────────────── */}
      <MediaMoreMenu
        visible={moreMenuItemId !== null}
        mediaId={moreMenuItemId}
        creatorId={moreMenuItem?.creator?.id ?? null}
        isOwner={
          !!currentUserId &&
          !!moreMenuItem &&
          moreMenuItem.creator?.id === currentUserId
        }
        isGems={true}
        onWhyThis={() => {
          setMoreMenuItemId(null);
          setWhyThisItemId(moreMenuItemId);
        }}
        onItemRemoved={() => setMoreMenuItemId(null)}
        onClose={() => setMoreMenuItemId(null)}
      />

      {/* ── Why This? sheet ──────────────────────────────────────────────── */}
      <WhyThisSheet
        visible={whyThisItemId !== null}
        explanation={(whyThisItem as any)?.compassExplanation ?? null}
        onClose={() => setWhyThisItemId(null)}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Must match MediaModeSelector's chip height (media.tsx) so the filter bar never
// overlaps the mode-selector chips — a hardcoded platform guess drifted out of
// sync with the real selector geometry and caused visual overlap + swallowed
// taps on the mode chips underneath it.
const MODE_SELECTOR_HEIGHT = 44;
const FILTER_BAR_GAP = 8;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.ink,
  },
  initialLoader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageFallback: {
    backgroundColor: '#1A1A18',
  },
  filterBarWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  footerLoader: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.ink,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xxl,
    gap: space.sm,
    backgroundColor: color.ink,
  },
  emptyTitle: {
    ...t.heading,
    color: color.onInk,
    textAlign: 'center',
  },
  emptyBody: {
    ...t.body,
    color: color.onInkMute,
    textAlign: 'center',
  },
});
