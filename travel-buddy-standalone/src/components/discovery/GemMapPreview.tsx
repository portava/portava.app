/**
 * GemMapPreview — safe map preview card for a Hidden Gem detail page.
 *
 * Coordinate privacy rules are enforced server-side; this component simply
 * renders what the server sends via `coordsPrecision` and `lat`/`lng`:
 *
 *   coordsPrecision = 'exact'       → MapLibre map, single pin, Open in Maps (exact coords)
 *   coordsPrecision = 'approximate' → MapLibre map, pin at approx area,
 *                                     Open in Maps (approx coords), "Approximate area" label
 *   coordsPrecision = 'hidden'      → privacy placeholder, no map, no pin, no coords
 *   lat/lng both null               → "Map unavailable" placeholder
 *
 * Metro automatically selects GemMapPreview.web.tsx on web — this file is
 * native-only (iOS / Android). Do NOT import MapLibre in the web file.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import { MapPin, Lock, Map as MapIcon } from 'lucide-react-native';

export interface GemMapPreviewProps {
  lat: number | null;
  lng: number | null;
  coordsPrecision: 'exact' | 'approximate' | 'hidden';
  locationLabel?: string | null;
}

import { MAP_STYLE_URL } from '../../constants/mapStyle.ts';
import { openInMaps } from '../../lib/openInMaps.ts';
import { avatar } from '../../theme/tokens.ts';
const MAP_STYLE = MAP_STYLE_URL;

export function GemMapPreview({ lat, lng, coordsPrecision, locationLabel }: GemMapPreviewProps) {
  if (coordsPrecision === 'hidden') {
    return (
      <View style={s.placeholder}>
        <View style={[s.iconCircle, s.iconProtected]}>
          <Lock size={22} color="#FF6B6B" />
        </View>
        <Text style={s.placeholderTitle}>Location protected</Text>
        <Text style={s.placeholderBody}>
          This hidden gem's exact location is hidden until it is approved or shared by the host.
        </Text>
      </View>
    );
  }

  if (lat == null || lng == null) {
    return (
      <View style={s.placeholder}>
        <View style={[s.iconCircle, s.iconMissing]}>
          <MapIcon size={22} color="#8A9BB5" />
        </View>
        <Text style={s.placeholderTitle}>Map unavailable</Text>
        <Text style={s.placeholderBody}>
          We don't have enough location data for this gem yet.
        </Text>
      </View>
    );
  }

  const isApprox = coordsPrecision === 'approximate';
  const zoom = isApprox ? 12 : 14;
  const pinColor = isApprox ? '#FF8F00' : '#4C8BF5';

  return (
    <View>
      <View style={s.mapContainer}>
        {/*
         * pointerEvents="none" prevents MapLibre's native gesture recognisers
         * from intercepting touches inside the parent ScrollView on Android/iOS.
         * dragPan disabled at the MapLibre level still lets the native view
         * swallow the initial gesture; removing the subtree from the hit-test
         * tree entirely ensures all swipes fall through to the ScrollView.
         * The "Open in Maps" Pressable lives outside this wrapper so it works.
         */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Map
            style={StyleSheet.absoluteFill}
            mapStyle={MAP_STYLE}
            logo={false}
            attribution={false}
          >
            <Camera
              initialViewState={{ center: [lng, lat], zoom }}
            />
            <Marker lngLat={[lng, lat]}>
              <View style={[s.pin, { backgroundColor: pinColor }]}>
                <MapPin size={14} color="#fff" />
              </View>
            </Marker>
          </Map>
        </View>
      </View>

      <View style={s.footer}>
        <View style={s.footerLeft}>
          {locationLabel ? (
            <Text style={s.locationLabel} numberOfLines={1}>{locationLabel}</Text>
          ) : null}
          {isApprox ? (
            <Text style={s.approxNotice}>Approximate area — exact location protected</Text>
          ) : null}
          <Text style={s.attribution}>© OpenFreeMap contributors</Text>
        </View>
        <Pressable
          style={s.openMapsBtn}
          onPress={() => openInMaps(lat, lng)}
          hitSlop={8}
        >
          <MapPin size={12} color="#4C8BF5" />
          <Text style={s.openMapsText}>Open in Maps</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  placeholder: {
    backgroundColor: '#13213A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E2D45',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 20,
    gap: 8,
  },
  iconCircle: {
    width: avatar.xl, height: avatar.xl,
    borderRadius: avatar.xl / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  iconProtected: { backgroundColor: 'rgba(255,107,107,0.12)' },
  iconMissing:   { backgroundColor: 'rgba(138,155,181,0.12)' },
  placeholderTitle: {
    color: '#E8F0FE',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  placeholderBody: {
    color: '#8A9BB5',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 280,
  },
  mapContainer: {
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#13213A',
  },
  pin: {
    width: avatar.xsSm,
    height: avatar.xsSm,
    borderRadius: avatar.xsSm / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 8,
  },
  footerLeft: { flex: 1, gap: 2 },
  locationLabel: {
    color: '#E8F0FE',
    fontSize: 13,
    fontWeight: '600',
  },
  approxNotice: {
    color: '#FF8F00',
    fontSize: 12,
    lineHeight: 16,
  },
  openMapsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1E2D45',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  openMapsText: {
    color: '#4C8BF5',
    fontSize: 13,
    fontWeight: '600',
  },
  attribution: {
    color: '#8A9BB5',
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
  },
});
