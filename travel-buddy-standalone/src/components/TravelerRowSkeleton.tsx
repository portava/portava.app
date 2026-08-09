import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { color, space, radius, avatar } from '../theme/tokens.ts';

function SkeletonBlock({ style }: { style: object }) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return <Animated.View style={[{ opacity, backgroundColor: color.haze }, style]} />;
}

export function TravelerRowSkeleton() {
  return (
    <View style={styles.row}>
      <SkeletonBlock style={styles.avatar} />
      <View style={styles.info}>
        <SkeletonBlock style={styles.nameLine} />
        <SkeletonBlock style={styles.handleLine} />
        <SkeletonBlock style={styles.subLine} />
      </View>
      <SkeletonBlock style={styles.followBtn} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  avatar: {
    width: avatar.s48, height: avatar.s48,
    borderRadius: avatar.s48 / 2,
  },
  info: {
    flex: 1,
    gap: 6,
  },
  nameLine: {
    height: 14,
    borderRadius: 6,
    width: '55%',
  },
  handleLine: {
    height: 12,
    borderRadius: 6,
    width: '38%',
  },
  subLine: {
    height: 11,
    borderRadius: 6,
    width: '28%',
  },
  followBtn: {
    width: 84,
    height: 30,
    borderRadius: radius.pill,
  },
});
