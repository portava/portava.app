/**
 * EventCardSkeleton — skeleton placeholder for EventCard / EventDiscoveryCard.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

export function EventCardSkeleton() {
  return (
    <View style={styles.card}>
      {/* Left stripe */}
      <View style={styles.stripe} />
      {/* Thumbnail — fixed height matching the card's minHeight */}
      <ShimmerBox width={80} height={110} borderRadius={0} style={styles.thumb} />
      {/* Content */}
      <View style={styles.content}>
        <ShimmerBox height={10} width="25%" />
        <ShimmerBox height={15} width="85%" />
        <ShimmerBox height={11} width="70%" />
        <ShimmerBox height={11} width="60%" />
        <View style={styles.footerRow}>
          <ShimmerBox height={10} width={70} />
          <ShimmerBox height={26} width={64} borderRadius={13} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.sm,
    minHeight: 110,
  },
  stripe: {
    width: 4,
    backgroundColor: color.haze,
  },
  thumb: {
    alignSelf: 'stretch',
  },
  content: {
    flex: 1,
    padding: space.md,
    gap: 6,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
});
