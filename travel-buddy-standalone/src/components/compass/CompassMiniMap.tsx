/**
 * CompassMiniMap — inline mini-map preview for Compass chat answers.
 *
 * Renders a small non-interactive MapLibre map with numbered pins for the
 * hydrated coordinates in a Compass `map` or `comparison` block. Tapping the
 * map surface fires `onPress` (the caller opens the full /map screen focused);
 * the map itself accepts no gestures, so it never fights the chat scroll.
 *
 * Web builds pick CompassMiniMap.web.tsx (MapLibre React Native is
 * native-only — see the maplibre web-split convention).
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
import { Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { CompassMiniMapPoint } from './compassMiniMapShared.ts';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

export interface CompassMiniMapProps {
  points: CompassMiniMapPoint[];
  /** Tap anywhere on the preview — caller opens /map focused. */
  onPress?: () => void;
  height?: number;
  testID?: string;
}

function computeViewport(points: CompassMiniMapPoint[]) {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.6, 0.02);
  const lngDelta = Math.max((maxLng - minLng) * 1.6, 0.02);
  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
    zoom: Math.min(Math.log2(360 / lngDelta), Math.log2(180 / latDelta)) - 0.5,
  };
}

export function CompassMiniMap({ points, onPress, height = 160, testID }: CompassMiniMapProps) {
  const viewport = useMemo(() => computeViewport(points), [points]);
  if (!viewport) return null;

  return (
    <Pressable
      style={({ pressed }) => [s.container, { height }, pressed && s.pressed]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel="Open the full map"
      testID={testID}
    >
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
        dragPan={false}
        touchZoom={false}
        touchRotate={false}
        touchPitch={false}
      >
        <Camera initialViewState={{ center: viewport.center, zoom: viewport.zoom }} />
        {points.map((p, idx) => (
          <Marker key={p.id} lngLat={[p.lng, p.lat]}>
            <View style={s.pin}>
              <Text style={s.pinLabel}>{idx + 1}</Text>
            </View>
          </Marker>
        ))}
      </Map>
      {onPress ? (
        <View style={s.expandBadge} pointerEvents="none">
          <Maximize2 size={12} color={color.ink} />
        </View>
      ) : null}
    </Pressable>
  );
}

const PIN_SIZE = 24;

const s = StyleSheet.create({
  container: {
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: color.haze,
  },
  pressed: { opacity: 0.85 },
  pin: {
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: PIN_SIZE / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  pinLabel: { ...t.small, color: '#fff', fontSize: 10, fontWeight: '700' },
  expandBadge: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: radius.sm,
    padding: 5,
  },
});
