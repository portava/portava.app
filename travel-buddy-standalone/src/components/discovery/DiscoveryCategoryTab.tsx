import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Switch, Animated,
} from 'react-native';
import { Search } from 'lucide-react-native';
import type { DiscoveryCategory, DiscoveryContextMode, DiscoveryFilters, DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';
import PlaceCard from './PlaceCard';
import { PlaceSkeletonList } from './PlaceSkeleton';
import { DiscoveryMapView } from './DiscoveryMapView';

// ── Sort labels ───────────────────────────────────────────────────────────────

export const SORT_LABELS: Record<string, string> = {
  rating: '★ Top rated',
  nearest: '📍 Nearest',
  popular: '🔥 Most popular',
};

// ── Radius chips ──────────────────────────────────────────────────────────────

const RADIUS_OPTIONS: { label: string; km: number }[] = [
  { label: '5 km',  km: 5  },
  { label: '10 km', km: 10 },
  { label: '25 km', km: 25 },
  { label: '50 km', km: 50 },
];

const MIN_RATING_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Any',  value: null },
  { label: '3+',   value: 3   },
  { label: '4+',   value: 4   },
  { label: '4.5+', value: 4.5 },
];

interface FilterStripProps {
  filters: DiscoveryFilters;
  onChange: (f: DiscoveryFilters) => void;
  /**
   * True when real user GPS coordinates are available.
   * When false, tapping Nearest calls onNearestUnavailable instead of applying
   * the sort, and the chip is visually marked as requiring location.
   */
  hasUserLocation?: boolean;
  /**
   * Called when the user taps Nearest but no user location is available.
   * Callers should either trigger a permission request (if not denied) or
   * explain why (if permanently denied).
   */
  onNearestUnavailable?: () => void;
  /**
   * True when the OS location permission is permanently denied.
   * When set, an inline hint is shown below the Sort row explaining that the
   * user must re-enable location in device Settings.
   */
  locationPermissionDenied?: boolean;
}

export function FilterStrip({
  filters,
  onChange,
  hasUserLocation = true,
  onNearestUnavailable,
  locationPermissionDenied = false,
}: FilterStripProps) {
  return (
    <View style={fs.wrap}>
      {/* Radius chips */}
      <View style={fs.row}>
        {RADIUS_OPTIONS.map((opt) => {
          const active = filters.radiusKm === opt.km;
          return (
            <Pressable
              key={opt.km}
              style={[fs.chip, active && fs.chipActive]}
              onPress={() => onChange({ ...filters, radiusKm: opt.km })}
            >
              <Text style={[fs.chipText, active && fs.chipTextActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Open Now toggle + Min rating */}
      <View style={fs.row2}>
        <View style={fs.toggleRow}>
          <Switch
            value={filters.openNow}
            onValueChange={(v) => onChange({ ...filters, openNow: v })}
            trackColor={{ false: color.haze, true: color.signal + '60' }}
            thumbColor={filters.openNow ? color.signal : color.faint}
            style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
          />
          <Text style={fs.toggleLabel}>Open now</Text>
        </View>

        <View style={fs.ratingRow}>
          <Text style={fs.ratingLabel}>Rating:</Text>
          {MIN_RATING_OPTIONS.map((opt) => {
            const active = filters.minRating === opt.value;
            return (
              <Pressable
                key={String(opt.value)}
                style={[fs.chip, active && fs.chipActive]}
                onPress={() => onChange({ ...filters, minRating: opt.value })}
              >
                <Text style={[fs.chipText, active && fs.chipTextActive]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Sort order */}
      <View style={fs.row2}>
        <Text style={fs.ratingLabel}>Sort:</Text>
        {Object.entries(SORT_LABELS).map(([key, label]) => {
          const isActive = filters.sortBy === key;
          const isNearest = key === 'nearest';
          const nearestLocked = isNearest && !hasUserLocation;
          return (
            <Pressable
              key={key}
              style={[
                fs.chip,
                isActive && fs.chipActive,
                nearestLocked && fs.chipLocked,
              ]}
              onPress={() => {
                if (nearestLocked) {
                  onNearestUnavailable?.();
                  return;
                }
                onChange({ ...filters, sortBy: isActive ? null : key });
              }}
            >
              <Text style={[
                fs.chipText,
                isActive && fs.chipTextActive,
                nearestLocked && fs.chipTextLocked,
              ]}>
                {label}
              </Text>
              {nearestLocked && (
                <Text style={fs.chipLockIcon}> 🔒</Text>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Inline hint shown when location permission is permanently denied */}
      {locationPermissionDenied && (
        <Text style={fs.locationDeniedHint}>
          📍 Location is off — enable it in your device Settings to sort by nearest
        </Text>
      )}
    </View>
  );
}

const fs = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  row2: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  toggleLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flex: 1,
    flexWrap: 'wrap',
  },
  ratingLabel: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
  },
  chip: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs + 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '12',
  },
  chipText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
  },
  chipTextActive: {
    color: color.signal,
    fontWeight: '700',
  },
  chipLocked: {
    borderColor: color.faint,
    opacity: 0.6,
  },
  chipTextLocked: {
    color: color.faint,
  },
  chipLockIcon: {
    fontSize: 9,
    color: color.faint,
  },
  locationDeniedHint: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    lineHeight: 15,
    paddingTop: 2,
  },
});

// ── Location distance helper ──────────────────────────────────────────────────

/** Approximate great-circle distance in km between two lat/lng pairs. */
function approxDistanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const NEAREST_REFRESH_THRESHOLD_KM = 0.1;

// ── Popular destinations fallback ─────────────────────────────────────────────

const POPULAR_CITIES = [
  'Paris', 'Tokyo', 'Bali', 'Barcelona', 'London',
  'New York', 'Rome', 'Amsterdam', 'Bangkok', 'Sydney',
];

interface NoDestinationProps {
  onPickCity: (city: string) => void;
}

function NoDestinationView({ onPickCity }: NoDestinationProps) {
  return (
    <View style={nd.wrap}>
      <Search size={32} color={color.faint} />
      <Text style={nd.title}>Pick a destination</Text>
      <Text style={nd.sub}>Tap the city bar above, or choose a popular one:</Text>
      <View style={nd.chips}>
        {POPULAR_CITIES.map((city) => (
          <Pressable key={city} style={nd.chip} onPress={() => onPickCity(city)}>
            <Text style={nd.chipText}>{city}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const nd = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  title: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  sub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
});

// ── Main tab component ────────────────────────────────────────────────────────

interface DiscoveryCategoryTabProps {
  category: DiscoveryCategory;
  destination: string;
  onSelectPlace: (place: DiscoveryPlace) => void;
  onAddToPlan: (place: DiscoveryPlace) => void;
  onAddToRoute?: (draft: import('../RouteBuilderSheet').RouteStopDraft) => void;
  onPickDestination?: (city: string) => void;
  contextMode?: DiscoveryContextMode | null;
  viewMode?: 'list' | 'map';
  ageFilter?: import('../../../src/services/discovery').DiscoveryAgeFilter | null;
  customMinAge?: number | null;
  customMaxAge?: number | null;
  lat?: number | null;
  lng?: number | null;
  userLat?: number | null;
  userLng?: number | null;
  fallbackZoom?: number;
  /** Controlled filters — passed from the parent (discovery.tsx owns the state). */
  filters: DiscoveryFilters;
  /** Kept for back-compat; no longer called by this component. */
  onFiltersChange?: (filters: DiscoveryFilters) => void;
  /** Padding applied to the list top so first items clear the floating chrome overlay. 0 for map mode. */
  listTopInset?: number;
}

export function DiscoveryCategoryTab({
  category,
  destination,
  onSelectPlace,
  onAddToPlan,
  onAddToRoute,
  onPickDestination,
  contextMode,
  viewMode = 'list',
  ageFilter,
  customMinAge,
  customMaxAge,
  lat,
  lng,
  userLat,
  userLng,
  fallbackZoom,
  filters,
  listTopInset = 0,
}: DiscoveryCategoryTabProps) {
  const [places, setPlaces]         = useState<DiscoveryPlace[]>([]);
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [page, setPage]             = useState(1);
  const [total, setTotal]           = useState(0);
  const [locationNudge, setLocationNudge] = useState(false);
  const loadingMore                 = useRef(false);
  const nudgeOpacity                = useRef(new Animated.Value(0)).current;
  const nudgeTimer                  = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stores the coords that were active when the last fetch fired. */
  const lastFetchedCoords           = useRef<{ lat: number; lng: number } | null>(null);
  /**
   * Refs for the current user coords — kept in sync every render so `load`
   * can read the latest value without closing over the prop, which would make
   * it recreate on every GPS update and re-trigger the main fetch effect.
   */
  const userLatRef = useRef(userLat);
  const userLngRef = useRef(userLng);
  userLatRef.current = userLat;
  userLngRef.current = userLng;

  const applyClientFilters = (raw: DiscoveryPlace[]): DiscoveryPlace[] => {
    let result = raw;
    // Open Now filter: OSM has opening_hours occasionally — filter where present
    if (filters.openNow) {
      result = result.filter((p) => {
        if (!p.openingHours) return true; // no data → include optimistically
        return isLikelyOpen(p.openingHours);
      });
    }
    // Min rating: OSM rarely carries ratings — no-op client-side for now
    // (kept as a UI affordance; future backend pass can honour it)
    return result;
  };

  const showNudge = useCallback(() => {
    setLocationNudge(true);
    Animated.timing(nudgeOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [nudgeOpacity]);

  const hideNudge = useCallback(() => {
    Animated.timing(nudgeOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
      setLocationNudge(false);
    });
  }, [nudgeOpacity]);

  const load = useCallback(async (nextPage: number, currentFilters: DiscoveryFilters, reset: boolean) => {
    if (!destination) return;
    if (reset) setLoading(true);
    setError(null);

    // Read user coords from refs so this callback stays stable across GPS updates.
    // The location-change effect is the sole handler that re-fires when the user
    // moves; `load` itself must not recreate on every coord update or the main
    // filter/destination effect would bypass the distance gate.
    const snapUserLat = userLatRef.current;
    const snapUserLng = userLngRef.current;

    // Pass the user's actual coordinates as separate userLat/userLng params when
    // sortBy=nearest so the backend can recompute distances from the user's position.
    // The lat/lng params always remain the destination coordinates — the Overpass query
    // centre and cache key must never use user coords.
    const nearestUserLat = currentFilters.sortBy === 'nearest' ? snapUserLat : null;
    const nearestUserLng = currentFilters.sortBy === 'nearest' ? snapUserLng : null;

    const res = await getDiscoveryPlaces(destination, category, currentFilters, nextPage, contextMode, ageFilter, customMinAge, customMaxAge, lat, lng, nearestUserLat, nearestUserLng);

    setLoading(false);
    setRefreshing(false);
    loadingMore.current = false;

    if (!res.ok) {
      setError(res.error);
      return;
    }

    // Record the coords at the time of this fetch so the location-change
    // effect can compare against them (not just against the previous render).
    if (nearestUserLat != null && nearestUserLng != null) {
      lastFetchedCoords.current = { lat: nearestUserLat, lng: nearestUserLng };
    }

    const filtered = applyClientFilters(res.data.places);
    setTotal(res.data.total);
    setPlaces((prev) => reset ? filtered : [...prev, ...filtered]);
    setPage(nextPage);
  }, [destination, category, filters, ageFilter, customMinAge, customMaxAge]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPlaces([]);
    setPage(1);
    load(1, filters, true);
  }, [destination, category, filters, ageFilter, customMinAge, customMaxAge, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect meaningful location changes while 'nearest' sort is active and
  // auto-refresh so the order stays accurate as the user moves around.
  useEffect(() => {
    if (filters.sortBy !== 'nearest') return;
    if (userLat == null || userLng == null) return;

    const prev = lastFetchedCoords.current;

    if (prev == null) {
      // Bootstrap case: Nearest was already active but the last fetch ran
      // without valid user coords (e.g. permission was granted after the user
      // tapped the Nearest chip). Re-fetch now that we have a real position.
      // No nudge is needed — this is effectively the initial nearest load completing.
      setPlaces([]);
      setPage(1);
      load(1, filters, true);
      return;
    }

    const distKm = approxDistanceKm(prev.lat, prev.lng, userLat, userLng);
    if (distKm < NEAREST_REFRESH_THRESHOLD_KM) return;

    // Movement exceeds 0.1 km — auto-refresh and show a brief nudge.
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    showNudge();

    setPlaces([]);
    setPage(1);
    load(1, filters, true);

    nudgeTimer.current = setTimeout(() => {
      hideNudge();
      nudgeTimer.current = null;
    }, 3000);

    return () => {
      // Always clear the timer and hide the nudge on cleanup so it never gets
      // stuck visible if the next effect run exits early (e.g. distance < threshold).
      if (nudgeTimer.current) {
        clearTimeout(nudgeTimer.current);
        nudgeTimer.current = null;
      }
      hideNudge();
    };
  }, [userLat, userLng]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setRefreshing(true);
    setPlaces([]);
    load(1, filters, false);
  };

  const handleLoadMore = () => {
    if (loadingMore.current || places.length >= total) return;
    loadingMore.current = true;
    load(page + 1, filters, false);
  };

  if (!destination) {
    return (
      <NoDestinationView onPickCity={(city) => onPickDestination?.(city)} />
    );
  }

  return (
    <View style={{ flex: 1 }}>

      {locationNudge && (
        <Animated.View style={[nudge.bar, { opacity: nudgeOpacity }]} pointerEvents="none">
          <Text style={nudge.text}>📍 Location updated — re-sorting nearest places</Text>
        </Animated.View>
      )}

      {loading && places.length === 0 ? (
        <PlaceSkeletonList count={6} />
      ) : viewMode === 'map' ? (
        <DiscoveryMapView key={destination} places={places} onSelectPlace={onSelectPlace} fallbackLat={lat} fallbackLng={lng} userLat={userLat} userLng={userLng} fallbackZoom={fallbackZoom} topInset={listTopInset} />
      ) : error && places.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Couldn't load places</Text>
          <Text style={styles.emptyDesc}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => load(1, filters, true)}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : places.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No places found</Text>
          <Text style={styles.emptyDesc}>
            Try increasing the search radius or adjust the filters.
          </Text>
        </View>
      ) : (
        <FlatList
          data={places}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PlaceCard
              place={item}
              onPress={() => onSelectPlace(item)}
              onAddToPlan={() => onAddToPlan(item)}
              onAddToRoute={onAddToRoute}
              showDistance={filters.sortBy === 'nearest'}
            />
          )}
          contentContainerStyle={listTopInset > 0 ? [styles.list, { paddingTop: listTopInset }] : styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={color.signal}
            />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            places.length >= total && places.length > 0 ? (
              <Text style={styles.endText}>{places.length} places found</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

/** Crude heuristic: check if today's day abbreviation appears in opening hours */
function isLikelyOpen(hours: string): boolean {
  const now = new Date();
  const dayAbbr = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][now.getDay()];
  const hh = now.getHours() * 100 + now.getMinutes();
  // Simple: if hours string mentions the day and seems to cover current hour
  if (!hours.includes(dayAbbr ?? '')) return false;
  const match = hours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!match) return true; // can't parse, be optimistic
  const open  = parseInt(match[1]!) * 100 + parseInt(match[2]!);
  const close = parseInt(match[3]!) * 100 + parseInt(match[4]!);
  return hh >= open && hh <= close;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  emptyDesc: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 19,
  },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  list: {
    paddingTop: space.sm,
    paddingBottom: space.xxxl,
  },
  endText: {
    ...t.stamp,
    color: color.faint,
    fontSize: 11,
    textAlign: 'center',
    marginVertical: space.xl,
  },
});

const nudge = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: color.signal,
    paddingVertical: space.xs + 2,
    paddingHorizontal: space.md,
    alignItems: 'center',
  },
  text: {
    ...t.stamp,
    color: color.onInk,
    fontSize: 12,
    fontWeight: '600',
  },
});

export default DiscoveryCategoryTab;
