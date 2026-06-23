/**
 * DiscoveryMapView — renders Discovery venue pins on a react-native-maps MapView.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import RNMapView, { Marker } from 'react-native-maps';
import { MapPin } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryMapViewProps {
  places: DiscoveryPlace[];
  onSelectPlace: (place: DiscoveryPlace) => void;
}

// ── Category pin colours ──────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  food:        '#E76F51',
  nightlife:   '#7A4DBF',
  places:      '#3A7CA5',
  activities:  '#2A9D5C',
  events:      '#D4A017',
  beaches:     '#0096C7',
  transport:   '#888888',
  for_you:     '#4A90D9',
};

// ── Region helper ─────────────────────────────────────────────────────────────

function computeRegion(places: DiscoveryPlace[]) {
  if (places.length === 0) return null;
  const lats = places.map((p) => p.lat!);
  const lngs = places.map((p) => p.lng!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude:      (minLat + maxLat) / 2,
    longitude:     (minLng + maxLng) / 2,
    latitudeDelta:  Math.max((maxLat - minLat) * 1.5, 0.05),
    longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.05),
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DiscoveryMapView({ places, onSelectPlace }: DiscoveryMapViewProps) {
  const mappable = useMemo(
    () => places.filter((p) => p.lat != null && p.lng != null),
    [places],
  );
  const region = useMemo(() => computeRegion(mappable), [mappable]);

  if (!region) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}>
          <MapPin size={28} color={color.faint} />
        </View>
        <Text style={s.emptyTitle}>No pins available</Text>
        <Text style={s.emptyBody}>
          These places don't have coordinates yet. Try a different search area or category.
        </Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <RNMapView
        style={s.map}
        initialRegion={region}
        showsUserLocation={false}
        showsMyLocationButton={false}
      >
        {mappable.map((place) => (
          <Marker
            key={place.id}
            coordinate={{ latitude: place.lat!, longitude: place.lng! }}
            pinColor={CAT_COLOR[place.category] ?? color.signal}
            title={place.name}
            description={place.address ?? place.type ?? undefined}
            onPress={() => onSelectPlace(place)}
          />
        ))}
      </RNMapView>
      <View style={s.badge}>
        <MapPin size={10} color="#fff" />
        <Text style={s.badgeText}>
          {mappable.length} {mappable.length === 1 ? 'place' : 'places'}
        </Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
  },
  map: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxxl,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.title,
    fontSize: 16,
    color: color.mute,
  },
  emptyBody: {
    ...t.body,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 260,
  },
  badge: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});
