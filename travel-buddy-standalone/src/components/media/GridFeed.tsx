/**
 * GridFeed — placeholder shell for the Grid (photo/reel mosaic) mode.
 * Real feed content is wired up in a follow-up task.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { color, type as t } from '../../theme/tokens.ts';

export function GridFeed() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={color.signal} />
      <Text style={styles.label}>Grid — coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: color.paper, // grid mode uses the solid surface
  },
  label: {
    ...t.small,
    color: color.mute,
  },
});
