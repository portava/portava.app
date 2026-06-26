/**
 * RouteMinimapView
 *
 * Compact map showing numbered checkpoints, a polyline between them,
 * the user's current location, and a highlighted "next stop" ring.
 * Built on the existing react-native-maps setup (same as MapView.tsx).
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import RNMapView, { Marker, Polyline, Circle } from 'react-native-maps';
import { Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import type { FullRoutePlan, RouteStop } from '../services/routePlan';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  routePlan: FullRoutePlan;
  userLat?: number | null;
  userLng?: number | null;
  onExpand?: () => void;
  height?: number;
}

// ── Region helper (same algorithm as MapView.tsx) ─────────────────────────────

function computeRegion(stops: RouteStop[]) {
  const points = stops
    .map((s) => ({ lat: s.structuredLocation?.lat, lng: s.structuredLocation?.lng }))
    .filter((p) => p.lat != null && p.lng != null) as { lat: number; lng: number }[];

  if (points.length === 0) return null;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.6, 0.02);
  const lngDelta = Math.max((maxLng - minLng) * 1.6, 0.02);

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: latDelta,
    longitudeDelta: lngDelta,
  };
}

// ── Pin colour by checkpoint status ──────────────────────────────────────────

function pinColor(status: RouteStop['checkpointStatus'], isNext: boolean): string {
  if (status === 'arrived') return '#888';
  if (status === 'skipped') return '#ccc';
  if (isNext) return color.deep;
  return '#E76F51';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RouteMinimapView({ routePlan, userLat, userLng, onExpand, height = 220 }: Props) {
  const { stops, legs } = routePlan;

  const region = useMemo(() => computeRegion(stops), [stops]);

  const polylineCoords = useMemo(() => {
    return stops
      .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
      .map((s) => ({ latitude: s.structuredLocation.lat, longitude: s.structuredLocation.lng }));
  }, [stops]);

  const nextStopId = stops.find((s) => s.checkpointStatus === 'pending')?.id ?? null;

  if (!region) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <ActivityIndicator color={color.deep} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      <RNMapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        region={region}
        scrollEnabled={false}
        zoomEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
      >
        {polylineCoords.length >= 2 && (
          <Polyline
            coordinates={polylineCoords}
            strokeColor={color.deep}
            strokeWidth={2}
            lineDashPattern={[6, 3]}
          />
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
              coordinate={{ latitude: loc.lat, longitude: loc.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
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

        {userLat != null && userLng != null && (
          <Circle
            center={{ latitude: userLat, longitude: userLng }}
            radius={12}
            fillColor={color.deep + 'CC'}
            strokeColor={color.deep}
            strokeWidth={1.5}
          />
        )}
      </RNMapView>

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
