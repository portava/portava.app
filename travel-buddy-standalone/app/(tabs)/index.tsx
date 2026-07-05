import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { getCommentCountSnapshot, subscribeCommentCount } from '../../src/lib/commentCountStore';
import { router, useFocusEffect } from 'expo-router';
import { PostCard } from '../../src/components/PostCard';
import { PulseHeader } from '../../src/components/PulseHeader';
import { FitsCard, FlexibleStrip } from '../../src/components/PulseFits';
import { PulseFeedCard } from '../../src/components/PulseFeedCard';
import { PulseFilterSheet, UnifiedPostComposer } from '../../src/components/PulseCreate';
import { Chip } from '../../src/components/ui';
import { TravelEmptyState } from '../../src/components/primitives';
import { useCityPulse } from '../../src/hooks/useCityPulse';
import { useFollowingFeed } from '../../src/hooks/usePosts';
import { usePulseFeed } from '../../src/hooks/usePulseFeed';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { useCircleFlag } from '../../src/hooks/useCircleFlag';
import { fetchPreferences } from '../../src/services/intelligence';
import { STATUS_LABEL } from '../../src/lib/availability';
import type { PulseFilter, PulseFeedItem } from '../../src/types/models';
import type { PostRow } from '../../src/services/posts';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { useLocationContext } from '../../src/context/LocationContext';
import { LocationPermissionPrompt } from '../../src/components/LocationPermissionPrompt';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { Plane, Users, MapPin } from 'lucide-react-native';
import { PeopleYouMayKnow } from '../../src/components/PeopleYouMayKnow';
import { CircleCompassSuggestions } from '../../src/components/CircleCompassSuggestions';

const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];

type FeedMode = 'forYou' | 'following';

/** Convert a real PostRow from the API into a PulseFeedItem for the Pulse Wall. */
function postRowToFeedItem(p: PostRow): PulseFeedItem {
  return {
    id: p.id,
    type: 'post',
    city: p.locationCity ?? 'Traveler Post',
    author: {
      id: p.authorId,
      name: p.author?.name ?? 'Traveler',
      avatarUrl: p.author?.avatarUrl ?? '',
    },
    createdAt: p.createdAt,
    timeAgo: timeAgo(p.createdAt),
    tags: [categoryToStamp(p.category)],
    categoryFallback: !p.category,
    mediaUrl: p.mediaUrls[0],
    caption: p.content,
    source: 'user',
    neighborhood: p.locationName ?? undefined,
    visibility: p.visibility === 'trip_only' ? 'private' : (p.visibility as 'public' | 'private'),
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    likedByMe: p.likedByMe,
    canLike: p.canLike,
    canComment: p.canComment,
    canShare: p.canShare,
    spanTags: p.tags,
    spanHashtags: p.hashtagUsages,
  };
}

/** Map a PostCategory slug to a human-readable stamp label. Falls back to 'Travel'. */
function categoryToStamp(cat: string | null | undefined): string {
  if (!cat) return 'Travel';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Pulse() {
  const [feedMode, setFeedMode] = useState<FeedMode>('forYou');
  const [active, setActive] = useState<PulseFilter[]>(['All']);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [layoverSheetOpen, setLayoverSheetOpen] = useState(false);
  const [categoryAffinities, setCategoryAffinities] = useState<Record<string, number>>({});
  const [peopleRefreshKey, setPeopleRefreshKey] = useState(0);
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const { enabled: circleEnabled } = useCircleFlag();

  // Comment count overrides: populated by the post detail screen via commentCountStore.
  // Initialised from the store snapshot so overrides from a previous visit are applied
  // immediately on mount, before any reload completes.
  const [commentCountOverrides, setCommentCountOverrides] = useState<Map<string, number>>(
    () => new Map(getCommentCountSnapshot()),
  );

  const { locationState, openCityPicker } = useLocationContext();
  const activeCity = locationState.place.city ?? null;
  const activeCitySlug = (activeCity ?? '').toLowerCase().replace(/\s+/g, '-');

  // Load learned category affinities from the preference engine so Pulse
  // ranking improves as the user interacts with recommendations.
  useEffect(() => {
    fetchPreferences().then((res) => {
      if (res.ok && res.data?.inferred?.categoryAffinities) {
        setCategoryAffinities(res.data.inferred.categoryAffinities);
      }
    }).catch(() => { /* best-effort: silently ignore if not logged in yet */ });
  }, []);

  const { buckets, status } = useCityPulse({ currentCitySlug: activeCitySlug, interests: [], categoryAffinities });

  // Primary Pulse feed: real posts + place cards from /api/pulse.
  const pulseFeed = usePulseFeed({
    city: activeCity ?? undefined,
    lat: locationState.coords?.lat,
    lng: locationState.coords?.lng,
  });
  const followingFeed = useFollowingFeed();

  useFocusEffect(
    useCallback(() => {
      // Seed overrides from the store snapshot so feed cards reflect any
      // comment count changes made on the detail screen before the reload lands.
      const snapshot = getCommentCountSnapshot();
      if (snapshot.size > 0) {
        setCommentCountOverrides(new Map(snapshot));
      }
      pulseFeed.reload();
      if (feedMode === 'following') followingFeed.reload();
    }, [pulseFeed.reload, followingFeed.reload, feedMode]),
  );

  // Keep overrides in sync while the detail screen is open in the background
  // (e.g. the user opens comments, adds one, then returns).
  useEffect(() => {
    return subscribeCommentCount((postId, count) => {
      setCommentCountOverrides((prev) => {
        const next = new Map(prev);
        next.set(postId, count);
        return next;
      });
    });
  }, []);

  // When switching to Following, load it on first activation.
  const handleFeedMode = useCallback((mode: FeedMode) => {
    setFeedMode(mode);
    if (mode === 'following') followingFeed.reload();
  }, [followingFeed.reload]);

  const handleRefresh = useCallback(() => {
    setPeopleRefreshKey((k) => k + 1);
    if (feedMode === 'following') followingFeed.reload();
    else pulseFeed.reload();
  }, [feedMode, followingFeed.reload, pulseFeed.reload]);

  const fits = [...buckets.fitsAvailability, ...buckets.openNearby];
  const noFits = fits.length === 0;

  // pulseFeed.items are already PulseFeedItem[] (pre-mapped by usePulseFeed)
  const realItems = useMemo<PulseFeedItem[]>(
    () => pulseFeed.items,
    [pulseFeed.items],
  );

  const forYouFeed = useMemo<PulseFeedItem[]>(() => {
    const filteredReal = active.includes('All') || active.includes('Posts')
      ? realItems
      : realItems.filter(() => false);
    // Place cards only shown in All / default view (not when a specific type filter is active)
    const showPlaceCards = active.includes('All') && realItems.length < 5;
    return [...filteredReal, ...(showPlaceCards ? pulseFeed.placeCards : [])];
  }, [realItems, pulseFeed.placeCards, active]);

  const followingItems = useMemo<PulseFeedItem[]>(
    () => (followingFeed.data ?? []).map(postRowToFeedItem),
    [followingFeed.data],
  );

  const baseFeed = feedMode === 'following' ? followingItems : forYouFeed;

  // Inject a synthetic rent_a_buddy feed item (rendered by PulseFeedCard switch) at position 3
  const feed = useMemo<PulseFeedItem[]>(() => {
    let result: PulseFeedItem[];
    if (!rentBuddyEnabled || feedMode === 'following') {
      result = baseFeed;
    } else {
      const buddyItem: PulseFeedItem = {
        id: '__rent_a_buddy__',
        type: 'rent_a_buddy',
        city: activeCity ?? '',
        createdAt: new Date().toISOString(),
        tags: [],
        source: 'editorial',
      };
      const insertAt = Math.min(3, baseFeed.length);
      result = [...baseFeed.slice(0, insertAt), buddyItem, ...baseFeed.slice(insertAt)];
    }

    // Apply comment count overrides from the detail screen so counts are
    // correct immediately on return, without waiting for the feed reload.
    // Only applies to real user posts (type === 'post') — synthetic items like
    // rent_a_buddy have no post ID in the store and must not be mutated.
    if (commentCountOverrides.size === 0) return result;
    return result.map((item) => {
      if (item.type !== 'post') return item;
      const override = commentCountOverrides.get(item.id);
      if (override === undefined || override === item.commentCount) return item;
      return { ...item, commentCount: override };
    });
  }, [baseFeed, rentBuddyEnabled, feedMode, activeCity, commentCountOverrides]);

  const filterCount = active.filter((f) => f !== 'All').length;

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
      {activeCity ? (
        <>
          {/* Fits your time */}
          <View style={styles.fitsHead}>
            <Text style={styles.sectionTitle}>Fits your time</Text>
            <View style={styles.insideBadge}><Text style={styles.insideText}>Inside your availability</Text></View>
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
        </>
      ) : (
        <Pressable style={styles.cityCta} onPress={openCityPicker}>
          <MapPin size={16} color={color.signal} />
          <Text style={styles.cityCtaText}>Tell us your city to see plans, events, and travelers near you →</Text>
        </Pressable>
      )}

      {/* Layover Mode entry point */}
      <Pressable style={styles.layoverBanner} onPress={() => setLayoverSheetOpen(true)}>
        <Plane size={16} color="#1565C0" />
        <Text style={styles.layoverBannerText}>Got a layover? Get activities, safety tips & more →</Text>
      </Pressable>

      {/* Available Buddies in [City] — city-level buddy module shown below Layover banner */}
      {rentBuddyEnabled && (
        <View style={styles.buddyModule}>
          {/* Module header */}
          <View style={styles.buddyModuleHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.buddyModuleTitle}>Available Buddies in {activeCity ?? 'your city'}</Text>
              <Text style={styles.buddyModuleCount}>Local buddies available</Text>
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
                onPress={() => router.push(`/(rent-a-buddy)/search?city=${encodeURIComponent(activeCity ?? '')}&category=${cat.toLowerCase().replace(/\s+/g, '_')}` as any)}
              >
                <Text style={styles.buddyCategoryText}>{cat}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {/* Browse all buddies CTA */}
          <Pressable
            style={styles.buddyBrowseBtn}
            onPress={() => router.push(`/(rent-a-buddy)/search?city=${encodeURIComponent(activeCity ?? '')}` as any)}
          >
            <Users size={16} color="#E53935" />
            <Text style={styles.buddyBrowseBtnText}>Browse local buddies in {activeCity}</Text>
          </Pressable>
        </View>
      )}

      {/* Circle suggestions — shown in For You mode when find_your_circle_enabled flag is on */}
      {feedMode === 'forYou' && circleEnabled && <CircleCompassSuggestions />}

      {/* People you may know — shown in For You mode only */}
      {feedMode === 'forYou' && <PeopleYouMayKnow refreshKey={peopleRefreshKey} />}

      {/* Pulse Wall — feed mode toggle + quick filters */}
      <Text style={styles.wallTitle}>Pulse Wall</Text>

      {/* For You / Following toggle */}
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

      {/* Quick filter chips — only visible in For You mode */}
      {feedMode === 'forYou' && (
        <FlatList
          data={QUICK_FILTERS}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(x) => x}
          contentContainerStyle={styles.filterRow}
          renderItem={({ item }) => (
            <Chip label={item} active={active.includes(item)} onPress={() => toggleQuick(item)} />
          )}
        />
      )}
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
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <PulseHeader
        city={activeCity ?? ''}
        cityFull={activeCity ?? ''}
        availabilityText={status === 'not_set' ? 'Availability not set' : STATUS_LABEL[status]}
        filterCount={filterCount}
        onSearch={() => router.push('/search' as any)}
        onFilter={() => setSheetOpen(true)}
        onCityPress={openCityPicker}
      />
      <FlatList
        data={feed}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={Header}
        ListFooterComponent={Footer}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: space.lg }}>
            <PulseFeedCard item={item} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={feedMode === 'following' ? followingFeed.loading : pulseFeed.loading}
            onRefresh={handleRefresh}
            tintColor={color.signal}
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
      <UnifiedPostComposer visible={createOpen} onClose={() => setCreateOpen(false)} onSuccess={() => pulseFeed.reload()} />

      {/* Location overlays */}
      <LocationPermissionPrompt />
      <ManualCityPicker />

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
  fitsHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.md, flexWrap: 'wrap' },
  sectionTitle: { ...t.title, color: color.ink, fontSize: 20 },
  insideBadge: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 3 },
  insideText: { ...t.small, color: color.deep, fontSize: 11, fontWeight: '600' },
  viewAll: { ...t.small, color: color.signal, fontWeight: '700' },
  fitsStrip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: 14, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, marginTop: 4 },
  wallTitle: { ...t.title, color: color.ink, fontSize: 20, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
  modeRow: { flexDirection: 'row', marginHorizontal: space.lg, marginBottom: space.md, borderRadius: 12, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, padding: 3, gap: 3 },
  modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: color.paper, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  modeBtnText: { ...t.bodyStrong, fontSize: 14, color: color.mute },
  modeBtnTextActive: { color: color.ink },
  filterRow: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
  followingEmpty: { marginHorizontal: space.lg, marginTop: space.xl, padding: space.xl, borderRadius: 16, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, alignItems: 'center', gap: space.md },
  followingEmptyTitle: { ...t.body, color: color.deep, textAlign: 'center', lineHeight: 22 },
  exploreBtn: { backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: 10 },
  exploreBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  loadingWrap: { paddingVertical: space.xxl, alignItems: 'center' },
  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: space.lg, marginTop: space.lg, marginBottom: space.sm, backgroundColor: '#E3F2FD', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  layoverBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: '#1565C0' },
  /* Available Buddies in [City] module */
  buddyModule: { marginHorizontal: space.lg, marginTop: space.lg, backgroundColor: '#FFF5F5', borderRadius: 14, borderWidth: 1, borderColor: '#E5393530', padding: space.md, gap: space.sm },
  buddyModuleHead: { flexDirection: 'row', alignItems: 'flex-start' },
  buddyModuleTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  buddyModuleCount: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  buddyModuleViewAll: { ...t.small, color: '#E53935', fontWeight: '700', fontSize: 12 },
  buddyCategoryRow: { gap: space.sm },
  buddyCategoryChip: { borderWidth: 1.5, borderColor: '#E53935', borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 5, backgroundColor: '#fff' },
  buddyCategoryText: { ...t.small, fontWeight: '700', color: '#E53935', fontSize: 11 },
  buddyBrowseBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E53935', borderRadius: 10, paddingVertical: 12 },
  buddyBrowseBtnText: { ...t.small, fontWeight: '700', color: '#E53935', fontSize: 13 },
  cityCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.lg,
    marginBottom: space.sm,
    backgroundColor: color.signal + '10',
    borderWidth: 1,
    borderColor: color.signal + '40',
    borderRadius: 12,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  cityCtaText: { flex: 1, ...t.small, fontWeight: '600', color: color.signal, fontSize: 13, lineHeight: 18 },
});
