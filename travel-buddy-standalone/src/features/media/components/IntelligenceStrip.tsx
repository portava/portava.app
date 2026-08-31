/**
 * IntelligenceStrip — evidence-class + freshness strip for a media item (§46).
 *
 * Gives observed / inferred / predicted media DISTINCT visual treatments (§46):
 * observed reads as solid confident evidence; inferred/predicted read as
 * derived/forecast (dashed border for forecast). This is the client's way of
 * honouring "PHOTO ≠ TRUTH" (§9) — the label never claims verified fact.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space, dot } from '../../../theme/tokens.ts';
import type { ObservationClass, FreshnessClass } from '../types/media.ts';
import { OBSERVATION_COLOR, isForecastClass } from '../state/stateColors.ts';
import { observationClassLabel } from '../state/freshness.ts';
import { FreshnessBadge } from './FreshnessBadge.tsx';

export interface IntelligenceStripProps {
  observationClass: ObservationClass;
  freshness: FreshnessClass;
  ageMinutes?: number | null;
  /** Perspective group label, e.g. "Street" (§12). */
  perspectiveLabel?: string | null;
}

export function IntelligenceStrip({
  observationClass,
  freshness,
  ageMinutes,
  perspectiveLabel,
}: IntelligenceStripProps) {
  const accent = OBSERVATION_COLOR[observationClass];
  const forecast = isForecastClass(observationClass);
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.classChip,
          { borderColor: accent },
          forecast && styles.forecastChip,
        ]}
      >
        <View style={[styles.classDot, { backgroundColor: accent }]} />
        <Text style={[styles.classText, { color: accent }]}>
          {observationClassLabel(observationClass)}
        </Text>
      </View>
      {perspectiveLabel ? (
        <Text style={styles.perspective} numberOfLines={1}>
          {perspectiveLabel}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <FreshnessBadge freshness={freshness} ageMinutes={ageMinutes} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  classChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  forecastChip: { borderStyle: 'dashed' },
  classDot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  classText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  perspective: {
    color: color.onInkMute,
    fontSize: 12,
    fontWeight: '600',
  },
});
