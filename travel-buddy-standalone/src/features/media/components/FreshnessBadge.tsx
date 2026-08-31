/**
 * FreshnessBadge — freshness/last-updated label (spec §10/§17/§39/§46).
 *
 * Renders a freshness class as a small pill with a "last updated" time. It is a
 * FRESHNESS label, never a fabricated "busy now" / "live" treatment (§46.2). A
 * `live` class means "just captured" and is styled calm-confident, not urgent.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space, dot } from '../../../theme/tokens.ts';
import type { FreshnessClass } from '../types/media.ts';
import { FRESHNESS_COLOR } from '../state/stateColors.ts';
import { freshnessClassLabel, relativeAgeLabel } from '../state/freshness.ts';

export interface FreshnessBadgeProps {
  freshness: FreshnessClass;
  /** Minutes since capture/update; when present, shown as "· 4m ago". */
  ageMinutes?: number | null;
  /** Explicit label overrides the derived one (server-supplied copy). */
  label?: string | null;
}

export function FreshnessBadge({ freshness, ageMinutes, label }: FreshnessBadgeProps) {
  const dotColor = FRESHNESS_COLOR[freshness];
  const rel = relativeAgeLabel(ageMinutes);
  const text = label?.trim() || (rel ? rel : freshnessClassLabel(freshness));
  return (
    <View style={styles.wrap} accessibilityLabel={`Updated ${text}`}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
    alignSelf: 'flex-start',
  },
  dot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  text: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
