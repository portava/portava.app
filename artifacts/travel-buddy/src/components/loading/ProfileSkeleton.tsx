/**
 * ProfileSkeleton — skeleton placeholder for ProfileCard.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ShimmerBox } from '../ui/ShimmerBox.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

export function ProfileSkeleton() {
  return (
    <View style={styles.card}>
      <ShimmerBox width={52} height={52} borderRadius={26} style={styles.avatar} />
      <View style={styles.info}>
        <ShimmerBox height={14} width="55%" />
        <ShimmerBox height={11} width="40%" />
        <ShimmerBox height={10} width="30%" />
      </View>
      <ShimmerBox width={72} height={30} borderRadius={15} style={styles.btn} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    marginBottom: space.sm,
    gap: space.md,
  },
  avatar: {
    flexShrink: 0,
  },
  info: {
    flex: 1,
    gap: 6,
  },
  btn: {
    flexShrink: 0,
  },
});
