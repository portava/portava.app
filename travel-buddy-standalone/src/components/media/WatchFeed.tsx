/**
 * WatchFeed — placeholder shell for the Watch (full-screen vertical video) mode.
 * Real feed content is wired up in a follow-up task.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { color, type as t } from '../../theme/tokens.ts';

export function WatchFeed() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={color.signal} />
      <Text style={styles.label}>Watch — coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: color.ink, // full-screen video surface is dark
  },
  label: {
    ...t.small,
    color: color.onInkMute,
  },
});
