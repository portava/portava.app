/**
 * MediaTimeRail — temporal state rail (spec §17).
 *
 *   EARLIER ───────── ● ─────── NOW ───────── LATER
 *
 * Time and temporal state are first-class UI (§46). Historical (observed) and
 * forecast (predicted) segments are VISUALLY DISTINCT (§17): observed segments
 * are solid; forecast segments are dashed/amber and read as "Likely". Forecasts
 * carry confidence, never presented as fact.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space, icon, dot } from '../../../theme/tokens.ts';
import type { ObservationClass } from '../types/media.ts';
import { OBSERVATION_COLOR, isForecastClass } from '../state/stateColors.ts';

export interface TimeRailSegment {
  key: string;
  /** EARLIER / NOW / TYPICAL / LATER (§17). */
  label: string;
  /** Short state note, e.g. "Getting busier". */
  note?: string | null;
  observationClass: ObservationClass;
  /** Marks the current moment (renders the ● anchor). */
  isNow?: boolean;
}

export interface MediaTimeRailProps {
  segments: TimeRailSegment[];
}

export function MediaTimeRail({ segments }: MediaTimeRailProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.railRow}>
        {segments.map((seg, i) => {
          const accent = OBSERVATION_COLOR[seg.observationClass];
          const forecast = isForecastClass(seg.observationClass);
          return (
            <View key={seg.key} style={styles.segment}>
              {/* connector line (skip before the first) */}
              {i > 0 ? (
                <View
                  style={[
                    styles.connector,
                    { borderColor: accent },
                    forecast ? styles.connectorForecast : styles.connectorSolid,
                  ]}
                />
              ) : (
                <View style={styles.connectorSpacer} />
              )}
              <View style={[styles.node, seg.isNow ? styles.nodeNow : null, { borderColor: accent }]}>
                {seg.isNow ? <View style={[styles.nodeDot, { backgroundColor: accent }]} /> : null}
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.labelsRow}>
        {segments.map((seg) => {
          const accent = OBSERVATION_COLOR[seg.observationClass];
          const forecast = isForecastClass(seg.observationClass);
          return (
            <View key={seg.key} style={styles.labelCol}>
              <Text style={[styles.label, seg.isNow && styles.labelNow]}>{seg.label}</Text>
              {seg.note ? (
                <Text style={[styles.note, { color: accent }]} numberOfLines={2}>
                  {forecast ? `Likely · ${seg.note}` : seg.note}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, gap: space.sm },
  railRow: { flexDirection: 'row', alignItems: 'center' },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  connector: { flex: 1, borderTopWidth: 2, marginRight: 4 },
  connectorSolid: {},
  connectorForecast: { borderStyle: 'dashed' },
  connectorSpacer: { flex: 1, marginRight: 4 },
  node: {
    width: icon.s14,
    height: icon.s14,
    borderRadius: icon.s14 / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.ink,
  },
  nodeNow: { width: icon.s18, height: icon.s18, borderRadius: icon.s18 / 2 },
  nodeDot: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2 },
  labelsRow: { flexDirection: 'row' },
  labelCol: { flex: 1, paddingRight: space.sm },
  label: { color: color.onInkMute, fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  labelNow: { color: color.onInk },
  note: { fontSize: 11, fontWeight: '600', marginTop: 2 },
});
