/**
 * RouteFullMapModal — full-screen native map modal for a route plan.
 * Uses MapLibre (replaces react-native-maps).
 * Metro picks RouteFullMapModal.web.tsx instead when bundling for web.
 */
import React, { useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet } from 'react-native';
// Safe-require pattern: a static import triggers TurboModuleRegistry at module
// evaluation time, which crashes route registration ("Tried to register two
// views with the same name MLRNCamera") on dev builds. See
// .agents/memory/maplibre-safe-require.md.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker, GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');
import { Minimize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import type { RouteStop, RouteLeg } from '../services/routePlan.ts';

// ── Map tile style ─────────────────────────────────────────────────────────────

import { MAP_STYLE_URL as MAP_STYLE, FALLBACK_MAP_STYLE_URL } from '../constants/mapStyle.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouteFullMapModalProps {
  visible: boolean;
  onClose: () => void;
  stops: RouteStop[];
  legs: RouteLeg[];
  userLat?: number | null;
  userLng?: number | null;
}

// ── Viewport helper ───────────────────────────────────────────────────────────

function computeViewport(stops: RouteStop[]) {
  const pts = stops
    .map((s) => ({ lat: s.structuredLocation?.lat, lng: s.structuredLocation?.lng }))
    .filter((p): p is { lat: number; lng: number } => p.lat != null && p.lng != null);
  if (pts.length === 0) return null;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.5, 0.015);
  const lngDelta = Math.max((maxLng - minLng) * 1.5, 0.015);
  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
    zoom: Math.min(
      Math.log2(360 / lngDelta),
      Math.log2(180 / latDelta),
    ) - 0.5,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RouteFullMapModal({
  visible,
  onClose,
  stops,
  legs: _legs,
  userLat,
  userLng,
}: RouteFullMapModalProps) {
  void _legs;
  const [mapStyle, setMapStyle] = useState(MAP_STYLE);

  const viewport = computeViewport(stops);
  const nextStopId = stops.find((s) => s.checkpointStatus === 'pending')?.id ?? null;

  const routeLineData = {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: stops
        .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
        .map((s) => [s.structuredLocation.lng, s.structuredLocation.lat] as [number, number]),
    },
    properties: {},
  };

  const userPointData =
    userLat != null && userLng != null
      ? {
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [userLng, userLat] as [number, number],
          },
          properties: {},
        }
      : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {viewport ? (
          <Map
            style={{ flex: 1 }}
            mapStyle={mapStyle}
            logo={false}
            attributionPosition={{ bottom: 4, right: 4 }}
            onDidFailLoadingMap={() => { if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL); }}
          >
            <Camera
              initialViewState={{
                center: viewport.center,
                zoom: viewport.zoom,
              }}
            />

            {routeLineData.geometry.coordinates.length >= 2 && (
              <GeoJSONSource id="fm-route-line-src" data={routeLineData}>
                <Layer
                  id="fm-route-line-layer"
                  type="line"
                  paint={{
                    'line-color': color.deep,
                    'line-width': 3,
                    'line-dasharray': [8, 4],
                  }}
                />
              </GeoJSONSource>
            )}

            {stops.map((stop, idx) => {
              const loc = stop.structuredLocation;
              if (loc?.lat == null || loc?.lng == null) return null;
              const isNext    = stop.id === nextStopId;
              const isDone    = stop.checkpointStatus === 'arrived';
              const isSkipped = stop.checkpointStatus === 'skipped';
              return (
                <Marker
                  key={stop.id}
                  lngLat={[loc.lng, loc.lat]}
                >
                  <View style={[
                    fm.pin,
                    isDone    && fm.pinDone,
                    isSkipped && fm.pinSkipped,
                    isNext    && fm.pinNext,
                  ]}>
                    <Text style={fm.pinLabel}>{idx + 1}</Text>
                  </View>
                </Marker>
              );
            })}

            {userPointData && (
              <GeoJSONSource id="fm-user-loc-src" data={userPointData}>
                <Layer
                  id="fm-user-loc-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 10,
                    'circle-color': color.deep + 'CC',
                    'circle-stroke-color': color.deep,
                    'circle-stroke-width': 2,
                  }}
                />
              </GeoJSONSource>
            )}
          </Map>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff' }}>No location data</Text>
          </View>
        )}

        <Pressable style={fm.closeBtn} onPress={onClose} hitSlop={12}>
          <Minimize2 size={18} color={color.ink} />
          <Text style={fm.closeBtnText}>Close map</Text>
        </Pressable>

        <View style={fm.legend}>
          {stops.map((s, idx) => (
            <View key={s.id} style={fm.legendRow}>
              <View style={[
                fm.legendDot,
                s.checkpointStatus === 'arrived' && fm.legendDotDone,
                s.id === nextStopId && fm.legendDotNext,
              ]}>
                <Text style={fm.legendDotLabel}>{idx + 1}</Text>
              </View>
              <Text style={fm.legendTitle} numberOfLines={1}>{s.title}</Text>
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const fm = StyleSheet.create({
  pin: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  pinDone:    { backgroundColor: '#999', borderColor: '#ddd' },
  pinSkipped: { backgroundColor: '#ccc', borderColor: '#eee' },
  pinNext:    { backgroundColor: color.deep, borderColor: '#fff', shadowColor: color.deep, shadowOpacity: 0.5, shadowRadius: 6, elevation: 6 },
  pinLabel:   { color: '#fff', fontSize: 12, fontWeight: '700' },
  closeBtn: {
    position: 'absolute', top: 54, right: 16,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
  },
  closeBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  legend: {
    position: 'absolute', bottom: 40, left: 16,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radius.md,
    paddingVertical: space.sm, paddingHorizontal: space.md,
    maxHeight: 200,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
  },
  legendRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 3 },
  legendDot:      { width: 22, height: 22, borderRadius: 11, backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center' },
  legendDotDone:  { backgroundColor: '#999' },
  legendDotNext:  { backgroundColor: color.deep },
  legendDotLabel: { color: '#fff', fontSize: 10, fontWeight: '700' },
  legendTitle:    { ...t.small, color: color.ink, fontSize: 12, maxWidth: 140 },
});
