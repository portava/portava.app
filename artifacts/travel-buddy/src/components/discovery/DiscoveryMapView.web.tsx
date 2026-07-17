/**
 * DiscoveryMapView.web.tsx — honest web fallback.
 *
 * react-native-maps (and any native map SDK) uses native modules unavailable on
 * web. Metro picks THIS file automatically when bundling for web, so the native
 * DiscoveryMapView.tsx is never compiled there — that is what prevents the
 * native-map web crash.
 *
 * The Discovery toggle in discovery.tsx is currently hidden on web
 * (Platform.OS !== 'web'), so in normal use this never renders. But returning an
 * honest, styled message — instead of null — means that IF the toggle is ever
 * shown on web (or this view is mounted directly), the user sees a clear
 * "available on mobile" state rather than a blank area.
 *
 * This imports NO native map module. Safe on web.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface DiscoveryMapViewProps {
  places: DiscoveryPlace[];
  onSelectPlace: (place: DiscoveryPlace) => void;
}

export function DiscoveryMapView(_props: DiscoveryMapViewProps) {
  return (
    <View style={s.root}>
      <View style={s.iconCircle}>
        <MapPin size={26} color={color.faint} />
      </View>
      <Text style={s.title}>Map is available on mobile</Text>
      <Text style={s.body}>
        Open Travel Buddy on your phone to explore the interactive map. The list
        view here shows the same places.
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
    paddingHorizontal: space.xxl,
    minHeight: 240,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: { ...t.title, fontSize: 16, color: color.mute, textAlign: 'center' },
  body: { ...t.body, color: color.faint, textAlign: 'center', maxWidth: 280 },
});

export default DiscoveryMapView;
