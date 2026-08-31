/**
 * CurrentPictureBadge — "Strong current picture" indicator (spec §13/§14).
 *
 * Summarises how well-covered a place's current visual picture is, from a
 * ConfidenceState. This is a corroboration/coverage signal (independent
 * sources), NOT a popularity metric (§25/§46.2).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { ConfidenceState } from '../types/media.ts';
import { currentPictureLabel } from '../state/freshness.ts';

export interface CurrentPictureBadgeProps {
  strength: ConfidenceState;
  /** Independent-source count, e.g. "3 sources" (§12/§18). */
  sourceCount?: number | null;
  tone?: 'dark' | 'light';
}

const BAR_COLOR: Record<ConfidenceState, string> = {
  strong: '#3DD6C4',
  moderate: '#8B9DFF',
  low: '#9C988F',
};
const BAR_FILL: Record<ConfidenceState, number> = { strong: 3, moderate: 2, low: 1 };

export function CurrentPictureBadge({ strength, sourceCount, tone = 'dark' }: CurrentPictureBadgeProps) {
  const accent = BAR_COLOR[strength];
  const filled = BAR_FILL[strength];
  const textColor = tone === 'dark' ? color.onInk : color.ink;
  const subColor = tone === 'dark' ? color.onInkMute : color.mute;
  return (
    <View style={styles.row}>
      <View style={styles.bars} accessibilityLabel={`${strength} current picture`}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.bar,
              { height: 8 + i * 3, backgroundColor: i < filled ? accent : 'rgba(156,152,143,0.35)' },
            ]}
          />
        ))}
      </View>
      <View>
        <Text style={[styles.label, { color: textColor }]}>{currentPictureLabel(strength)}</Text>
        {sourceCount != null && sourceCount > 0 ? (
          <Text style={[styles.sub, { color: subColor }]}>
            {sourceCount} independent {sourceCount === 1 ? 'source' : 'sources'}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 14 },
  bar: { width: 3, borderRadius: radius.sm },
  label: { fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  sub: { fontSize: 11, fontWeight: '600', marginTop: 1 },
});
