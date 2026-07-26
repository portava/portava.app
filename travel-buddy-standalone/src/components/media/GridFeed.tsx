/**
 * GridFeed — placeholder shell for the Grid (photo/reel mosaic) mode.
 * Real feed content is wired up in a follow-up task.
 *
 * Includes a camera/create button in the top-right corner so creators can
 * always reach /create without leaving Grid mode.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Camera } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, type as t, shadow } from '../../theme/tokens.ts';

export function GridFeed() {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={color.signal} />
      <Text style={styles.label}>Grid — coming soon</Text>

      {/* Camera / create button — top-right corner */}
      <Pressable
        style={[styles.createBtn, { top: insets.top + 12 }]}
        onPress={() => router.push('/create')}
        accessibilityRole="button"
        accessibilityLabel="Create a post"
        hitSlop={8}
      >
        <Camera size={18} color={color.ink} strokeWidth={2} />
      </Pressable>
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
  createBtn: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
});
