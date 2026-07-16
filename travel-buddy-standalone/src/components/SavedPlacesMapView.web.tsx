/**
 * Web fallback for SavedPlacesMapView.
 * Metro selects this file on web builds where the MapLibre native module
 * is unavailable. Shows a clear message so the UI doesn't break.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens';
import type { SavedPlacesMapViewProps } from './SavedPlacesMapView';

export function SavedPlacesMapView({ places }: SavedPlacesMapViewProps) {
  return (
    <View style={s.root}>
      <View style={s.icon}>
        <MapPin size={28} color={color.faint} />
      </View>
      <Text style={s.title}>Map is available on mobile</Text>
      <Text style={s.body}>
        Open Travel Buddy on your iOS or Android device to see your{' '}
        {places.length} saved place{places.length === 1 ? '' : 's'} on the map.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: 32,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: {
    ...t.title,
    fontSize: 16,
    color: color.mute,
  },
  body: {
    ...t.body,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 280,
  },
});
