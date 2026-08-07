/**
 * SectionHeader — the small caps label above a group of rows.
 *
 * "SEND ON TELEGRAPH", "CHOOSE A CHAT", "YOUR CIRCLE".
 *
 * Four hand-rolled versions existed and three were the same idea at slightly
 * different sizes:
 *
 *   TripInviteSheet   t.stamp + Courier, 11px, color.mute, ls 0.5,
 *                     textTransform: 'uppercase'          <- taken
 *   ShareSheet        11px/700/uppercase but color.faint and no stamp font
 *   Discovery         same as TripInvite at 10px, and the caller had to type
 *                     the label already uppercased
 *   TagPreviewSheet   t.small/600 — a type label, not a section header; left alone
 *
 * TripInviteSheet's wins on three counts: it uses the `t.stamp` + Courier
 * token pair that is the passport/telegraph typographic voice everywhere else
 * in the app, it puts `textTransform` in the style so callers pass natural
 * sentence case instead of shouting in the source, and 11px matches
 * ShareSheet rather than Discovery's odd 10.
 *
 * accessibilityRole="header" lets a screen reader jump between sections, which
 * none of the four originals offered.
 */
import React from 'react';
import { View, Text, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { color, space, type as t, font } from '../../theme/tokens.ts';

export interface SectionHeaderProps {
  /** Natural sentence case — uppercasing is the style's job. */
  children: string;
  /** Right-hand slot: a count, an action, a chevron. */
  accessory?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SectionHeader({ children, accessory, style, testID }: SectionHeaderProps) {
  return (
    <View style={[s.row, style]} testID={testID}>
      <Text
        style={s.label}
        accessibilityRole="header"
        // No numberOfLines and no fixed height: at 200% OS text size this
        // wraps to two lines and pushes the list down, rather than clipping.
        accessibilityLabel={children}
      >
        {children}
      </Text>
      {accessory ? <View style={s.accessory}>{accessory}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  label: {
    ...t.stamp,
    fontFamily: font.stamp,
    flexShrink: 1,
    color: color.mute,
    textTransform: 'uppercase',
  },
  accessory: { marginLeft: 'auto', paddingLeft: space.sm },
});

export default SectionHeader;
