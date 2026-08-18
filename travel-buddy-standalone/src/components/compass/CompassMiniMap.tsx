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
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import { Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { MAP_STYLE_URL, FALLBACK_MAP_STYLE_URL } from '../../constants/mapStyle.ts';
import type { CompassMiniMapPoint } from './compassMiniMapShared.ts';

// Shared style — see constants/mapStyle.ts. This file carried a second,
// character-identical copy of the divergent MapTiler URL that DiscoveryMapView
// had, with the same stale v1 `maps/streets` id and the same demotiles
// debug-basemap fallback. Two copies of one wrong decision is why this is fixed
// in both places rather than only on the flagship map.

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
  // Declared BEFORE the early return below — a hook after a conditional return
  // would break the rules of hooks on the no-viewport path.
  const [mapStyle, setMapStyle] = useState<string>(MAP_STYLE_URL);
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
        mapStyle={mapStyle}
        onDidFailLoadingMap={() => {
          if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL);
        }}
        logo={false}
        attributionPosition={{ bottom: 4, right: 4 }}
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
