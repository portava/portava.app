/**
 * CityTimeline — Map spec §15: "A compact city timeline can show expected peaks
 * and cooling periods."
 *
 * A single horizontal strip covering `horizonStartsAt … horizonEndsAt`, with
 * each band from `cityTimeline()` laid out proportionally along it.
 *
 * THE ONE RULE THIS COMPONENT EXISTS TO HOLD
 * ==========================================
 * §37: "Do not make predictions look like observations." An OBSERVED band is a
 * solid fill with a solid edge. A FORECAST band is dashed AND hatched AND
 * carries the word "expected" in its own label — three independent signals, so
 * the distinction survives a colour-blind viewer, a greyscale screenshot and a
 * dropped font alike. It is deliberately not a tint difference.
 *
 * Dark-mode-first (§4): near-black chrome, subdued base, bright semantic
 * overlays. Pure presentation — every number comes from the pure module.
 *
 * @see src/features/map/time/timeMachine.ts
 */
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius, space } from '../../theme/tokens.ts';
import {
  formatClock,
  type CityTimeline as CityTimelineData,
  type TimelineBand,
} from '../../features/map/time/timeMachine.ts';

// ── Palette (dark chrome, §4) ─────────────────────────────────────────────────

const TRACK_BG = 'rgba(250,249,246,0.06)';
const TRACK_EDGE = 'rgba(250,249,246,0.12)';
const AXIS_TEXT = 'rgba(250,249,246,0.55)';

/** Observed peaks read as heat; observed cooling reads as calm. */
const OBSERVED_FILL: Record<TimelineBand['kind'], string> = {
  peak: 'rgba(255,77,46,0.42)',
  cooling: 'rgba(10,61,74,0.55)',
};
const OBSERVED_EDGE: Record<TimelineBand['kind'], string> = {
  peak: color.signal,
  cooling: '#4FB8CE',
};

/**
 * Forecast bands are washed out AND dashed AND hatched. The fill is
 * deliberately weaker than any observed fill so the two never read as peers.
 */
const FORECAST_FILL: Record<TimelineBand['kind'], string> = {
  peak: 'rgba(200,133,26,0.16)',
  cooling: 'rgba(250,249,246,0.07)',
};
const FORECAST_EDGE = color.warn;

/** Minimum on-screen share of the track, so a short band is still tappable/visible. */
const MIN_BAND_WIDTH_PCT = 8;

export interface CityTimelineProps {
  timeline: CityTimelineData | null | undefined;
  /** IANA zone for the axis clock labels. Omit for device-local. */
  tz?: string;
  style?: StyleProp<ViewStyle>;
  /** Hide the axis end labels in very tight layouts. */
  compact?: boolean;
}

export function CityTimeline({ timeline, tz, style, compact = false }: CityTimelineProps) {
  if (!timeline) return null;

  const start = Date.parse(timeline.horizonStartsAt);
  const end = Date.parse(timeline.horizonEndsAt);
  const span = Math.max(1, end - start);

  // §15's timeline is an aggregate claim. When the support floor filtered
  // everything out we say so, rather than rendering an empty strip that reads
  // as "nothing is happening" — those are different statements.
  const empty = timeline.bands.length === 0;

  return (
    <View style={[s.wrap, style]} accessibilityRole="summary" accessibilityLabel="City timeline">
      <View style={s.track}>
        {timeline.bands.map((band) => {
          const bs = Date.parse(band.startsAt);
          const be = Date.parse(band.endsAt);
          const left = clampPct(((bs - start) / span) * 100);
          const width = Math.max(MIN_BAND_WIDTH_PCT, clampPct(((be - bs) / span) * 100));
          return (
            <Band
              key={band.id}
              band={band}
              leftPct={Math.min(left, 100 - width)}
              widthPct={width}
              tz={tz}
            />
          );
        })}

        {empty && (
          <View style={s.emptyOverlay} pointerEvents="none">
            <Text style={s.emptyText} numberOfLines={1}>
              {timeline.qualifyingObjects > 0
                ? 'Not enough confirmed signal for a city trend yet'
                : 'No city trend to show'}
            </Text>
          </View>
        )}
      </View>

      {!compact && (
        <View style={s.axis}>
          <Text style={s.axisText}>{formatClock(new Date(start), tz)}</Text>
          <Text style={s.axisText}>{formatClock(new Date(end), tz)}</Text>
        </View>
      )}

      {!empty && (
        <View style={s.legend}>
          {timeline.bands.map((band) => (
            <View key={`l-${band.id}`} style={s.legendRow}>
              <View
                style={[
                  s.legendSwatch,
                  {
                    backgroundColor: band.isForecast
                      ? FORECAST_FILL[band.kind]
                      : OBSERVED_FILL[band.kind],
                    borderColor: band.isForecast ? FORECAST_EDGE : OBSERVED_EDGE[band.kind],
                    borderStyle: band.isForecast ? 'dashed' : 'solid',
                  },
                ]}
              />
              <Text style={s.legendText} numberOfLines={1}>
                {band.label}
                <Text style={s.legendTime}>{`  ${formatClock(new Date(Date.parse(band.startsAt)), tz)}`}</Text>
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── One band ──────────────────────────────────────────────────────────────────

function Band({
  band,
  leftPct,
  widthPct,
  tz,
}: {
  band: TimelineBand;
  leftPct: number;
  widthPct: number;
  tz?: string;
}) {
  const forecast = band.isForecast;
  return (
    <View
      style={[
        s.band,
        {
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          backgroundColor: forecast ? FORECAST_FILL[band.kind] : OBSERVED_FILL[band.kind],
          borderColor: forecast ? FORECAST_EDGE : OBSERVED_EDGE[band.kind],
          borderStyle: forecast ? 'dashed' : 'solid',
        },
      ]}
      accessibilityLabel={`${band.label}, ${formatClock(new Date(Date.parse(band.startsAt)), tz)} to ${formatClock(
        new Date(Date.parse(band.endsAt)),
        tz,
      )}${forecast ? ', forecast, not observed' : ', observed'}`}
    >
      {forecast && <Hatch />}
    </View>
  );
}

/**
 * Diagonal hatching for forecast bands — the §6 "predicted state" texture, so
 * the forecast/observed split survives greyscale and colour-blindness. Built
 * from rotated hairlines rather than an SVG pattern so it costs one View per
 * stripe and no bridge traffic.
 */
const HATCH_STRIPES = 7;

function Hatch() {
  return (
    <View style={s.hatchClip} pointerEvents="none">
      {Array.from({ length: HATCH_STRIPES }, (_, i) => (
        <View key={i} style={[s.hatchLine, { left: `${(i / HATCH_STRIPES) * 140 - 20}%` }]} />
      ))}
    </View>
  );
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// ── Styles ────────────────────────────────────────────────────────────────────

const TRACK_HEIGHT = 30;

const s = StyleSheet.create({
  wrap: {
    width: '100%',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.sm,
    backgroundColor: TRACK_BG,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: TRACK_EDGE,
    overflow: 'hidden',
    position: 'relative',
  },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: radius.sm - 2,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  hatchClip: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  hatchLine: {
    position: 'absolute',
    top: -TRACK_HEIGHT,
    height: TRACK_HEIGHT * 3,
    width: 1,
    backgroundColor: 'rgba(200,133,26,0.55)',
    transform: [{ rotate: '35deg' }],
  },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  emptyText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: AXIS_TEXT,
  },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  axisText: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: AXIS_TEXT,
  },
  legend: {
    marginTop: 6,
    gap: 3,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendSwatch: {
    width: 14,
    height: 10,
    borderRadius: 3,
    borderWidth: 1.5,
  },
  legendText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    color: color.onInkMute,
  },
  legendTime: {
    fontWeight: '400',
    color: AXIS_TEXT,
  },
});

export default CityTimeline;
