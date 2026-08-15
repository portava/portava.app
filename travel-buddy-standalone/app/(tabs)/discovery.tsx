import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Platform, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation, Plane, Users, Hash, PlusCircle,
  SlidersHorizontal, ChevronDown, X, Search, Trophy,
} from 'lucide-react-native';
import { getTrendingHashtags, type TrendingHashtag } from '../../src/services/hashtag';
import { getFeaturedHub } from '../../src/services/featured';
import type { DiscoveryAgeFilter } from '../../src/services/discovery';
import type { Place } from '../../src/lib/location/placeTypes';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { DiscoveryCategory, DiscoveryPlace, DiscoveryContextMode, DiscoveryFilters } from '../../src/services/discovery';
import { getDiscoveryCategoryCounts } from '../../src/services/discovery';
import { DiscoveryCategoryTab, FilterStrip, SORT_LABELS } from '../../src/components/discovery/DiscoveryCategoryTab';
import { PlaceDetailSheet } from '../../src/components/discovery/PlaceDetailSheet';
import { ForYouTab } from '../../src/components/discovery/ForYouTab';
import { DestinationBar } from '../../src/components/discovery/DestinationBar';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { useSession } from '../../src/context/SessionContext';
import { useLocationContext } from '../../src/context/LocationContext';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { FollowingHighlightsStrip } from '../../src/components/FollowingHighlightsStrip';
import { useFollowingHighlights } from '../../src/hooks/useFollowingHighlights';
import { RouteBuilderSheet } from '../../src/components/RouteBuilderSheet';
import type { RouteStopDraft } from '../../src/components/RouteBuilderSheet';
import { SubmitPlaceSheet } from '../../src/components/discovery/SubmitPlaceSheet';
import { SectionErrorBoundary } from '../../src/components/discovery/SectionErrorBoundary';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadDiscoveryFilters,
  saveDiscoveryFilters,
  removeDiscoveryFilters,
  getCachedFilters,
  loadSortPerCategory,
  saveSortForCategory,
  getCachedSortForCategory,
  hasCachedSortForCategory,
} from '../../src/components/discovery/discoveryFilterStorage';

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

/** How long a city change must settle before quota-limited API calls fire.
 * Absorbs rapid city-picker scrolling so only the final selection triggers
 * Foursquare-backed requests. */
const DEST_DEBOUNCE_MS = 400;

function DiscoveryHubScreen() {
  const insets = useSafeAreaInsets();
  const bottomInset = useLayoverAwareBottomInset();
  const { isAuthed } = useSession();
  const { open: openPlanPicker } = usePlanPicker();
  const { locationState, requestLocation, showCityPicker, openCityPicker, closeCityPicker, setManualCity } = useLocationContext();
  const { users: highlightUsers, sessionViewedIds, markSessionViewed } = useFollowingHighlights();
  const currentCity = locationState.place.city ?? null;

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
  }, [currentCity]);

  // Deep-link: ?category=food navigates to that tab on mount
  const params = useLocalSearchParams<{
    category?: string;
    placeId?: string;
    placeName?: string;
    placeCity?: string;
    placeBlurb?: string;
  }>();
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
    () => finiteOrNull(locationState.coords?.lat)
  );
  const [destinationLng, setDestinationLng] = useState<number | null>(
    () => finiteOrNull(locationState.coords?.lng)
  );
  const [destinationZoom, setDestinationZoom] = useState<number>(11);
  // Debounced copies of destination — used by quota-limited API effects so that
  // rapid city changes (e.g. quickly scrolling the city picker) only trigger one
  // Foursquare-backed request once the selection settles, not one per tap.
  const [debouncedDestination, setDebouncedDestination] = useState(
    () => locationState.place.city ?? 'Paris'
  );
  const [debouncedDestLat, setDebouncedDestLat] = useState<number | null>(
    () => finiteOrNull(locationState.coords?.lat)
  );
  const [debouncedDestLng, setDebouncedDestLng] = useState<number | null>(
    () => finiteOrNull(locationState.coords?.lng)
  );
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
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [tabRowHeight, setTabRowHeight] = useState(46);

  // Deep-link from Pulse place cards: ?placeId=... opens PlaceDetailSheet
  useEffect(() => {
    if (!params.placeId) return;
    const synthetic: DiscoveryPlace = {
      id: params.placeId,
      name: params.placeName ?? 'Place',
      category: 'places',
      type: null,
      description: params.placeBlurb ?? null,
      distanceKm: null,
      lat: null,
      lng: null,
      tags: [],
      address: params.placeCity ?? null,
      website: null,
      phone: null,
      openingHours: null,
      rating: null,
      isOpenNow: null,
    };
    setSelectedPlace(synthetic);
    setDetailVisible(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.placeId]);

  // Web back-nav guard for the place detail sheet.
  //
  // Without this, the sheet opens with no browser history entry, so pressing
  // Back navigates the whole tab away (to /passport or wherever the user came
  // from) instead of just closing the sheet.
  //
  // When the sheet becomes visible on web we push a synthetic history entry at
  // the same URL.  A Back press fires `popstate`, which we intercept to close
  // the sheet and absorb the navigation.  When the sheet is dismissed via the
  // close button instead, the cleanup callback pops the synthetic entry so the
  // history stack stays clean for future back presses.
  //
  // The listener is registered in CAPTURE phase (third arg = true) so it fires
  // before Expo Router's bubble-phase popstate listener.  Without capture, Expo
  // Router (whose listener was registered first at app init) fires first and
  // may stop propagation or navigate before our handler has a chance to close
  // the sheet — leaving it open on screen even though the URL stayed correct.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!detailVisible) return;

    // Push a history entry with the same URL so the address bar doesn't change.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.history.pushState({ _discoverySheet: true }, '', w.location.href);

    // Track whether the sheet was already dismissed by the Back button so the
    // cleanup doesn't call history.back() a second time (which would navigate
    // past the absorbed synthetic entry and send the user away from Discovery).
    let dismissedByBack = false;

    const handlePop = () => {
      dismissedByBack = true;
      setDetailVisible(false);
    };
    // Capture phase: our handler fires before any bubble-phase listener
    // (including Expo Router's), so the sheet closes reliably on Back.
    w.addEventListener('popstate', handlePop, true);

    return () => {
      w.removeEventListener('popstate', handlePop, true);
      // If the sheet was closed through the UI (not Back), we still have the
      // synthetic entry on the stack.  Pop it silently so subsequent Back
      // presses go to the correct previous screen.
      if (!dismissedByBack && w.history.state?._discoverySheet) {
        w.history.back();
      }
    };
  }, [detailVisible]);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [routeBuilderDraft, setRouteBuilderDraft] = useState<RouteStopDraft | null>(null);
  const [routeBuilderOpen, setRouteBuilderOpen] = useState(false);

  // Web back-nav guard for LayoverModeSheet — mirrors the detailVisible guard above.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!layoverOpen) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.history.pushState({ _layoverSheet: true }, '', w.location.href);

    const handlePop = () => {
      setLayoverOpen(false);
    };
    w.addEventListener('popstate', handlePop);

    return () => {
      w.removeEventListener('popstate', handlePop);
      if (w.history.state?._layoverSheet) {
        w.history.back();
      }
    };
  }, [layoverOpen]);

  // Web back-nav guard for RouteBuilderSheet — mirrors the detailVisible guard above.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!routeBuilderOpen) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.history.pushState({ _routeBuilderSheet: true }, '', w.location.href);

    const handlePop = () => {
      setRouteBuilderOpen(false);
    };
    w.addEventListener('popstate', handlePop);

    return () => {
      w.removeEventListener('popstate', handlePop);
      if (w.history.state?._routeBuilderSheet) {
        w.history.back();
      }
    };
  }, [routeBuilderOpen]);
  const [submitPlaceOpen, setSubmitPlaceOpen] = useState(false);

  // Web back-nav guard for SubmitPlaceSheet — mirrors the detailVisible guard above.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (!submitPlaceOpen) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.history.pushState({ _submitPlaceSheet: true }, '', w.location.href);

    const handlePop = () => {
      setSubmitPlaceOpen(false);
    };
    w.addEventListener('popstate', handlePop);

    return () => {
      w.removeEventListener('popstate', handlePop);
      if (w.history.state?._submitPlaceSheet) {
        w.history.back();
      }
    };
  }, [submitPlaceOpen]);
  const [communityRefreshKey, setCommunityRefreshKey] = useState(0);
  const [categoryCounts, setCategoryCounts] = useState<Partial<Record<DiscoveryCategory, number>>>({});
  const [countsLoading, setCountsLoading] = useState(false);
  // Count of featured posts fetched on mount — shown in the banner subtitle.
  // Null means loading/unavailable; falls back to the static subtitle.
  const [featuredCount, setFeaturedCount] = useState<number | null>(null);
  const [activeFilters, setActiveFilters] = useState<DiscoveryFilters>(
    () => getCachedFilters() ?? { radiusKm: 10, openNow: false, minRating: null },
  );

  // Load persisted filters and per-category sorts from AsyncStorage on first
  // mount (covers cold app launches). getCachedFilters() above handles
  // in-session remounts synchronously.
  useEffect(() => {
    Promise.all([
      loadDiscoveryFilters(AsyncStorage),
      loadSortPerCategory(AsyncStorage),
    ]).then(([filters]) => {
      // Always derive sortBy from per-category cache so the global filter blob's
      // sortBy (which may be from a different category's last session) never
      // bleeds into the initial tab. hasCachedSortForCategory distinguishes
      // "saved null (no sort)" from "never saved"; both resolve to null here.
      setActiveFilters({
        ...filters,
        sortBy: hasCachedSortForCategory(initialCategory)
          ? getCachedSortForCategory(initialCategory)
          : null,
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiltersChange = useCallback((f: DiscoveryFilters) => {
    setActiveFilters(f);
    saveDiscoveryFilters(AsyncStorage, f);
    saveSortForCategory(AsyncStorage, activeTab, f.sortBy ?? null);
  }, [activeTab]);

  const handleResetFilters = useCallback(() => {
    const defaults: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };
    setActiveFilters(defaults);
    removeDiscoveryFilters(AsyncStorage);
  }, []);

  /**
   * Set to true when the user taps the Nearest chip while location is
   * unavailable. When coords subsequently arrive, the sort is applied
   * automatically so the user doesn't need to tap again.
   */
  const nearestIntentPending = useRef(false);

  /**
   * Timeout handle for the GPS-wait guard. If coords don't arrive within
   * NEAREST_GPS_TIMEOUT_MS after the user taps the Nearest chip, the intent
   * is cleared and an inline message is shown so the user isn't left waiting
   * silently.
   */
  const nearestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const NEAREST_GPS_TIMEOUT_MS = 10_000;

  /** Inline GPS-timeout message shown below the filter panel. Auto-clears. */
  const [nearestGpsMessage, setNearestGpsMessage] = useState<string | null>(null);
  const nearestMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNearestGpsMessage = useCallback((msg: string) => {
    if (nearestMsgTimerRef.current) clearTimeout(nearestMsgTimerRef.current);
    setNearestGpsMessage(msg);
    nearestMsgTimerRef.current = setTimeout(() => setNearestGpsMessage(null), 5_000);
  }, []);

  /**
   * Mirrors nearestIntentPending as React state so the FilterStrip chip can
   * render a "Locating…" pending visual while GPS is resolving.
   */
  const [nearestLocating, setNearestLocating] = useState(false);

  const handleNearestUnavailable = useCallback(() => {
    if (locationState.permissionStatus === 'denied') {
      return;
    }
    // Cancel any previous pending timeout before starting a new one.
    if (nearestTimeoutRef.current) clearTimeout(nearestTimeoutRef.current);

    nearestIntentPending.current = true;
    setNearestLocating(true);
    requestLocation();

    // Guard: if GPS hasn't resolved within the timeout, clear the intent and
    // surface a message so the user knows what happened.
    nearestTimeoutRef.current = setTimeout(() => {
      if (!nearestIntentPending.current) return; // already resolved
      nearestIntentPending.current = false;
      setNearestLocating(false);
      showNearestGpsMessage("Couldn't get your location — try again or move to an open area.");
    }, NEAREST_GPS_TIMEOUT_MS);
  }, [locationState.permissionStatus, requestLocation, showNearestGpsMessage]);

  // If the Nearest sort is active but user location disappears (permission
  // revoked, location cleared), remove the sort so results aren't misleadingly
  // ordered by destination-centre coordinates.
  const hasUserLocation = locationState.coords != null;
  useEffect(() => {
    if (!hasUserLocation && activeFilters.sortBy === 'nearest') {
      handleFiltersChange({ ...activeFilters, sortBy: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUserLocation]);

  // Auto-apply Nearest sort once location permission is granted.
  // When the user tapped the Nearest chip without coords, nearestIntentPending
  // is set. As soon as real coords arrive, apply the sort immediately without
  // requiring a second tap. Also cancel the GPS timeout — coords arrived in time.
  useEffect(() => {
    if (!hasUserLocation) return;
    if (!nearestIntentPending.current) return;
    nearestIntentPending.current = false;
    if (nearestTimeoutRef.current) {
      clearTimeout(nearestTimeoutRef.current);
      nearestTimeoutRef.current = null;
    }
    setNearestLocating(false);
    handleFiltersChange({ ...activeFilters, sortBy: 'nearest' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUserLocation]);

  const handleAddToRoute = useCallback((draft: RouteStopDraft) => {
    setRouteBuilderDraft(draft);
    setRouteBuilderOpen(true);
  }, []);

  // Keep destination in sync when location city or coordinates change.
  // Deps use primitive values (not the coords object) to avoid object-reference
  // churn and unnecessary re-runs. Without coords in deps, destinationLat/Lng
  // would stay stale when GPS fires or improves after the city string was set.
  useEffect(() => {
    if (locationState.place.city) {
      setDestination(locationState.place.city);
      setDestinationLat(finiteOrNull(locationState.coords?.lat));
      setDestinationLng(finiteOrNull(locationState.coords?.lng));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationState.place.city, locationState.coords?.lat, locationState.coords?.lng]);

  // Debounce custom age inputs (500 ms) so that each keystroke while the user
  // is typing a number doesn't fire a batch of 7 parallel API requests.
  // contextMode, ageFilter, and activeFilters are immediate; destination is
  // debounced separately via DEST_DEBOUNCE_MS to protect Foursquare quota.
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

  // Settle destination before quota-limited effects run.
  // On rapid city changes the timer resets so only the final settled value fires.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedDestination(destination);
      setDebouncedDestLat(destinationLat);
      setDebouncedDestLng(destinationLng);
    }, DEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [destination, destinationLat, destinationLng]);

  // Fetch per-category result counts whenever the destination, filters, context
  // mode, or age filter changes. Both the city (debouncedDestination) and custom
  // age inputs use debounced values: city to guard Foursquare quota on rapid
  // picker scrolling, age to avoid 7 parallel requests per keystroke.
  // countsLoading gates tab dimming so no tab flickers "dimmed" before the full
  // batch resolves.
  useEffect(() => {
    setCategoryCounts({});
    setCountsLoading(true);
    let cancelled = false;
    getDiscoveryCategoryCounts(debouncedDestination, activeFilters, contextMode, ageFilter, debouncedAgeRange.min, debouncedAgeRange.max).then((counts) => {
      if (!cancelled) { setCategoryCounts(counts); setCountsLoading(false); }
    }).catch(() => {
      if (!cancelled) setCountsLoading(false);
    });
    return () => { cancelled = true; };
  }, [debouncedDestination, activeFilters, contextMode, ageFilter, debouncedAgeRange]);

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

  // Fire-and-forget: fetch the total featured post count on mount.
  // Uses a short timeout so it never delays the Discover tab render.
  // Falls back silently — the banner subtitle stays static when this fails.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setFeaturedCount(null);
    }, 4000);
    getFeaturedHub().then((res) => {
      if (cancelled) return;
      clearTimeout(timer);
      if (res.ok && res.data && typeof res.data.total === 'number' && res.data.total > 0) {
        setFeaturedCount(res.data.total);
      }
    }).catch(() => {
      if (!cancelled) clearTimeout(timer);
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, []); // mount only

  // Re-apply deep-link category if params change (e.g. in-app navigation).
  // Restores the destination category's persisted sort (or null for a fresh tab).
  useEffect(() => {
    if (params.category && VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)) {
      const cat = params.category as DiscoveryCategory;
      setActiveTab(cat);
      setActiveFilters((prev) => ({
        ...prev,
        sortBy: hasCachedSortForCategory(cat) ? getCachedSortForCategory(cat) : null,
      }));
    }
  }, [params.category]);

  // Switching tabs resets view mode to list. The FROM tab's sort is saved to
  // per-category storage, then the TO tab's last-used sort is restored (null
  // for a tab that's never been sorted).
  const handleTabChange = (key: DiscoveryCategory) => {
    saveSortForCategory(AsyncStorage, activeTab, activeFilters.sortBy ?? null);
    setActiveTab(key);
    setViewMode('list');
    const savedSort = getCachedSortForCategory(key);
    setActiveFilters((prev) => ({ ...prev, sortBy: savedSort }));
  };


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

  const handlePickDestination = useCallback((place: Place) => {
    setDestination(place.city ?? place.name);
    setDestinationLat(place.lat ?? null);
    setDestinationLng(place.lng ?? null);
    // Also persist as manual city in the location system
    setManualCity(place).catch(() => {});
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
        if (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
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
    setManualCity(place).catch(() => {});
  }, [setManualCity]);

  // ── Map vs list mode ─────────────────────────────────────────────────────
  const isMapMode = viewMode === 'map' || activeTab === 'for_you';

  // ── Filter badge count (all 6 dimensions) ─────────────────────────────────
  const totalActiveFilters = [
    contextMode !== 'in_city',
    ageFilter !== 'any',
    activeFilters.radiusKm !== 10,
    activeFilters.openNow,
    activeFilters.minRating !== null,
    activeFilters.sortBy != null,
  ].filter(Boolean).length;
  const hasNonDefaultFilters = totalActiveFilters > 0;

  return (
    <SectionErrorBoundary label="DiscoveryHub" fullScreen>
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Search entry bar ── */}
      <Pressable
        style={styles.searchEntryBar}
        onPress={() => router.push({ pathname: '/search', params: { q: '', type: 'all' } } as any)}
        accessible
        accessibilityRole="search"
        accessibilityLabel="Open search"
      >
        <Search size={15} color={color.mute} />
        <Text style={styles.searchEntryText} numberOfLines={1}>
          Search travelers, trips, events, places, or hashtags
        </Text>
      </Pressable>

      {/* ── Header ── */}
      <View style={styles.header}>
        <Compass size={20} color={color.signal} />
        <Text style={styles.headerTitle} numberOfLines={1}>Discover</Text>
        <View style={{ flex: 1 }} />
        <DestinationBar destination={destination} onSelectPlace={handleSelectPlaceFromBar} />
        {isAuthed && (
          <Pressable
            style={styles.sharePlaceBtn}
            onPress={() => setSubmitPlaceOpen(true)}
            hitSlop={8}
          >
            <PlusCircle size={16} color={color.signal} />
          </Pressable>
        )}
      </View>

      {/* ── Content area: map fills edge-to-edge, chrome floats on top ── */}
      <View style={styles.contentArea}>

        {/* Tab content fills the full content area */}
        {activeTab === 'for_you' ? (
          <SectionErrorBoundary label="ForYouTab">
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
              bottomInset={bottomInset}
            />
          </SectionErrorBoundary>
        ) : (
          <SectionErrorBoundary label={`DiscoveryCategoryTab-${activeTab}`}>
            <DiscoveryCategoryTab
              key={`${activeTab}-${destination}-${contextMode}-${activeFilters.sortBy ?? ''}`}
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
              filters={activeFilters}
              fallbackZoom={destinationZoom}
              listTopInset={tabRowHeight}
              bottomInset={bottomInset}
            />
          </SectionErrorBoundary>
        )}

        {/* Floating chrome: tab bar + filter panel + highlights/trending overlay */}
        <View style={styles.floatingChrome} pointerEvents="box-none">

          {/* Tab bar row — semi-transparent over map, solid over list */}
          <View
            style={[styles.tabRow, filtersExpanded ? styles.tabRowSolid : styles.tabRowSemi]}
            onLayout={(e) => setTabRowHeight(e.nativeEvent.layout.height)}
            pointerEvents="auto"
          >
            <Pressable
              style={[styles.filtersTabBtn, hasNonDefaultFilters && styles.filtersTabBtnActive]}
              onPress={() => setFiltersExpanded((v) => !v)}
              hitSlop={8}
            >
              <SlidersHorizontal size={14} color={hasNonDefaultFilters ? '#fff' : color.mute} />
              {totalActiveFilters > 0 && (
                <View style={styles.filtersTabBtnBadge}>
                  <Text style={styles.filtersTabBtnBadgeText}>{totalActiveFilters}</Text>
                </View>
              )}
            </Pressable>

            {activeFilters.sortBy != null && (
              <Pressable
                style={styles.activeSortChip}
                onPress={() => handleFiltersChange({ ...activeFilters, sortBy: null })}
                hitSlop={6}
              >
                <Text style={styles.activeSortChipText}>
                  {activeFilters.sortBy != null ? (SORT_LABELS[activeFilters.sortBy] ?? activeFilters.sortBy) : null}
                </Text>
                <Text style={styles.activeSortChipX}>✕</Text>
              </Pressable>
            )}

            <View style={styles.tabDivider} />

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabBar}
              contentContainerStyle={styles.tabBarContent}
            >
              {TABS.map((tab) => {
                const active = tab.key === activeTab;
                const count = categoryCounts[tab.key];
                const isEmpty = !countsLoading && count !== undefined && count === 0;
                const iconColor = active ? color.signal : (isEmpty ? color.faint : color.mute);
                const countSuffix = !countsLoading && count !== undefined && count > 0 ? ` · ${count}` : '';
                const showSortedIndicator = active && activeFilters.sortBy != null;
                return (
                  <Pressable
                    key={tab.key}
                    style={[styles.tab, active && styles.tabActive, !active && isEmpty && styles.tabDim]}
                    onPress={() => handleTabChange(tab.key)}
                  >
                    <tab.Icon size={16} color={iconColor} />
                    <View style={styles.tabLabelColumn}>
                      <Text style={[styles.tabLabel, active && styles.tabLabelActive, !active && isEmpty && styles.tabLabelDim]}>
                        {tab.label}{countSuffix}
                      </Text>
                      {showSortedIndicator && (
                        <Text style={styles.tabSortedLabel}>★ sorted</Text>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {showMapToggle && (
              <View style={styles.viewToggle}>
                <Pressable style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]} onPress={() => setViewMode('list')}>
                  <Text style={[styles.toggleBtnText, viewMode === 'list' && styles.toggleBtnTextActive]}>List</Text>
                </Pressable>
                <Pressable style={[styles.toggleBtn, viewMode === 'map' && styles.toggleBtnActive]} onPress={() => setViewMode('map')}>
                  <MapPin size={11} color={viewMode === 'map' ? color.signal : color.mute} />
                  <Text style={[styles.toggleBtnText, viewMode === 'map' && styles.toggleBtnTextActive]}>Map</Text>
                </Pressable>
              </View>
            )}
          </View>

          {/* Expanded filter panel — always fully opaque */}
          {filtersExpanded && (
            <View style={styles.filtersPanel} pointerEvents="auto">
              {activeFilters.sortBy != null && (
                <View style={styles.activeSortRow}>
                  <Text style={styles.activeSortLabel}>Sorted by</Text>
                  <View style={styles.activeSortChip}>
                    <Text style={styles.activeSortChipText}>
                      {SORT_LABELS[activeFilters.sortBy] ?? activeFilters.sortBy}
                    </Text>
                    <Pressable
                      onPress={() => handleFiltersChange({ ...activeFilters, sortBy: null })}
                      hitSlop={8}
                    >
                      <X size={10} color={color.signal} />
                    </Pressable>
                  </View>
                </View>
              )}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.modeBar} contentContainerStyle={styles.modeBarContent}>
                {CONTEXT_MODES.map((m) => {
                  const active = m.key === contextMode;
                  return (
                    <Pressable key={m.key} style={[styles.modeChip, active && styles.modeChipActive]} onPress={() => setContextMode(m.key)}>
                      <m.Icon size={12} color={active ? color.signal : color.mute} />
                      <Text style={[styles.modeChipLabel, active && styles.modeChipLabelActive]}>{m.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.ageFilterBar} contentContainerStyle={styles.ageFilterBarContent}>
                {([
                  { key: 'any',        label: 'Any age' },
                  { key: 'open_to_me', label: 'Open to me' },
                  { key: '18_plus',    label: '18+' },
                  { key: '21_plus',    label: '21+' },
                  { key: 'under_30',   label: 'Under 30' },
                  { key: '30_plus',    label: '30+' },
                  { key: 'custom',     label: 'Custom' },
                ] as { key: DiscoveryAgeFilter; label: string }[]).map((opt) => {
                  const active = ageFilter === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[styles.ageChip, active && styles.ageChipActive]}
                      onPress={() => {
                        setAgeFilter(opt.key);
                        if (opt.key !== 'custom') { setCustomAgeRange({ min: null, max: null }); setDebouncedAgeRange({ min: null, max: null }); }
                      }}
                    >
                      {opt.key === 'open_to_me' && <Users size={10} color={active ? color.signal : color.mute} />}
                      <Text style={[styles.ageChipLabel, active && styles.ageChipLabelActive]}>{opt.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {ageFilter === 'custom' && (
                <View style={styles.customRangeRow}>
                  <Text style={styles.customRangeLabel}>Min age</Text>
                  <TextInput style={styles.customRangeInput} value={customAgeRange.min != null ? String(customAgeRange.min) : ''} onChangeText={(v) => setCustomAgeRange((p) => ({ ...p, min: v ? parseInt(v, 10) || null : null }))} keyboardType="number-pad" placeholder="e.g. 18" placeholderTextColor={color.mute} maxLength={3} />
                  <Text style={styles.customRangeLabel}>Max age</Text>
                  <TextInput style={styles.customRangeInput} value={customAgeRange.max != null ? String(customAgeRange.max) : ''} onChangeText={(v) => setCustomAgeRange((p) => ({ ...p, max: v ? parseInt(v, 10) || null : null }))} keyboardType="number-pad" placeholder="e.g. 35" placeholderTextColor={color.mute} maxLength={3} />
                </View>
              )}

              <FilterStrip
                filters={activeFilters}
                onChange={handleFiltersChange}
                hasUserLocation={hasUserLocation}
                onNearestUnavailable={handleNearestUnavailable}
                locationPermissionDenied={locationState.permissionStatus === 'denied'}
                nearestLocating={nearestLocating}
              />
              {(activeFilters.radiusKm !== 10 || activeFilters.openNow || activeFilters.minRating !== null || activeFilters.sortBy != null) && (
                <Pressable style={styles.resetFiltersBtn} onPress={handleResetFilters}>
                  <Text style={styles.resetFiltersText}>Reset filters</Text>
                </Pressable>
              )}
            </View>
          )}

          {/* GPS-timeout inline message — shown when Nearest chip times out */}
          {nearestGpsMessage != null && (
            <View style={styles.nearestGpsMessage} pointerEvents="none">
              <Text style={styles.nearestGpsMessageText}>{nearestGpsMessage}</Text>
            </View>
          )}

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
                <Text style={styles.featuredBannerSub}>
                  {featuredCount != null ? `${featuredCount} pick${featuredCount === 1 ? '' : 's'} this week` : 'This week\'s top picks'}
                </Text>
              </View>
            </View>
            <Text style={styles.featuredBannerArrow}>›</Text>
          </Pressable>

          {/* Following highlights — float below filter panel */}
          {isAuthed && (
            <View pointerEvents="auto">
              <FollowingHighlightsStrip
                users={highlightUsers}
                sessionViewedIds={sessionViewedIds}
                onMarkViewed={markSessionViewed}
              />
            </View>
          )}

          {/* Trending hashtags */}
          {trendingHashtags.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.trendingBar} contentContainerStyle={styles.trendingBarContent} pointerEvents="auto">
              {trendingHashtags.map((ht) => (
                <Pressable key={ht.id} style={styles.trendingChip} onPress={() => router.push(`/hashtag/${ht.slug}` as any)}>
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

        </View>
      </View>

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

      {/* Layover Mode floating entry — hidden while the place detail sheet is open */}
      {!detailVisible && (
        <Pressable style={styles.layoverFab} onPress={() => setLayoverOpen(true)}>
          <Plane size={16} color="#fff" />
          <Text style={styles.layoverFabText}>Layover Mode</Text>
        </Pressable>
      )}

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
    </SectionErrorBoundary>
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
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  sharePlaceBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.signal + '12',
    borderWidth: 1,
    borderColor: color.signal + '30',
    flexShrink: 0,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 20,
    flexShrink: 0,
  },
  filtersTabBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.haze,
    flexShrink: 0,
  },
  filtersTabBtnActive: {
    backgroundColor: color.signal,
  },
  filtersTabBtnBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  filtersTabBtnBadgeText: {
    fontSize: 9,
    fontWeight: '800' as const,
    color: color.signal,
  },
  tabDivider: {
    width: 1,
    height: 20,
    backgroundColor: color.haze,
    marginHorizontal: space.xs,
    alignSelf: 'center',
    flexShrink: 0,
  },
  filtersPanel: {
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  contentArea: {
    flex: 1,
    overflow: 'hidden',
  },
  floatingChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tabRowSemi: {
    backgroundColor: 'rgba(255,255,255,0.90)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.10)',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  tabRowSolid: {
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tabBar: {
    flexGrow: 1,
    flexShrink: 1,
  },
  tabBarContent: {
    paddingHorizontal: space.md,
    gap: space.xs,
    paddingVertical: space.sm,
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
  activeSortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  activeSortLabel: {
    fontSize: 11,
    fontWeight: '500' as const,
    color: color.mute,
  },
  tabLabelColumn: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  tabSortedLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: color.signal,
    letterSpacing: 0.3,
    marginTop: -1,
  },
  modeBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  modeBarContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
  },
  modeChipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  modeChipLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  modeChipLabelActive: {
    color: color.signal,
  },
  ageFilterBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  ageFilterBarContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  ageChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
  },
  ageChipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  ageChipLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: color.mute,
  },
  ageChipLabelActive: {
    color: color.signal,
  },
  customRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  customRangeLabel: {
    fontSize: 12,
    color: color.mute,
    fontWeight: '600' as const,
  },
  customRangeInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    fontSize: 13,
    color: color.ink,
    backgroundColor: color.paper,
    textAlign: 'center',
  },
  layoverFab: {
    position: 'absolute',
    bottom: 24,
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
  resetFiltersBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  resetFiltersText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    textDecorationLine: 'underline' as const,
  },
  nearestGpsMessage: {
    marginHorizontal: space.lg,
    marginTop: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.mute + '14',
    borderWidth: 1,
    borderColor: color.mute + '30',
  },
  nearestGpsMessageText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center' as const,
  },
  activeSortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.signal + '14',
    borderWidth: 1,
    borderColor: color.signal + '40',
    marginLeft: space.xs,
    flexShrink: 0,
  },
  activeSortChipText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: color.signal,
  },
  activeSortChipX: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: color.signal,
    opacity: 0.7,
  },
  searchEntryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginVertical: space.xs,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  searchEntryText: {
    ...t.body,
    color: color.faint,
    flex: 1,
  },
});

export default function DiscoveryHub() {
  return (
    <ScreenErrorBoundary>
      <DiscoveryHubScreen />
    </ScreenErrorBoundary>
  );
}
