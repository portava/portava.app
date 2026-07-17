/**
 * MeetupAreaPreview — read-only map card showing a buddy's approximate
 * meetup area on their public profile.
 *
 * Privacy: the stored pin is already rounded server-side to ~100 m, and this
 * component NEVER renders an exact point — only a translucent ~500 m circle
 * centred on the (approximate) pin, framed as "approximate area".
 *
 * Metro automatically selects MeetupAreaPreview.web.tsx on web — this file is
 * native-only (iOS / Android). Do NOT import MapLibre in the web file.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Map, Camera } from '@maplibre/maplibre-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface MeetupAreaPreviewProps {
  lat: number;
  lng: number;
}

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

const MAP_HEIGHT = 180;
const ZOOM = 13;
/** Radius of the rendered fuzzy area, in metres. */
const AREA_RADIUS_M = 500;

/**
 * Pixel radius of AREA_RADIUS_M at the given latitude and ZOOM, using the
 * Web Mercator ground resolution (metres per pixel at zoom z):
 *   156543.03392 * cos(lat) / 2^z
 */
function circleRadiusPx(lat: number): number {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM);
  return AREA_RADIUS_M / metersPerPixel;
}

export function MeetupAreaPreview({ lat, lng }: MeetupAreaPreviewProps) {
  const r = circleRadiusPx(lat);

  return (
    <View>
      <View style={s.mapContainer}>
        {/*
         * pointerEvents="none" keeps MapLibre's native gesture recognisers
         * from swallowing scroll gestures inside the parent ScrollView
         * (same pattern as GemMapPreview).
         */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Map
            style={StyleSheet.absoluteFill}
            mapStyle={MAP_STYLE}
            logo={false}
            attribution={false}
          >
            <Camera initialViewState={{ center: [lng, lat], zoom: ZOOM }} />
          </Map>
          {/* Fuzzy area overlay — the camera is centred on the pin, so a
              screen-centred circle marks the approximate area without ever
              drawing an exact point. */}
          <View style={s.circleWrap} pointerEvents="none">
            <View
              style={[
                s.areaCircle,
                { width: r * 2, height: r * 2, borderRadius: r },
              ]}
            />
          </View>
        </View>
      </View>
      <Text style={s.approxNote}>
        Approximate area only — the exact meetup point is agreed after booking.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  mapContainer: {
    height: MAP_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  circleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  areaCircle: {
    backgroundColor: 'rgba(255, 77, 46, 0.14)', // color.signal at low alpha
    borderWidth: 2,
    borderColor: 'rgba(255, 77, 46, 0.5)',
  },
  approxNote: {
    ...t.small,
    color: color.mute,
    marginTop: space.sm,
    lineHeight: 16,
  },
});
