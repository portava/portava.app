import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl, Switch,
} from 'react-native';
import { Search } from 'lucide-react-native';
import type { DiscoveryCategory, DiscoveryContextMode, DiscoveryFilters, DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';
import PlaceCard from './PlaceCard';
import { PlaceSkeletonList } from './PlaceSkeleton';
import { DiscoveryMapView } from './DiscoveryMapView';

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
  /** Called whenever the user changes radius, open-now, or min-rating. */
  onFiltersChange?: (filters: DiscoveryFilters) => void;
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
  onFiltersChange,
}: DiscoveryCategoryTabProps) {
  const [places, setPlaces]         = useState<DiscoveryPlace[]>([]);
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [page, setPage]             = useState(1);
  const [total, setTotal]           = useState(0);
  const [filters, setFilters]       = useState<DiscoveryFilters>({ radiusKm: 10, openNow: false, minRating: null });
  const loadingMore                 = useRef(false);

  // Notify parent whenever the filter strip changes so it can refresh count badges.
  useEffect(() => { onFiltersChange?.(filters); }, [filters, onFiltersChange]);

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

    const res = await getDiscoveryPlaces(destination, category, currentFilters, nextPage, contextMode, ageFilter, customMinAge, customMaxAge, lat, lng);

    setLoading(false);
    setRefreshing(false);
    loadingMore.current = false;

    if (!res.ok) {
      setError(res.error);
      return;
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

  const handleFilterChange = (f: DiscoveryFilters) => {
    setFilters(f);
    setPlaces([]);
    setPage(1);
  };

  if (!destination) {
    return (
      <NoDestinationView onPickCity={(city) => onPickDestination?.(city)} />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FilterStrip filters={filters} onChange={handleFilterChange} />

      {loading && places.length === 0 ? (
        <PlaceSkeletonList count={6} />
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
      ) : viewMode === 'map' ? (
        <DiscoveryMapView places={places} onSelectPlace={onSelectPlace} />
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
            />
          )}
          contentContainerStyle={styles.list}
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

export default DiscoveryCategoryTab;
