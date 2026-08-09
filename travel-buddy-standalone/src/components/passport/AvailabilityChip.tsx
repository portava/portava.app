/**
 * AvailabilityChip — compact availability indicator for the Passport header.
 *
 * Renders a small rounded pill with a green accent dot when the user is
 * open to meet. Returns null (nothing rendered) when chipState is null.
 *
 * Consistent with the Passport card's cream/gold design language.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { AvailabilityChipState } from '../../lib/availabilityChip.ts';
import { dot } from '../../theme/tokens.ts';

interface AvailabilityChipProps {
  chipState: AvailabilityChipState | null | undefined;
  onPress?: () => void;
  testID?: string;
}

const GREEN_DOT = '#22C55E';
const CHIP_BG   = '#F0FAF4';
const CHIP_BORDER = 'rgba(34,197,94,0.35)';
const TEXT_COLOR  = '#166534';

export function AvailabilityChip({ chipState, onPress, testID }: AvailabilityChipProps) {
  if (!chipState) return null;

  return (
    <Pressable
      style={s.chip}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      accessibilityLabel={
        chipState.secondary
          ? `${chipState.primary} · ${chipState.secondary}`
          : chipState.primary
      }
      accessibilityRole="button"
      testID={testID ?? 'availability-chip'}
    >
      {/* Green accent dot */}
      <View style={s.dot} />

      {/* Text content */}
      <View style={s.textWrap}>
        <Text style={s.primary} numberOfLines={1}>
          {chipState.primary}
          {chipState.secondary ? (
            <Text style={s.secondary}>{` · ${chipState.secondary}`}</Text>
          ) : null}
        </Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: CHIP_BG,
    borderWidth: 1,
    borderColor: CHIP_BORDER,
    marginTop: 4,
  },
  dot: {
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
    backgroundColor: GREEN_DOT,
  },
  textWrap: {
    flexShrink: 1,
  },
  primary: {
    fontSize: 12,
    fontWeight: '700',
    color: TEXT_COLOR,
    letterSpacing: 0.1,
  },
  secondary: {
    fontSize: 12,
    fontWeight: '500',
    color: TEXT_COLOR,
  },
});
