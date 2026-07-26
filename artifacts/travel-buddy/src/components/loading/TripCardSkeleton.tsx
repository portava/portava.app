/**
 * TripCardSkeleton — skeleton placeholder for TripCard.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

export function TripCardSkeleton() {
  return (
    <View style={styles.card}>
      <ShimmerBox height={140} borderRadius={0} />
      <View style={styles.body}>
        <ShimmerBox height={16} width="65%" />
        <ShimmerBox height={12} width="50%" />
        <ShimmerBox height={12} width="45%" />
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
});
