/**
 * DiscoveryMapView — renders Discovery venue pins on a MapLibre Map.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 *
 * The map is ALWAYS rendered, even when there are zero places with coordinates.
 * When no places are mappable the camera falls back to a sensible default
 * location and the pin-count badge shows "0 places".
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

// ── Fallback viewport (Fort Lauderdale) when no places have coordinates ────────

const FALLBACK_CENTER: [number, number] = [-80.1373, 26.1224];
const FALLBACK_ZOOM = 11;

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

  // Always use a valid center/zoom — fall back to Fort Lauderdale when no
  // places have coordinates so the interactive map is always visible.
  const center = viewport?.center ?? FALLBACK_CENTER;
  const zoom   = viewport?.zoom   ?? FALLBACK_ZOOM;

  return (
    <View style={s.root}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
      >
        <Camera
          initialViewState={{ center, zoom }}
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

      {/* Pin-count badge — shows "0 places" honestly when the list is empty */}
      <View style={s.badge}>
        <MapPin size={10} color="#fff" />
        <Text style={s.badgeText}>
          {mappable.length} {mappable.length === 1 ? 'place' : 'places'}
        </Text>
      </View>

      {/* Overlay hint when there are no pins — map still visible behind it */}
      {mappable.length === 0 && (
        <View style={s.emptyOverlay} pointerEvents="none">
          <View style={s.emptyIcon}>
            <MapPin size={22} color={color.faint} />
          </View>
          <Text style={s.emptyTitle}>No pins available</Text>
          <Text style={s.emptyBody}>
            These places don't have coordinates yet. Try a different search area or category.
          </Text>
        </View>
      )}
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
  emptyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.78)',
    gap: space.sm,
    paddingHorizontal: space.xxl,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.title,
    fontSize: 15,
    color: color.mute,
    textAlign: 'center',
  },
  emptyBody: {
    ...t.body,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 260,
  },
});
