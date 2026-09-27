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
    opacity: 1, // census-media §31.12: was 0.38 with no backing, which no photo guaranteed; the stamp now carries its own ink backing
    transform: [{ rotate: '-12deg' }],
  },
  stamp: {
    borderWidth: 2,
    borderColor: '#E8DFC8',
    borderRadius: 40,
    borderStyle: 'dashed', backgroundColor: 'rgba(17,17,15,0.66)', // census-media §31.12: the least alpha at which the stamp's text clears 4.5:1 over a white photo
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
    fontWeight: '700', alignSelf: 'stretch', textAlign: 'center', // census-media §40.14: fills the stamp's width and truncates inside it when a caller narrows the stamp
  },
  name: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: '#E8DFC8',
    maxWidth: 130, alignSelf: 'stretch', textAlign: 'center', // census-media §40.14: as the eyebrow; sized to its own text, a name on web overflowed a narrowed stamp's border
  },
});
