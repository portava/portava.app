/**
 * RouteMinimapView
 *
 * Compact map showing numbered checkpoints, a dashed polyline between them,
 * the user's current location dot, and a highlighted "next stop" ring.
 * Built on MapLibre (replaces react-native-maps).
 * Metro picks RouteMinimapView.web.tsx on web.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
// Safe-require pattern: a static import triggers TurboModuleRegistry at module
// evaluation time, which crashes route registration ("Tried to register two
// views with the same name MLRNCamera") on dev builds. See
// .agents/memory/maplibre-safe-require.md.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker, GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');
import { Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import type { FullRoutePlan } from '../services/routePlan.ts';
import { computeViewport } from './routeMinimapViewport.ts';

// ── Map tile style ─────────────────────────────────────────────────────────────

import { MAP_STYLE_URL as MAP_STYLE, FALLBACK_MAP_STYLE_URL } from '../constants/mapStyle.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  routePlan: FullRoutePlan;
  userLat?: number | null;
  userLng?: number | null;
  onExpand?: () => void;
  height?: number;
}

// computeViewport lives in ./routeMinimapViewport.ts so it can be unit-tested
// without a React Native renderer.

// ── Component ─────────────────────────────────────────────────────────────────

export function RouteMinimapView({ routePlan, userLat, userLng, onExpand, height = 220 }: Props) {
  const { stops } = routePlan;
  const [mapStyle, setMapStyle] = useState(MAP_STYLE);

  const viewport = useMemo(() => computeViewport(stops), [stops]);

  const routeLineData = useMemo(() => {
    const coords = stops
      .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
      .map((s) => [s.structuredLocation.lng, s.structuredLocation.lat] as [number, number]);
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: coords },
      properties: {},
    };
  }, [stops]);

  const userPointData = useMemo(() => {
    if (userLat == null || userLng == null) return null;
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [userLng, userLat] as [number, number] },
      properties: {},
    };
  }, [userLat, userLng]);

  const nextStopId = stops.find((s) => s.checkpointStatus === 'pending')?.id ?? null;

  if (!viewport) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <ActivityIndicator color={color.deep} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        logo={false}
        attributionPosition={{ bottom: 4, right: 4 }}
        dragPan={false}
        touchZoom={false}
        touchRotate={false}
        touchPitch={false}
        onDidFailLoadingMap={() => { if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL); }}
      >
        <Camera
          initialViewState={{
            center: viewport.center,
            zoom: viewport.zoom,
          }}
        />

        {routeLineData.geometry.coordinates.length >= 2 && (
          <GeoJSONSource id="route-line-src" data={routeLineData}>
            <Layer
              id="route-line-layer"
              type="line"
              paint={{
                'line-color': color.deep,
                'line-width': 2,
                'line-dasharray': [6, 3],
              }}
            />
          </GeoJSONSource>
        )}

        {stops.map((stop, idx) => {
          const loc = stop.structuredLocation;
          if (loc?.lat == null || loc?.lng == null) return null;
          const isNext = stop.id === nextStopId;
          const isDone = stop.checkpointStatus === 'arrived';
          const isSkipped = stop.checkpointStatus === 'skipped';

          return (
            <Marker
              key={stop.id}
              lngLat={[loc.lng, loc.lat]}
            >
              <View style={[
                styles.pin,
                isDone && styles.pinDone,
                isSkipped && styles.pinSkipped,
                isNext && styles.pinNext,
              ]}>
                <Text style={[styles.pinLabel, (isDone || isSkipped) && styles.pinLabelDim]}>
                  {idx + 1}
                </Text>
              </View>
            </Marker>
          );
        })}

        {userPointData && (
          <GeoJSONSource id="user-loc-src" data={userPointData}>
            <Layer
              id="user-loc-layer"
              type="circle"
              paint={{
                'circle-radius': 8,
                'circle-color': color.deep + 'CC',
                'circle-stroke-color': color.deep,
                'circle-stroke-width': 1.5,
              }}
            />
          </GeoJSONSource>
        )}
      </Map>

      {onExpand && (
        <Pressable style={styles.expandBtn} onPress={onExpand} hitSlop={8}>
          <Maximize2 size={14} color={color.ink} />
        </Pressable>
      )}

      <View style={styles.legend}>
        <Text style={styles.legendText}>
          {stops.filter((s) => s.checkpointStatus === 'arrived').length}/{stops.length} stops
        </Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PIN_SIZE = 26;

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.haze,
  },
  placeholder: {
    borderRadius: radius.md,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pin: {
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: PIN_SIZE / 2,
    backgroundColor: '#E76F51',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  pinDone: {
    backgroundColor: '#999',
    borderColor: '#ddd',
  },
  pinSkipped: {
    backgroundColor: '#ccc',
    borderColor: '#eee',
  },
  pinNext: {
    backgroundColor: color.deep,
    borderColor: '#fff',
    shadowColor: color.deep,
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  pinLabel: {
    ...t.small,
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  pinLabelDim: {
    color: 'rgba(255,255,255,0.7)',
  },
  expandBtn: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: radius.sm,
    padding: 6,
  },
  legend: {
    position: 'absolute',
    bottom: space.sm,
    left: space.sm,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  legendText: {
    ...t.small,
    color: color.ink,
    fontSize: 11,
    fontWeight: '600',
  },
});
