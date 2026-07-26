/**
 * CommentsSkeleton — skeleton placeholder for a comments list.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space } from '../../theme/tokens.ts';

function CommentSkeletonItem() {
  return (
    <View style={styles.item}>
      <ShimmerBox width={32} height={32} borderRadius={16} style={styles.avatar} />
      <View style={styles.bubble}>
        <ShimmerBox height={11} width="40%" />
        <ShimmerBox height={13} width="90%" />
        <ShimmerBox height={13} width="75%" />
      </View>
    </View>
  );
}

interface CommentsSkeletonProps {
  count?: number;
}

export function CommentsSkeleton({ count = 4 }: CommentsSkeletonProps) {
  return (
    <View style={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <CommentSkeletonItem key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  item: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  avatar: {
    flexShrink: 0,
  },
  bubble: {
    flex: 1,
    backgroundColor: color.paper,
    borderRadius: 12,
    padding: space.sm,
    gap: 6,
  },
});
