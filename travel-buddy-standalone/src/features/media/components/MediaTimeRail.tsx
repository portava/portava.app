/**
 * MediaTimeRail — temporal state rail (spec §17).
 *
 *   EARLIER ───── ● NOW ───── TYPICAL ┈┈┈ LIKELY NEXT
 *
 * Time and temporal state are first-class UI (§46). The four §17 bands render
 * with DISTINCT visual treatments: Earlier / Now are observed (solid, teal);
 * Typical is a derived historical pattern (indigo); Likely-Next is a forecast
 * (dashed, amber) and reads as "Likely", never as fact. Forecasts carry their
 * confidence band. The Now band shows a current-state label ONLY when the server
 * marks it genuinely live — otherwise a neutral "No current read" (§46.2: cached
 * / typical / predicted data is never dressed up as a live now).
 *
 * Two shapes are accepted: the rich §17 `bands` model (preferred, from
 * GET /media/timeline), and the legacy simple `segments` list. Both funnel into
 * one rail renderer so there is a single visual treatment, not a fork.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space, icon, dot } from '../../../theme/tokens.ts';
import type { ObservationClass } from '../types/media.ts';
import type { TimelineBand, TimelineBands } from '../types/mediaTimeline.ts';
import { OBSERVATION_COLOR, isForecastClass } from '../state/stateColors.ts';
import {
  RENDER_CLASS_OBSERVATION,
  confidenceChipLabel,
  nowIsLive,
  nowStateLabel,
} from '../state/timeBands.ts';
import { FreshnessBadge } from './FreshnessBadge.tsx';

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
  /** The rich §17 four-band model (preferred). */
  bands?: TimelineBands;
  /** Legacy simple segment list (still supported for callers without bands). */
  segments?: TimeRailSegment[];
  /**
   * Data is being shown from a retained (failed-refresh) load. When true the Now
   * band is forced to its neutral state — cached intelligence is never presented
   * as live (§39/§46.2) — and a "showing last update" hint is shown.
   */
  stale?: boolean;
}

export function MediaTimeRail({ bands, segments, stale = false }: MediaTimeRailProps) {
  if (bands) {
    return <FourBandRail bands={bands} stale={stale} />;
  }
  return <SegmentRail segments={segments ?? []} />;
}

// ── §17 four-band rail ────────────────────────────────────────────────────────

function FourBandRail({ bands, stale }: { bands: TimelineBands; stale: boolean }) {
  const ordered: TimelineBand[] = [bands.earlier, bands.now, bands.typical, bands.likelyNext];
  const segments: TimeRailSegment[] = ordered.map((b) => ({
    key: b.key,
    label: b.label.toUpperCase(),
    observationClass: RENDER_CLASS_OBSERVATION[b.renderClass],
    isNow: b.key === 'now',
  }));
  return (
    <View style={styles.wrap}>
      <SegmentRail segments={segments} />
      {stale ? <Text style={styles.staleNote}>Reconnecting — showing last update, not live.</Text> : null}
      <View style={styles.detail}>
        <NowRow now={bands.now} stale={stale} />
        <TypicalRow band={bands.typical} />
        <LikelyNextRow band={bands.likelyNext} />
      </View>
    </View>
  );
}

/** Now: the gated current-state — a live badge ONLY when genuinely live (§46.2). */
function NowRow({ now, stale }: { now: TimelineBand; stale: boolean }) {
  // Retained/stale data is never live (§39): only a fresh gated read may be live.
  const live = !stale && nowIsLive(now);
  return (
    <View style={styles.bandRow}>
      <Text style={[styles.bandLabel, { color: OBSERVATION_COLOR.observed }]}>NOW</Text>
      {live ? (
        <FreshnessBadge freshness="live" label={nowStateLabel(now)} />
      ) : (
        <Text style={styles.neutral}>No current read</Text>
      )}
    </View>
  );
}

/** Typical: a derived historical pattern (indigo) — explicitly not live. */
function TypicalRow({ band }: { band: TimelineBand }) {
  const accent = OBSERVATION_COLOR[RENDER_CLASS_OBSERVATION.typical];
  if (band.items.length === 0) {
    return (
      <View style={styles.bandRow}>
        <Text style={[styles.bandLabel, { color: accent }]}>TYPICALLY</Text>
        <Text style={styles.neutral}>No typical pattern yet</Text>
      </View>
    );
  }
  return (
    <View style={styles.bandBlock}>
      <Text style={[styles.bandLabel, { color: accent }]}>TYPICALLY</Text>
      {band.items.slice(0, 3).map((it, i) => (
        <Text key={`${it.claimType ?? 'typical'}-${i}`} style={styles.patternLine} numberOfLines={1}>
          {it.label ?? it.claimType ?? 'Typical pattern'}
        </Text>
      ))}
    </View>
  );
}

/** Likely-Next: a forecast (amber). Every item carries its confidence chip (§17). */
function LikelyNextRow({ band }: { band: TimelineBand }) {
  const accent = OBSERVATION_COLOR[RENDER_CLASS_OBSERVATION.predicted];
  if (band.items.length === 0) {
    return (
      <View style={styles.bandRow}>
        <Text style={[styles.bandLabel, { color: accent }]}>LIKELY NEXT</Text>
        <Text style={styles.neutral}>No forecast yet</Text>
      </View>
    );
  }
  return (
    <View style={styles.bandBlock}>
      <Text style={[styles.bandLabel, { color: accent }]}>LIKELY NEXT</Text>
      {band.items.slice(0, 3).map((it, i) => (
        <View key={`${it.claimType ?? 'forecast'}-${i}`} style={styles.forecastLine}>
          <Text style={styles.forecastLabel} numberOfLines={1}>
            {it.label ?? it.claimType ?? 'Likely next'}
          </Text>
          <View style={[styles.confChip, { borderColor: accent }]}>
            <Text style={[styles.confChipText, { color: accent }]}>
              {confidenceChipLabel(it.confidence, it.confidenceBand)}
            </Text>
          </View>
        </View>
      ))}
      <Text style={styles.forecastNote}>Forecast — shown as “Likely”, never presented as fact (§17).</Text>
    </View>
  );
}

// ── Shared rail renderer (the EARLIER ─ ● ─ LATER line) ────────────────────────

function SegmentRail({ segments }: { segments: TimeRailSegment[] }) {
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

  // Four-band detail
  detail: { gap: space.md, marginTop: space.sm },
  bandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bandBlock: { gap: space.xs },
  bandLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  neutral: { color: color.faint, fontSize: 13, fontWeight: '600' },
  patternLine: { color: color.onInkMute, fontSize: 13, fontWeight: '600' },
  forecastLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  forecastLabel: { color: color.onInk, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  confChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  confChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  forecastNote: { color: color.faint, fontSize: 11, fontWeight: '600', marginTop: 2 },
  staleNote: { color: color.warn, fontSize: 11, fontWeight: '700', marginTop: 2 },
});
