/**
 * SearchResultsSkeleton — skeleton placeholder for a search results list.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space } from '../../theme/tokens.ts';

function SearchResultSkeletonItem() {
  return (
    <View style={styles.item}>
      <ShimmerBox width={48} height={48} borderRadius={8} style={styles.thumb} />
      <View style={styles.info}>
        <ShimmerBox height={14} width="60%" />
        <ShimmerBox height={11} width="45%" />
      </View>
    </View>
  );
}

interface SearchResultsSkeletonProps {
  count?: number;
}

export function SearchResultsSkeleton({ count = 5 }: SearchResultsSkeletonProps) {
  return (
    <View style={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <SearchResultSkeletonItem key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 0,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  thumb: {
    flexShrink: 0,
  },
  info: {
    flex: 1,
    gap: 6,
  },
});
