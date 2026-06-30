/**
 * DiscoveryMapView — renders Discovery venue pins on a MapLibre Map.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
import { MapPin } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Map tile style ─────────────────────────────────────────────────────────────

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

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

// ── Viewport helper ───────────────────────────────────────────────────────────

function computeViewport(places: DiscoveryPlace[]) {
  if (places.length === 0) return null;
  const lats = places.map((p) => p.lat!);
  const lngs = places.map((p) => p.lng!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.5, 0.05);
  const lngDelta = Math.max((maxLng - minLng) * 1.5, 0.05);
  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
    zoom: Math.min(
      Math.log2(360 / lngDelta),
      Math.log2(180 / latDelta),
    ) - 0.5,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DiscoveryMapView({ places, onSelectPlace }: DiscoveryMapViewProps) {
  const mappable = useMemo(
    () => places.filter((p) => p.lat != null && p.lng != null),
    [places],
  );
  const viewport = useMemo(() => computeViewport(mappable), [mappable]);

  if (!viewport) {
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
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
      >
        <Camera
          initialViewState={{
            center: viewport.center,
            zoom: viewport.zoom,
          }}
        />
        {mappable.map((place) => (
          <Marker
            key={place.id}
            lngLat={[place.lng!, place.lat!]}
          >
            <Pressable onPress={() => onSelectPlace(place)}>
              <View style={[s.pin, { backgroundColor: CAT_COLOR[place.category] ?? color.signal }]}>
                <MapPin size={10} color="#fff" />
              </View>
            </Pressable>
          </Marker>
        ))}
      </Map>
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
  pin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
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
