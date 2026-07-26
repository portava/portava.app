/**
 * PlaceCardSkeleton — skeleton placeholder for PlaceCard.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

export function PlaceCardSkeleton() {
  return (
    <View style={styles.card}>
      <ShimmerBox height={140} borderRadius={0} />
      <View style={styles.body}>
        <ShimmerBox height={10} width="30%" />
        <ShimmerBox height={16} width="75%" />
        <ShimmerBox height={11} width="55%" />
        <View style={styles.footerRow}>
          <ShimmerBox height={10} width={60} />
          <ShimmerBox height={28} width={80} borderRadius={14} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.md,
  },
  body: {
    padding: space.md,
    gap: space.sm,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
});
