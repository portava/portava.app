/**
 * StructuredValueChips — the tappable `structured_value` rows under a creation
 * title (census G46). Each chip says exactly what a tap sets ("Fri 9 Oct ·
 * 8:00 PM – 11:00 PM — Set as the date and time"); nothing is applied without
 * the tap, and a chip can be ignored. Renders nothing when there is nothing to
 * offer (the flag is OFF, or the title names no date, time or size).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CalendarClock } from 'lucide-react-native';
import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';
import type { StructuredValueChip } from './structuredValues.ts';

export interface StructuredValueChipsProps {
  chips: StructuredValueChip[];
  onApply: (chip: StructuredValueChip) => void;
  testID?: string;
}

export function StructuredValueChips({ chips, onApply, testID }: StructuredValueChipsProps) {
  if (chips.length === 0) return null;
  return (
    <View style={styles.wrap} testID={testID ?? 'structured-value-chips'}>
      {chips.map((c) => (
        <Pressable
          key={c.id}
          onPress={() => onApply(c)}
          style={styles.chip}
          accessibilityRole="button"
          accessibilityLabel={c.subtitle ? `${c.subtitle}: ${c.label}` : c.label}
          testID={`structured-value-${c.value.kind}`}
        >
          <CalendarClock size={iconToken.s14} color={color.deep} />
          <View style={styles.text}>
            <Text style={styles.label} numberOfLines={1}>{c.label}</Text>
            {c.subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{c.subtitle}</Text> : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    maxWidth: '100%',
  },
  text: { flexShrink: 1, minWidth: 0 },
  label: { ...t.small, color: color.deep, fontWeight: '700' },
  subtitle: { ...t.small, color: color.mute },
});
