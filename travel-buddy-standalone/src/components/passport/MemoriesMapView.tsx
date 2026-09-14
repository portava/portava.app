/**
 * MemoriesMapView — the §15 Memories "Map" view (native iOS/Android only).
 *
 * Metro automatically selects MemoriesMapView.web.tsx on web builds, so this
 * file is compiled only for native. The MapLibre module is required lazily and
 * defensively, matching `src/components/SavedPlacesMapView.tsx`, so that a
 * build without the native GL module renders the empty state instead of
 * crashing the Passport.
 *
 * COARSE BY DESIGN. Memories carry no precise coordinates. Pins are city-level,
 * sourced by `buildMemoryMap` from the trip destination when one is known and
 * the shared city centroid table otherwise. Memories that cannot be placed are
 * COUNTED ON SCREEN rather than dropped — a map that quietly shows fewer
 * memories than the collection holds misreports the collection.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { MAP_STYLE_URL as MAP_STYLE } from '../../constants/mapStyle.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { TripRow } from '../../services/trips.ts';
import { buildMemoryMap } from './memoryViews.ts';

export interface MemoriesMapViewProps {
  memories: PassportMemory[];
  trips?: TripRow[];
}

export function MemoriesMapView({ memories, trips = [] }: MemoriesMapViewProps) {
  const { pins, unplotted } = useMemo(() => buildMemoryMap(memories, trips), [memories, trips]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = pins.find((p) => p.key === selectedKey) ?? null;

  if (pins.length === 0) {
    return (
      <View style={s.empty} testID="memories-map-empty">
        <View style={s.emptyIcon}>
          <MapPin size={26} color={color.faint} />
        </View>
        <Text style={s.emptyTitle}>Nothing to map yet</Text>
        <Text style={s.emptyBody}>
          {unplotted.length > 0
            ? `${unplotted.length} ${unplotted.length === 1 ? 'memory has' : 'memories have'} no city to place on the map.`
            : 'Memories with a city will appear here as pins.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={s.root} testID="memories-map-view">
      <View style={s.mapWrap}>
        <Map mapStyle={MAP_STYLE} style={{ flex: 1 }}>
          <Camera />
          {pins.map((pin) => (
            <Marker key={pin.key} lngLat={[pin.lng, pin.lat]}>
              <Pressable
                onPress={() => setSelectedKey(pin.key === selectedKey ? null : pin.key)}
                hitSlop={8}
                testID={`memories-map-pin-${pin.key}`}
                accessibilityRole="button"
                accessibilityLabel={`${pin.city}, ${pin.memories.length} ${pin.memories.length === 1 ? 'memory' : 'memories'}`}
              >
                <View style={[s.pin, pin.key === selectedKey && s.pinSelected]}>
                  <Text style={s.pinCount}>{pin.memories.length}</Text>
                </View>
              </Pressable>
            </Marker>
          ))}
        </Map>
      </View>

      {/* The count the map is NOT showing, stated rather than hidden. */}
      {unplotted.length > 0 && (
        <Text style={s.unplotted} testID="memories-map-unplotted">
          {unplotted.length} {unplotted.length === 1 ? 'memory is' : 'memories are'} not on the map — no known location.
        </Text>
      )}

      {/* City strip: every pin is reachable without hitting a marker. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.strip}
        testID="memories-map-strip"
      >
        {pins.map((pin) => {
          const active = pin.key === selectedKey;
          return (
            <Pressable
              key={pin.key}
              style={[s.chip, active && s.chipActive]}
              onPress={() => setSelectedKey(active ? null : pin.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              testID={`memories-map-chip-${pin.key}`}
            >
              <Text style={[s.chipText, active && s.chipTextActive]} numberOfLines={1}>
                {pin.city} · {pin.memories.length}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {selected && (
        <View style={s.detail} testID="memories-map-detail">
          <Text style={s.detailTitle}>
            {selected.city}{selected.country ? `, ${selected.country}` : ''}
          </Text>
          {selected.memories.slice(0, 5).map((m) => (
            <Text key={m.id} style={s.detailRow} numberOfLines={1}>
              {m.title ?? 'Untitled memory'}
            </Text>
          ))}
          {selected.memories.length > 5 && (
            <Text style={s.detailMore}>+{selected.memories.length - 5} more</Text>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { gap: space.sm },
  // A fixed height: the Map sits inside the Passport's scrolling tab, where a
  // flex:1 map would collapse to zero.
  mapWrap: {
    height: 280,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.haze,
  },
  pin: {
    minWidth: avatar.s30,
    height: avatar.s30,
    paddingHorizontal: space.xs,
    borderRadius: avatar.s30 / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: color.paperRaised,
  },
  pinSelected: { backgroundColor: color.deep },
  pinCount: { ...t.stamp, color: color.onInk, fontSize: 12 },
  unplotted: { ...t.small, color: color.mute },
  strip: { gap: space.sm, paddingVertical: space.xs },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.small, color: color.mute },
  chipTextActive: { color: color.onInk },
  detail: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: space.xs,
  },
  detailTitle: { ...t.title, fontSize: 15, color: color.ink },
  detailRow: { ...t.body, color: color.mute },
  detailMore: { ...t.small, color: color.faint },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  emptyIcon: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { ...t.title, fontSize: 16, color: color.mute },
  emptyBody: { ...t.body, color: color.faint, textAlign: 'center', paddingHorizontal: space.xl },
});
