/**
 * CircleMapSection — native map for Find Your Circle.
 *
 * In V1, no precise GPS is exposed by the API. The map renders with
 * a placeholder state when there are no plottable coordinates.
 * Metro automatically picks CircleMapSection.web.tsx on web.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Map, Camera } from '@maplibre/maplibre-react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, type as t } from '../../theme/tokens';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

const DEFAULT_CENTER: [number, number] = [0, 20];

interface Props {
  hasLocationData?: boolean;
  meetingPointLabel?: string | null;
}

export function CircleMapSection({ hasLocationData = false, meetingPointLabel }: Props) {
  if (!hasLocationData) {
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

  return (
    <View style={s.mapSurface}>
      <Map
        style={{ flex: 1 }}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
      >
        <Camera
          initialViewState={{
            center: DEFAULT_CENTER,
            zoom: 1.5,
          }}
        />
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
});
