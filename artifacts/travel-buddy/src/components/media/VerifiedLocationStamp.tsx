/**
 * VerifiedLocationStamp — passport-stamp-style "Actually Here" overlay.
 *
 * Rendered on top of media when `locationVerified` is true on the item.
 * The stamp is semi-transparent, rotated, and non-interactive (pointerEvents="none").
 * It signals to viewers that the photo or video was captured at the tagged place.
 */

import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export interface VerifiedLocationStampProps {
  /** The place name to display inside the stamp. */
  locationName: string;
  /** Optional container style — use to position the stamp absolutely. */
  style?: StyleProp<ViewStyle>;
}

export function VerifiedLocationStamp({ locationName, style }: VerifiedLocationStampProps) {
  return (
    <View style={[s.wrap, style]} pointerEvents="none">
      <View style={s.stamp}>
        <Text style={s.eyebrow} numberOfLines={1}>VERIFIED · HERE</Text>
        <Text style={s.name} numberOfLines={1}>{locationName}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-start',
    opacity: 0.38,
    transform: [{ rotate: '-12deg' }],
  },
  stamp: {
    borderWidth: 2,
    borderColor: '#E8DFC8',
    borderRadius: 40,
    borderStyle: 'dashed',
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 2,
  },
  eyebrow: {
    fontFamily: 'Courier',
    fontSize: 7,
    letterSpacing: 1.8,
    color: '#E8DFC8',
    fontWeight: '700',
  },
  name: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: '#E8DFC8',
    maxWidth: 130,
  },
});
