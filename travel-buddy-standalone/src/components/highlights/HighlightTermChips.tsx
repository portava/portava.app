/**
 * HighlightTermChips — the single vocabulary for "how long does this Highlight live?"
 *
 * A Highlight may be PERMANENT: `null` hours means "never expires". That option
 * has to read identically wherever the user is asked to choose a term — the
 * composer, and re-posting from the archive — so the array and the chip row
 * live here rather than being copied per surface.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** `hours: null` is the permanent option — it is a value, not a missing choice. */
export const HIGHLIGHT_TERMS: { hours: number | null; label: string }[] = [
  { hours: 3,    label: '3h' },
  { hours: 6,    label: '6h' },
  { hours: 12,   label: '12h' },
  { hours: 24,   label: '24h' },
  { hours: 48,   label: '48h' },
  { hours: null, label: 'Never' },
];

/** The term selected when the user has not chosen one. Never `null`: permanence is deliberate. */
export const DEFAULT_HIGHLIGHT_TERM_HOURS = 24;

/** Stable React key for a term — `null` has no string form of its own. */
function termKey(hours: number | null): string {
  return hours === null ? 'never' : String(hours);
}

/**
 * One-line summary of what the selected term means, for the hint under the row.
 * Kept here so "permanent" is phrased the same way everywhere.
 */
export function describeHighlightTerm(hours: number | null): string {
  return hours === null
    ? 'Always on your profile — this Highlight never expires.'
    : `Disappears after ${hours} hours, then moves to your archive.`;
}

/**
 * Renders a highlight's own expiry for display.
 * `null` reads as permanent — it is never passed to a date formatter.
 */
export function formatHighlightExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return 'Always on';
  const diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `${hrs}h left`;
  return `${mins}m left`;
}

interface Props {
  /** Currently selected term. `null` = permanent. */
  value: number | null;
  onChange: (hours: number | null) => void;
  disabled?: boolean;
  testID?: string;
}

export function HighlightTermChips({ value, onChange, disabled, testID }: Props) {
  return (
    <View style={s.chipRow} testID={testID}>
      {HIGHLIGHT_TERMS.map(({ hours, label }) => {
        const on = value === hours;
        return (
          <Pressable
            key={termKey(hours)}
            style={[s.chip, on && s.chipOn]}
            onPress={() => onChange(hours)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: !!disabled }}
            accessibilityLabel={hours === null ? 'Never expires' : `Expires in ${label}`}
          >
            <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  chipTextOn: { color: color.onInk },
});
