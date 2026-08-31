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

const NEUTRAL_ACCENT = 'rgba(250,249,246,0.45)';

export function CityVisualPulse({ zones, onSelectZone }: CityVisualPulseProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>City visual state</Text>
      {zones.map((z) => {
        // A qualitative state is present ONLY when a gated live claim resolved it.
        // With no live claim we show a neutral row (name + coverage) and NEVER a
        // fabricated "Building/Peak" pulse (§46 "no fake-live treatment").
        const hasState = z.state != null;
        const accent = hasState ? ZONE_COLOR[z.state as NonNullable<typeof z.state>] : NEUTRAL_ACCENT;
        const glyph = hasState ? zoneGlyph(z.state as NonNullable<typeof z.state>, z.trend ?? 'steady') : 'dot';
        const intensity = hasState ? zoneIntensity(z.state as NonNullable<typeof z.state>) : 0.28;
        const stateText = hasState ? zoneStateLabel(z.state as NonNullable<typeof z.state>) : null;
        const coverageText =
          z.perspectiveCount != null && z.perspectiveCount > 0
            ? `${z.perspectiveCount}`
            : null;
        return (
          <Pressable
            key={z.id}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={onSelectZone ? () => onSelectZone(z) : undefined}
            accessibilityRole={onSelectZone ? 'button' : undefined}
            accessibilityLabel={stateText ? `${z.name}, ${stateText}` : z.name}
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
              {stateText ? (
                <>
                  <Text style={[styles.stateLabel, { color: accent }]}>{stateText}</Text>
                  {glyph === 'arrow-up' ? (
                    <TrendingUp size={13} color={accent} strokeWidth={2.4} />
                  ) : glyph === 'arrow-down' ? (
                    <TrendingDown size={13} color={accent} strokeWidth={2.4} />
                  ) : (
                    <View style={[styles.holdDot, { backgroundColor: accent }]} />
                  )}
                </>
              ) : coverageText ? (
                <Text style={styles.coverageLabel}>{coverageText}</Text>
              ) : null}
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
  coverageLabel: { color: color.faint, fontSize: 12, fontWeight: '700' },
  holdDot: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2 },
});
