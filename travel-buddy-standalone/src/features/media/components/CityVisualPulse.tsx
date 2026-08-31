/**
 * CityVisualPulse — the city visual-state list (spec §4.1/§20).
 *
 *   An Thuong       Building ↑
 *   Beach Festival  Peak ●
 *   Riverside       Starting ↑
 *   My Khe          Moderate ●
 *
 * A SUBTLE current-state pulse (a thin intensity bar + a small trend glyph) —
 * never a fake-live animation or a vanity counter (§46 / §46.2).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { TrendingUp, TrendingDown } from 'lucide-react-native';
import { color, radius, space, dot } from '../../../theme/tokens.ts';
import type { CityVisualZone } from '../types/mediaContext.ts';
import { ZONE_COLOR } from '../state/stateColors.ts';
import { zoneStateLabel, zoneGlyph, zoneIntensity } from '../state/cityPulse.ts';

export interface CityVisualPulseProps {
  zones: CityVisualZone[];
  onSelectZone?: (zone: CityVisualZone) => void;
}

export function CityVisualPulse({ zones, onSelectZone }: CityVisualPulseProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>City visual state</Text>
      {zones.map((z) => {
        const accent = ZONE_COLOR[z.state];
        const glyph = zoneGlyph(z.state, z.trend);
        const intensity = zoneIntensity(z.state);
        return (
          <Pressable
            key={z.id}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={onSelectZone ? () => onSelectZone(z) : undefined}
            accessibilityRole={onSelectZone ? 'button' : undefined}
            accessibilityLabel={`${z.name}, ${zoneStateLabel(z.state)}`}
          >
            <Text style={styles.zoneName} numberOfLines={1}>
              {z.name}
            </Text>
            {/* subtle intensity bar — sized by qualitative state, not views */}
            <View style={styles.barTrack}>
              <View
                style={[styles.barFill, { width: `${Math.round(intensity * 100)}%`, backgroundColor: accent }]}
              />
            </View>
            <View style={styles.stateWrap}>
              <Text style={[styles.stateLabel, { color: accent }]}>{zoneStateLabel(z.state)}</Text>
              {glyph === 'arrow-up' ? (
                <TrendingUp size={13} color={accent} strokeWidth={2.4} />
              ) : glyph === 'arrow-down' ? (
                <TrendingDown size={13} color={accent} strokeWidth={2.4} />
              ) : (
                <View style={[styles.holdDot, { backgroundColor: accent }]} />
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(250,249,246,0.05)',
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 7,
  },
  rowPressed: { opacity: 0.6 },
  zoneName: {
    color: color.onInk,
    fontSize: 15,
    fontWeight: '700',
    width: 118,
  },
  barTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(250,249,246,0.10)',
    overflow: 'hidden',
  },
  barFill: { height: 4, borderRadius: 2 },
  stateWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    width: 108,
    justifyContent: 'flex-end',
  },
  stateLabel: { fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  holdDot: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2 },
});
