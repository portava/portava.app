/**
 * CompassMiniMap.web.tsx — web-safe sibling of CompassMiniMap.
 *
 * MapLibre React Native is native-only (codegen/TurboModules), so the web
 * build renders a flat pin strip instead of a map canvas. Same props, same
 * tap-through behaviour: pressing it fires `onPress` so the caller can open
 * the full map screen. Metro picks this file automatically on web, keeping
 * the native file (and its maplibre import) out of the web bundle.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import type { CompassMiniMapPoint } from './compassMiniMapShared.ts';

export interface CompassMiniMapProps {
  points: CompassMiniMapPoint[];
  onPress?: () => void;
  height?: number;
  testID?: string;
}

export function CompassMiniMap({ points, onPress, height = 160, testID }: CompassMiniMapProps) {
  if (points.length === 0) return null;
  return (
    <Pressable
      style={({ pressed }) => [s.container, { minHeight: Math.min(height, 160) }, pressed && s.pressed]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel="Open the full map"
      testID={testID}
    >
      <View style={s.banner}>
        <MapPin size={12} color={color.mute} />
        <Text style={s.bannerText}>Map preview is available in the mobile app.</Text>
        {onPress ? <Maximize2 size={12} color={color.mute} /> : null}
      </View>
      <View style={s.list}>
        {points.map((p, idx) => (
          <View key={p.id} style={s.row}>
            <View style={s.dot}><Text style={s.dotLabel}>{idx + 1}</Text></View>
            <Text style={s.rowLabel} numberOfLines={1}>{p.label}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: {
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    padding: space.sm,
    gap: space.sm,
  },
  pressed: { opacity: 0.85 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bannerText: { ...t.stamp, fontSize: 10, color: color.mute, flex: 1 },
  list: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: {
    width: icon.md, height: icon.md,
    borderRadius: icon.md / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotLabel: { color: '#fff', fontSize: 9, fontWeight: '700' },
  rowLabel: { ...t.small, fontSize: 11, color: color.ink, flex: 1 },
});
