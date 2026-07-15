/**
 * RsvpBar — a slim, colour-segmented progress bar summarising a meetup's RSVP
 * split: Going (green), Maybe (amber), Invited/Pending (grey).
 *
 * The bar is capped at `total` (the invitee count); when no one has responded
 * yet it renders as a fully grey track. A compact legend with colour dots shows
 * the exact counts below the bar. Static render only (no animated fill).
 */
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { color, type as t } from '../theme/tokens';

const GOING_COLOR   = color.success; // green
const MAYBE_COLOR   = '#E0A417';     // amber
const PENDING_COLOR = color.haze;    // grey track / invited

export interface RsvpBarProps {
  going: number;
  maybe: number;
  pending: number;
  /** Total invitee count; the bar is capped at this. Defaults to the sum. */
  total?: number;
  style?: StyleProp<ViewStyle>;
}

export function RsvpBar({ going, maybe, pending, total, style }: RsvpBarProps) {
  const g = Math.max(0, going);
  const m = Math.max(0, maybe);
  const p = Math.max(0, pending);
  const sum = g + m + p;

  // Bar length is capped at the invitee `total` when provided (in either
  // direction); otherwise it falls back to the sum of the counts. Segment
  // weights are clamped so the responded portions never overflow the cap.
  const cap = typeof total === 'number' && total > 0 ? total : sum;
  const goingBar = Math.min(g, cap);
  const maybeBar = Math.min(m, Math.max(0, cap - goingBar));
  const greyBar = Math.max(0, cap - goingBar - maybeBar);

  return (
    <View style={style}>
      <View style={styles.track}>
        {goingBar > 0 ? <View style={{ flex: goingBar, backgroundColor: GOING_COLOR }} /> : null}
        {maybeBar > 0 ? <View style={{ flex: maybeBar, backgroundColor: MAYBE_COLOR }} /> : null}
        {greyBar > 0 ? <View style={{ flex: greyBar, backgroundColor: PENDING_COLOR }} /> : null}
      </View>

      <View style={styles.legend}>
        <LegendItem dotColor={GOING_COLOR} count={g} label="Going" />
        <LegendItem dotColor={MAYBE_COLOR} count={m} label="Maybe" />
        <LegendItem dotColor={PENDING_COLOR} count={p} label="Invited" />
      </View>
    </View>
  );
}

function LegendItem({ dotColor, count, label }: { dotColor: string; count: number; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.legendText}>
        {count} {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: PENDING_COLOR,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginTop: 5,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  legendText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
});
