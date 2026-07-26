/**
 * MediaGridSkeleton — skeleton placeholder for a media grid.
 */
import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

interface MediaGridSkeletonProps {
  columns?: number;
  count?: number;
}

export function MediaGridSkeleton({ columns = 2, count = 6 }: MediaGridSkeletonProps) {
  const { width } = useWindowDimensions();
  const gap = space.sm;
  const cellWidth = (width - space.lg * 2 - gap * (columns - 1)) / columns;
  const cellHeight = cellWidth * 0.75;

  return (
    <View style={styles.grid}>
      {Array.from({ length: count }).map((_, i) => (
        <ShimmerBox
          key={i}
          width={cellWidth}
          height={cellHeight}
          borderRadius={radius.sm}
          style={styles.cell}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  cell: {
    flexShrink: 0,
  },
});
