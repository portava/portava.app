/**
 * Web fallback for MemoriesMapView.
 *
 * Metro selects this file on web builds, where the MapLibre native GL module is
 * unavailable. Rather than rendering nothing, it lists the same city pins
 * `buildMemoryMap` computes — so the Map view still carries its information on
 * web — and states the unplotted count for the same reason the native view
 * does: the surface must account for every memory it was given.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { buildMemoryMap } from './memoryViews.ts';
import type { MemoriesMapViewProps } from './MemoriesMapView';

export function MemoriesMapView({ memories, trips = [] }: MemoriesMapViewProps) {
  const { pins, unplotted } = useMemo(() => buildMemoryMap(memories, trips), [memories, trips]);

  if (pins.length === 0) {
    return (
      <View style={s.empty} testID="memories-map-empty">
        <View style={s.emptyIcon}>
          <MapPin size={26} color={color.faint} />
        </View>
        <Text style={s.emptyTitle}>Nothing to map yet</Text>
        <Text style={s.emptyBody}>Memories with a city will appear here.</Text>
      </View>
    );
  }

  return (
    <View style={s.root} testID="memories-map-view">
      <Text style={s.note}>The interactive map is available on iOS and Android.</Text>
      {pins.map((pin) => (
        <View key={pin.key} style={s.row} testID={`memories-map-chip-${pin.key}`}>
          <MapPin size={14} color={color.deep} />
          <Text style={s.city} numberOfLines={1}>
            {pin.city}{pin.country ? `, ${pin.country}` : ''}
          </Text>
          <Text style={s.count}>{pin.memories.length}</Text>
        </View>
      ))}
      {unplotted.length > 0 && (
        <Text style={s.unplotted} testID="memories-map-unplotted">
          {unplotted.length} {unplotted.length === 1 ? 'memory is' : 'memories are'} not on the map — no known location.
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { gap: space.sm },
  note: { ...t.small, color: color.faint },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  city: { ...t.body, color: color.ink, flex: 1 },
  count: { ...t.stamp, color: color.mute, fontSize: 12 },
  unplotted: { ...t.small, color: color.mute },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  emptyIcon: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { ...t.title, fontSize: 16, color: color.mute },
  emptyBody: { ...t.body, color: color.faint, textAlign: 'center' },
});
