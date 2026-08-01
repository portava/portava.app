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
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera } = _ml as typeof import('@maplibre/maplibre-react-native');

import { MAP_STYLE_URL as MAP_STYLE } from '../../constants/mapStyle.ts';

export interface GemLocationPreviewProps {
  lat: number;
  lng: number;
}

export function GemLocationPreview({ lat, lng }: GemLocationPreviewProps) {
  const center: [number, number] = [lng, lat];
  return (
    <View>
      <View style={styles.container}>
        {/*
         * pointerEvents="none" on this wrapper prevents MapLibre's native gesture
         * recognisers from intercepting touch events on Android/iOS.  Without it,
         * dragPan={false} disables MapLibre-level panning but the native view can
         * still swallow the initial touch, blocking the parent ScrollView.
         * Setting pointerEvents="none" removes the Map subtree from the hit-test
         * tree entirely so all gestures fall through to the ScrollView.
         */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
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
        </View>
        <View style={styles.pinWrap} pointerEvents="none">
          <Ionicons name="location" size={32} color="#4C8BF5" style={styles.pinIcon} />
        </View>
      </View>
      <Text style={styles.attribution}>© OpenFreeMap contributors</Text>
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
  attribution: {
    color: '#8A9BB5',
    fontSize: 10,
    lineHeight: 14,
    marginTop: 4,
  },
});
