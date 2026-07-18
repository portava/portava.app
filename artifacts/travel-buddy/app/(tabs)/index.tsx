import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import Animated, { useAnimatedStyle, interpolate } from 'react-native-reanimated';
import { useNavBarScrollHandler, navBarProgress } from '../../src/hooks/useNavBarCollapse';
import { useBottomInset } from '../../src/hooks/useBottomInset';
import { PostCard } from '../../src/components/PostCard';
import { PulseHeader } from '../../src/components/PulseHeader';
import { FitsCard, FlexibleStrip } from '../../src/components/PulseFits';
import { PulseFeedCard } from '../../src/components/PulseFeedCard';
import { PulseFilterSheet, UnifiedPostComposer } from '../../src/components/PulseCreate';
import { PulseLiveBanner } from '../../src/components/PulseLiveBanner';
import { TravelEmptyState } from '../../src/components/primitives';
import { useCityPulse } from '../../src/hooks/useCityPulse';
import { useGlobalFeed, useFollowingFeed } from '../../src/hooks/usePosts';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { fetchPreferences } from '../../src/services/intelligence';
import { STATUS_LABEL } from '../../src/lib/availability';

import { PULSE_FILTERS } from '../../src/types/models';
import type { PulseFilter, PulseFeedItem } from '../../src/types/models';
import type { PostRow } from '../../src/services/posts';
import { postRowToFeedItem } from '../../src/lib/postFeedAdapter';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { useLocationContext } from '../../src/context/LocationContext';
import { LocationPermissionPrompt } from '../../src/components/LocationPermissionPrompt';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { ActiveLayoverPill } from '../../src/components/layover/ActiveLayoverPill';
import { PeopleYouMayKnow } from '../../src/components/PeopleYouMayKnow';
import { pv } from '../../src/theme/pulseTheme';

const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Hidden Gems', 'Circle'];

/**
 * Display labels for the Portava chip row. The VALUES stay the internal
 * PulseFilter truth ('All', 'Plans', …) — only the visible label changes,
 * so toggle logic, sheet filters, and feed filtering are untouched.
 */
const CHIP_LABELS: Partial<Record<PulseFilter, string>> = {
  All: 'For You',
  Plans: 'Events',
  Posts: 'Posts',
  'Hidden Gems': 'Gems',
  Circle: 'People',
};

type FeedMode = 'forYou' | 'following';

/** Scroll offsets below this count as "at the top" — new posts prepend automatically. */
const AT_TOP_THRESHOLD = 80;

/**
 * Stable creation timestamp for the synthetic rent-a-buddy card so the feed
 * memo doesn't produce a brand-new item object per render (which would defeat
 * row memoization and re-render the whole list).
 */
const RENT_A_BUDDY_CREATED_AT = new Date(0).toISOString();

/**
 * Memoized feed row. The delete callback is derived from the stable
 * (onPostDeleted, item.id) pair inside the row so the props passed to the
 * memo boundary are themselves stable — inline closures in renderItem would
 * defeat React.memo and re-render every visible card on each list render.
 */
const FeedRow = React.memo(function FeedRow({
  item,
  onPostDeleted,
}: {
  item: PulseFeedItem;
  onPostDeleted: (id: string) => void;
}) {
  const handleDeleted = useCallback(() => onPostDeleted(item.id), [onPostDeleted, item.id]);
  if (item.type === 'post') {
    return <PulseFeedCard item={item} onDeleteSuccess={handleDeleted} />;
  }
  return (
    <View style={{ paddingHorizontal: space.lg }}>
      <PulseFeedCard item={item} onDeleteSuccess={handleDeleted} />
    </View>
  );
});

/** Module-level separator — a stable reference so FlatList never re-mounts separators. */
function FeedSeparator({ leadingItem }: { leadingItem?: PulseFeedItem }) {
  return <View style={{ height: leadingItem?.type === 'post' ? 8 : space.md }} />;
}

export default function Pulse() {
  const insets = useSafeAreaInsets();
  const navScrollHandler = useNavBarScrollHandler();
  const bottomInset = useBottomInset();

  // For You / Following toggle collapses with the nav bar on scroll-down,
  // leaving just the compact icon rail. Natural height 46 px:
  // lineHeight 22 (t.bodyStrong) + modeBtn paddingVertical 8×2
  // + modeRow padding 3×2 + border 1×2.
  const animatedModeRow = useAnimatedStyle(() => {
    const p = navBarProgress.value;
    return {
      height: interpolate(p, [0, 1], [46, 0]),
      marginBottom: interpolate(p, [0, 1], [8, 0]),
      opacity: interpolate(p, [0, 0.5], [1, 0], 'clamp'),
    };
  });

  // Chip row shrinks slightly (mostly vertical) in sync with the nav bar;
  // chips scale proportionally so labels never clip.
  const animatedChipRow = useAnimatedStyle(() => {
    const p = navBarProgress.value;
    return {
      height: interpolate(p, [0, 1], [46, 38]),
      transform: [{ scale: interpolate(p, [0, 1], [1, 0.9]) }],
    };
  });
  const [feedMode, setFeedMode] = useState<FeedMode>('forYou');
  const [active, setActive] = useState<PulseFilter[]>(['All']);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [layoverSheetOpen, setLayoverSheetOpen] = useState(false);
  const [categoryAffinities, setCategoryAffinities] = useState<Record<string, number>>({});
  const [peopleRefreshKey, setPeopleRefreshKey] = useState(0);
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();

  const { locationState, openCityPicker } = useLocationContext();
  const activeCity = locationState.place.city ?? 'Cebu City';
  const activeCitySlug = activeCity.toLowerCase().replace(/\s+/g, '-');

  // Load learned category affinities from the preference engine so Pulse
  // ranking improves as the user interacts with recommendations.
  useEffect(() => {
    let cancelled = false;
    fetchPreferences().then((res) => {
      if (!cancelled && res.ok && res.data?.inferred?.categoryAffinities) {
        setCategoryAffinities(res.data.inferred.categoryAffinities);
      }
    }).catch(() => { /* best-effort: silently ignore if not logged in yet */ });
    return () => { cancelled = true; };
  }, []);

  const { buckets, status } = useCityPulse({ currentCitySlug: activeCitySlug, interests: [], categoryAffinities });

  const realFeed = useGlobalFeed();
  const followingFeed = useFollowingFeed();

  // When any post is deleted, remove it from both feeds so it cannot reappear on refresh
  const handlePostDeleted = useCallback((id: string) => {
    realFeed.markDeleted(id);
    followingFeed.markDeleted(id);
  }, [realFeed.markDeleted, followingFeed.markDeleted]);

  // List ref + last-known scroll offset. The offset decides whether buffered
  // new posts can be prepended silently (user at top) or must wait behind the
  // "new posts" pill (user mid-feed).
  const listRef = useRef<FlatList<PulseFeedItem>>(null);
  const scrollOffsetRef = useRef(0);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    navScrollHandler(event);
  }, [navScrollHandler]);

  // On focus: only refresh when the data is stale (TTL), and do it in the
  // background without replacing the list — so re-entering the tab never
  // resets the scroll position. Pull-to-refresh still does a full reload.
  useFocusEffect(
    useCallback(() => {
      realFeed.refreshIfStale();
      if (feedMode === 'following') followingFeed.refreshIfStale();
    }, [realFeed.refreshIfStale, followingFeed.refreshIfStale, feedMode]),
  );

  // If new posts arrive while the user is already at (or near) the top,
  // prepend them automatically — no pill needed, no visible jump.
  useEffect(() => {
    if (realFeed.pending.length > 0 && scrollOffsetRef.current < AT_TOP_THRESHOLD) {
      realFeed.applyPending();
    }
  }, [realFeed.pending, realFeed.applyPending]);

  useEffect(() => {
    if (followingFeed.pending.length > 0 && scrollOffsetRef.current < AT_TOP_THRESHOLD) {
      followingFeed.applyPending();
    }
  }, [followingFeed.pending, followingFeed.applyPending]);

  const handleNewPostsPress = useCallback(() => {
    if (feedMode === 'following') {
      followingFeed.applyPending();
    } else {
      realFeed.applyPending();
    }
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [feedMode, realFeed.applyPending, followingFeed.applyPending]);

  // When switching to Following, load it on first activation.
  const handleFeedMode = useCallback((mode: FeedMode) => {
    setFeedMode(mode);
    if (mode === 'following') followingFeed.refreshIfStale();
  }, [followingFeed.refreshIfStale]);

  const handleRefresh = useCallback(() => {
    setPeopleRefreshKey((k) => k + 1);
    if (feedMode === 'following') followingFeed.reload();
    else realFeed.reload();
  }, [feedMode, followingFeed.reload, realFeed.reload]);

  const fits = useMemo(
    () => [...buckets.fitsAvailability, ...buckets.openNearby],
    [buckets.fitsAvailability, buckets.openNearby],
  );
  const noFits = fits.length === 0;

  // Stable events array for the live banner — a fresh array every render
  // would defeat the banner's memo and re-measure it during scroll.
  const bannerEvents = useMemo(
    () => [...fits, ...buckets.flexible],
    [fits, buckets.flexible],
  );

  const realItems = useMemo<PulseFeedItem[]>(
    () => (realFeed.data ?? [])
      .filter((p) => p.mediaUrls.length > 0)
      .map(postRowToFeedItem),
    [realFeed.data],
  );
  const forYouFeed = useMemo<PulseFeedItem[]>(() => {
    const filteredReal = active.includes('All') || active.includes('Posts')
      ? realItems
      : realItems.filter(() => false);
    return filteredReal;
  }, [realItems, active]);

  const followingItems = useMemo<PulseFeedItem[]>(
    () => (followingFeed.data ?? []).map(postRowToFeedItem),
    [followingFeed.data],
  );

  const baseFeed = feedMode === 'following' ? followingItems : forYouFeed;

  // Inject a synthetic rent_a_buddy feed item (rendered by PulseFeedCard switch) at position 3
  const feed = useMemo<PulseFeedItem[]>(() => {
    if (!rentBuddyEnabled || feedMode === 'following') return baseFeed;
    const buddyItem: PulseFeedItem = {
      id: '__rent_a_buddy__',
      type: 'rent_a_buddy',
      city: activeCity,
      createdAt: RENT_A_BUDDY_CREATED_AT,
      tags: [],
      source: 'editorial',
    };
    const insertAt = Math.min(3, baseFeed.length);
    return [...baseFeed.slice(0, insertAt), buddyItem, ...baseFeed.slice(insertAt)];
  }, [baseFeed, rentBuddyEnabled, feedMode, activeCity]);

  const filterCount = active.filter((f) => f !== 'All').length;

  // Stable renderItem/keyExtractor so the FlatList doesn't tear down and
  // rebuild rows on every screen render (a major source of scroll jank).
  const renderItem = useCallback(
    ({ item }: { item: PulseFeedItem }) => <FeedRow item={item} onPostDeleted={handlePostDeleted} />,
    [handlePostDeleted],
  );
  const keyExtractor = useCallback((it: PulseFeedItem) => String(it.id), []);

  function toggleQuick(f: PulseFilter) {
    if (f === 'All') { setActive(['All']); return; }
    setActive((prev) => {
      const without = prev.filter((x) => x !== 'All');
      return without.includes(f) ? (without.filter((x) => x !== f).length ? without.filter((x) => x !== f) : ['All']) : [...without, f];
    });
  }
  function toggleSheet(f: PulseFilter) {
    if (f === 'All') { setActive(['All']); return; }
    setActive((prev) => {
      const without = prev.filter((x) => x !== 'All');
      return without.includes(f) ? (without.filter((x) => x !== f).length ? without.filter((x) => x !== f) : ['All']) : [...without, f];
    });
  }

  const Header = (
    <View>
      {/* PulseHeader scrolls with the feed — not pinned above it */}
      <PulseHeader
        city={activeCity}
        cityFull={activeCity}
        availabilityText={status === 'not_set' ? 'Availability not set' : STATUS_LABEL[status]}
        filterCount={filterCount}
        liveEvents={bannerEvents}
        onSearch={() => router.push('/(tabs)/discovery')}
        onFilter={() => setSheetOpen(true)}
        onCityPress={openCityPicker}
      />

      {/* Live multi-status banner — computed from real event buckets + availability */}
      <PulseLiveBanner
        city={activeCity}
        events={bannerEvents}
        availabilityLabel={status === 'not_set' ? 'Set availability' : STATUS_LABEL[status]}
      />

      {/* Postcards — event/gem/trip cards that fit your time */}
      <View style={styles.fitsHead}>
        <Text style={styles.sectionTitle}>Postcards</Text>
        <View style={styles.insideBadge}><Text style={styles.insideText}>Fits your time</Text></View>
        <View style={{ flex: 1 }} />
        {fits.length > 0 && (
          <Pressable onPress={() => router.push('/(tabs)/trips')}><Text style={styles.viewAll}>View all ({fits.length})</Text></Pressable>
        )}
      </View>
      {noFits ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{status === 'not_set' ? 'Set your availability to see better matches.' : 'No plans fit your availability yet.'}</Text>
          <Text style={styles.emptySub}>Check flexible options below or create a plan.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fitsStrip}>
          {fits.map((e) => <FitsCard key={e.id} ev={e} />)}
        </ScrollView>
      )}

      {/* When you're flexible */}
      <FlexibleStrip events={buckets.flexible} />

      {/* Available Buddies in [City] — city-level buddy module shown below Fits strip */}
      {rentBuddyEnabled && (
        <View style={styles.buddyModule}>
          {/* Module header */}
          <View style={styles.buddyModuleHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.buddyModuleTitle}>Available Buddies in {activeCity}</Text>
              <Text style={styles.buddyModuleCount}>12 locals ready to help</Text>
            </View>
            <Pressable onPress={() => router.push('/(rent-a-buddy)/search' as any)}>
              <Text style={styles.buddyModuleViewAll}>View all →</Text>
            </Pressable>
          </View>
          {/* Top category chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.buddyCategoryRow}>
            {['Arrival Help', 'City Tour', 'Nightlife', 'Language', 'Content'].map((cat) => (
              <Pressable
                key={cat}
                style={styles.buddyCategoryChip}
                onPress={() => router.push(`/(rent-a-buddy)/search?city=${encodeURIComponent(activeCity)}&category=${cat.toLowerCase().replace(/\s+/g, '_')}` as any)}
              >
                <Text style={styles.buddyCategoryText}>{cat}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {/* 3 preview buddy cards */}
          <View style={styles.buddyPreviewRow}>
            {[
              { name: 'Marco T.', category: 'City Tour', rating: '4.9' },
              { name: 'Ana R.', category: 'Arrival Help', rating: '5.0' },
              { name: 'Jin S.', category: 'Nightlife', rating: '4.8' },
            ].map((buddy) => (
              <Pressable
                key={buddy.name}
                style={styles.buddyPreviewCard}
                onPress={() => router.push('/(rent-a-buddy)/search' as any)}
              >
                <View style={styles.buddyPreviewAvatar} />
                <Text style={styles.buddyPreviewName} numberOfLines={1}>{buddy.name}</Text>
                <Text style={styles.buddyPreviewCat} numberOfLines={1}>{buddy.category}</Text>
                <View style={styles.buddyPreviewRating}>
                  <Text style={styles.buddyPreviewRatingText}>★ {buddy.rating}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* People you may know — shown in For You mode only */}
      {feedMode === 'forYou' && <PeopleYouMayKnow refreshKey={peopleRefreshKey} />}

      {/* Pulse Wall section label — scrolls with pre-wall content */}
      <Text style={styles.wallTitle}>Pulse Wall</Text>
    </View>
  );

  const FollowingEmpty = (
    <View style={styles.followingEmpty}>
      <Text style={styles.followingEmptyTitle}>Follow travelers to see their public posts here.</Text>
      <Pressable style={styles.exploreBtn} onPress={() => router.push('/(tabs)/discovery')}>
        <Text style={styles.exploreBtnText}>Explore travelers</Text>
      </Pressable>
    </View>
  );

  const FollowingError = (
    <View style={styles.followingEmpty}>
      <Text style={styles.followingEmptyTitle}>Couldn't load your Following feed.</Text>
      <Pressable style={styles.exploreBtn} onPress={() => followingFeed.reload()}>
        <Text style={styles.exploreBtnText}>Retry</Text>
      </Pressable>
    </View>
  );

  const Footer = (
    <View>
      {feedMode === 'following' ? (
        followingFeed.loading ? (
          <View style={styles.loadingWrap}><ActivityIndicator size="large" color={color.signal} /></View>
        ) : followingFeed.error ? (
          FollowingError
        ) : followingItems.length === 0 ? (
          FollowingEmpty
        ) : null
      ) : (
        feed.length === 0 ? (
          <TravelEmptyState title="No results for these filters" sub="Try clearing a filter or switch to All." action="Clear filters" onAction={() => setActive(['All'])} />
        ) : null
      )}
      
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: pv.navy }}>
      {/* ── Sticky wall controls: mode toggle + category filter rail ──
           Both collapse in sync with the floating nav bar on scroll-down:
           the mode toggle folds away entirely; the rail keeps icons and
           collapses its labels. Everything restores on scroll-up. */}
      <View style={[styles.stickyControls, { paddingTop: insets.top + space.sm }]}>
        <Animated.View style={[styles.modeRowClip, animatedModeRow]}>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeBtn, feedMode === 'forYou' && styles.modeBtnActive]}
              onPress={() => handleFeedMode('forYou')}
            >
              <Text style={[styles.modeBtnText, feedMode === 'forYou' && styles.modeBtnTextActive]}>For You</Text>
            </Pressable>
            <Pressable
              style={[styles.modeBtn, feedMode === 'following' && styles.modeBtnActive]}
              onPress={() => handleFeedMode('following')}
            >
              <Text style={[styles.modeBtnText, feedMode === 'following' && styles.modeBtnTextActive]}>Following</Text>
            </Pressable>
          </View>
        </Animated.View>
        {feedMode === 'forYou' && (
          <Animated.View style={[styles.chipRowClip, animatedChipRow]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {QUICK_FILTERS.map((f) => {
                const isChipActive = active.includes(f);
                const label = CHIP_LABELS[f] ?? f;
                return (
                  <Pressable
                    key={f}
                    style={[styles.chip, isChipActive && styles.chipActive]}
                    onPress={() => toggleQuick(f)}
                    hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isChipActive }}
                    accessibilityLabel={`${label} filter${isChipActive ? ', selected' : ''}`}
                  >
                    <Text style={[styles.chipText, isChipActive && styles.chipTextActive]}>{label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Animated.View>
        )}
      </View>

      {/* New-posts pill — buffered fresh posts are one tap away, never a scroll jump */}
      {(() => {
        const pendingCount = feedMode === 'following' ? followingFeed.pending.length : realFeed.pending.length;
        if (pendingCount === 0) return null;
        return (
          <View style={styles.newPostsWrap} pointerEvents="box-none">
            <Pressable
              style={styles.newPostsPill}
              onPress={handleNewPostsPress}
              accessibilityRole="button"
              accessibilityLabel={`${pendingCount} new posts. Tap to show`}
            >
              <Text style={styles.newPostsText}>↑ {pendingCount} new post{pendingCount === 1 ? '' : 's'}</Text>
            </Pressable>
          </View>
        );
      })()}

      <FlatList
        ref={listRef}
        data={feed}
        keyExtractor={keyExtractor}
        ListHeaderComponent={Header}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        ListFooterComponent={Footer}
        renderItem={renderItem}
        ItemSeparatorComponent={FeedSeparator}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        overScrollMode="auto"
        refreshControl={
          <RefreshControl
            refreshing={feedMode === 'following' ? followingFeed.loading : realFeed.loading}
            onRefresh={handleRefresh}
            tintColor={pv.teal}
          />
        }
      />

      <PulseFilterSheet
        visible={sheetOpen}
        active={active.filter((f) => f !== 'All')}
        onToggle={toggleSheet}
        onClear={() => setActive(['All'])}
        onClose={() => setSheetOpen(false)}
      />
      <UnifiedPostComposer visible={createOpen} onClose={() => setCreateOpen(false)} onSuccess={() => realFeed.reload()} />

      {/* Location overlays */}
      <LocationPermissionPrompt />
      <ManualCityPicker />

      {/* Resume pill for an in-flight layover session */}
      <ActiveLayoverPill />

      {/* Layover Mode */}
      <LayoverModeSheet
        visible={layoverSheetOpen}
        onClose={() => setLayoverSheetOpen(false)}
        initialCity={activeCity}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /* "N new posts" pill — floats just under the sticky controls */
  newPostsWrap: { position: 'absolute', top: 190, left: 0, right: 0, alignItems: 'center', zIndex: 20 },
  newPostsPill: {
    backgroundColor: pv.teal, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  newPostsText: { ...t.bodyStrong, color: pv.navy, fontSize: 13 },
  stickyControls: {
    backgroundColor: pv.navy,
    // paddingTop is applied inline: insets.top + space.sm (accounts for status bar)
    // Subtle bottom shadow so the sticky bar reads as a layer above the feed
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    zIndex: 10,
  },
  fitsHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.md, flexWrap: 'wrap' },
  sectionTitle: { ...t.title, color: pv.text, fontSize: 20 },
  insideBadge: { backgroundColor: pv.navySoft, borderWidth: 1, borderColor: pv.navyEdge, borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 3 },
  insideText: { ...t.small, color: pv.teal, fontSize: 11, fontWeight: '600' },
  viewAll: { ...t.small, color: pv.teal, fontWeight: '700' },
  fitsStrip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: 14, borderWidth: 1, borderColor: pv.navyEdge, backgroundColor: pv.navyRaised },
  emptyTitle: { ...t.bodyStrong, color: pv.text },
  emptySub: { ...t.small, color: pv.textMute, marginTop: 4 },
  wallTitle: { ...t.title, color: pv.text, fontSize: 20, paddingHorizontal: space.lg, marginTop: 24, marginBottom: space.sm },
  // Clip container for the collapsing mode row — height/margin/opacity are
  // animated; the inner modeRow keeps its natural 42 px layout and gets
  // clipped as the container folds.
  modeRowClip: { overflow: 'hidden' },
  modeRow: { flexDirection: 'row', marginHorizontal: space.lg, borderRadius: 12, borderWidth: 1, borderColor: pv.navyEdge, backgroundColor: pv.navyRaised, padding: 3, gap: 3 },
  modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  modeBtnText: { ...t.bodyStrong, fontSize: 14, color: pv.textMute },
  modeBtnTextActive: { color: pv.text },
  /* Portava filter chips — values stay the internal PulseFilter truth */
  chipRowClip: { overflow: 'hidden', justifyContent: 'center' },
  chipRow: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 6 },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: pv.navyEdge, backgroundColor: pv.navySoft, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: pv.tealDim, borderColor: pv.teal },
  chipText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: pv.textMute },
  chipTextActive: { color: pv.teal, fontWeight: '800' },
  inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
  followingEmpty: { marginHorizontal: space.lg, marginTop: space.xl, padding: space.xl, borderRadius: 16, borderWidth: 1, borderColor: pv.navyEdge, backgroundColor: pv.navyRaised, alignItems: 'center', gap: space.md },
  followingEmptyTitle: { ...t.body, color: pv.text, textAlign: 'center', lineHeight: 22 },
  exploreBtn: { backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: 10 },
  exploreBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  loadingWrap: { paddingVertical: space.xxl, alignItems: 'center' },
  /* Available Buddies in [City] module */
  buddyModule: { marginHorizontal: space.lg, marginTop: space.lg, backgroundColor: '#FFF5F5', borderRadius: 14, borderWidth: 1, borderColor: '#E5393530', padding: space.md, gap: space.sm },
  buddyModuleHead: { flexDirection: 'row', alignItems: 'flex-start' },
  buddyModuleTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  buddyModuleCount: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  buddyModuleViewAll: { ...t.small, color: '#E53935', fontWeight: '700', fontSize: 12 },
  buddyCategoryRow: { gap: space.sm },
  buddyCategoryChip: { borderWidth: 1.5, borderColor: '#E53935', borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 5, backgroundColor: '#fff' },
  buddyCategoryText: { ...t.small, fontWeight: '700', color: '#E53935', fontSize: 11 },
  buddyPreviewRow: { flexDirection: 'row', gap: space.sm },
  buddyPreviewCard: { flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: color.haze, padding: space.sm, alignItems: 'center', gap: 3 },
  buddyPreviewAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.haze, marginBottom: 2 },
  buddyPreviewName: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 11 },
  buddyPreviewCat: { ...t.small, color: color.mute, fontSize: 10 },
  buddyPreviewRating: { backgroundColor: '#FFF3CD', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  buddyPreviewRatingText: { ...t.small, color: '#9A6700', fontWeight: '700', fontSize: 10 },
});
