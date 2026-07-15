/**
 * CircleMapSection.web.tsx — web-safe stub for CircleMapSection.
 * Metro automatically picks this file over CircleMapSection.tsx when bundling for web.
 * Accepts the same Props interface as the native component so imports stay identical.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, type as t } from '../../theme/tokens';

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

export function CircleMapSection({ meetingPoint, meetingPointLabel }: Props) {
  const label = meetingPoint?.label ?? meetingPointLabel;
  return (
    <View style={s.banner}>
      <MapPin size={14} color={color.mute} />
      <Text style={s.bannerText}>
        {label
          ? `Meeting point: ${label}`
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
