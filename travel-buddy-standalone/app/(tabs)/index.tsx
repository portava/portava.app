import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { getCommentCountSnapshot, subscribeCommentCount } from '../../src/lib/commentCountStore';
import { router, useFocusEffect } from 'expo-router';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { NotificationBell } from '../../src/components/NotificationBell';
import { FitsCard, FlexibleStrip } from '../../src/components/PulseFits';
import { ExploreTodaySection } from '../../src/components/ExploreTodaySection';
import { PulseFeedCard } from '../../src/components/PulseFeedCard';
import { PulseFilterSheet } from '../../src/components/PulseCreate';
import { Chip } from '../../src/components/ui';
import { TravelEmptyState } from '../../src/components/primitives';
import { useCityPulse } from '../../src/hooks/useCityPulse';
import { useFollowingFeed, FOCUS_REFETCH_TTL_MS } from '../../src/hooks/usePosts';
import { usePulseFeed } from '../../src/hooks/usePulseFeed';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { useCircleFlag } from '../../src/hooks/useCircleFlag';
import { getLaunchStatus } from '../../src/services/rentABuddy';
import { fetchPreferences } from '../../src/services/intelligence';
import { STATUS_LABEL } from '../../src/lib/availability';
import type { PulseFilter, PulseFeedItem } from '../../src/types/models';
import type { PostRow } from '../../src/services/posts';
import { color, space, radius, type as t, shadow, avatar } from '../../src/theme/tokens';
import { useLocationContext } from '../../src/context/LocationContext';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { ActiveLayoverPill } from '../../src/components/layover/ActiveLayoverPill';
import { Plane, Users, MapPin, MessageCircle, PlusCircle } from 'lucide-react-native';
import { PeopleYouMayKnow } from '../../src/components/PeopleYouMayKnow';
import { CircleCompassSuggestions } from '../../src/components/CircleCompassSuggestions';
import { LivePulseRail } from '../../src/components/LivePulseRail';
import { useLivePulse } from '../../src/hooks/useLivePulse';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';
import { useScreenTiming } from '../../src/hooks/useScreenTiming';
import { useSnapshotCache } from '../../src/hooks/useSnapshotCache';
import { LayoverSessionProvider } from '../../src/context/LayoverSessionContext';

const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];

/**
 * QA round 2, bugs 9 and 10.
 *
 * Bug 10 first, because it explains bug 9's symptom. QUICK_FILTERS is a strict
 * subset of PULSE_FILTERS (src/types/models.ts), which also offers Food,
 * Nightlife, Beach, Culture, Fits My Time and Open Now. Both the chip row and the
 * filter sheet write the SAME state (`active`) through byte-identical toggles, so
 * they were never actually out of sync — the chip row simply had no chip to
 * highlight for a sheet-only filter, which reads as "sheet says Food, chips say
 * All". `visibleFilters` in the component appends any active sheet-only filter to
 * the chip row so it is visible and dismissible.
 *
 * Bug 9: the feed's filter step was `realItems.filter(() => false)` for every
 * filter except All and Posts — an unconditional empty list. That is the blank
 * wall. Real matching lives below.
 *
 * Note on the "just send the filter to the server" fix: it does not work.
 * api-server/src/routes/pulse.ts types `tab` as
 * z.enum(['all','city','nearby','neighborhood','trip','crew','airport']) — those
 * are VISIBILITY scopes, not content categories — so `tab=food` is rejected as
 * invalid_payload. Category filtering has to happen client-side.
 */
const FILTER_TYPES: Partial<Record<PulseFilter, ReadonlyArray<PulseFeedItem['type']>>> = {
  Posts:         ['post'],
  Questions:     ['question'],
  Plans:         ['plan'],
  'Hidden Gems': ['hidden_gem'],
  Itineraries:   ['itinerary'],
  Circle:        ['circle_activity'],
};

/**
 * Category filters have no column of their own on PulseFeedItem — they match
 * against `tags`, which is what the category stamp on each card renders from.
 */
const FILTER_TAGS: Partial<Record<PulseFilter, ReadonlyArray<string>>> = {
  Food:      ['food', 'foodie', 'eat', 'eats', 'restaurant', 'cafe', 'coffee', 'dining', 'street food'],
  Nightlife: ['nightlife', 'night', 'bar', 'bars', 'club', 'clubs', 'party', 'drinks'],
  Beach:     ['beach', 'beaches', 'island', 'islands', 'sea', 'ocean', 'swim', 'surf', 'coast', 'diving', 'snorkel'],
  Culture:   ['culture', 'cultural', 'museum', 'museums', 'temple', 'church', 'heritage', 'history', 'historic', 'art', 'gallery'],
};

function pulseItemMatchesFilter(item: PulseFeedItem, filter: PulseFilter): boolean {
  if (filter === 'All') return true;
  const types = FILTER_TYPES[filter];
  if (types) return types.includes(item.type);
  const wanted = FILTER_TAGS[filter];
  if (wanted) {
    const tags = (item.tags ?? []).map((tag) => tag.trim().toLowerCase());
    return wanted.some((w) => tags.includes(w));
  }
  // 'Fits My Time' and 'Open Now' are availability filters and PulseFeedItem
  // carries no client-side signal for either. Leave the feed untouched rather
  // than blanking the wall — an empty result the user cannot explain is the
  // exact failure this bug was about.
  return true;
}

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
      username: p.author?.handle ?? null,
    },
    createdAt: p.createdAt,
    timeAgo: timeAgo(p.createdAt),
    tags: [categoryToStamp(p.category)],
    categoryFallback: !p.category,
    mediaUrl: p.mediaUrls?.[0],
    // Structured media passthrough — carries thumbnail/video info AND the
    // stamp_overlay jsonb that PulseFeedCard renders via MediaStampOverlay.
    media: p.media,
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

function Pulse() {
  const [feedMode, setFeedMode] = useState<FeedMode>('forYou');
  const [active, setActive] = useState<PulseFilter[]>(['All']);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  const bottomInset = useLayoverAwareBottomInset();
  const { markFirstContent, epoch } = useScreenTiming('Pulse');

  // Stale-while-revalidate: pre-paint the Pulse feed from the previous session's
  // snapshot before any network round-trip completes.
  const { snapshot: pulseSnapshot, save: savePulseSnapshot, clear: clearPulseSnapshot } = useSnapshotCache<PulseFeedItem[]>('pulse');
  const { locationState, openCityPicker } = useLocationContext();
  const activeCity = locationState.place.city ?? null;
  const activeCitySlug = (activeCity ?? '').toLowerCase().replace(/\s+/g, '-');

  // Single source of truth for "are buddies actually available in this city" —
  // same /rent-buddy/launch-status.availableNowCount field the Rent-a-Buddy
  // landing page and its "Available Now" list read.
  const [buddyAvailableCount, setBuddyAvailableCount] = useState<number | null>(null);
  useEffect(() => {
    if (!rentBuddyEnabled || !activeCity) { setBuddyAvailableCount(null); return; }
    let cancelled = false;
    // Debounce by ~300 ms so rapid city-picker scrolling doesn't fire a
    // network request for every intermediate city — only the final selection.
    const timer = setTimeout(() => {
      getLaunchStatus(activeCity).then((res) => {
        if (cancelled) return;
        setBuddyAvailableCount(res.ok ? (res.data.availableNowCount ?? 0) : 0);
      }).catch(() => { if (!cancelled) setBuddyAvailableCount(0); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rentBuddyEnabled, activeCity]);

  // Load learned category affinities from the preference engine so Pulse
  // ranking improves as the user interacts with recommendations.
  useEffect(() => {
    fetchPreferences().then((res) => {
      if (res.ok && res.data?.inferred?.categoryAffinities) {
        setCategoryAffinities(res.data.inferred.categoryAffinities);
      }
    }).catch(() => { /* best-effort: silently ignore if not logged in yet */ });
  }, []);

  const { buckets, events, status, sessionId: cityPulseSessionId } = useCityPulse({ currentCitySlug: activeCitySlug, interests: [], categoryAffinities });

  const livePulse = useLivePulse({
    context: activeCitySlug ? 'currentCity' : 'myPlans',
    citySlug: activeCitySlug || undefined,
    lat: locationState.coords?.lat,
    lng: locationState.coords?.lng,
  });

  // Primary Pulse feed: real posts + place cards from /api/pulse.
  const pulseFeed = usePulseFeed({
    city: activeCity ?? undefined,
    lat: locationState.coords?.lat,
    lng: locationState.coords?.lng,
  });
  const followingFeed = useFollowingFeed();

  // Tracks when the last Pulse/following feed reload fired so focus-driven
  // reloads are skipped within the TTL window (avoids refetch storms on tab switches).
  const lastPulseFetchAt = useRef(0);

  // When any post is deleted, remove it from both feeds so it cannot reappear on refresh
  const handlePostDeleted = useCallback((id: string) => {
    pulseFeed.markDeleted(id);
    followingFeed.markDeleted(id);
  }, [pulseFeed.markDeleted, followingFeed.markDeleted]);

  useFocusEffect(
    useCallback(() => {
      // Seed overrides from the store snapshot so feed cards reflect any
      // comment count changes made on the detail screen before the reload lands.
      const snapshot = getCommentCountSnapshot();
      if (snapshot.size > 0) {
        setCommentCountOverrides(new Map(snapshot));
      }
      // TTL guard: skip the network reload if data is still fresh (60 s).
      // Pull-to-refresh resets lastPulseFetchAt.current = 0 to bypass this.
      if (Date.now() - lastPulseFetchAt.current >= FOCUS_REFETCH_TTL_MS) {
        pulseFeed.reload();
        if (feedMode === 'following') followingFeed.reload();
        lastPulseFetchAt.current = Date.now();
      }
      // Refresh the Live Pulse rail whenever the Pulse tab is focused so
      // users always see fresh data on re-open, not just on mount or pull-to-refresh.
      // This is a lightweight subscription refresh — kept outside the TTL guard.
      livePulse.refresh();
    }, [pulseFeed.reload, followingFeed.reload, feedMode, livePulse.refresh]),
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
    // Reset TTL so the next focus-driven reload fires unconditionally.
    lastPulseFetchAt.current = 0;
    // Clear snapshot so pull-to-refresh forces a full network reload.
    clearPulseSnapshot();
    setPeopleRefreshKey((k) => k + 1);
    livePulse.refresh();
    if (feedMode === 'following') followingFeed.reload();
    else pulseFeed.reload();
  }, [feedMode, followingFeed.reload, pulseFeed.reload, livePulse.refresh, clearPulseSnapshot]);

  // Track whether the initial network load has completed — once true, live data
  // (even empty) always wins over the snapshot so stale items are never sticky.
  const [pulseLoadedOnce, setPulseLoadedOnce] = useState(false);
  useEffect(() => {
    if (!pulseFeed.loading && !pulseLoadedOnce) setPulseLoadedOnce(true);
  }, [pulseFeed.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Perf timing: before first load, fire when snapshot has data;
  // after first load, fire only when live data is present.
  useEffect(() => {
    const hasContent = pulseLoadedOnce
      ? pulseFeed.items.length > 0
      : pulseFeed.items.length > 0 || (pulseSnapshot?.length ?? 0) > 0;
    if (hasContent) markFirstContent();
  }, [epoch, pulseLoadedOnce, pulseFeed.items.length > 0, (pulseSnapshot?.length ?? 0) > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Guard: fitsAvailability/openNearby are always arrays from filterPulse, but
  // a stale Metro bundler cache can serve an older version of recommend.ts that
  // returned {fits, flexible} (old property names), leaving these undefined and
  // causing a "not iterable" TypeError on every Pulse tab open. ?? [] makes the
  // spread safe against cache-version skew and any future bucket-shape changes.
  const fits = [...(buckets.fitsAvailability ?? []), ...(buckets.openNearby ?? [])];
  const noFits = fits.length === 0;

  // pulseFeed.items are already PulseFeedItem[] (pre-mapped by usePulseFeed).
  // Use snapshot only while the initial load is in-flight. Once any response
  // arrives (even empty) live data always wins — no stale items left on screen.
  const realItems = useMemo<PulseFeedItem[]>(
    () => pulseLoadedOnce ? pulseFeed.items : (pulseSnapshot ?? pulseFeed.items),
    [pulseFeed.items, pulseSnapshot, pulseLoadedOnce],
  );

  // Persist feed items to the snapshot cache after each successful load.
  // Save even on empty arrays so a genuinely-empty feed clears the old snapshot.
  useEffect(() => {
    if (!pulseFeed.loading && !pulseFeed.error) {
      savePulseSnapshot(pulseFeed.items);
    }
  }, [pulseFeed.items, pulseFeed.loading, pulseFeed.error, savePulseSnapshot]);

  const forYouFeed = useMemo<PulseFeedItem[]>(() => {
    // QA round 2, bug 9: was `realItems.filter(() => false)` for every filter
    // other than All/Posts — i.e. the Food filter could only ever return nothing.
    const filteredReal = active.includes('All')
      ? realItems
      : realItems.filter((it) => active.some((f) => pulseItemMatchesFilter(it, f)));
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
    // QA round 2, bug 9: the synthetic rent_a_buddy card was injected even into an
    // EMPTY feed, so `feed.length` was never 0 and the "No results for these
    // filters" empty state below could never render — the user saw a blank wall
    // with one promo card and no explanation. Skip the injection when there is
    // nothing to interleave it with.
    if (!rentBuddyEnabled || feedMode === 'following' || baseFeed.length === 0) {
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
  // QA round 2, bug 10: surface any active sheet-only filter (Food, Nightlife,
  // Beach, Culture, Fits My Time, Open Now) in the chip row, so the two filter
  // UIs visibly agree and the filter can be cleared from either one.
  const visibleFilters = useMemo<PulseFilter[]>(
    () => [...QUICK_FILTERS, ...active.filter((f) => !QUICK_FILTERS.includes(f))],
    [active],
  );

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
      {/* AppHeader lives inside ListHeaderComponent so it scrolls with the feed
          (collapsing-header design). A compact overlay bar at root takes the
          "fixed" role once the large header scrolls off screen. */}
      <AppHeader
        variant="primary"
        title="Pulse"
        rightActions={[
          { icon: <NotificationBell />, accessibilityLabel: 'Notifications' },
          { icon: <MessageCircle size={22} color={color.ink} />, onPress: () => router.push('/(tabs)/messages' as any), accessibilityLabel: 'Messages' },
          { icon: <PlusCircle size={22} color={color.ink} />, onPress: () => router.push('/create' as any), accessibilityLabel: 'Create post' },
        ]}
        overflowActions={[
          { label: filterCount > 0 ? `Filters (${filterCount})` : 'Filters', onPress: () => setSheetOpen(true) },
        ]}
      />
      {/* Live Pulse smart rail — above all other sections */}
      <LivePulseRail pulse={livePulse} />

      {activeCity ? (
        status === 'not_set' ? (
          // ── Explore Today — user has no availability set ─────────────────
          // Availability improves personalisation but must not gate Pulse's
          // usefulness. Show what's happening in the city right now instead of
          // a dead-end message telling the user to set availability first.
          <ExploreTodaySection events={events} city={activeCity} sessionId={cityPulseSessionId} />
        ) : (
          <>
            {/* Fits your time — only visible when availability is set */}
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
                <Text style={styles.emptyTitle}>No plans fit your availability yet.</Text>
                <Text style={styles.emptySub}>Check flexible options below or create a plan.</Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fitsStrip}>
                {fits.map((e) => <FitsCard key={e.id} ev={e} sessionId={cityPulseSessionId} />)}
              </ScrollView>
            )}

            {/* When you're flexible */}
            <FlexibleStrip events={buckets.flexible} />
          </>
        )
      ) : (
        <Pressable style={styles.cityCta} onPress={openCityPicker}>
          <MapPin size={16} color={color.signal} />
          <Text style={styles.cityCtaText}>Tell us your city to see plans, events, and travelers near you →</Text>
        </Pressable>
      )}

      {/* Layover Mode entry point */}
      <Pressable style={styles.layoverBanner} onPress={() => setLayoverSheetOpen(true)}>
        <View style={styles.layoverBannerIcon}>
          <Plane size={18} color="#1565C0" />
        </View>
        <View style={styles.layoverBannerBody}>
          <Text style={styles.layoverBannerTitle}>Layover Mode</Text>
          <Text style={styles.layoverBannerSubText}>Plan your time, stay safe, find things to do →</Text>
        </View>
      </Pressable>

      {/* Available Buddies in [City] — city-level buddy module shown below Layover banner */}
      {rentBuddyEnabled && (
        <View style={styles.buddyModule}>
          {/* Module header */}
          <View style={styles.buddyModuleHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.buddyModuleTitle}>
                {buddyAvailableCount && buddyAvailableCount > 0
                  ? `Available Buddies in ${activeCity ?? 'your city'}`
                  : `Rent a Buddy in ${activeCity ?? 'your city'}`}
              </Text>
              <Text style={styles.buddyModuleCount}>
                {buddyAvailableCount == null
                  ? 'Checking availability…'
                  : buddyAvailableCount > 0
                    ? 'Local buddies available'
                    : `No buddies online right now in ${activeCity} — check back soon`}
              </Text>
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

  const isLoadingMore =
    feedMode === 'following' ? followingFeed.loadingMore : pulseFeed.loadingMore;

  // The Wall is auth-only: /api/pulse answers 401 without a bearer token. It used
  // to show "Check your connection and try again" for every failure, including
  // the signed-out one — which the app already knew about, since getPulseData
  // returns errorKind:'unauthenticated' before it even makes the request. A
  // signed-out user was being sent to debug their wifi.
  const forYouSignedOut = pulseFeed.errorKind === 'unauthenticated';
  const ForYouError = (
    <View style={styles.followingEmpty}>
      <Text style={styles.followingEmptyTitle}>
        {forYouSignedOut
          ? 'Sign in to see your For You feed.'
          : "Couldn't load the For You feed. Check your connection and try again."}
      </Text>
      <Pressable
        style={styles.exploreBtn}
        onPress={() => (forYouSignedOut ? router.push('/(auth)/sign-in' as any) : pulseFeed.reload())}
      >
        <Text style={styles.exploreBtnText}>{forYouSignedOut ? 'Sign in' : 'Retry'}</Text>
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
      ) : pulseFeed.loading && feed.length === 0 ? (
        // Initial For You load — spinner, not a misleading empty state.
        <View style={styles.loadingWrap}><ActivityIndicator size="large" color={color.signal} /></View>
      ) : pulseFeed.error ? (
        ForYouError
      ) : feed.length === 0 ? (
        <TravelEmptyState title="No results for these filters" sub="Try clearing a filter or switch to All." action="Clear filters" onAction={() => setActive(['All'])} />
      ) : null}
      {isLoadingMore && (
        <View style={styles.loadMoreWrap}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <FlatList
        data={feed}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={Header}
        ListFooterComponent={Footer}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: space.lg }}>
            <PulseFeedCard item={item} onDeleteSuccess={() => handlePostDeleted(item.id)} sessionId={pulseFeed.sessionId} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}
        onEndReached={() => {
          if (feedMode === 'following') followingFeed.loadMore();
          else pulseFeed.loadMore();
        }}
        onEndReachedThreshold={0.3}
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
      {/* Post composer lives on the full-screen /create route (pushed by the
          tab-bar POST button and the various "Add Post" CTAs); the feed
          refreshes via the focus-effect reload when the page pops back. */}

      {/* Location overlays — the permission prompt itself is now mounted
          globally in app/(tabs)/_layout.tsx so it fires regardless of which
          tab the user lands on after login; only the city picker stays here. */}
      <ManualCityPicker />

      {/* Layover Mode */}
      <ActiveLayoverPill />
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
  loadMoreWrap: { paddingVertical: space.lg, alignItems: 'center' },
  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: space.lg, marginTop: space.lg, marginBottom: space.sm, backgroundColor: '#E3F2FD', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#BBDEFB' },
  layoverBannerIcon: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#BBDEFB' },
  layoverBannerBody: { flex: 1, gap: 1 },
  layoverBannerTitle: { fontSize: 14, fontWeight: '700', color: '#0D47A1' },
  layoverBannerSubText: { fontSize: 12, fontWeight: '400', color: '#1565C0', opacity: 0.85 },
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

// Wrapped: a render throw anywhere in Pulse (the default landing tab) must
// show the recoverable error screen, never a white screen. Matches
// discovery.tsx / trips.tsx / trip/[id].tsx.
//
// LayoverSessionProvider owns the single getActiveLayoverSession call per
// focus event; both ActiveLayoverPill and useLayoverAwareBottomInset (used
// inside <Pulse />) read from the shared context instead of each firing their
// own fetch.
export default function PulseScreen() {
  return (
    <ScreenErrorBoundary>
      <LayoverSessionProvider>
        <Pulse />
      </LayoverSessionProvider>
    </ScreenErrorBoundary>
  );
}
