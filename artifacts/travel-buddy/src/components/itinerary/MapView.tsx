/**
 * MapView — shows plan items with GPS coordinates on a native map via react-native-maps.
 * Items without coordinates are shown in a fallback list below the map.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import RNMapView, { Marker } from 'react-native-maps';
import { MapPin, Navigation } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../../types/models';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Category pin colours ──────────────────────────────────────────────────────

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

// ── Region helper ─────────────────────────────────────────────────────────────

function computeRegion(items: TripPlanItem[]) {
  if (items.length === 0) return null;
  const lats = items.map((i) => i.lat!);
  const lngs = items.map((i) => i.lng!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.5, 0.04);
  const lngDelta = Math.max((maxLng - minLng) * 1.5, 0.04);
  return {
    latitude:      (minLat + maxLat) / 2,
    longitude:     (minLng + maxLng) / 2,
    latitudeDelta: latDelta,
    longitudeDelta: lngDelta,
  };
}

// ── Pin list card (fallback for items without coordinates) ────────────────────

function PinListCard({ item, onPress }: { item: TripPlanItem; onPress: () => void }) {
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

  const region = computeRegion(coordItems);

  return (
    <ScrollView contentContainerStyle={mv.wrap} showsVerticalScrollIndicator={false}>
      {coordItems.length > 0 && region ? (
        <View style={mv.mapSection}>
          <Text style={mv.sectionLabel}>On the map</Text>
          <RNMapView
            style={mv.mapSurface}
            initialRegion={region}
            showsUserLocation={false}
            showsMyLocationButton={false}
          >
            {coordItems.map((item) => (
              <Marker
                key={item.id}
                coordinate={{ latitude: item.lat!, longitude: item.lng! }}
                pinColor={CAT_PIN[item.category] ?? '#888'}
                title={item.title}
                description={item.locationName ?? undefined}
                onPress={() => onItemPress(item)}
              />
            ))}
          </RNMapView>
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
  mapSurface:  { height: 300, borderRadius: radius.lg, overflow: 'hidden' },
  listSection: { gap: 8 },
  sectionLabel:{ ...t.small, color: color.mute, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  noMapBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, padding: 12 },
  noMapText:   { ...t.small, color: color.mute, flex: 1 },
});

const pl = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: color.haze },
  pinDot:  { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  text:    { flex: 1, gap: 2 },
  title:   { ...t.body, color: color.ink, fontWeight: '600' },
  loc:     { ...t.small, color: color.mute },
});
