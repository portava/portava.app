/**
 * MeetupAreaPreview.web.tsx — honest web fallback for the buddy profile
 * meetup-area map.
 *
 * MapLibre React Native is native-only. Metro picks THIS file on web so the
 * native MeetupAreaPreview.tsx is never compiled there. No fake map — just a
 * clear "view on mobile" notice with the same privacy framing.
 *
 * Props match MeetupAreaPreview.tsx exactly so the screen can import without
 * platform guards.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';

export interface MeetupAreaPreviewProps {
  lat: number;
  lng: number;
}

export function MeetupAreaPreview(_props: MeetupAreaPreviewProps) {
  return (
    <View style={s.placeholder}>
      <View style={s.iconCircle}>
        <MapPin size={20} color={color.signal} />
      </View>
      <Text style={s.title}>Approximate meetup area pinned</Text>
      <Text style={s.body}>
        This buddy has pinned a rough meetup area (never an exact point). Open
        Travel Buddy on your phone to see it on the map.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  placeholder: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    gap: 6,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 77, 46, 0.10)',
    marginBottom: 2,
  },
  title: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  body: {
    ...t.small,
    color: color.mute,
    lineHeight: 17,
    textAlign: 'center',
    maxWidth: 300,
  },
});
