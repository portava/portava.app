import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { icon } from '../../theme/tokens.ts';

interface Props {
  index: number;
}

/**
 * Numbered circle used in passport reorder rows.
 * Renders a 24px circle with `PP.paperDeep` background containing
 * a small monospace index number (1-based).
 */
export function PassportReorderRowIndex({ index }: Props) {
  return (
    <View style={styles.circle}>
      <Text style={styles.text}>{index + 1}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: icon.s24,
    height: icon.s24,
    borderRadius: icon.s24 / 2,
    backgroundColor: PP.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { ...PP_LABEL, fontSize: 11, color: PP.inkMuted },
});
