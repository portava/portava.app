/**
 * Draws the original text under a translation the server could not call
 * certain (census T242). The decision is `originalAlongsideText`; this only
 * renders what it returns, so both chat screens draw the same thing.
 */
import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { space, typography } from '../../../theme/tokens.ts'; import { useTelegraphStyles, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  originalAlongsideText,
  ORIGINAL_ALONGSIDE_LABEL,
  type OriginalAlongsideInput,
  type OriginalAlongsideView,
} from './originalAlongside.ts';

export function OriginalAlongside({ item, view }: { item: OriginalAlongsideInput; view: OriginalAlongsideView }) {
  const styles = useTelegraphStyles(makeStyles);
  const text = originalAlongsideText(item, view);
  if (text === null) return null;
  return (
    <View style={styles.wrap} accessibilityLabel={`${ORIGINAL_ALONGSIDE_LABEL}: ${text}`}>
      <Text style={styles.label}>{ORIGINAL_ALONGSIDE_LABEL}</Text>
      <Text style={styles.original} selectable>{text}</Text>
    </View>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({
  wrap: { marginTop: space.xs, paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.haze },
  label: { ...typography.caption, color: p.mute },
  original: { ...typography.caption, color: p.mute, fontStyle: 'italic' },
});
