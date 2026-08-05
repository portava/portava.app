/**
 * GemMapPreview.web.tsx — honest web fallback for the gem detail map preview.
 *
 * MapLibre React Native is native-only. Metro picks THIS file on web so the
 * native GemMapPreview.tsx is never compiled there.
 *
 * Privacy placeholders (protected / missing coords) are rendered as-is on web
 * because they contain no map at all. Gems with safe coordinates get a
 * "Map available on mobile" notice — no fake interactive map.
 *
 * Props match GemMapPreview.tsx exactly so the page can import without platform guards.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Lock, MapPin, Map as MapIcon } from 'lucide-react-native';

export interface GemMapPreviewProps {
  lat: number | null;
  lng: number | null;
  coordsPrecision: 'exact' | 'approximate' | 'hidden';
  locationLabel?: string | null;
}

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

  return (
    <View style={s.placeholder}>
      <View style={[s.iconCircle, s.iconMobile]}>
        <MapPin size={22} color="#4C8BF5" />
      </View>
      {locationLabel ? (
        <Text style={s.locationLabel} numberOfLines={1}>{locationLabel}</Text>
      ) : null}
      <Text style={s.placeholderTitle}>Map preview on mobile</Text>
      <Text style={s.placeholderBody}>
        {isApprox
          ? 'Open Portava on your phone to see the approximate area on the map.'
          : 'Open Portava on your phone to see this gem on the map.'}
      </Text>
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
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  iconProtected: { backgroundColor: 'rgba(255,107,107,0.12)' },
  iconMissing:   { backgroundColor: 'rgba(138,155,181,0.12)' },
  iconMobile:    { backgroundColor: 'rgba(76,139,245,0.12)' },
  locationLabel: {
    color: '#E8F0FE',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
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
});
