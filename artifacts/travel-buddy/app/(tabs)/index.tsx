import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { PostCard } from '../../src/components/PostCard';
import { PulseHeader } from '../../src/components/PulseHeader';
import { FitsCard, FlexibleStrip } from '../../src/components/PulseFits';
import { PulseFeedCard } from '../../src/components/PulseFeedCard';
import { PulseFilterSheet, UnifiedPostComposer } from '../../src/components/PulseCreate';
import { PulseFilterRail } from '../../src/components/PulseFilterRail';
import { TravelEmptyState } from '../../src/components/primitives';
import { useCityPulse } from '../../src/hooks/useCityPulse';
import { useGlobalFeed, useFollowingFeed } from '../../src/hooks/usePosts';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { fetchPreferences } from '../../src/services/intelligence';
import { STATUS_LABEL } from '../../src/lib/availability';

import { PULSE_FILTERS } from '../../src/types/models';
import type { PulseFilter, PulseFeedItem } from '../../src/types/models';
import type { PostRow } from '../../src/services/posts';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { useLocationContext } from '../../src/context/LocationContext';
import { LocationPermissionPrompt } from '../../src/components/LocationPermissionPrompt';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { Users, MapPin } from 'lucide-react-native';
import { PeopleYouMayKnow } from '../../src/components/PeopleYouMayKnow';

const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Hidden Gems', 'Circle'];

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

  const { locationState, openCityPicker } = useLocationContext();
  const activeCity = locationState.place.city ?? 'Cebu City';
  const activeCitySlug = activeCity.toLowerCase().replace(/\s+/g, '-');

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

  const realFeed = useGlobalFeed();
  const followingFeed = useFollowingFeed();

  // When any post is deleted, remove it from both feeds so it cannot reappear on refresh
  const handlePostDeleted = useCallback((id: string) => {
    realFeed.markDeleted(id);
    followingFeed.markDeleted(id);
  }, [realFeed.markDeleted, followingFeed.markDeleted]);

  useFocusEffect(
    useCallback(() => {
      realFeed.reload();
      if (feedMode === 'following') followingFeed.reload();
    }, [realFeed.reload, followingFeed.reload, feedMode]),
  );

  // When switching to Following, load it on first activation.
  const handleFeedMode = useCallback((mode: FeedMode) => {
    setFeedMode(mode);
    if (mode === 'following') followingFeed.reload();
  }, [followingFeed.reload]);

  const handleRefresh = useCallback(() => {
    setPeopleRefreshKey((k) => k + 1);
    if (feedMode === 'following') followingFeed.reload();
    else realFeed.reload();
  }, [feedMode, followingFeed.reload, realFeed.reload]);

  const fits = [...buckets.fitsAvailability, ...buckets.openNearby];
  const noFits = fits.length === 0;

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
      createdAt: new Date().toISOString(),
      tags: [],
      source: 'editorial',
    };
    const insertAt = Math.min(3, baseFeed.length);
    return [...baseFeed.slice(0, insertAt), buddyItem, ...baseFeed.slice(insertAt)];
  }, [baseFeed, rentBuddyEnabled, feedMode, activeCity]);

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

      {/* Category filter rail — underline-tab style, For You mode only */}
      {feedMode === 'forYou' && (
        <PulseFilterRail
          filters={QUICK_FILTERS}
          active={active}
          onPress={(f) => toggleQuick(f as PulseFilter)}
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
        city={activeCity}
        cityFull={activeCity}
        availabilityText={status === 'not_set' ? 'Availability not set' : STATUS_LABEL[status]}
        filterCount={filterCount}
        onSearch={() => router.push('/(tabs)/discovery')}
        onFilter={() => setSheetOpen(true)}
        onCityPress={openCityPicker}
      />
      <FlatList
        data={feed}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={Header}
        ListFooterComponent={Footer}
        renderItem={({ item }) => (
          item.type === 'post' ? (
            <PulseFeedCard item={item} onDeleteSuccess={() => handlePostDeleted(item.id)} />
          ) : (
            <View style={{ paddingHorizontal: space.lg }}>
              <PulseFeedCard item={item} onDeleteSuccess={() => handlePostDeleted(item.id)} />
            </View>
          )
        )}
        ItemSeparatorComponent={({ leadingItem }) => (
          <View style={{ height: (leadingItem as any)?.type === 'post' ? 8 : space.md }} />
        )}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={feedMode === 'following' ? followingFeed.loading : realFeed.loading}
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
      <UnifiedPostComposer visible={createOpen} onClose={() => setCreateOpen(false)} onSuccess={() => realFeed.reload()} />

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
  wallTitle: { ...t.title, color: color.ink, fontSize: 20, paddingHorizontal: space.lg, marginTop: 24, marginBottom: space.sm },
  modeRow: { flexDirection: 'row', marginHorizontal: space.lg, marginBottom: space.sm, borderRadius: 12, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, padding: 3, gap: 3 },
  modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: color.paperRaised, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  modeBtnText: { ...t.bodyStrong, fontSize: 14, color: color.mute },
  modeBtnTextActive: { color: color.ink },
  inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
  followingEmpty: { marginHorizontal: space.lg, marginTop: space.xl, padding: space.xl, borderRadius: 16, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, alignItems: 'center', gap: space.md },
  followingEmptyTitle: { ...t.body, color: color.deep, textAlign: 'center', lineHeight: 22 },
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
