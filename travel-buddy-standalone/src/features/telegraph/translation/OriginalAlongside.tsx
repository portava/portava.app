/**
 * Draws the original text under a translation the server could not call
 * certain (census T242). The decision is `originalAlongsideText`; this only
 * renders what it returns, so both chat screens draw the same thing.
 */
import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { color, space, typography } from '../../../theme/tokens.ts';
import {
  originalAlongsideText,
  ORIGINAL_ALONGSIDE_LABEL,
  type OriginalAlongsideInput,
  type OriginalAlongsideView,
} from './originalAlongside.ts';

export function OriginalAlongside({ item, view }: { item: OriginalAlongsideInput; view: OriginalAlongsideView }) {
  const text = originalAlongsideText(item, view);
  if (text === null) return null;
  return (
    <View style={styles.wrap} accessibilityLabel={`${ORIGINAL_ALONGSIDE_LABEL}: ${text}`}>
      <Text style={styles.label}>{ORIGINAL_ALONGSIDE_LABEL}</Text>
      <Text style={styles.original} selectable>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.xs, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  label: { ...typography.caption, color: color.mute },
  original: { ...typography.caption, color: color.mute, fontStyle: 'italic' },
});
