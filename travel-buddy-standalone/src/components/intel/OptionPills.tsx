/**
 * OptionPills — the one-tap option row a Quick Signal prompt is built from.
 *
 * The composer's whole job is a single tap: the traveler reads the prompt, taps
 * one option, and the structured observation is sent. No free-text field ever.
 * A light haptic fires on tap; the tapped pill shows a spinner while its write
 * is in flight, and the others disable so a double-tap can't fork two writes.
 */
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { color, space, radius, typography } from '../../theme/tokens.ts';

export interface OptionPillsProps {
  options: readonly string[];
  onSelect: (option: string) => void;
  /** The option whose write is currently in flight (shows a spinner). */
  busyOption?: string | null;
  /** The already-chosen option (stays highlighted after it lands). */
  selectedOption?: string | null;
  /** Disable the whole row (e.g. suppressed, or another write in flight). */
  disabled?: boolean;
  /** Map raw option → display label (defaults to the option verbatim). */
  labelFor?: (option: string) => string;
  testIDPrefix?: string;
}

export function OptionPills({
  options,
  onSelect,
  busyOption,
  selectedOption,
  disabled,
  labelFor,
  testIDPrefix = 'intel-option',
}: OptionPillsProps) {
  const anyBusy = !!busyOption;
  return (
    <View style={styles.row}>
      {options.map((opt) => {
        const busy = busyOption === opt;
        const selected = selectedOption === opt && !busy;
        const isDisabled = disabled || (anyBusy && !busy);
        return (
          <Pressable
            key={opt}
            testID={`${testIDPrefix}-${opt}`}
            accessibilityRole="button"
            accessibilityLabel={labelFor ? labelFor(opt) : opt}
            accessibilityState={{ disabled: isDisabled, busy, selected }}
            disabled={isDisabled}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              onSelect(opt);
            }}
            style={({ pressed }) => [
              styles.pill,
              busy && styles.pillBusy,
              selected && styles.pillSelected,
              isDisabled && !busy && styles.pillDisabled,
              pressed && !isDisabled && styles.pillPressed,
            ]}
          >
            {busy ? <ActivityIndicator size="small" color={color.onInk} /> : null}
            <Text
              style={[styles.pillText, busy && styles.pillTextBusy, selected && styles.pillTextSelected]}
              numberOfLines={1}
            >
              {labelFor ? labelFor(opt) : opt}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    minHeight: 44,
  },
  pillPressed: { backgroundColor: color.paper, borderColor: color.faint },
  pillBusy: { backgroundColor: color.ink, borderColor: color.ink },
  pillSelected: { backgroundColor: color.signal + '14', borderColor: color.signal },
  pillDisabled: { opacity: 0.4 },
  pillText: { ...typography.button, color: color.ink },
  pillTextBusy: { color: color.onInk },
  pillTextSelected: { color: color.signalDim },
});
