/**
 * FeedSkeleton — skeleton placeholder for a generic feed / Pulse Wall.
 * Renders several PostCard-shaped shimmer rows while content loads.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

function FeedSkeletonItem() {
  return (
    <View style={styles.card}>
      {/* Cover image */}
      <ShimmerBox height={180} borderRadius={0} />
      <View style={styles.body}>
        {/* Author row */}
        <View style={styles.authorRow}>
          <ShimmerBox width={36} height={36} borderRadius={18} style={styles.avatar} />
          <View style={{ flex: 1, gap: 6 }}>
            <ShimmerBox height={12} width="50%" />
            <ShimmerBox height={10} width="35%" />
          </View>
        </View>
        {/* Text lines */}
        <ShimmerBox height={14} width="90%" />
        <ShimmerBox height={14} width="75%" />
        <ShimmerBox height={14} width="60%" />
        {/* Engagement bar */}
        <View style={styles.engRow}>
          <ShimmerBox height={12} width={48} />
          <ShimmerBox height={12} width={48} />
        </View>
      </View>
    </View>
  );
}

interface FeedSkeletonProps {
  count?: number;
}

export function FeedSkeleton({ count = 3 }: FeedSkeletonProps) {
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <FeedSkeletonItem key={i} />
      ))}
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
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.xs,
  },
  avatar: {
    flexShrink: 0,
  },
  engRow: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.xs,
  },
});
