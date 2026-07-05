/**
 * CircleMapSection.web.tsx — web-safe stub for CircleMapSection.
 * Metro automatically picks this file over CircleMapSection.tsx when bundling for web.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, type as t } from '../../theme/tokens';

interface Props {
  hasLocationData?: boolean;
  meetingPointLabel?: string | null;
}

export function CircleMapSection({ meetingPointLabel }: Props) {
  return (
    <View style={s.banner}>
      <MapPin size={14} color={color.mute} />
      <Text style={s.bannerText}>
        {meetingPointLabel
          ? `Meeting point: ${meetingPointLabel}`
          : 'Map view is available in the mobile app.'}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
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
