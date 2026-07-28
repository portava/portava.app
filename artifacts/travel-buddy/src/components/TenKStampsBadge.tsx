/**
 * TenKStampsBadge
 *
 * Small amber badge that appears on a profile header when the user has earned
 * 10,000 or more lifetime stamps. Renders null when the threshold isn't met.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  stampsEarned: number;
}

export function TenKStampsBadge({ stampsEarned }: Props) {
  if (stampsEarned < 10000) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.star}>★</Text>
      <Text style={styles.label}>10K Stamps</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEF3C7',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#FCD34D',
    alignSelf: 'flex-start',
  },
  star: {
    fontSize: 11,
    color: '#D97706',
    lineHeight: 14,
  },
  label: {
    ...(t.small as object),
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#B45309',
    letterSpacing: 0.4,
  },
});
