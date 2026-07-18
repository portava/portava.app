/**
 * DestinationsTab — aggregated destination cards on the Passport screen.
 *
 * Groups the user's memories, postcards, and trips by city and renders either:
 *   • List mode — a scrollable FlatList of destination cards (default).
 *   • Map  mode — a MapLibre map with one pin per destination city; tapping a
 *                 pin opens the DestinationDetailScreen for that city.
 *
 * The List / Map toggle lives in an inline header row above the content.
 * A filter chip bar lets users narrow pins/cards by content type.
 */
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
  ActivityIndicator, useWindowDimensions, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin, List, Map as MapIcon } from 'lucide-react-native';
import { Map as MapView, Camera, Marker } from '@maplibre/maplibre-react-native';
import type { CameraRef, LngLat, LngLatBounds } from '@maplibre/maplibre-react-native';
import { MAP_STYLE_URL } from '../../constants/mapStyle.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { PassportStamp, PassportPostcard } from '../../types/models.ts';
import type { TripRow } from '../../services/trips.ts';
import {
  groupByDestination,
  encodeDestinationKey,
  type DestinationGroup,
} from '../../utils/destinationGrouping.ts';
import { batchGeocodeCities } from '../../services/cityGeocode.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'map';
type ContentFilter = 'all' | 'memories' | 'stamps' | 'postcards' | 'trips';

interface CoordsMap {
  /** key → [lat, lng] — null when unresolvable */
  [key: string]: [number, number] | null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  memories: PassportMemory[];
  stamps: PassportStamp[];
  postcards: PassportPostcard[];
  trips: TripRow[];
}

// ── Filter bar ────────────────────────────────────────────────────────────────

interface FilterBarProps {
  active: ContentFilter;
  onChange: (f: ContentFilter) => void;
  counts: Record<ContentFilter, number>;
}

const FILTER_OPTIONS: { value: ContentFilter; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'memories',  label: 'Memories' },
  { value: 'stamps',    label: 'Stamps' },
  { value: 'postcards', label: 'Postcards' },
  { value: 'trips',     label: 'Trips' },
];

function FilterBar({ active, onChange, counts }: FilterBarProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={f.row}
      style={f.scroll}
    >
      {FILTER_OPTIONS.map(({ value, label }) => {
        const isActive = active === value;
        const count = counts[value];
        // Hide chips with 0 items (except "All")
        if (value !== 'all' && count === 0) return null;
        return (
          <Pressable
            key={value}
            style={[f.chip, isActive && f.chipActive]}
            onPress={() => onChange(value)}
            hitSlop={4}
          >
            <Text style={[f.chipText, isActive && f.chipTextActive]}>
              {label}
              {value !== 'all' && (
                <Text style={[f.chipCount, isActive && f.chipCountActive]}>
                  {' '}{count}
                </Text>
              )}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ── Chip helper ───────────────────────────────────────────────────────────────

interface CountChipProps {
  label: string;
  count: number;
}

function CountChip({ label, count }: CountChipProps) {
  if (count === 0) return null;
  return (
    <View style={s.chip}>
      <Text style={s.chipText}>{count} {label}</Text>
    </View>
  );
}

// ── Destination card (list mode) ──────────────────────────────────────────────

interface CardProps {
  group: DestinationGroup;
}

function DestinationCard({ group }: CardProps) {
  const handlePress = () => {
    router.push({
      pathname: '/destinations/[city]' as any,
      params: { city: encodeDestinationKey(group.key) },
    });
  };

  return (
    <Pressable style={s.card} onPress={handlePress}>
      {/* Hero image */}
      {group.heroImageUrl ? (
        <Image source={{ uri: group.heroImageUrl }} style={s.hero} resizeMode="cover" />
      ) : (
        <View style={[s.hero, s.heroPlaceholder]}>
          <MapPin size={28} color={color.faint} />
        </View>
      )}

      {/* Card body */}
      <View style={s.body}>
        <View style={s.titleRow}>
          <Text style={s.city} numberOfLines={1}>{group.city}</Text>
          {group.country ? (
            <Text style={s.country} numberOfLines={1}>{group.country}</Text>
          ) : null}
        </View>

        {/* Content-type chips */}
        <View style={s.chips}>
          <CountChip label="memories" count={group.memories.length} />
          <CountChip label="stamps" count={group.stamps.length} />
          <CountChip label="postcards" count={group.postcards.length} />
          <CountChip label="trips" count={group.trips.length} />
        </View>

        {/* Most recent date */}
        <Text style={s.date}>
          {group.mostRecentAt > new Date(0).toISOString()
            ? new Date(group.mostRecentAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
            : null}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Map pin badge ─────────────────────────────────────────────────────────────

interface PinBadgeProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

function DestinationPinBadge({ label, selected, onPress }: PinBadgeProps) {
  return (
    <Pressable onPress={onPress} hitSlop={12}>
      <View style={[pin.wrap, selected && pin.selected]}>
        <MapPin size={selected ? 14 : 12} color="#fff" />
        <Text style={[pin.label, selected && pin.labelSelected]} numberOfLines={1}>
          {label.length > 12 ? label.slice(0, 11) + '…' : label}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Map callout ───────────────────────────────────────────────────────────────

interface CalloutProps {
  group: DestinationGroup;
  activeFilter: ContentFilter;
  onClose: () => void;
  onOpen: () => void;
}

function DestinationCallout({ group, activeFilter, onClose, onOpen }: CalloutProps) {
  // Build meta line reflecting only the filtered content type
  const metaParts: string[] = [];
  if (activeFilter === 'all' || activeFilter === 'memories') {
    if (group.memories.length > 0) metaParts.push(`${group.memories.length} memory`);
  }
  if (activeFilter === 'all' || activeFilter === 'stamps') {
    if (group.stamps.length > 0) metaParts.push(`${group.stamps.length} stamp`);
  }
  if (activeFilter === 'all' || activeFilter === 'postcards') {
    if (group.postcards.length > 0) metaParts.push(`${group.postcards.length} postcard`);
  }
  if (activeFilter === 'all' || activeFilter === 'trips') {
    if (group.trips.length > 0) metaParts.push(`${group.trips.length} trip`);
  }

  const metaStr = metaParts
    .map((part, i, arr) =>
      i < arr.length - 1
        ? `${part}s · `
        : `${part}${part.endsWith('s') ? '' : 's'}`,
    )
    .join('');

  return (
    <View style={s.callout}>
      <View style={s.calloutLeft}>
        <Text style={s.calloutCity}>{group.city}</Text>
        {group.country ? (
          <Text style={s.calloutCountry}>{group.country}</Text>
        ) : null}
        <Text style={s.calloutMeta}>{metaStr}</Text>
      </View>
      <Pressable onPress={onOpen} style={s.calloutOpen}>
        <Text style={s.calloutOpenText}>View</Text>
      </Pressable>
      <Pressable onPress={onClose} hitSlop={8} style={s.calloutClose}>
        <Text style={s.calloutCloseText}>✕</Text>
      </Pressable>
    </View>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={s.empty}>
      <MapPin size={32} color={color.faint} />
      <Text style={s.emptyTitle}>No destinations yet</Text>
      <Text style={s.emptySub}>
        Add memories, postcards, or trips to see your destinations here.
      </Text>
    </View>
  );
}

// ── DestinationsTab ───────────────────────────────────────────────────────────

export function DestinationsTab({ memories, stamps, postcards, trips }: Props) {
  const { height: winHeight } = useWindowDimensions();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeFilter, setActiveFilter] = useState<ContentFilter>('all');
  const [coordsMap, setCoordsMap] = useState<CoordsMap>({});
  const [geocoding, setGeocoding] = useState(false);
  const [geocodedCount, setGeocodedCount] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  const geocodeStartedRef = useRef(false);
  /** Persists the last camera position so switching Map→List→Map restores it. */
  const savedCameraRef = useRef<{ center: LngLat; zoom: number } | null>(null);
  /** Tracks the viewMode value from the previous effect run to detect List→Map returns. */
  const prevViewModeRef = useRef<ViewMode>('list');

  const groups = useMemo(
    () => groupByDestination(memories, stamps, postcards, trips),
    [memories, stamps, postcards, trips],
  );

  // Filter groups by active content-type filter
  const filteredGroups = useMemo(() => {
    if (activeFilter === 'all') return groups;
    return groups.filter((g) => {
      switch (activeFilter) {
        case 'memories':  return g.memories.length > 0;
        case 'stamps':    return g.stamps.length > 0;
        case 'postcards': return g.postcards.length > 0;
        case 'trips':     return g.trips.length > 0;
        default:          return true;
      }
    });
  }, [groups, activeFilter]);

  // Per-filter destination counts for the chip bar labels
  const filterCounts = useMemo((): Record<ContentFilter, number> => ({
    all:       groups.length,
    memories:  groups.filter((g) => g.memories.length > 0).length,
    stamps:    groups.filter((g) => g.stamps.length > 0).length,
    postcards: groups.filter((g) => g.postcards.length > 0).length,
    trips:     groups.filter((g) => g.trips.length > 0).length,
  }), [groups]);

  // Reset active filter to 'all' when the selected chip becomes hidden (count=0)
  useEffect(() => {
    if (activeFilter !== 'all' && filterCounts[activeFilter] === 0) {
      setActiveFilter('all');
    }
  }, [activeFilter, filterCounts]);

  // Deselect pin if it's filtered out
  useEffect(() => {
    if (selectedKey && !filteredGroups.find((g) => g.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [filteredGroups, selectedKey]);

  // Geocode all destinations when switching to map mode (once per mount)
  useEffect(() => {
    if (viewMode !== 'map' || geocodeStartedRef.current || groups.length === 0) return;
    geocodeStartedRef.current = true;
    setGeocoding(true);
    setGeocodedCount(0);

    const entries = groups.map((g) => ({ city: g.city, country: g.country }));
    batchGeocodeCities(entries, (resolved) => setGeocodedCount(resolved))
      .then((result) => {
        const next: CoordsMap = {};
        for (const [key, coords] of result) next[key] = coords;
        setCoordsMap(next);
      })
      .catch(() => {})
      .finally(() => setGeocoding(false));
  }, [viewMode, groups]);

  // Fit camera to filtered resolved pins — or restore the saved position when
  // the user returns from List mode having previously panned / zoomed the map.
  useEffect(() => {
    // Track the previous viewMode so we can detect a List→Map return.
    const wasInList = prevViewModeRef.current === 'list';
    prevViewModeRef.current = viewMode;

    if (!cameraRef.current || viewMode !== 'map') return;

    // If the user is returning from List mode and has a saved camera position,
    // restore that position instead of running fitBounds again.
    if (wasInList && savedCameraRef.current) {
      const { center, zoom } = savedCameraRef.current;
      cameraRef.current.easeTo({ center, zoom, duration: 300 });
      return;
    }

    const resolved = filteredGroups
      .map((g) => coordsMap[`${g.city.toLowerCase()}|${(g.country ?? '').toLowerCase()}`])
      .filter((c): c is [number, number] => c != null);
    if (resolved.length === 0) return;
    if (resolved.length === 1) {
      cameraRef.current.easeTo({ center: [resolved[0][1], resolved[0][0]], zoom: 8, duration: 600 });
      return;
    }
    const lats = resolved.map((c) => c[0]);
    const lngs = resolved.map((c) => c[1]);
    const pad = 5;
    const bounds: LngLatBounds = [
      Math.min(...lngs) - pad,
      Math.min(...lats) - pad,
      Math.max(...lngs) + pad,
      Math.max(...lats) + pad,
    ];
    cameraRef.current.fitBounds(bounds, {
      padding: { top: 40, right: 20, bottom: 120, left: 20 },
      duration: 600,
    });
  }, [coordsMap, viewMode, filteredGroups]);

  const handleOpenDetail = useCallback((group: DestinationGroup) => {
    router.push({
      pathname: '/destinations/[city]' as any,
      params: { city: encodeDestinationKey(group.key) },
    });
  }, []);

  const selectedGroup = filteredGroups.find((g) => g.key === selectedKey) ?? null;

  // Count destinations without coords for the fallback note (from filtered set)
  const resolvedPins = useMemo(() => {
    return filteredGroups.filter((g) => {
      const k = `${g.city.toLowerCase()}|${(g.country ?? '').toLowerCase()}`;
      return coordsMap[k] != null;
    });
  }, [filteredGroups, coordsMap]);

  const unmappedCount = filteredGroups.length - resolvedPins.length;

  if (groups.length === 0) {
    return <EmptyState />;
  }

  // ── Toggle header ─────────────────────────────────────────────────────────

  const toggleHeader = (
    <View style={s.toggleRow}>
      <Text style={s.toggleLabel}>
        {filteredGroups.length}{activeFilter !== 'all' ? `/${groups.length}` : ''}{' '}
        {filteredGroups.length === 1 ? 'destination' : 'destinations'}
      </Text>
      <View style={s.toggleBtns}>
        <Pressable
          style={[s.toggleBtn, viewMode === 'list' && s.toggleBtnActive]}
          onPress={() => setViewMode('list')}
          hitSlop={6}
        >
          <List size={15} color={viewMode === 'list' ? color.paper : color.mute} />
          <Text style={[s.toggleBtnText, viewMode === 'list' && s.toggleBtnTextActive]}>
            List
          </Text>
        </Pressable>
        <Pressable
          style={[s.toggleBtn, viewMode === 'map' && s.toggleBtnActive]}
          onPress={() => setViewMode('map')}
          hitSlop={6}
        >
          <MapIcon size={15} color={viewMode === 'map' ? color.paper : color.mute} />
          <Text style={[s.toggleBtnText, viewMode === 'map' && s.toggleBtnTextActive]}>
            Map
          </Text>
        </Pressable>
      </View>
    </View>
  );

  // ── Filter chip bar ───────────────────────────────────────────────────────

  const filterBar = (
    <FilterBar
      active={activeFilter}
      onChange={(f) => {
        setActiveFilter(f);
        setSelectedKey(null);
      }}
      counts={filterCounts}
    />
  );

  // ── Map mode ──────────────────────────────────────────────────────────────

  if (viewMode === 'map') {
    const mapHeight = Math.min(Math.max(winHeight * 0.55, 340), 520);

    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xl }}>
        {toggleHeader}
        {filterBar}

        {/* Map container */}
        <View style={[s.mapWrap, { height: mapHeight }]}>
          <MapView
            mapStyle={MAP_STYLE_URL}
            style={s.mapView}
            onRegionDidChange={(e) => {
              savedCameraRef.current = {
                center: e.nativeEvent.center,
                zoom: e.nativeEvent.zoom,
              };
            }}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{ center: [10, 20], zoom: 1 }}
            />
            {filteredGroups.map((group) => {
              const coordKey = `${group.city.toLowerCase()}|${(group.country ?? '').toLowerCase()}`;
              const coords = coordsMap[coordKey];
              if (!coords) return null;
              return (
                <Marker key={group.key} lngLat={[coords[1], coords[0]]}>
                  <DestinationPinBadge
                    label={group.city}
                    selected={selectedKey === group.key}
                    onPress={() =>
                      setSelectedKey((prev) => (prev === group.key ? null : group.key))
                    }
                  />
                </Marker>
              );
            })}
          </MapView>

          {/* Geocoding progress overlay */}
          {geocoding && (
            <View style={s.geocodingOverlay} pointerEvents="none">
              <ActivityIndicator size="small" color={color.signal} />
              <Text style={s.geocodingText}>
                Locating cities… {geocodedCount}/{groups.length}
              </Text>
            </View>
          )}

          {/* Empty overlay — no pins resolved for current filter */}
          {!geocoding && resolvedPins.length === 0 && (
            <View style={s.emptyMapOverlay} pointerEvents="none">
              <Text style={s.emptyMapIcon}>🗺️</Text>
              <Text style={s.emptyMapTitle}>
                {activeFilter === 'all'
                  ? 'Couldn\'t place any pins'
                  : `No ${activeFilter} pins to show`}
              </Text>
              <Text style={s.emptyMapSub}>
                {activeFilter === 'all'
                  ? 'Switch to List view to browse your destinations.'
                  : 'Try a different filter or switch to List view.'}
              </Text>
            </View>
          )}
        </View>

        {/* Selected-destination callout */}
        {selectedGroup && (
          <DestinationCallout
            group={selectedGroup}
            activeFilter={activeFilter}
            onClose={() => setSelectedKey(null)}
            onOpen={() => {
              setSelectedKey(null);
              handleOpenDetail(selectedGroup);
            }}
          />
        )}

        {/* Unmapped destinations note */}
        {!geocoding && unmappedCount > 0 && (
          <View style={s.unmappedNote}>
            <Text style={s.unmappedText}>
              {unmappedCount} destination{unmappedCount !== 1 ? 's' : ''} couldn't be placed on the map.
              Switch to List view to see all.
            </Text>
          </View>
        )}
      </View>
    );
  }

  // ── List mode ─────────────────────────────────────────────────────────────

  return (
    <View style={s.listWrapper}>
      {toggleHeader}
      {filterBar}
      <FlatList
        data={filteredGroups}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <DestinationCard group={item} />}
        contentContainerStyle={s.list}
        scrollEnabled={false}
        ItemSeparatorComponent={() => <View style={s.separator} />}
        ListEmptyComponent={
          <View style={s.filterEmpty}>
            <Text style={s.filterEmptyText}>
              No destinations with {activeFilter} yet.
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pin = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: color.signal,
    maxWidth: 120,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 3,
    elevation: 3,
  },
  selected: {
    backgroundColor: color.deep,
    shadowOpacity: 0.4,
    elevation: 5,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
    flexShrink: 1,
  },
  labelSelected: {
    fontSize: 12,
  },
});

const f = StyleSheet.create({
  scroll: {
    marginBottom: space.md,
    marginHorizontal: -space.xs,
  },
  row: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.xs,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  chipText: {
    ...t.small,
    fontWeight: '600',
    color: color.mute,
    fontSize: 13,
  },
  chipTextActive: {
    color: color.paper,
  },
  chipCount: {
    fontWeight: '500',
    color: color.faint,
    fontSize: 12,
  },
  chipCountActive: {
    color: 'rgba(255,255,255,0.65)',
  },
});

const s = StyleSheet.create({
  // ── Toggle row ──────────────────────────────────────────────────────────────
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  toggleLabel: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  toggleBtns: {
    flexDirection: 'row',
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  toggleBtnActive: {
    backgroundColor: color.ink,
  },
  toggleBtnText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
    fontSize: 12,
  },
  toggleBtnTextActive: {
    color: color.paper,
  },

  // ── Map ─────────────────────────────────────────────────────────────────────
  mapWrap: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    marginBottom: space.sm,
  },
  mapView: { flex: 1 },

  geocodingOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  geocodingText: {
    fontSize: 11,
    color: '#fff',
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  emptyMapOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  emptyMapIcon: { fontSize: 36 },
  emptyMapTitle: { ...t.bodyStrong, color: color.mute },
  emptyMapSub: { ...t.small, color: color.faint, textAlign: 'center', paddingHorizontal: space.xl },

  // ── Callout ─────────────────────────────────────────────────────────────────
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginBottom: space.sm,
    gap: space.sm,
  },
  calloutLeft: { flex: 1 },
  calloutCity: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  calloutCountry: { ...t.small, color: color.mute, fontFamily: 'Courier', marginTop: 1 },
  calloutMeta: { ...t.small, color: color.mute, marginTop: 3 },
  calloutOpen: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  calloutOpenText: { ...t.bodyStrong, color: '#fff', fontSize: 13 },
  calloutClose: { padding: 4 },
  calloutCloseText: { fontSize: 14, color: color.faint },

  // ── Unmapped note ────────────────────────────────────────────────────────────
  unmappedNote: {
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  unmappedText: { ...t.small, color: color.mute, textAlign: 'center' },

  // ── List mode ────────────────────────────────────────────────────────────────
  listWrapper: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  list: {
    paddingBottom: 0,
  },
  separator: { height: space.md },

  filterEmpty: {
    paddingVertical: space.xl,
    alignItems: 'center',
  },
  filterEmptyText: {
    ...t.small,
    color: color.faint,
    textAlign: 'center',
  },

  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  hero: {
    width: '100%',
    height: 140,
    backgroundColor: color.haze,
  },
  heroPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: space.md,
    gap: space.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  city: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  country: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: 2,
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  chipText: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.mute,
    fontSize: 11,
  },
  date: {
    ...t.small,
    color: color.faint,
    fontFamily: 'Courier',
    marginTop: 2,
  },

  empty: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    padding: space.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
    alignItems: 'center',
    gap: space.sm,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
});
