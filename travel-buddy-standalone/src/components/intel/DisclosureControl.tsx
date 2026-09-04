/**
 * DisclosureControl — the §22 Table 30 "any connection to this place?" control.
 *
 * The traveler declares any commercial relationship to the subject once, at the
 * screen level, and it is attached to every write on that screen. The default is
 * 'none' (no pill selected) and 'none' is never sent, so an untouched control
 * changes nothing. A declared relationship makes the server record the report
 * under a NON_INDEPENDENT source class, so it never counts as independent
 * community consensus — the honest thing to do, surfaced as a light, optional tap.
 *
 * Structured only: a fixed pill set, never free text.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { OptionPills } from './OptionPills.tsx';
import {
  COMMERCIAL_DISCLOSURE_OPTIONS,
  COMMERCIAL_DISCLOSURE_LABELS,
  COMMERCIAL_DISCLOSURE_PROMPT,
  type CommercialDisclosure,
} from '../../lib/intel/contracts.ts';

export interface DisclosureControlProps {
  /** The current selection, or null / 'none' when nothing is declared. */
  value: CommercialDisclosure | null;
  /** Called with the new value; tapping the selected pill again clears to null. */
  onChange: (value: CommercialDisclosure | null) => void;
}

export function DisclosureControl({ value, onChange }: DisclosureControlProps) {
  const selected = value && value !== 'none' ? value : null;
  return (
    <View style={styles.block} testID="intel-disclosure">
      <Text style={styles.prompt}>{COMMERCIAL_DISCLOSURE_PROMPT}</Text>
      <OptionPills
        options={COMMERCIAL_DISCLOSURE_OPTIONS}
        onSelect={(v) => onChange(selected === v ? null : (v as CommercialDisclosure))}
        selectedOption={selected}
        labelFor={(v) => COMMERCIAL_DISCLOSURE_LABELS[v as CommercialDisclosure]}
        testIDPrefix="intel-disclosure"
      />
      <Text style={styles.hint}>
        Optional. Telling us keeps your report honest — a disclosed connection is shown as such and never counts as an independent review.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  prompt: { ...typography.cardTitle, color: color.ink },
  hint: { ...typography.caption, color: color.faint, lineHeight: 18 },
});
