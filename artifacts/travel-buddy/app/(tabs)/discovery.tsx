import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, TextInput, Modal, InteractionManager, FlatList,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader } from '../../src/hooks/useCollapsingHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation, Plane, Users, Hash, PlusCircle, Search, SlidersHorizontal, Trophy,
} from 'lucide-react-native';
import { getTrendingHashtags, type TrendingHashtag } from '../../src/services/hashtag';
import type { DiscoveryAgeFilter } from '../../src/services/discovery';
import type { Place } from '../../src/lib/location/placeTypes';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { DiscoveryCategory, DiscoveryPlace, DiscoveryContextMode, DiscoveryFilters } from '../../src/services/discovery';
import { getDiscoveryCategoryCounts, getDiscoveryCategoryCountsBatch } from '../../src/services/discovery';
import { DiscoveryCategoryTab } from '../../src/components/discovery/DiscoveryCategoryTab';
import { PlaceDetailSheet } from '../../src/components/discovery/PlaceDetailSheet';
import { ForYouTab } from '../../src/components/discovery/ForYouTab';
import { DestinationBar } from '../../src/components/discovery/DestinationBar';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { getAvailableNow, type BuddyProfile } from '../../src/services/rentABuddy';
import { BuddyCardSkeleton } from '../../src/components/BuddyCard';
import { CompassBuddyRow } from '../../src/components/compass/CompassBuddyRow';
import { CityConfidenceBadge } from '../../src/components/compass/CityConfidenceBadge';
import { useSession } from '../../src/context/SessionContext';
import { useLocationContext } from '../../src/context/LocationContext';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { FollowingHighlightsStrip } from '../../src/components/FollowingHighlightsStrip';
import { useFollowingHighlights } from '../../src/hooks/useFollowingHighlights';
import { RouteBuilderSheet } from '../../src/components/RouteBuilderSheet';
import type { RouteStopDraft } from '../../src/components/RouteBuilderSheet';
import { SubmitPlaceSheet } from '../../src/components/discovery/SubmitPlaceSheet';
import { SectionErrorBoundary } from '../../src/components/discovery/SectionErrorBoundary';
import { loadCachedCounts, saveCachedCounts } from '../../src/services/discoveryLocalCache';
import { DiscoveryEventPostCard } from '../../src/components/discovery/DiscoveryEventPostCard';
import type { DiscoveryEventPost } from '../../src/types/discovery';
import { freshToken } from '../../src/services/apiToken';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { PlaceCardSkeleton } from '../../src/components/loading/PlaceCardSkeleton';
import { EventCardSkeleton } from '../../src/components/loading/EventCardSkeleton';

/** Returns the value only when it is a real, finite number — otherwise null. */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

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
  const bottomInset = useLayoverAwareBottomInset();
  const { isAuthed } = useSession();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const { open: openPlanPicker } = usePlanPicker();
  const {
    locationState, showCityPicker, openCityPicker, closeCityPicker, isLoading,
    resolvedLocation, setSessionLocation, clearSessionLocation,
  } = useLocationContext();
  const { users: highlightUsers, sessionViewedIds, markSessionViewed } = useFollowingHighlights();
  // currentCity always reads from the canonical location (not the session override)
  // so that trending-hashtag and buddy fetches re-anchor on GPS updates.
  const currentCity = resolvedLocation.place.city ?? null;
  const navScrollHandler = useNavBarScrollHandler();
  const { largeHeaderStyle, compactBarStyle, compactBarInteractive } = useCollapsingHeader();

  // Bumped by pull-to-refresh to force the counts/buddy/trending effects below
  // to re-run without changing any of their real dependencies.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([]);
  useEffect(() => {
    let cancelled = false;
    getTrendingHashtags('city', currentCity).then((res) => {
      if (cancelled) return;
      // Normalize at the boundary: missing/invalid array → [].
      if (res.ok && res.data) setTrendingHashtags((res.data.trending ?? []).slice(0, 12));
    }).catch((err) => {
      if (!cancelled && __DEV__) console.error('[Discovery] trending hashtags failed:', err);
    });
    return () => { cancelled = true; };
  }, [currentCity, refreshNonce]);

  // Deep-link: ?category=food navigates to that tab on mount
  const params = useLocalSearchParams<{ category?: string; city?: string }>();
  const initialCategory = (
    VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)
      ? params.category as DiscoveryCategory
      : 'for_you'
  );
  // Deep-link: ?city=Cebu City switches the active destination on mount
  // (e.g. from a trip's "explore on the map" CTA).
  const cityParam = typeof params.city === 'string' && params.city.trim() ? params.city.trim() : null;

  const [activeTab, setActiveTab] = useState<DiscoveryCategory>(initialCategory);
  // Seed from resolved location (cascade: GPS → last-known → home).
  const [destination, setDestination] = useState<string | null>(
    () => cityParam ?? resolvedLocation.place.city ?? null
  );
  const [destinationLat, setDestinationLat] = useState<number | null>(
    () => finiteOrNull(resolvedLocation.coords?.lat)
  );
  const [destinationLng, setDestinationLng] = useState<number | null>(
    () => finiteOrNull(resolvedLocation.coords?.lng)
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
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [routeBuilderDraft, setRouteBuilderDraft] = useState<RouteStopDraft | null>(null);
  const [routeBuilderOpen, setRouteBuilderOpen] = useState(false);
  const [submitPlaceOpen, setSubmitPlaceOpen] = useState(false);
  const [agePickerOpen, setAgePickerOpen] = useState(false);
  const [communityRefreshKey, setCommunityRefreshKey] = useState(0);
  const [eventPosts, setEventPosts] = useState<DiscoveryEventPost[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<Partial<Record<DiscoveryCategory, number>>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  const [activeFilters, setActiveFilters] = useState<DiscoveryFilters>({ radiusKm: 10, openNow: false, minRating: null });
  const [availableBuddies, setAvailableBuddies] = useState<BuddyProfile[]>([]);
  const [buddyStripLoading, setBuddyStripLoading] = useState(false);
  const [buddyCityNotAvailable, setBuddyCityNotAvailable] = useState(false);
  const [nudgeHighlighted, setNudgeHighlighted] = useState(false);
  const nudgeHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: prevents a rapid double-tap on a dimmed chip from calling openCityPicker twice.
  // Set to true on first press; cleared when the picker closes (showCityPicker → false).
  const cityPickerPendingRef = useRef(false);

  // ── Event posts fetch — "Live from events" strip ───────────────────────────
  // Fetches from /api/discovery/feed and reads the `posts` array (previously always []).
  // Only fires when a destination is set; renders nothing when posts is empty.
  // Auth token is included so block filtering applies for signed-in users.
  // Fire-and-forget: errors are silently swallowed — the strip is supplementary.
  useEffect(() => {
    if (!destination) { setEventPosts([]); return; }
    let cancelled = false;
    const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
    const params = new URLSearchParams({ city: destination, limit: '20' });
    if (destinationLat != null && Number.isFinite(destinationLat)) params.set('lat', String(destinationLat));
    if (destinationLng != null && Number.isFinite(destinationLng)) params.set('lng', String(destinationLng));
    freshToken().then((token) => {
      if (cancelled) return;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(`${base}/api/discovery/feed?${params}`, { headers });
    }).then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const posts = Array.isArray(data?.posts) ? (data.posts as DiscoveryEventPost[]) : [];
        setEventPosts(posts);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [destination, destinationLat, destinationLng]);

  // ── Step-1 instrumentation + Step-4 cache-first paint ─────────────────────
  const mountedAt          = useRef(Date.now());
  const firstContentLogged = useRef(false);

  // On mount, load cached category counts from AsyncStorage so the tab bar
  // badges render instantly on the second open (< 300 ms from storage).
  // Network fetch still runs in parallel and overwrites when it resolves.
  const initialCity = useRef(destination);
  useEffect(() => {
    const city = initialCity.current;
    if (!city) return;
    loadCachedCounts(city)
      .then((cached) => {
        if (cached && !firstContentLogged.current) {
          setCategoryCounts(cached);
          if (__DEV__) {
            console.log(
              `[discovery] render ms: ${Date.now() - mountedAt.current} city=${city}`,
            );
          }
        }
      })
      .catch(() => {});
  }, []); // run once on mount only

  const handleAddToRoute = useCallback((draft: RouteStopDraft) => {
    setRouteBuilderDraft(draft);
    setRouteBuilderOpen(true);
  }, []);

  // Reset the double-tap guard whenever the city picker is dismissed.
  useEffect(() => {
    if (!showCityPicker) {
      cityPickerPendingRef.current = false;
    }
  }, [showCityPicker]);

  // Fired when a user taps a context-mode chip while it is disabled (no destination set).
  // Briefly highlights the location-nudge banner so the user understands why the chip
  // is inactive, and opens the city picker so they can act immediately.
  // Guard: if the picker is already pending (rapid double-tap), ignore subsequent presses.
  const handleDisabledChipPress = useCallback(() => {
    if (cityPickerPendingRef.current) return;
    cityPickerPendingRef.current = true;
    setNudgeHighlighted(true);
    if (nudgeHighlightTimerRef.current) clearTimeout(nudgeHighlightTimerRef.current);
    nudgeHighlightTimerRef.current = setTimeout(() => {
      setNudgeHighlighted(false);
      nudgeHighlightTimerRef.current = null;
    }, 1800);
    openCityPicker();
  }, [openCityPicker]);

  // Keep destination in sync when location city changes (GPS capture / manual set).
  useEffect(() => {
    if (locationState.place.city) {
      setDestination(locationState.place.city);
      setDestinationLat(finiteOrNull(locationState.coords?.lat));
      setDestinationLng(finiteOrNull(locationState.coords?.lng));
    }
  }, [locationState.place.city]);

  // Load available buddies for the current city (for_you buddy strip).
  // Step-5: deferred until after first paint — the strip is below fold.
  useEffect(() => {
    if (!currentCity) return;
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      setBuddyStripLoading(true);
      setBuddyCityNotAvailable(false);
      getAvailableNow(currentCity).then(res => {
        if (cancelled) return;
        setBuddyStripLoading(false);
        if (!res.ok) {
          if (res.error?.includes('city_not_available')) setBuddyCityNotAvailable(true);
          return;
        }
        // Normalize at the boundary: missing/invalid array → [].
        setAvailableBuddies((res.data?.buddies ?? []).slice(0, 8));
      }).catch((err) => {
        if (cancelled) return;
        setBuddyStripLoading(false);
        if (__DEV__) console.error('[Discovery] available-now buddies failed:', err);
      });
    });
    return () => { cancelled = true; task.cancel(); };
  }, [currentCity, refreshNonce]);

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
  //
  // Key performance decisions:
  //   1. Do NOT reset counts to {} on each run — stale counts stay visible
  //      while fresh ones load, eliminating the "all tabs dim" flash.
  //   2. For the default case (no age filter), use the single-request batch
  //      endpoint instead of 7 parallel /api/discovery requests.
  useEffect(() => {
    // Don't fetch counts until a destination is set — no "Paris" fallback anymore.
    if (!destination) {
      setCountsLoading(false);
      return;
    }
    setCountsLoading(true);
    let cancelled = false;

    // Capture coords at effect-run time (not as deps) — lets the server skip
    // Nominatim when we already know the lat/lng, without retriggering on
    // every MapTiler geocode resolution.
    const latSnap = finiteOrNull(destinationLat);
    const lngSnap = finiteOrNull(destinationLng);

    const usesBatch = ageFilter === 'any';
    const fetchCounts = usesBatch
      ? getDiscoveryCategoryCountsBatch(destination, activeFilters.radiusKm, latSnap, lngSnap)
      : getDiscoveryCategoryCounts(destination, activeFilters, contextMode, ageFilter, debouncedAgeRange.min, debouncedAgeRange.max);

    fetchCounts.then((counts) => {
      if (!cancelled) {
        setCategoryCounts(counts);
        setCountsLoading(false);
        // Step-4: persist for instant second-open (< 300 ms from AsyncStorage).
        if (destination) void saveCachedCounts(destination, counts);
        // Step-1: first-content timing (dev only).
        if (!firstContentLogged.current) {
          firstContentLogged.current = true;
          if (__DEV__) {
            console.log(
              `[discovery] first-content ms: ${Date.now() - mountedAt.current} city=${destination}`,
            );
          }
        }
      }
    }).catch(() => {
      if (!cancelled) setCountsLoading(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, activeFilters, contextMode, ageFilter, debouncedAgeRange, refreshNonce]);

  // Upgrade to the user's actual trip destination once trips load.
  // Only overrides if the user hasn't set a location yet.
  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    listMyTrips().then((rows) => {
      if (cancelled) return;
      const list = Array.isArray(rows) ? rows : [];
      const active = list.find((r) => r.status === 'planning' || r.status === 'active') ?? list[0];
      if (active?.destinationCity && !locationState.place.city) {
        setDestination(active.destinationCity);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
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
    setActiveFilters({ radiusKm: 10, openNow: false, minRating: null });
  };

  const handleFiltersChange = useCallback((filters: DiscoveryFilters) => {
    setActiveFilters(filters);
  }, []);

  // Pull-to-refresh (triggered from inside ForYouTab/DiscoveryCategoryTab's own
  // FlatList RefreshControl): invalidates the cached counts and re-runs the
  // counts/buddy-strip/trending-hashtag fetches alongside the tab's own
  // places refresh. Does not change what's fetched or TTL/caching strategy —
  // it only forces an immediate re-fetch.
  const handleDiscoveryRefresh = useCallback(() => {
    // The counts effect below re-fetches and calls saveCachedCounts() itself
    // once fresh data lands, replacing the stale cached entry in place.
    setRefreshNonce((n) => n + 1);
  }, []);

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

  const handlePickDestination = useCallback((place: import('../../src/lib/location/placeTypes').Place) => {
    setDestination(place.city ?? place.name);
    setDestinationLat(place.lat ?? null);
    setDestinationLng(place.lng ?? null);
    // Session-only override — never written to the backend or persistent storage.
    // Cleared automatically on tab focus via useFocusEffect below.
    setSessionLocation(place);
  }, [setSessionLocation]);

  // MapTiler geocode on load:
  //  - If a city is set but coords missing -> geocode the city (zoom 11).
  //  - If no city but a country is known -> geocode the country (country-level zoom 4).
  // Step-5: deferred via InteractionManager — map coordinates are not needed
  // for place card rendering, only for the map toggle and full-screen map.
  React.useEffect(() => {
    if (destinationLat != null || destinationLng != null) return;
    const key = process.env.EXPO_PUBLIC_MAPTILER_KEY;
    if (!key) return;
    const country = locationState.place.country ?? null;
    const query = destination || country;
    if (!query) return;
    const isCountryView = !destination && !!country;
    const types = isCountryView ? 'country' : '';
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${key}&limit=1${types ? `&types=${types}` : ''}`;
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      fetch(url)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          const c = data?.features?.[0]?.center;
          if (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
            setDestinationLng(c[0]);
            setDestinationLat(c[1]);
            setDestinationZoom(isCountryView ? 4 : 11);
          }
        })
        .catch(() => {});
    });
    return () => { cancelled = true; task.cancel(); };
  }, [destination, destinationLat, destinationLng, locationState.place.country]);

  const handleSelectPlaceFromBar = useCallback((place: Place) => {
    setDestination(place.city ?? place.name);
    setDestinationLat(place.lat ?? null);
    setDestinationLng(place.lng ?? null);
    // Session-only — does not persist or overwrite the user's canonical location.
    setSessionLocation(place);
  }, [setSessionLocation]);

  // On every focus: clear session city override and re-anchor to canonical location.
  // This ensures a temporary city search never persists across tab switches.
  useFocusEffect(
    useCallback(() => {
      clearSessionLocation();
      setDestination(locationState.place.city ?? null);
      setDestinationLat(finiteOrNull(locationState.coords?.lat));
      setDestinationLng(finiteOrNull(locationState.coords?.lng));
    }, [clearSessionLocation, locationState.place.city, locationState.coords]),
  );

  // Explicit top-level screen status. 'error' is handled by the surrounding
  // SectionErrorBoundary (fullScreen) and per-tab empty states cover 'empty'.
  const screenStatus: 'loading' | 'location-required' | 'loaded' =
    isLoading && !destination
      ? 'loading'
      : !destination
        ? 'location-required'
        : 'loaded';

  // ── Shared scrolling header ─────────────────────────────────────────────────
  // Everything that was previously fixed above the scroll content is captured
  // here as a plain JSX element and passed to each tab's FlatList as
  // ListHeaderComponent.  Swiping up causes the full header stack — title,
  // destination bar, search bar, context-mode chips, category tabs, highlights
  // and buddy strip — to scroll off-screen so content fills the viewport.
  const discoveryHeader = useMemo(() => (
    <View>
      <AppHeader
        variant="primary"
        title="Discovery"
        animatedStyle={largeHeaderStyle}
        rightActions={isAuthed && isFlagEnabled('external_places_enabled') ? [
          { icon: <PlusCircle size={20} color={color.signal} />, onPress: () => setSubmitPlaceOpen(true), accessibilityLabel: 'Share a place' },
        ] : []}
      />
      <View style={{ paddingHorizontal: space.lg, paddingVertical: 6 }}>
        <DestinationBar destination={destination} onSelectPlace={handleSelectPlaceFromBar} />
      </View>

      {/* Freshness indicator — shown when location is last-known or home-only */}
      {(resolvedLocation.source === 'last_known' || resolvedLocation.source === 'home') && (
        <View style={styles.freshnessBar}>
          <Text style={styles.freshnessText}>
            {resolvedLocation.source === 'home' ? 'Using home city' : 'Using last known location'}
          </Text>
        </View>
      )}

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
          const chipsDisabled = screenStatus === 'location-required';
          return (
            <Pressable
              key={m.key}
              style={[styles.modeChip, active && styles.modeChipActive, chipsDisabled && styles.modeChipDisabled]}
              onPress={chipsDisabled ? handleDisabledChipPress : () => setContextMode(m.key)}
              accessibilityState={{ disabled: chipsDisabled }}
              accessibilityHint={chipsDisabled ? 'Set a city to enable context modes' : undefined}
            >
              <m.Icon size={12} color={active ? color.signal : color.mute} />
              <Text style={[styles.modeChipLabel, active && styles.modeChipLabelActive]}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Location nudge — shown when no destination is set ── */}
      {screenStatus === 'location-required' && (
        <Pressable
          style={[styles.locationNudge, nudgeHighlighted && styles.locationNudgeHighlighted]}
          onPress={openCityPicker}
          accessibilityRole="button"
          accessibilityLabel="Set your location to discover nearby places"
        >
          <MapPin size={16} color={color.signal} />
          <Text style={styles.locationNudgeText}>
            Enable location or <Text style={styles.locationNudgeLink}>choose a city</Text> to discover nearby places
          </Text>
        </Pressable>
      )}

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

        <Pressable
          style={[styles.viewToggle, !destination && styles.viewToggleDisabled]}
          disabled={!destination}
          accessibilityLabel="Map view"
          accessibilityHint={destination ? undefined : 'Set a destination to open the map'}
          onPress={() => {
            const params: Record<string, string> = { entityTypes: 'places,travelers' };
            if (destinationLat != null && Number.isFinite(destinationLat)) params.lat = String(destinationLat);
            if (destinationLng != null && Number.isFinite(destinationLng)) params.lng = String(destinationLng);
            if (destinationZoom) params.zoom = String(destinationZoom);
            if (destination) params.title = destination;
            // Pass the active category so the full-screen map fetches the
            // same discovery places the user was just browsing in the tab.
            params.category = activeTab;
            router.push({ pathname: '/map', params } as any);
          }}
        >
          <MapPin size={11} color={destination ? color.mute : color.faint} />
          <Text style={[styles.toggleBtnText, !destination && styles.toggleBtnTextDisabled]}>Map</Text>
        </Pressable>
      </View>

      {/* ── Featured by Portava entry point ── */}
      <Pressable
        style={styles.featuredBanner}
        onPress={() => router.push('/featured' as any)}
        accessibilityRole="button"
        accessibilityLabel="Featured by Portava — see this week's top picks"
      >
        <View style={styles.featuredBannerLeft}>
          <Trophy size={16} color="#D97706" strokeWidth={2.5} />
          <View>
            <Text style={styles.featuredBannerTitle}>Featured by Portava 🏆</Text>
            <Text style={styles.featuredBannerSub}>This week's top picks</Text>
          </View>
        </View>
        <Text style={styles.featuredBannerArrow}>›</Text>
      </Pressable>

      {/* ── Following highlights strip ── */}
      {isAuthed && (
        <SectionErrorBoundary label="FollowingHighlights">
          <FollowingHighlightsStrip
            users={highlightUsers}
            sessionViewedIds={sessionViewedIds}
            onMarkViewed={markSessionViewed}
          />
        </SectionErrorBoundary>
      )}

      {/* ── Trending hashtags strip ── */}
      {trendingHashtags.length > 0 && (
        <SectionErrorBoundary label="TrendingHashtags">
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
        </SectionErrorBoundary>
      )}

      {/* ── For You tab: buddy strip + compass picks (hidden on category tabs) ── */}
      {activeTab === 'for_you' && (availableBuddies.length > 0 || buddyCityNotAvailable || (buddyStripLoading && availableBuddies.length === 0)) && (
        <SectionErrorBoundary label="AvailableNow">
        <View style={buddyStrip.wrap}>
          <View style={buddyStrip.header}>
            <Users size={13} color={color.signal} />
            <Text style={buddyStrip.title}>Buddies Available Now</Text>
            <Pressable onPress={() => router.push('/(rent-a-buddy)/search' as any)}>
              <Text style={buddyStrip.seeAll}>See all</Text>
            </Pressable>
          </View>
          {buddyStripLoading && availableBuddies.length === 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={buddyStrip.scroll}
            >
              <BuddyCardSkeleton />
              <BuddyCardSkeleton />
            </ScrollView>
          ) : buddyCityNotAvailable ? (
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
                  {b.categories?.[0] && (
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
        </SectionErrorBoundary>
      )}
      {activeTab === 'for_you' && (
        <SectionErrorBoundary label="CompassPicks">
          <CityConfidenceBadge city={currentCity} />
          <CompassBuddyRow city={currentCity} headerSuffix={currentCity ? `· near ${currentCity}` : undefined} />
        </SectionErrorBoundary>
      )}

      {/* ── "Live from events" strip — shown when event posts are available ── */}
      {eventPosts.length > 0 && (
        <SectionErrorBoundary label="LiveFromEvents">
          <View style={styles.liveFromEventsSection}>
            <Text style={styles.liveFromEventsTitle}>Live from events</Text>
            <FlatList
              data={eventPosts}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <DiscoveryEventPostCard post={item} />}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.liveFromEventsList}
              initialNumToRender={4}
            />
          </View>
        </SectionErrorBoundary>
      )}

      {/* ── Location-loading placeholder — skeletons while location resolves ── */}
      {screenStatus === 'loading' && (
        <View style={styles.loadingState}>
          <PlaceCardSkeleton />
          <EventCardSkeleton />
          <PlaceCardSkeleton />
        </View>
      )}
    </View>
  ), [
    insets.top,
    destination,
    handleSelectPlaceFromBar,
    isAuthed,
    ageFilter,
    contextMode,
    screenStatus,
    openCityPicker,
    activeTab,
    categoryCounts,
    countsLoading,
    handleTabChange,
    destinationLat,
    destinationLng,
    destinationZoom,
    highlightUsers,
    sessionViewedIds,
    markSessionViewed,
    trendingHashtags,
    availableBuddies,
    buddyCityNotAvailable,
    currentCity,
    nudgeHighlighted,
    handleDisabledChipPress,
    eventPosts,
    largeHeaderStyle,
  ]);

  return (
    <SectionErrorBoundary label="DiscoveryHub" fullScreen>
    <View style={styles.root}>
      {/* Compact sticky bar — fades in as the large AppHeader scrolls away */}
      <Animated.View
        style={[styles.compactBar, { paddingTop: insets.top }, compactBarStyle, { pointerEvents: compactBarInteractive ? 'auto' : 'none' }]}
      >
        <View style={styles.compactBarInner}>
          <Text style={styles.compactBarTitle}>Discovery</Text>
          <View style={styles.compactBarActions}>
            <Pressable
              style={styles.compactBarBtn}
              onPress={() => router.push({ pathname: '/search', params: { q: '', type: 'all' } } as any)}
              accessibilityLabel="Search"
              hitSlop={8}
            >
              <Search size={20} color={color.mute} />
            </Pressable>
            <Pressable
              style={styles.compactBarBtn}
              onPress={() => setAgePickerOpen(true)}
              accessibilityLabel="Filters"
              hitSlop={8}
            >
              <SlidersHorizontal size={20} color={ageFilter !== 'any' ? color.signal : color.mute} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
      {/* ── Age filter modal — opened via the filter button in the search row ── */}
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
          {([
            { key: 'any',        label: 'Any age' },
            { key: 'open_to_me', label: 'Open to me' },
            { key: '18_plus',    label: '18+' },
            { key: '21_plus',    label: '21+' },
            { key: 'under_30',   label: 'Under 30' },
            { key: '30_plus',    label: '30+' },
            { key: 'custom',     label: 'Custom range' },
          ] as { key: DiscoveryAgeFilter; label: string }[]).map((opt) => {
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

      {/* ── Active tab — discoveryHeader lives inside each tab's FlatList as ListHeaderComponent ── */}
      {activeTab === 'for_you' ? (
        <SectionErrorBoundary label="ForYou">
          <ForYouTab
            key={`${destination}-${contextMode}-${communityRefreshKey}`}
            destination={destination ?? ''}
            onAddToPlan={handleAddToPlan}
            onAddToRoute={handleAddToRoute}
            contextMode={contextMode}
            lat={destinationLat}
            lng={destinationLng}
            userLat={locationState.coords?.lat ?? null}
            userLng={locationState.coords?.lng ?? null}
            fallbackZoom={destinationZoom}
            sortBy={activeFilters.sortBy ?? null}
            bottomInset={bottomInset}
            onScroll={navScrollHandler}
            listHeaderComponent={discoveryHeader}
            onRefresh={handleDiscoveryRefresh}
          />
        </SectionErrorBoundary>
      ) : (
        <SectionErrorBoundary label="CategoryTab">
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}-${contextMode}`}
            category={activeTab}
            destination={destination ?? ''}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlanFromPlace}
            onAddToRoute={handleAddToRoute}
            onPickDestination={handlePickDestination}
            contextMode={contextMode}
            ageFilter={ageFilter}
            customMinAge={debouncedAgeRange.min}
            customMaxAge={debouncedAgeRange.max}
            lat={destinationLat}
            lng={destinationLng}
            userLat={locationState.coords?.lat ?? null}
            userLng={locationState.coords?.lng ?? null}
            onFiltersChange={handleFiltersChange}
            fallbackZoom={destinationZoom}
            bottomInset={bottomInset}
            onScroll={navScrollHandler}
            listHeaderComponent={discoveryHeader}
            onRefresh={handleDiscoveryRefresh}
          />
        </SectionErrorBoundary>
      )}

      {/* ── Place detail sheet ── */}
      <PlaceDetailSheet
        place={selectedPlace}
        city={destination}
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

      {/* Layover Mode floating entry — hidden while any full-screen sheet/picker is open */}
      {!detailVisible && !showCityPicker && !routeBuilderOpen && !submitPlaceOpen && (
        <Pressable style={[styles.layoverFab, { bottom: insets.bottom + 88 }]} onPress={() => setLayoverOpen(true)}>
          <Plane size={16} color="#fff" />
          <Text style={styles.layoverFabText}>Layover Mode</Text>
        </Pressable>
      )}

      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
        initialCity={destination ?? ''}
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
        city={destination ?? ''}
        onClose={() => setSubmitPlaceOpen(false)}
        onSubmitted={() => {
          setSubmitPlaceOpen(false);
          setCommunityRefreshKey((k) => k + 1);
        }}
      />
    </View>
    </SectionErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  // ── Compact sticky bar ────────────────────────────────────────────────────
  compactBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: color.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  compactBarInner: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  compactBarTitle: { fontSize: 18, fontWeight: '700', color: color.ink, flex: 1, letterSpacing: -0.3 },
  compactBarActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  compactBarBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingStateText: {
    ...t.small,
    color: color.mute,
  },
  liveFromEventsSection: {
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  liveFromEventsTitle: {
    ...t.small,
    fontWeight: '600',
    color: color.ink,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  liveFromEventsList: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
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
  locationNudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.signal + '10',
    borderBottomWidth: 1,
    borderBottomColor: color.signal + '30',
  },
  locationNudgeHighlighted: {
    backgroundColor: color.signal + '28',
    borderBottomColor: color.signal + '70',
  },
  locationNudgeText: {
    ...t.small,
    color: color.mute,
    flex: 1,
    lineHeight: 18,
  },
  locationNudgeLink: {
    color: color.signal,
    fontWeight: '700',
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
  viewToggleDisabled: {
    opacity: 0.4,
  },
  toggleBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  toggleBtnTextDisabled: {
    color: color.faint,
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
  modeChipDisabled: {
    opacity: 0.4,
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

  featuredBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: radius.md,
  },
  featuredBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  featuredBannerTitle: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: '#92400E',
    letterSpacing: 0.1,
  },
  featuredBannerSub: {
    fontSize: 11,
    color: '#B45309',
    marginTop: 1,
  },
  featuredBannerArrow: {
    fontSize: 20,
    color: '#D97706',
    fontWeight: '700' as const,
    lineHeight: 22,
  },
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
  freshnessBar: {
    marginHorizontal: space.lg,
    marginBottom: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    backgroundColor: color.paperRaised,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: color.haze,
    alignSelf: 'flex-start',
  },
  freshnessText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
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
