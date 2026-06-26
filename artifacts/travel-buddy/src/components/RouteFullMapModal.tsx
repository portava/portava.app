/**
 * RouteFullMapModal — full-screen native map modal for a route plan.
 * Uses react-native-maps. Metro will pick RouteFullMapModal.web.tsx
 * instead when bundling for web.
 */
import React from 'react';
import { View, Text, Modal, Pressable, StyleSheet } from 'react-native';
import RNMapView, { Marker, Polyline, Circle } from 'react-native-maps';
import { Minimize2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import type { RouteStop, RouteLeg } from '../services/routePlan';

export interface RouteFullMapModalProps {
  visible: boolean;
  onClose: () => void;
  stops: RouteStop[];
  legs: RouteLeg[];
  userLat?: number | null;
  userLng?: number | null;
}

function computeRegion(stops: RouteStop[]) {
  const pts = stops
    .map((s) => ({ lat: s.structuredLocation?.lat, lng: s.structuredLocation?.lng }))
    .filter((p): p is { lat: number; lng: number } => p.lat != null && p.lng != null);
  if (pts.length === 0) return null;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.015),
    longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.015),
  };
}

export function RouteFullMapModal({ visible, onClose, stops, legs: _legs, userLat, userLng }: RouteFullMapModalProps) {
  void _legs;
  const region = computeRegion(stops);
  const nextStopId = stops.find((s) => s.checkpointStatus === 'pending')?.id ?? null;

  const polylineCoords = stops
    .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
    .map((s) => ({ latitude: s.structuredLocation.lat, longitude: s.structuredLocation.lng }));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {region ? (
          <RNMapView
            style={{ flex: 1 }}
            initialRegion={region}
            showsUserLocation={false}
            showsMyLocationButton={false}
            showsCompass
            toolbarEnabled={false}
          >
            {polylineCoords.length >= 2 && (
              <Polyline
                coordinates={polylineCoords}
                strokeColor={color.deep}
                strokeWidth={3}
                lineDashPattern={[8, 4]}
              />
            )}
            {stops.map((stop, idx) => {
              const loc = stop.structuredLocation;
              if (loc?.lat == null || loc?.lng == null) return null;
              const isNext    = stop.id === nextStopId;
              const isDone    = stop.checkpointStatus === 'arrived';
              const isSkipped = stop.checkpointStatus === 'skipped';
              return (
                <Marker key={stop.id} coordinate={{ latitude: loc.lat, longitude: loc.lng }} anchor={{ x: 0.5, y: 0.5 }}>
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
            {userLat != null && userLng != null && (
              <Circle
                center={{ latitude: userLat, longitude: userLng }}
                radius={15}
                fillColor={color.deep + 'CC'}
                strokeColor={color.deep}
                strokeWidth={2}
              />
            )}
          </RNMapView>
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
