import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRentABuddyGate } from '../../src/hooks/useRentABuddyFlag';
import { color, space, type as t } from '../../src/theme/tokens';
import { TravelErrorState } from '../../src/components/primitives';
import { RabGateRefusalState } from '../../src/components/rentabuddy/RabGateRefusalState';
import { masterSwitchOffRefusal } from '../../src/services/rentABuddyGates';

/**
 * Guards the whole (rent-a-buddy) group on `rent_buddy_enabled`.
 *
 * Three outcomes, kept apart (testing mode, lane tm-rab): ON renders the stack;
 * OFF is a gate refusal and says so — which flag, and that an admin turns it on
 * in Admin → Feature flags; UNKNOWN (the flags could not be read) is a failed
 * read with a retry, never the "off" screen. The server enforces the same flag
 * on every non-admin write; this is only the app's honest reading of it.
 */
export default function RentABuddyLayout() {
  const { state, retry } = useRentABuddyGate();
  const loading = state === 'loading';
  const enabled = state === 'on';
  const insets = useSafeAreaInsets();

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (state === 'unknown') {
    return (
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: color.paper }}>
        <TravelErrorState
          title="Couldn't check whether Rent a Buddy is on"
          sub="The app could not read its feature flags, so it can't tell whether Rent a Buddy is switched on. This is a connection problem, not the feature being off."
          onRetry={retry}
        />
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
        <View style={{ alignSelf: 'stretch' }}>
          <RabGateRefusalState refusal={masterSwitchOffRefusal()} onRetry={retry} compact testID="rab-layout-gate" />
        </View>
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
