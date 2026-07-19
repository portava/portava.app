/**
 * DestinationsTab.web — Web-safe version of the Passport Destinations tab.
 *
 * MapLibre React Native is native-only (its codegen native components crash
 * react-native-web at import time), so this variant keeps
 * @maplibre/maplibre-react-native out of the web bundle entirely — same
 * pattern as MapTab.web / DiscoveryMapView.web.
 *
 * List mode is identical to the native version. Map mode renders a flat
 * destination-pin grid with the same filter chips and callout; the
 * interactive map stays mobile-only.
 */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin, List, Map as MapIcon } from 'lucide-react-native';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { PassportStamp, PassportPostcard } from '../../types/models.ts';
import type { TripRow } from '../../services/trips.ts';
import {
  groupByDestination,
  encodeDestinationKey,
  type DestinationGroup,
} from '../../utils/destinationGrouping.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'map';
type ContentFilter = 'all' | 'memories' | 'stamps' | 'postcards' | 'trips';

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

// ── Flat pin badge (web map substitute) ───────────────────────────────────────

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

// ── Callout ───────────────────────────────────────────────────────────────────

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

// ── DestinationsTab (web) ─────────────────────────────────────────────────────

export function DestinationsTab({ memories, stamps, postcards, trips }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeFilter, setActiveFilter] = useState<ContentFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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

  const handleOpenDetail = useCallback((group: DestinationGroup) => {
    router.push({
      pathname: '/destinations/[city]' as any,
      params: { city: encodeDestinationKey(group.key) },
    });
  }, []);

  const selectedGroup = filteredGroups.find((g) => g.key === selectedKey) ?? null;

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
      onChange={(fVal) => {
        setActiveFilter(fVal);
        setSelectedKey(null);
      }}
      counts={filterCounts}
    />
  );

  // ── Map mode (web: flat pin grid) ─────────────────────────────────────────

  if (viewMode === 'map') {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xl }}>
        {toggleHeader}
        {filterBar}

        {/* Flat pin board — the interactive map is native-only */}
        <View style={s.pinBoard}>
          {filteredGroups.map((group) => (
            <DestinationPinBadge
              key={group.key}
              label={group.city}
              selected={selectedKey === group.key}
              onPress={() =>
                setSelectedKey((prev) => (prev === group.key ? null : group.key))
              }
            />
          ))}
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

        <View style={s.unmappedNote}>
          <Text style={s.unmappedText}>
            The interactive destination map is available in the mobile app.
          </Text>
        </View>
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

  // ── Pin board (web map substitute) ──────────────────────────────────────────
  pinBoard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    gap: space.sm,
    minHeight: 160,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    marginBottom: space.sm,
  },

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

  // ── Native-map note ─────────────────────────────────────────────────────────
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
