/**
 * MapView — shows plan items with public GPS coordinates on a styled map.
 * react-native-maps is not currently installed; this uses a React Native
 * View-based placeholder that will be replaced with MapView when native
 * maps are configured.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions, ActivityIndicator } from 'react-native';
import { MapPin, Navigation } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../../types/models';
import { color, space, radius, type as t } from '../../theme/tokens';
import type { PlanItemSheetProps } from './PlanItemSheet';

// ── Category colours ──────────────────────────────────────────────────────────

const CAT_PIN: Record<TripPlanCategory, string> = {
  accommodation: '#3A7CA5',
  activity:      '#2A9D5C',
  dining:        '#E76F51',
  transport:     '#7A4DBF',
  free_time:     '#8B6914',
  meeting_point: '#E9C46A',
  other:         '#888',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MapViewProps {
  items: TripPlanItem[];
  onItemPress: (item: TripPlanItem) => void;
  selectedDay: string;
  loading?: boolean;
}

// ── Pin list card (fallback when item has no coordinates) ─────────────────────

function PinListCard({
  item, onPress,
}: {
  item: TripPlanItem;
  onPress: () => void;
}) {
  const pinColor = CAT_PIN[item.category] ?? '#888';
  return (
    <Pressable style={pl.card} onPress={onPress}>
      <View style={[pl.pinDot, { backgroundColor: pinColor }]}>
        <MapPin size={10} color="#fff" />
      </View>
      <View style={pl.text}>
        <Text style={pl.title} numberOfLines={1}>{item.title}</Text>
        {item.locationName && (
          <Text style={pl.loc} numberOfLines={1}>{item.locationName}</Text>
        )}
      </View>
    </Pressable>
  );
}

// ── Pseudo-map canvas (items with coordinates) ────────────────────────────────

function CoordMap({
  coordItems, onItemPress,
}: {
  coordItems: TripPlanItem[];
  onItemPress: (item: TripPlanItem) => void;
}) {
  const { width } = useWindowDimensions();
  const canvasW = width - space.lg * 2;
  const canvasH = 260;

  // Normalize lat/lng to canvas space
  const lats = coordItems.map((i) => i.lat!);
  const lngs = coordItems.map((i) => i.lng!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latRange = maxLat - minLat || 0.01;
  const lngRange = maxLng - minLng || 0.01;

  const toCanvas = (lat: number, lng: number) => ({
    x: ((lng - minLng) / lngRange) * (canvasW - 40) + 20,
    y: (1 - (lat - minLat) / latRange) * (canvasH - 40) + 20,
  });

  return (
    <View style={[cm.canvas, { width: canvasW, height: canvasH }]}>
      {/* Grid lines */}
      <View style={cm.gridH1} />
      <View style={cm.gridH2} />
      <View style={cm.gridV1} />
      <View style={cm.gridV2} />

      {coordItems.map((item) => {
        const { x, y } = toCanvas(item.lat!, item.lng!);
        const pinColor = CAT_PIN[item.category] ?? '#888';
        return (
          <Pressable
            key={item.id}
            style={[cm.pin, { left: x - 14, top: y - 28 }]}
            onPress={() => onItemPress(item)}
          >
            <View style={[cm.pinBubble, { backgroundColor: pinColor }]}>
              <MapPin size={12} color="#fff" />
            </View>
            <View style={[cm.pinTip, { borderTopColor: pinColor }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ItineraryMapView({ items, onItemPress, selectedDay, loading }: MapViewProps) {
  const filtered = selectedDay === 'all' ? items : items.filter((i) => i.dayDate === selectedDay);
  const coordItems = filtered.filter((i) => i.lat != null && i.lng != null);
  const noCoordItems = filtered.filter((i) => i.lat == null || i.lng == null);

  if (loading) {
    return (
      <View style={mv.empty}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (filtered.length === 0) {
    return (
      <View style={mv.empty}>
        <View style={mv.emptyIcon}><Navigation size={28} color={color.faint} /></View>
        <Text style={mv.emptyTitle}>No items for this day</Text>
        <Text style={mv.emptyBody}>Add places or activities to see them here.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={mv.wrap} showsVerticalScrollIndicator={false}>
      {coordItems.length > 0 ? (
        <View style={mv.mapSection}>
          <Text style={mv.sectionLabel}>On the map</Text>
          <View style={mv.mapCard}>
            <CoordMap coordItems={coordItems} onItemPress={onItemPress} />
          </View>
        </View>
      ) : (
        <View style={mv.noMapBanner}>
          <Navigation size={16} color={color.mute} />
          <Text style={mv.noMapText}>Add places with public locations to see them on the map.</Text>
        </View>
      )}

      {noCoordItems.length > 0 && (
        <View style={mv.listSection}>
          <Text style={mv.sectionLabel}>
            {coordItems.length > 0 ? 'Other items' : 'All items'}
          </Text>
          {noCoordItems.map((item) => (
            <PinListCard key={item.id} item={item} onPress={() => onItemPress(item)} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mv = StyleSheet.create({
  wrap:        { gap: 16, paddingBottom: 24 },
  empty:       { alignItems: 'center', paddingVertical: 48, gap: 8 },
  emptyIcon:   { width: 56, height: 56, borderRadius: 28, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:  { ...t.title, fontSize: 16, color: color.mute },
  emptyBody:   { ...t.body, color: color.faint, textAlign: 'center', maxWidth: 260 },
  mapSection:  { gap: 8 },
  listSection: { gap: 8 },
  sectionLabel:{ ...t.small, color: color.mute, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  mapCard:     { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#E8F0E8', borderWidth: 1, borderColor: color.haze },
  noMapBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, padding: 12 },
  noMapText:   { ...t.small, color: color.mute, flex: 1 },
});

const cm = StyleSheet.create({
  canvas:      { backgroundColor: '#EEF3EC', position: 'relative' },
  gridH1:      { position: 'absolute', top: '33%', left: 0, right: 0, height: 1, backgroundColor: '#D4E0D0' },
  gridH2:      { position: 'absolute', top: '66%', left: 0, right: 0, height: 1, backgroundColor: '#D4E0D0' },
  gridV1:      { position: 'absolute', left: '33%', top: 0, bottom: 0, width: 1, backgroundColor: '#D4E0D0' },
  gridV2:      { position: 'absolute', left: '66%', top: 0, bottom: 0, width: 1, backgroundColor: '#D4E0D0' },
  pin:         { position: 'absolute', alignItems: 'center', width: 28 },
  pinBubble:   { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pinTip:      { width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent', marginTop: -1 },
});

const pl = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: color.haze },
  pinDot:  { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  text:    { flex: 1, gap: 2 },
  title:   { ...t.body, color: color.ink, fontWeight: '600' },
  loc:     { ...t.small, color: color.mute },
});
