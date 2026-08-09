/**
 * RouteMinimapView.web.tsx — web-safe stub for RouteMinimapView.
 * react-native-maps uses codegenNativeComponent (TurboModules) which is not
 * available in react-native-web. Metro automatically picks this file over
 * RouteMinimapView.tsx when bundling for web, so the native file is unchanged.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../theme/tokens.ts';
import type { FullRoutePlan } from '../services/routePlan.ts';

interface Props {
  routePlan: FullRoutePlan;
  userLat?: number | null;
  userLng?: number | null;
  onExpand?: () => void;
  height?: number;
}

export function RouteMinimapView({ routePlan, height = 220 }: Props) {
  const { stops } = routePlan;

  return (
    <View style={[s.container, { height }]}>
      <View style={s.banner}>
        <MapPin size={13} color={color.mute} />
        <Text style={s.bannerText}>Map view is available in the mobile app.</Text>
      </View>
      <View style={s.list}>
        {stops.map((stop, idx) => (
          <View key={stop.id} style={s.row}>
            <View style={[
              s.dot,
              stop.checkpointStatus === 'arrived' && s.dotDone,
              stop.checkpointStatus === 'pending' && idx === stops.findIndex((s) => s.checkpointStatus === 'pending') && s.dotNext,
            ]}>
              <Text style={s.dotLabel}>{idx + 1}</Text>
            </View>
            <Text style={s.stopTitle} numberOfLines={1}>{stop.title}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    borderRadius: radius.md,
    backgroundColor: color.haze,
    overflow: 'hidden',
    padding: space.md,
    gap: space.sm,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerText: {
    ...t.small,
    color: color.mute,
  },
  list: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: {
    width: icon.lg, height: icon.lg,
    borderRadius: icon.lg / 2,
    backgroundColor: '#E76F51',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: { backgroundColor: '#999' },
  dotNext: { backgroundColor: color.deep },
  dotLabel: { color: '#fff', fontSize: 10, fontWeight: '700' },
  stopTitle: { ...t.small, color: color.ink, flex: 1 },
});
