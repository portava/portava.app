/**
 * CircleMapSection — native map for Find Your Circle (MapLibre v11).
 *
 * Renders member presence pins and a highlighted meeting point marker.
 * Only shows the map when at least one coordinate is available; otherwise
 * renders a text banner so list layout is unaffected.
 *
 * V1: API returns null publicLat/publicLng for all presences and meeting points,
 * so the banner renders by default. V2 will populate coordinates and the map
 * activates automatically.
 *
 * Stale presence markers are greyed out and intentionally non-routable.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Map, Camera, GeoJSONSource, Layer, Marker } from '@maplibre/maplibre-react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, type as t } from '../../theme/tokens.ts';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

export interface MapMember {
  userId: string;
  lat: number;
  lng: number;
  isStale: boolean;
}

export interface MapMeetingPoint {
  lat: number;
  lng: number;
  label: string;
}

interface Props {
  members: MapMember[];
  meetingPoint: MapMeetingPoint | null;
  meetingPointLabel?: string | null;
}

export function CircleMapSection({ members, meetingPoint, meetingPointLabel }: Props) {
  const hasData = members.length > 0 || meetingPoint !== null;

  if (!hasData) {
    return (
      <View style={s.banner}>
        <MapPin size={14} color={color.mute} />
        <Text style={s.bannerText}>
          {meetingPointLabel
            ? `Meeting point: ${meetingPointLabel}`
            : 'Location pins appear when members check in at a venue.'}
        </Text>
      </View>
    );
  }

  const centerPoint: [number, number] = meetingPoint
    ? [meetingPoint.lng, meetingPoint.lat]
    : [members[0].lng, members[0].lat];

  const activeMembers = members.filter((m) => !m.isStale);
  const staleMembers = members.filter((m) => m.isStale);

  const activeMembersGeoJSON = {
    type: 'FeatureCollection' as const,
    features: activeMembers.map((m) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
      properties: { userId: m.userId },
    })),
  };

  const staleMembersGeoJSON = {
    type: 'FeatureCollection' as const,
    features: staleMembers.map((m) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
      properties: { userId: m.userId },
    })),
  };

  return (
    <View style={s.mapSurface}>
      <Map style={{ flex: 1 }} mapStyle={MAP_STYLE} logo={false} attribution={false}>
        <Camera initialViewState={{ center: centerPoint, zoom: 13 }} />

        {activeMembers.length > 0 && (
          <GeoJSONSource id="circle-active-members" data={activeMembersGeoJSON}>
            <Layer
              id="circle-active-circles"
              type="circle"
              paint={{
                'circle-radius': 10,
                'circle-color': '#2E7D32',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff',
              }}
            />
          </GeoJSONSource>
        )}

        {staleMembers.length > 0 && (
          <GeoJSONSource id="circle-stale-members" data={staleMembersGeoJSON}>
            <Layer
              id="circle-stale-circles"
              type="circle"
              paint={{
                'circle-radius': 10,
                'circle-color': '#BDBDBD',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#fff',
                'circle-opacity': 0.6,
              }}
            />
          </GeoJSONSource>
        )}

        {meetingPoint && (
          <Marker lngLat={[meetingPoint.lng, meetingPoint.lat]}>
            <View style={s.mpMarker}>
              <MapPin size={14} color="#fff" />
            </View>
          </Marker>
        )}
      </Map>
    </View>
  );
}

const s = StyleSheet.create({
  mapSurface: {
    height: 180,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginHorizontal: 16,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.haze,
    borderRadius: radius.md,
    padding: 12,
    marginHorizontal: 16,
  },
  bannerText: { ...t.small, color: color.mute, flex: 1 },
  mpMarker: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F57F17',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
});
