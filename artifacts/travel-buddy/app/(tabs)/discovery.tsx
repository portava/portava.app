import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Platform, TextInput, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation, Plane, Users, Hash, PlusCircle, Search, SlidersHorizontal,
} from 'lucide-react-native';
import { getTrendingHashtags, type TrendingHashtag } from '../../src/services/hashtag';
import type { DiscoveryAgeFilter } from '../../src/services/discovery';
import type { Place } from '../../src/lib/location/placeTypes';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { DiscoveryCategory, DiscoveryPlace, DiscoveryContextMode, DiscoveryFilters } from '../../src/services/discovery';
import { getDiscoveryCategoryCounts } from '../../src/services/discovery';
import { DiscoveryCategoryTab } from '../../src/components/discovery/DiscoveryCategoryTab';
import { PlaceDetailSheet } from '../../src/components/discovery/PlaceDetailSheet';
import { ForYouTab } from '../../src/components/discovery/ForYouTab';
import { DestinationBar } from '../../src/components/discovery/DestinationBar';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { getAvailableNow, type BuddyProfile } from '../../src/services/rentABuddy';
import { CompassBuddyRow } from '../../src/components/compass/CompassBuddyRow';
import { useSession } from '../../src/context/SessionContext';
import { useLocationContext } from '../../src/context/LocationContext';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { FollowingHighlightsStrip } from '../../src/components/FollowingHighlightsStrip';
import { useFollowingHighlights } from '../../src/hooks/useFollowingHighlights';
import { RouteBuilderSheet } from '../../src/components/RouteBuilderSheet';
import type { RouteStopDraft } from '../../src/components/RouteBuilderSheet';
import { SubmitPlaceSheet } from '../../src/components/discovery/SubmitPlaceSheet';

// ── Tab definitions ───────────────────────────────────────────────────────────

interface HubTab {
  key: DiscoveryCategory;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const TABS: HubTab[] = [
  { key: 'for_you',    label: 'For You',    Icon: Sparkles    },
  { key: 'places',     label: 'Places',     Icon: MapPin      },
  { key: 'food',       label: 'Food',       Icon: Coffee      },
  { key: 'nightlife',  label: 'Nightlife',  Icon: Moon        },
  { key: 'activities', label: 'Activities', Icon: Activity    },
  { key: 'events',     label: 'Events',     Icon: Calendar    },
  { key: 'beaches',    label: 'Beaches',    Icon: Waves       },
  { key: 'transport',  label: 'Transport',  Icon: Navigation  },
];

const VALID_CATEGORY_KEYS = TABS.map((t) => t.key);

// ── Context modes ─────────────────────────────────────────────────────────────

interface ContextModeItem {
  key: DiscoveryContextMode;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const CONTEXT_MODES: ContextModeItem[] = [
  { key: 'near_me',      label: 'Near Me',      Icon: Navigation },
  { key: 'in_city',      label: 'In City',      Icon: MapPin     },
  { key: 'going_soon',   label: 'Going Soon',   Icon: Calendar   },
  { key: 'around_crew',  label: 'Around Crew',  Icon: Compass    },
  { key: 'safe_nearby',  label: 'Safe Nearby',  Icon: Activity   },
];

// ── Main screen ───────────────────────────────────────────────────────────────

export default function DiscoveryHub() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const { open: openPlanPicker } = usePlanPicker();
  const { locationState, showCityPicker, openCityPicker, closeCityPicker, setManualCity } = useLocationContext();
  const { users: highlightUsers, sessionViewedIds, markSessionViewed } = useFollowingHighlights();
  const currentCity = locationState.place.city ?? null;

  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([]);
  useEffect(() => {
    getTrendingHashtags('city', currentCity).then((res) => {
      if (res.ok && res.data) setTrendingHashtags(res.data.trending.slice(0, 12));
    }).catch(() => {});
  }, [currentCity]);

  // Deep-link: ?category=food navigates to that tab on mount
  const params = useLocalSearchParams<{ category?: string }>();
  const initialCategory = (
    VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)
      ? params.category as DiscoveryCategory
      : 'for_you'
  );

  const [activeTab, setActiveTab] = useState<DiscoveryCategory>(initialCategory);
  // Seed from location context city if available; fall back to 'Paris' so
  // content fetches start immediately without a blank screen.
  const [destination, setDestination] = useState(
    () => locationState.place.city ?? 'Paris'
  );
  const [destinationLat, setDestinationLat] = useState<number | null>(
    () => locationState.coords?.lat ?? null
  );
  const [destinationLng, setDestinationLng] = useState<number | null>(
    () => locationState.coords?.lng ?? null
  );
  const [destinationZoom, setDestinationZoom] = useState<number>(11);
  const [contextMode, setContextMode] = useState<DiscoveryContextMode>('in_city');
  const [ageFilter, setAgeFilter] = useState<DiscoveryAgeFilter>('any');
  // Single object so any preset updating both min and max is one setState call →
  // one render → one debounce cycle (avoids the double-fetch when both change together).
  const [customAgeRange, setCustomAgeRange] = useState<{ min: number | null; max: number | null }>({ min: null, max: null });
  // Debounced copy — used only for the count-badge effect so that typing in
  // the custom age TextInputs does not fire 7 parallel API requests per keystroke.
  const [debouncedAgeRange, setDebouncedAgeRange] = useState<{ min: number | null; max: number | null }>({ min: null, max: null });
  const [selectedPlace, setSelectedPlace] = useState<DiscoveryPlace | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [routeBuilderDraft, setRouteBuilderDraft] = useState<RouteStopDraft | null>(null);
  const [routeBuilderOpen, setRouteBuilderOpen] = useState(false);
  const [submitPlaceOpen, setSubmitPlaceOpen] = useState(false);
  const [agePickerOpen, setAgePickerOpen] = useState(false);
  const [communityRefreshKey, setCommunityRefreshKey] = useState(0);
  const [categoryCounts, setCategoryCounts] = useState<Partial<Record<DiscoveryCategory, number>>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const [activeFilters, setActiveFilters] = useState<DiscoveryFilters>({ radiusKm: 10, openNow: false, minRating: null });
  const [availableBuddies, setAvailableBuddies] = useState<BuddyProfile[]>([]);
  const [buddyStripLoading, setBuddyStripLoading] = useState(false);
  const [buddyCityNotAvailable, setBuddyCityNotAvailable] = useState(false);

  const handleAddToRoute = useCallback((draft: RouteStopDraft) => {
    setRouteBuilderDraft(draft);
    setRouteBuilderOpen(true);
  }, []);

  // Keep destination in sync when location city changes (GPS capture / manual set).
  useEffect(() => {
    if (locationState.place.city) {
      setDestination(locationState.place.city);
      setDestinationLat(locationState.coords?.lat ?? null);
      setDestinationLng(locationState.coords?.lng ?? null);
    }
  }, [locationState.place.city]);

  // Load available buddies for the current city (for_you buddy strip).
  useEffect(() => {
    if (!currentCity) return;
    setBuddyStripLoading(true);
    setBuddyCityNotAvailable(false);
    getAvailableNow(currentCity).then(res => {
      setBuddyStripLoading(false);
      if (!res.ok) {
        if (res.error?.includes('city_not_available')) setBuddyCityNotAvailable(true);
        return;
      }
      setAvailableBuddies(res.data.buddies.slice(0, 8));
    }).catch(() => setBuddyStripLoading(false));
  }, [currentCity]);

  // Debounce custom age inputs (500 ms) so that each keystroke while the user
  // is typing a number doesn't fire a batch of 7 parallel API requests.
  // Destination, contextMode, ageFilter, and activeFilters remain immediate.
  // countsLoading is only set to true here when ageFilter === 'custom' — the
  // debounced value is only used in that mode, so there is no reason to show
  // a loading spinner (or cancel an in-flight count fetch) for other filters.
  const ageDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstAgeRender = useRef(true);
  useEffect(() => {
    if (isFirstAgeRender.current) {
      isFirstAgeRender.current = false;
      return;
    }
    if (ageFilter === 'custom') {
      setCountsLoading(true);
    }
    if (ageDebounceRef.current) clearTimeout(ageDebounceRef.current);
    ageDebounceRef.current = setTimeout(() => {
      setDebouncedAgeRange(customAgeRange);
    }, 500);
    return () => {
      if (ageDebounceRef.current) clearTimeout(ageDebounceRef.current);
    };
  }, [customAgeRange]);

  // Fetch per-category result counts whenever the destination, filters, context
  // mode, or age filter changes. Custom age inputs use debounced values to avoid
  // a count fetch on every keystroke. countsLoading gates tab dimming so no tab
  // flickers to "dimmed" before the full batch resolves.
  // Custom age changes use the debounced values so rapid keystrokes don't
  // trigger redundant fetches.
  useEffect(() => {
    setCategoryCounts({});
    setCountsLoading(true);
    let cancelled = false;
    getDiscoveryCategoryCounts(destination, activeFilters, contextMode, ageFilter, debouncedAgeRange.min, debouncedAgeRange.max).then((counts) => {
      if (!cancelled) { setCategoryCounts(counts); setCountsLoading(false); }
    }).catch(() => {
      if (!cancelled) setCountsLoading(false);
    });
    return () => { cancelled = true; };
  }, [destination, activeFilters, contextMode, ageFilter, debouncedAgeRange]);

  // Upgrade to the user's actual trip destination once trips load.
  // Only overrides if the user hasn't set a location yet.
  useEffect(() => {
    if (!isAuthed) return;
    listMyTrips().then((rows) => {
      const active = rows.find((r) => r.status === 'planning' || r.status === 'active') ?? rows[0];
      if (active?.destinationCity && !locationState.place.city) {
        setDestination(active.destinationCity);
      }
    }).catch(() => {});
  }, [isAuthed, locationState.place.city]);

  // Re-apply deep-link category if params change (e.g. in-app navigation)
  useEffect(() => {
    if (params.category && VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)) {
      setActiveTab(params.category as DiscoveryCategory);
    }
  }, [params.category]);

  // Reset to list view and filters when the user switches tabs.
  // activeFilters reset here keeps counts consistent until the newly-mounted
  // DiscoveryCategoryTab fires its own onFiltersChange with its initial state.
  const handleTabChange = (key: DiscoveryCategory) => {
    setActiveTab(key);
    setViewMode('list');
    setActiveFilters({ radiusKm: 10, openNow: false, minRating: null });
  };

  const handleFiltersChange = useCallback((filters: DiscoveryFilters) => {
    setActiveFilters(filters);
  }, []);

  // Map toggle is shown on all native tabs (category tabs + for_you).
  const showMapToggle = Platform.OS !== 'web';

  const handleAddToPlan = useCallback((place: { id: string; name: string; category: string; address?: string | null }) => {
    setDetailVisible(false);
    openPlanPicker({
      id:           place.id,
      type:         'place',
      title:        place.name,
      category:     place.category,
      locationName: place.address ?? undefined,
    });
  }, [openPlanPicker]);

  const handleAddToPlanFromPlace = useCallback((place: DiscoveryPlace) => {
    handleAddToPlan({ id: place.id, name: place.name, category: place.category, address: place.address });
  }, [handleAddToPlan]);

  const handleSelectPlace = (place: DiscoveryPlace) => {
    setSelectedPlace(place);
    setDetailVisible(true);
  };

  const handlePickDestination = useCallback((city: string) => {
    setDestination(city);
    setDestinationLat(null);
    setDestinationLng(null);
    // Also persist as manual city in the location system
    setManualCity(city).catch(() => {});
  }, [setManualCity]);

  // MapTiler geocode on load:
  //  - If a city is set but coords missing -> geocode the city (zoom 11).
  //  - If no city but a country is known -> geocode the country (country-level zoom 4).
  React.useEffect(() => {
    if (destinationLat != null || destinationLng != null) return;
    const key = process.env.EXPO_PUBLIC_MAPTILER_KEY;
    if (!key) return;
    const country = locationState.place.country ?? null;
    const query = destination || country;
    if (!query) return;
    const isCountryView = !destination && !!country;
    let cancelled = false;
    const types = isCountryView ? 'country' : '';
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${key}&limit=1${types ? `&types=${types}` : ''}`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const c = data?.features?.[0]?.center;
        if (Array.isArray(c) && c.length === 2) {
          setDestinationLng(c[0]);
          setDestinationLat(c[1]);
          setDestinationZoom(isCountryView ? 4 : 11);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [destination, destinationLat, destinationLng, locationState.place.country]);

  const handleSelectPlaceFromBar = useCallback((place: Place) => {
    setDestination(place.city ?? place.name);
    setDestinationLat(place.lat ?? null);
    setDestinationLng(place.lng ?? null);
    setManualCity(place.city ?? place.name).catch(() => {});
  }, [setManualCity]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Compass size={22} color={color.signal} />
          <Text style={styles.headerTitle}>Discover</Text>
        </View>
        <View style={styles.headerRight}>
          <DestinationBar destination={destination} onSelectPlace={handleSelectPlaceFromBar} />
          {isAuthed && (
            <Pressable
              style={styles.sharePlaceBtn}
              onPress={() => setSubmitPlaceOpen(true)}
              hitSlop={12}
              accessibilityLabel="Share a place"
            >
              <PlusCircle size={20} color={color.signal} />
            </Pressable>
          )}
        </View>
      </View>

      {/* ── Search bar + filter button ── */}
      <View style={styles.searchRow}>
        <Pressable
          style={styles.searchEntryBar}
          onPress={() => router.push({ pathname: '/search', params: { q: '', type: 'all' } } as any)}
          accessible
          accessibilityRole="search"
          accessibilityLabel="Open search"
        >
          <Search size={15} color={color.mute} />
          <Text style={styles.searchEntryText} numberOfLines={1}>
            Search travelers, trips, events, places…
          </Text>
        </Pressable>
        <Pressable
          style={[styles.filterBtn, ageFilter !== 'any' && styles.filterBtnActive]}
          onPress={() => setAgePickerOpen(true)}
          hitSlop={8}
          accessibilityLabel="Open filters"
        >
          <SlidersHorizontal size={17} color={ageFilter !== 'any' ? color.signal : color.mute} />
        </Pressable>
      </View>

      {/* ── Context mode selector ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.modeBar}
        contentContainerStyle={styles.modeBarContent}
      >
        {CONTEXT_MODES.map((m) => {
          const active = m.key === contextMode;
          return (
            <Pressable
              key={m.key}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => setContextMode(m.key)}
            >
              <m.Icon size={12} color={active ? color.signal : color.mute} />
              <Text style={[styles.modeChipLabel, active && styles.modeChipLabelActive]}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Age filter — compact picker pill ── */}
      {(() => {
        const AGE_OPTIONS: { key: DiscoveryAgeFilter; label: string }[] = [
          { key: 'any',        label: 'Any age' },
          { key: 'open_to_me', label: 'Open to me' },
          { key: '18_plus',    label: '18+' },
          { key: '21_plus',    label: '21+' },
          { key: 'under_30',   label: 'Under 30' },
          { key: '30_plus',    label: '30+' },
          { key: 'custom',     label: 'Custom range' },
        ];
        const activeLabel = ageFilter === 'custom' && (customAgeRange.min != null || customAgeRange.max != null)
          ? `Age: ${customAgeRange.min ?? '?'}–${customAgeRange.max ?? '?'}`
          : (AGE_OPTIONS.find((o) => o.key === ageFilter)?.label ?? 'Any age');
        const isFiltered = ageFilter !== 'any';
        return (
          <>
            <View style={styles.agePickerRow}>
              <Pressable
                style={[styles.agePickerPill, isFiltered && styles.agePickerPillActive]}
                onPress={() => setAgePickerOpen(true)}
              >
                <Users size={11} color={isFiltered ? color.signal : color.mute} />
                <Text style={[styles.agePickerLabel, isFiltered && styles.agePickerLabelActive]}>
                  {activeLabel}
                </Text>
                <Text style={[styles.agePickerChevron, isFiltered && styles.agePickerLabelActive]}>▾</Text>
              </Pressable>
            </View>

            <Modal
              visible={agePickerOpen}
              transparent
              animationType="slide"
              onRequestClose={() => setAgePickerOpen(false)}
            >
              <Pressable style={styles.ageModalOverlay} onPress={() => setAgePickerOpen(false)} />
              <View style={styles.ageModalSheet}>
                <View style={styles.ageModalHandle} />
                <Text style={styles.ageModalTitle}>Age filter</Text>
                {AGE_OPTIONS.map((opt) => {
                  const sel = ageFilter === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[styles.ageModalItem, sel && styles.ageModalItemActive]}
                      onPress={() => {
                        setAgeFilter(opt.key);
                        if (opt.key !== 'custom') {
                          setCustomAgeRange({ min: null, max: null });
                          setDebouncedAgeRange({ min: null, max: null });
                          setAgePickerOpen(false);
                        }
                      }}
                    >
                      {opt.key === 'open_to_me' && (
                        <Users size={14} color={sel ? color.signal : color.mute} />
                      )}
                      <Text style={[styles.ageModalItemText, sel && styles.ageModalItemTextActive]}>
                        {opt.label}
                      </Text>
                      {sel && <Text style={styles.ageModalCheck}>✓</Text>}
                    </Pressable>
                  );
                })}
                {ageFilter === 'custom' && (
                  <View style={styles.ageModalCustomRow}>
                    <Text style={styles.ageModalCustomLabel}>Min</Text>
                    <TextInput
                      style={styles.ageModalCustomInput}
                      value={customAgeRange.min != null ? String(customAgeRange.min) : ''}
                      onChangeText={(v) => setCustomAgeRange((prev) => ({ ...prev, min: v ? parseInt(v, 10) || null : null }))}
                      keyboardType="number-pad"
                      placeholder="18"
                      placeholderTextColor={color.mute}
                      maxLength={3}
                    />
                    <Text style={styles.ageModalCustomLabel}>Max</Text>
                    <TextInput
                      style={styles.ageModalCustomInput}
                      value={customAgeRange.max != null ? String(customAgeRange.max) : ''}
                      onChangeText={(v) => setCustomAgeRange((prev) => ({ ...prev, max: v ? parseInt(v, 10) || null : null }))}
                      keyboardType="number-pad"
                      placeholder="35"
                      placeholderTextColor={color.mute}
                      maxLength={3}
                    />
                    <Pressable
                      style={styles.ageModalDoneBtn}
                      onPress={() => setAgePickerOpen(false)}
                    >
                      <Text style={styles.ageModalDoneBtnText}>Done</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            </Modal>
          </>
        );
      })()}

      {/* ── Tab bar + list/map toggle ── */}
      <View style={styles.tabRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tab) => {
            const active = tab.key === activeTab;
            const count = categoryCounts[tab.key];
            // Only dim when the full batch has resolved; suppress dimming while loading
            // to prevent any tab flickering to "0" before all responses arrive.
            const isEmpty = !countsLoading && count !== undefined && count === 0;
            const iconColor = active ? color.signal : (isEmpty ? color.faint : color.mute);
            const countSuffix = !countsLoading && count !== undefined && count > 0 ? ` · ${count}` : '';
            return (
              <Pressable
                key={tab.key}
                style={[styles.tab, active && styles.tabActive, !active && isEmpty && styles.tabDim]}
                onPress={() => handleTabChange(tab.key)}
              >
                <tab.Icon size={16} color={iconColor} />
                <Text style={[styles.tabLabel, active && styles.tabLabelActive, !active && isEmpty && styles.tabLabelDim]}>
                  {tab.label}{countSuffix}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {showMapToggle && (
          <View style={styles.viewToggle}>
            <Pressable
              style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]}
              onPress={() => setViewMode('list')}
            >
              <Text style={[styles.toggleBtnText, viewMode === 'list' && styles.toggleBtnTextActive]}>
                List
              </Text>
            </Pressable>
            <Pressable
              style={[styles.toggleBtn, viewMode === 'map' && styles.toggleBtnActive]}
              onPress={() => setViewMode('map')}
            >
              <MapPin size={11} color={viewMode === 'map' ? color.signal : color.mute} />
              <Text style={[styles.toggleBtnText, viewMode === 'map' && styles.toggleBtnTextActive]}>
                Map
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* ── Following highlights strip ── */}
      {isAuthed && (
        <FollowingHighlightsStrip
          users={highlightUsers}
          sessionViewedIds={sessionViewedIds}
          onMarkViewed={markSessionViewed}
        />
      )}

      {/* ── Trending hashtags strip ── */}
      {trendingHashtags.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.trendingBar}
          contentContainerStyle={styles.trendingBarContent}
        >
          {trendingHashtags.map((ht) => (
            <Pressable
              key={ht.id}
              style={styles.trendingChip}
              onPress={() => router.push(`/hashtag/${ht.slug}` as any)}
            >
              <Hash size={10} color={color.deep} />
              <Text style={styles.trendingChipText}>{ht.slug}</Text>
              {ht.usageCount > 0 && (
                <Text style={styles.trendingChipCount}>
                  {ht.usageCount >= 1000 ? `${(ht.usageCount / 1000).toFixed(1)}k` : String(ht.usageCount)}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Active tab content ── */}
      <View style={{ flex: 1 }}>
        {activeTab === 'for_you' ? (
          <View style={{ flex: 1 }}>
            {/* Buddy strip — available-now Buddies in the current city */}
            {(availableBuddies.length > 0 || buddyCityNotAvailable) && (
              <View style={buddyStrip.wrap}>
                <View style={buddyStrip.header}>
                  <Users size={13} color={color.signal} />
                  <Text style={buddyStrip.title}>Buddies Available Now</Text>
                  <Pressable onPress={() => router.push('/(rent-a-buddy)/search' as any)}>
                    <Text style={buddyStrip.seeAll}>See all</Text>
                  </Pressable>
                </View>
                {buddyCityNotAvailable ? (
                  <View style={buddyStrip.comingSoon}>
                    <Text style={buddyStrip.comingSoonText}>Coming soon to {currentCity ?? 'your city'}</Text>
                  </View>
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={buddyStrip.scroll}
                  >
                    {availableBuddies.map(b => (
                      <Pressable
                        key={b.id}
                        style={buddyStrip.chip}
                        onPress={() => router.push(`/(rent-a-buddy)/buddy/${b.id}` as any)}
                      >
                        <View style={buddyStrip.chipAvatar}>
                          <Text style={buddyStrip.chipInitial}>{b.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
                          <View style={buddyStrip.liveDot} />
                        </View>
                        <Text style={buddyStrip.chipName} numberOfLines={1}>{b.displayName ?? 'Buddy'}</Text>
                        {b.categories[0] && (
                          <Text style={buddyStrip.chipCat} numberOfLines={1}>{b.categories[0]}</Text>
                        )}
                      </Pressable>
                    ))}
                    <Pressable
                      style={buddyStrip.moreChip}
                      onPress={() => router.push('/(rent-a-buddy)/' as any)}
                    >
                      <Text style={buddyStrip.moreText}>Browse all</Text>
                    </Pressable>
                  </ScrollView>
                )}
              </View>
            )}
            {/* Compass buddy recommendations — privacy-safe, city-matched */}
            <CompassBuddyRow city={currentCity} />
            <ForYouTab
              key={`${destination}-${contextMode}-${communityRefreshKey}`}
              destination={destination}
              onAddToPlan={handleAddToPlan}
              onAddToRoute={handleAddToRoute}
              contextMode={contextMode}
              lat={destinationLat}
              lng={destinationLng}
              userLat={locationState.coords?.lat ?? null}
              userLng={locationState.coords?.lng ?? null}
              viewMode={viewMode}
              fallbackZoom={destinationZoom}
              sortBy={activeFilters.sortBy ?? null}
              bottomInset={insets.bottom + 100}
            />
          </View>
        ) : (
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}-${contextMode}`}
            category={activeTab}
            destination={destination}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlanFromPlace}
            onAddToRoute={handleAddToRoute}
            onPickDestination={handlePickDestination}
            contextMode={contextMode}
            viewMode={viewMode}
            ageFilter={ageFilter}
            customMinAge={debouncedAgeRange.min}
            customMaxAge={debouncedAgeRange.max}
            lat={destinationLat}
            lng={destinationLng}
            userLat={locationState.coords?.lat ?? null}
            userLng={locationState.coords?.lng ?? null}
            onFiltersChange={handleFiltersChange}
            fallbackZoom={destinationZoom}
            bottomInset={insets.bottom + 100}
          />
        )}
      </View>

      {/* ── Place detail sheet ── */}
      <PlaceDetailSheet
        place={selectedPlace}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onAddToPlan={handleAddToPlanFromPlace}
      />

      {/* City picker — triggered from DestinationBar or location context */}
      <ManualCityPicker
        visible={showCityPicker}
        onClose={closeCityPicker}
        onSelect={handlePickDestination}
      />

      {/* Layover Mode floating entry — positioned above the floating tab bar */}
      <Pressable style={[styles.layoverFab, { bottom: insets.bottom + 88 }]} onPress={() => setLayoverOpen(true)}>
        <Plane size={16} color="#fff" />
        <Text style={styles.layoverFabText}>Layover Mode</Text>
      </Pressable>

      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
        initialCity={destination}
      />

      {/* Route builder — opened from any "Add to Route" button in this tab */}
      <RouteBuilderSheet
        visible={routeBuilderOpen}
        initialStops={routeBuilderDraft ? [routeBuilderDraft] : []}
        onClose={() => { setRouteBuilderOpen(false); setRouteBuilderDraft(null); }}
        onRouteCreated={(route) => {
          setRouteBuilderOpen(false);
          setRouteBuilderDraft(null);
          router.push(`/route/${route.plan.id}`);
        }}
      />

      {/* Submit a community place */}
      <SubmitPlaceSheet
        visible={submitPlaceOpen}
        city={destination}
        onClose={() => setSubmitPlaceOpen(false)}
        onSubmitted={() => {
          setSubmitPlaceOpen(false);
          setCommunityRefreshKey((k) => k + 1);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
  },
  sharePlaceBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.signal + '12',
    borderWidth: 1,
    borderColor: color.signal + '30',
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 20,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tabBar: {
    flexGrow: 1,
    flexShrink: 1,
  },
  tabBarContent: {
    paddingHorizontal: space.md,
    gap: space.sm,
    paddingVertical: 10,
  },
  viewToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderLeftWidth: 1,
    borderLeftColor: color.haze,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  toggleBtnActive: {
    backgroundColor: color.signal + '14',
  },
  toggleBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  toggleBtnTextActive: {
    color: color.signal,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tabActive: {
    backgroundColor: color.signal + '12',
    borderColor: color.signal + '40',
  },
  tabLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: color.signal,
    fontWeight: '700',
  },
  tabDim: {
    opacity: 0.45,
  },
  tabLabelDim: {
    color: color.faint,
  },
  modeBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  modeBarContent: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    gap: space.sm,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
    minHeight: 34,
  },
  modeChipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  modeChipLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: color.mute,
  },
  modeChipLabelActive: {
    color: color.signal,
  },
  agePickerRow: {
    flexDirection: 'row',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  agePickerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  agePickerPillActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  agePickerLabel: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: color.mute,
  },
  agePickerLabelActive: {
    color: color.signal,
  },
  agePickerChevron: {
    fontSize: 10,
    color: color.mute,
    marginTop: 1,
  },
  ageModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  ageModalSheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    paddingTop: space.md,
  },
  ageModalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  ageModalTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700' as const,
    fontSize: 15,
    marginBottom: space.sm,
  },
  ageModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  ageModalItemActive: {
    backgroundColor: 'transparent',
  },
  ageModalItemText: {
    ...t.body,
    color: color.ink,
    fontSize: 15,
    flex: 1,
  },
  ageModalItemTextActive: {
    color: color.signal,
    fontWeight: '600' as const,
  },
  ageModalCheck: {
    color: color.signal,
    fontSize: 14,
    fontWeight: '700' as const,
  },
  ageModalCustomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.md,
  },
  ageModalCustomLabel: {
    fontSize: 13,
    color: color.mute,
    fontWeight: '600' as const,
  },
  ageModalCustomInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 7,
    fontSize: 14,
    color: color.ink,
    backgroundColor: color.paperRaised,
    textAlign: 'center',
  },
  ageModalDoneBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  ageModalDoneBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700' as const,
  },
  layoverFab: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1565C0',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  layoverFabText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  trendingBar: {
    flexGrow: 0,
    flexShrink: 0,
    paddingTop: 4,
  },
  trendingBarContent: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    gap: space.xs,
    flexDirection: 'row',
  },
  trendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.deep + '12',
    borderWidth: 1,
    borderColor: color.deep + '22',
  },
  trendingChipText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600' as const,
  },
  trendingChipCount: {
    fontSize: 10,
    color: color.mute,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  searchEntryBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    minHeight: 44,
  },
  filterBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  filterBtnActive: {
    backgroundColor: color.signal + '12',
    borderColor: color.signal + '40',
  },
  searchEntryText: {
    ...t.body,
    color: color.faint,
    flex: 1,
  },
});

const buddyStrip = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    paddingVertical: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  title: { ...t.small, fontWeight: '700', color: color.ink, flex: 1 },
  seeAll: { ...t.small, color: color.signal, fontWeight: '700' },
  scroll: { paddingHorizontal: space.lg, gap: space.md },
  chip: {
    alignItems: 'center',
    width: 72,
    gap: 4,
  },
  chipAvatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: color.deep,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  chipInitial: { fontSize: 20, fontWeight: '700', color: color.onInk },
  liveDot: {
    position: 'absolute', bottom: 2, right: 2,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: color.success,
    borderWidth: 2, borderColor: color.paperRaised,
  },
  chipName: { ...t.small, color: color.ink, fontWeight: '600', textAlign: 'center' },
  chipCat: { fontSize: 9, color: color.mute, textAlign: 'center', fontFamily: 'Courier' },
  moreChip: {
    width: 72, height: 52, borderRadius: 26,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
  },
  moreText: { fontSize: 10, fontWeight: '700', color: color.mute, textAlign: 'center' },
  comingSoon: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  comingSoonText: { ...t.small, color: color.mute, fontStyle: 'italic' },
});
