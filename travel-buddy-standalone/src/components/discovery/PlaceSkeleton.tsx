import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import { color, space, radius } from '../../theme/tokens.ts';

function SkeletonBox({ width, height, style }: { width: number | string; height: number; style?: object }) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: 6, backgroundColor: color.haze, opacity },
        style,
      ]}
    />
  );
}

export function PlaceCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.strip} />
      <View style={styles.body}>
        <SkeletonBox width="70%" height={14} />
        <View style={styles.metaRow}>
          <SkeletonBox width={60} height={18} style={{ borderRadius: radius.pill }} />
          <SkeletonBox width={50} height={10} />
        </View>
        <SkeletonBox width="90%" height={11} />
        <SkeletonBox width="60%" height={11} />
        <View style={styles.tagRow}>
          <SkeletonBox width={44} height={16} style={{ borderRadius: radius.pill }} />
          <SkeletonBox width={56} height={16} style={{ borderRadius: radius.pill }} />
        </View>
      </View>
      <View style={styles.addArea}>
        <SkeletonBox width={20} height={20} style={{ borderRadius: 10 }} />
      </View>
    </View>
  );
}

export function PlaceSkeletonList({ count = 6 }: { count?: number }) {
  return (
    <View style={{ paddingTop: space.sm }}>
      {Array.from({ length: count }).map((_, i) => (
        <PlaceCardSkeleton key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    overflow: 'hidden',
  },
  strip: {
    width: 4,
    backgroundColor: color.haze,
  },
  body: {
    flex: 1,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  tagRow: {
    flexDirection: 'row',
    gap: space.xs,
    marginTop: 2,
  },
  addArea: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: color.haze,
  },
});
