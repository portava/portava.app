/**
 * GemsFeed — placeholder shell for the Gems (hidden gems) mode.
 * Real feed content is wired up in a follow-up task.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { color, type as t } from '../../theme/tokens.ts';

export function GemsFeed() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={color.signal} />
      <Text style={styles.label}>Gems — coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: color.ink, // gems shares the immersive dark surface with Watch
  },
  label: {
    ...t.small,
    color: color.onInkMute,
  },
});
