import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Switch,
} from 'react-native';
import { Search } from 'lucide-react-native';
import type { DiscoveryCategory, DiscoveryContextMode, DiscoveryFilters, DiscoveryPlace } from '../../services/discovery.ts';
import { getDiscoveryPlaces, getCachedDiscoveryPlaces } from '../../services/discovery.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import PlaceCard from './PlaceCard.tsx';
import { PlaceSkeletonList } from './PlaceSkeleton.tsx';
import { usePopularCities } from '../../hooks/usePopularCities.ts';
import { POPULAR } from '../selectors/GlobalPlacePicker.tsx';
import type { Place } from '../../lib/location/placeTypes.ts';

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
}

function FilterStrip({ filters, onChange }: FilterStripProps) {
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
        <Pressable
          style={[fs.chip, filters.sortBy === 'rating' && fs.chipActive]}
          onPress={() => onChange({ ...filters, sortBy: filters.sortBy === 'rating' ? null : 'rating' })}
        >
          <Text style={[fs.chipText, filters.sortBy === 'rating' && fs.chipTextActive]}>★ Top rated</Text>
        </Pressable>
      </View>
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
});

// ── Popular destinations fallback ─────────────────────────────────────────────

interface NoDestinationProps {
  /** Emits a full normalized Place (canonical when online) — never a raw string. */
  onPickPlace: (place: Place) => void;
  userLat?: number | null;
  userLng?: number | null;
}

function NoDestinationView({ onPickPlace, userLat, userLng }: NoDestinationProps) {
  // Real activity ranking ("Popular on Portava"), proximity-biased when the
  // user's coords are known; falls back to the seed list offline.
  const { places } = usePopularCities({ lat: userLat, lng: userLng, limit: 10 });
  const chips = places.length > 0 ? places : POPULAR.slice(0, 10);
  return (
    <View style={nd.wrap}>
      <Search size={32} color={color.faint} />
      <Text style={nd.title}>Pick a destination</Text>
      <Text style={nd.sub}>Tap the city bar above, or choose a popular one:</Text>
      <View style={nd.chips}>
        {chips.map((place) => (
          <Pressable key={place.id} style={nd.chip} onPress={() => onPickPlace(place)}>
            <Text style={nd.chipText}>{place.name}</Text>
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
  /** Fired with a full normalized Place when the user picks a popular destination chip. */
  onPickDestination?: (place: Place) => void;
  contextMode?: DiscoveryContextMode | null;
  ageFilter?: import('../../../src/services/discovery').DiscoveryAgeFilter | null;
  customMinAge?: number | null;
  customMaxAge?: number | null;
  lat?: number | null;
  lng?: number | null;
  userLat?: number | null;
  userLng?: number | null;
  fallbackZoom?: number;
  /** Called whenever the user changes radius, open-now, or min-rating. */
  onFiltersChange?: (filters: DiscoveryFilters) => void;
  /** Extra padding at the bottom of the list to clear the floating nav bar. */
  bottomInset?: number;
  /** Reanimated scroll handler forwarded from the parent discovery screen. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onScroll?: any;
  /** Shared header element from the parent discovery screen — scrolls inside this tab's FlatList. */
  listHeaderComponent?: React.ReactElement;
  /** Invoked alongside this tab's own places refresh so the parent can re-fetch counts/buddy-strip/trending on pull-to-refresh. */
  onRefresh?: () => void;
}

export function DiscoveryCategoryTab({
  category,
  destination,
  onSelectPlace,
  onAddToPlan,
  onAddToRoute,
  onPickDestination,
  contextMode,
  ageFilter,
  customMinAge,
  customMaxAge,
  lat,
  lng,
  userLat,
  userLng,
  fallbackZoom,
  onFiltersChange,
  bottomInset,
  onScroll,
  listHeaderComponent,
  onRefresh,
}: DiscoveryCategoryTabProps) {
  // SWR: seed from in-memory client cache so second opens paint instantly.
  const [places, setPlaces]         = useState<DiscoveryPlace[]>(() => {
    if (!destination) return [];
    return getCachedDiscoveryPlaces(destination, category, 10, 1)?.places ?? [];
  });
  const [loading, setLoading]       = useState<boolean>(() => {
    if (!destination) return false;
    return getCachedDiscoveryPlaces(destination, category, 10, 1) === null;
  });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [page, setPage]             = useState(1);
  const [total, setTotal]           = useState(0);
  const [filters, setFilters]       = useState<DiscoveryFilters>({ radiusKm: 10, openNow: false, minRating: null });
  const loadingMore                 = useRef(false);

  // Notify parent whenever the filter strip changes so it can refresh count badges.
  // prevFiltersRef suppresses the mount-time call (and any re-run where filters
  // didn't actually change, e.g. a new onFiltersChange identity) — the parent
  // updates its own state in response, which would otherwise re-render this
  // component and risk a render loop.
  const prevFiltersRef = useRef<DiscoveryFilters | null>(null);
  useEffect(() => {
    const prev = prevFiltersRef.current;
    prevFiltersRef.current = filters;
    if (prev === null || prev === filters) return;
    onFiltersChange?.(filters);
  }, [filters, onFiltersChange]);

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

  const load = useCallback(async (nextPage: number, currentFilters: DiscoveryFilters, reset: boolean) => {
    if (!destination) return;
    if (reset) setLoading(true);
    setError(null);

    const res = await getDiscoveryPlaces(
      destination, category, currentFilters, nextPage,
      contextMode, ageFilter, customMinAge, customMaxAge,
      lat, lng,
      // User's real GPS position — required so the backend computes distanceKm
      // from the user's actual location rather than falling back to the
      // (potentially province-level) destination-search coordinates.
      userLat, userLng,
      // emitSignal=true only on page 1 so explicit category-tab selections
      // contribute to Compass personalization without double-counting pagination.
      nextPage === 1,
    );

    setLoading(false);
    setRefreshing(false);
    loadingMore.current = false;

    if (!res.ok) {
      setError(res.error);
      return;
    }

    // Normalize at the boundary: missing/invalid array → [], missing total → 0.
    const rawPlaces = Array.isArray(res.data?.places) ? res.data.places : [];
    const filtered = applyClientFilters(rawPlaces);
    setTotal(Number.isFinite(res.data?.total) ? res.data.total : 0);
    // Replace on page-1 (new query), append on subsequent pages (pagination).
    // Using nextPage===1 (not the reset flag) ensures a first-page revalidation
    // after a cache hit still replaces stale content rather than appending.
    setPlaces((prev) => nextPage === 1 ? filtered : [...prev, ...filtered]);
    setPage(nextPage);
  }, [destination, category, filters, ageFilter, customMinAge, customMaxAge]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // SWR: immediately hydrate with the cache entry for the active destination/
    // category/filters so city or tab switches never show old-query content.
    // On miss, clear and show skeleton; on hit, show stale content while the
    // network refresh runs (reset=false → no skeleton, page-1 → list replaced).
    const cachedResult = destination
      ? getCachedDiscoveryPlaces(destination, category, filters.radiusKm, 1)
      : null;
    if (cachedResult) {
      setPlaces(cachedResult.places);
      setLoading(false);
    } else {
      setPlaces([]);
    }
    setPage(1);
    load(1, filters, cachedResult === null); // reset=true (skeleton) only on miss
  }, [destination, category, filters, ageFilter, customMinAge, customMaxAge, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setRefreshing(true);
    setPlaces([]);
    load(1, filters, false);
    onRefresh?.();
  };

  const handleLoadMore = () => {
    if (loadingMore.current || places.length >= total) return;
    loadingMore.current = true;
    load(page + 1, filters, false);
  };

  const handleFilterChange = (f: DiscoveryFilters) => {
    setFilters(f);
    setPlaces([]);
    setPage(1);
  };

  if (!destination) {
    return (
      <View style={{ flex: 1 }}>
        {listHeaderComponent}
        <NoDestinationView
          onPickPlace={(place) => onPickDestination?.(place)}
          userLat={userLat}
          userLng={userLng}
        />
      </View>
    );
  }

  // Combined header: discovery header (from parent) + filter strip — all scrolls together
  const listHeader = (
    <View>
      {listHeaderComponent}
      <FilterStrip filters={filters} onChange={handleFilterChange} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {loading && places.length === 0 ? (
        <>
          {listHeader}
          <PlaceSkeletonList count={6} />
        </>
      ) : error && places.length === 0 ? (
        <>
          {listHeader}
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn't load places</Text>
            <Text style={styles.emptyDesc}>{error}</Text>
            <Pressable style={styles.retryBtn} onPress={() => load(1, filters, true)}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        </>
      ) : places.length === 0 ? (
        <>
          {listHeader}
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No places found</Text>
            <Text style={styles.emptyDesc}>
              Try increasing the search radius or adjust the filters.
            </Text>
          </View>
        </>
      ) : (
        <FlatList
          testID="main-scroll"
          data={places}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PlaceCard
              place={item}
              onPress={() => onSelectPlace(item)}
              onAddToPlan={() => onAddToPlan(item)}
              onAddToRoute={onAddToRoute}
              showDistance={filters.sortBy === 'nearest'}
              city={destination}
            />
          )}
          ListHeaderComponent={listHeader}
          contentContainerStyle={[styles.list, bottomInset != null ? { paddingBottom: bottomInset } : undefined]}
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
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
    paddingBottom: 130,
  },
  endText: {
    ...t.stamp,
    color: color.faint,
    fontSize: 11,
    textAlign: 'center',
    marginVertical: space.xl,
  },
});

export default DiscoveryCategoryTab;
