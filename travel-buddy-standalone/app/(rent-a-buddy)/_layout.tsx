import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { color, space, type as t } from '../../src/theme/tokens';

export default function RentABuddyLayout() {
  const { enabled, loading } = useRentABuddyFlag();
  const insets = useSafeAreaInsets();

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (!enabled) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.stamp}>
          <Text style={styles.stampText}>COMING SOON</Text>
        </View>
        <Text style={styles.title}>Rent a Buddy</Text>
        <Text style={styles.sub}>
          Connect with trusted local buddies who help you navigate your destination — for arrival support, city tours, nightlife, and more.
        </Text>
        <Text
          style={styles.back}
          onPress={() => router.canGoBack() ? router.back() : router.push('/(tabs)/' as any)}
        >
          ← Back
        </Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.lg,
  },
  stamp: {
    backgroundColor: color.signal,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 6,
    transform: [{ rotate: '-2deg' }],
    marginBottom: space.sm,
  },
  stampText: {
    fontFamily: 'Courier',
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 2,
  },
  title: {
    ...t.title,
    fontSize: 28,
    color: color.ink,
    textAlign: 'center',
  },
  sub: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 22,
  },
  back: {
    ...t.bodyStrong,
    color: color.signal,
    marginTop: space.md,
  },
});
