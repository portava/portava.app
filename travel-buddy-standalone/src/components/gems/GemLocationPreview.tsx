/**
 * GemLocationPreview — compact non-interactive map thumbnail for the gem review step.
 *
 * Native (iOS/Android) implementation: renders a MapLibre map locked to the
 * pinned coordinate with all gesture handlers disabled.
 *
 * Metro automatically selects GemLocationPreview.web.tsx on web where
 * MapLibre native modules are unavailable.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Map, Camera } from '@maplibre/maplibre-react-native';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

export interface GemLocationPreviewProps {
  lat: number;
  lng: number;
}

export function GemLocationPreview({ lat, lng }: GemLocationPreviewProps) {
  const center: [number, number] = [lng, lat];
  return (
    <View style={styles.container}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
        dragPan={false}
        doubleTapZoom={false}
        doubleTapHoldZoom={false}
        touchPitch={false}
      >
        <Camera initialViewState={{ center, zoom: 13 }} />
      </Map>
      <View style={styles.pinWrap} pointerEvents="none">
        <Ionicons name="location" size={32} color="#4C8BF5" style={styles.pinIcon} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 160,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1E2D45',
    position: 'relative',
  },
  pinWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinIcon: {
    marginBottom: 16,
  },
});
