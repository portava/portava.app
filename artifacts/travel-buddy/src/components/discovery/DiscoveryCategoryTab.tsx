import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Search } from 'lucide-react-native';
import type { DiscoveryCategory, DiscoveryFilters, DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';
import PlaceCard from './PlaceCard';

// ── Radius chips ──────────────────────────────────────────────────────────────

const RADIUS_OPTIONS: { label: string; km: number }[] = [
  { label: '5 km',  km: 5  },
  { label: '10 km', km: 10 },
  { label: '25 km', km: 25 },
  { label: '50 km', km: 50 },
];

interface FilterStripProps {
  filters: DiscoveryFilters;
  onChange: (f: DiscoveryFilters) => void;
}

function FilterStrip({ filters, onChange }: FilterStripProps) {
  return (
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
  );
}

const fs = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
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

// ── Main tab component ────────────────────────────────────────────────────────

interface DiscoveryCategoryTabProps {
  category: DiscoveryCategory;
  destination: string;
  onSelectPlace: (place: DiscoveryPlace) => void;
  onAddToPlan: (place: DiscoveryPlace) => void;
}

export function DiscoveryCategoryTab({
  category,
  destination,
  onSelectPlace,
  onAddToPlan,
}: DiscoveryCategoryTabProps) {
  const [places, setPlaces]     = useState<DiscoveryPlace[]>([]);
  const [loading, setLoading]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [page, setPage]         = useState(1);
  const [total, setTotal]       = useState(0);
  const [filters, setFilters]   = useState<DiscoveryFilters>({ radiusKm: 10 });
  const loadingMore             = useRef(false);

  const load = useCallback(async (nextPage: number, currentFilters: DiscoveryFilters, reset: boolean) => {
    if (!destination) return;
    if (reset) setLoading(true);
    setError(null);

    const res = await getDiscoveryPlaces(destination, category, currentFilters, nextPage);

    setLoading(false);
    setRefreshing(false);
    loadingMore.current = false;

    if (!res.ok) {
      setError(res.error);
      return;
    }

    setTotal(res.data.total);
    setPlaces((prev) => reset ? res.data.places : [...prev, ...res.data.places]);
    setPage(nextPage);
  }, [destination, category]);

  useEffect(() => {
    setPlaces([]);
    setPage(1);
    load(1, filters, true);
  }, [destination, category, filters, load]);

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
      <View style={styles.center}>
        <Search size={32} color={color.faint} />
        <Text style={styles.emptyTitle}>No destination set</Text>
        <Text style={styles.emptyDesc}>
          Create or open a trip to set a destination and start discovering.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FilterStrip filters={filters} onChange={handleFilterChange} />

      {loading && places.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
          <Text style={styles.loadingText}>Finding places near {destination}…</Text>
        </View>
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
            Try increasing the search radius or pick a different category.
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
            loadingMore.current ? (
              <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />
            ) : places.length >= total && places.length > 0 ? (
              <Text style={styles.endText}>{places.length} places found</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
  },
  loadingText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    marginTop: space.md,
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
