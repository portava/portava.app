/**
 * SuggestionChip — an inline chip for free-text completions and query
 * continuations (spec §27 "Inline chips", §56 compass continuation).
 *
 * Used for the light-touch suggestions that sit inline (e.g. "sky nightlife",
 * "Where should I go tonight?") rather than as full rows. Accessible button.
 */
import React from 'react';
import { Text, Pressable, StyleSheet, View } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';

export interface SuggestionChipProps {
  label: string;
  onPress: () => void;
  active?: boolean;
  /** Optional leading glyph node. */
  icon?: React.ReactNode;
  testID?: string;
}

function SuggestionChipBase({ label, onPress, active, icon, testID }: SuggestionChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      testID={testID}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export const SuggestionChip = React.memo(SuggestionChipBase);

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: {
    borderColor: color.deep,
    backgroundColor: color.paper,
  },
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...t.small,
    color: color.ink,
  },
  labelActive: {
    color: color.deep,
  },
});
