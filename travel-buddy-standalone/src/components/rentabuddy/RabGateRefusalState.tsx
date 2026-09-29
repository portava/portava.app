/**
 * RabGateRefusalState — a refused Rent-a-Buddy gate, shown as its own state.
 *
 * Testing mode (lane tm-rab, WP-01): when a server gate refuses, the app says
 * which gate refused and what unblocks it — never an empty list and never a
 * generic error. The sentence comes from `describeGateRefusal`
 * (src/services/rentABuddyGates.ts); this component only renders it.
 *
 * `compact` renders an inline card (inside a screen that still has other
 * content, e.g. a booking whose Start was refused); the default fills the
 * screen (a list or a whole surface the gate closed).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ShieldOff } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../theme/tokens.ts';
import type { GateRefusal } from '../../services/rentABuddyGates.ts';

export function RabGateRefusalState({
  refusal,
  onRetry,
  compact = false,
  testID = 'rab-gate-refusal',
}: {
  refusal: GateRefusal;
  /** Offered as "Check again" — a gate can be lifted while the screen is open. */
  onRetry?: () => void;
  compact?: boolean;
  testID?: string;
}) {
  return (
    <View style={compact ? s.card : s.full} testID={testID} accessibilityRole="summary">
      <View style={s.head}>
        <ShieldOff size={compact ? 16 : 26} color={color.signal} />
        <Text style={compact ? s.titleCompact : s.title}>{refusal.title}</Text>
      </View>
      <Text style={s.body}>{refusal.body}</Text>
      <View style={s.gateRow}>
        <Text style={s.gateKicker}>REFUSED BY</Text>
        <Text style={s.gateName} testID={`${testID}-gate`}>{refusal.gate}</Text>
      </View>
      <Text style={s.unblockKicker}>WHAT UNBLOCKS IT</Text>
      <Text style={s.body} testID={`${testID}-unblock`}>{refusal.unblock}</Text>
      <View style={s.actions}>
        {refusal.action ? (
          <Pressable
            style={({ pressed }) => [s.primary, pressed && { opacity: layout.pressedOpacity }]}
            onPress={() => router.push(refusal.action!.route as any)}
            accessibilityRole="button"
          >
            <Text style={s.primaryText}>{refusal.action.label}</Text>
          </Pressable>
        ) : null}
        {onRetry ? (
          <Pressable
            style={({ pressed }) => [s.secondary, pressed && { opacity: layout.pressedOpacity }]}
            onPress={onRetry}
            accessibilityRole="button"
            testID={`${testID}-retry`}
          >
            <Text style={s.secondaryText}>Check again</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  full: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    gap: space.sm,
    backgroundColor: color.paper,
  },
  card: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal,
    backgroundColor: color.paperRaised,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, flex: 1 },
  titleCompact: { ...t.bodyStrong, color: color.ink, flex: 1 },
  body: { ...t.body, color: color.mute, lineHeight: 21 },
  gateRow: { gap: 2, marginTop: space.xs },
  gateKicker: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5 },
  gateName: { fontFamily: 'Courier', fontSize: 13, color: color.ink },
  unblockKicker: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginTop: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  primary: { backgroundColor: color.ink, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  primaryText: { ...t.bodyStrong, color: color.onInk },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  secondaryText: { ...t.bodyStrong, color: color.ink },
});
