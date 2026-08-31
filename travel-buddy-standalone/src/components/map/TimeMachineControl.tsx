/**
 * TimeMachineControl — Map spec §15's Time Machine control.
 *
 *     "Primary control: NOW, +30m, +60m, +120m."
 *     "Later controls: Yesterday, Tonight, Tomorrow, Last Friday."
 *     "It should support historical observation and future prediction, with
 *      unmistakably different visual treatment."
 *
 * Layout: a floating dark card (§4 dark-mode-first). The primary row is the
 * four instants; the named controls sit under it as a quieter secondary row. A
 * status strip under both states, in words, which of the three temporal modes
 * the map is currently showing — and when that mode is `forecast`, it states
 * the forecast confidence, because §15's definition of a forecast is
 * "predicted AND must carry forecast confidence".
 *
 * WHY THE FORECAST STATE LOOKS THE WAY IT DOES
 * ============================================
 * §37: "Do not make predictions look like observations." A tint would not do
 * it. The forecast state changes FIVE things at once:
 *
 *   1. the card gains an amber dashed border (the §6 "predicted state" edge),
 *   2. the whole card's ground shifts to a warm dark instead of neutral,
 *   3. the selected chip is dashed rather than filled,
 *   4. an explicit "Forecast · <confidence>" label appears, and
 *   5. a second line says, in plain words, that nothing has been observed.
 *
 * The historical state is equally distinct in the other direction: a
 * desaturated ground, a solid left rule, a History glyph, and a label that says
 * what was OBSERVED and when. Neither can be mistaken for the live state, which
 * is the only one that gets the vermilion live dot.
 *
 * No API calls, no clock of its own beyond the `now` it is handed.
 *
 * @see src/features/map/time/timeMachine.ts
 */
import React, { useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Clock, History, Radio, TrendingUp } from 'lucide-react-native';

import { color, radius, space, dot } from '../../theme/tokens.ts';
import type { ConfidenceState } from '../../types/mapObjects.ts';
import {
  PRIMARY_OFFSETS,
  SECONDARY_OFFSETS,
  offsetKey,
  offsetLabel,
  offsetsEqual,
  resolveOffset,
  forecastBadgeLabel,
  formatClock,
  type CityTimeline as CityTimelineData,
  type TemporalMode,
  type TimeOffset,
} from '../../features/map/time/timeMachine.ts';
import { CityTimeline } from './CityTimeline.tsx';

// ── Per-mode treatment (§15: "unmistakably different") ────────────────────────

interface ModeSkin {
  cardBg: string;
  cardBorder: string;
  borderStyle: 'solid' | 'dashed';
  borderWidth: number;
  accent: string;
  chipSelectedBg: string;
  chipSelectedBorderStyle: 'solid' | 'dashed';
  chipSelectedText: string;
}

const SKIN: Record<TemporalMode, ModeSkin> = {
  now: {
    cardBg: 'rgba(17,17,15,0.92)',
    cardBorder: 'rgba(250,249,246,0.14)',
    borderStyle: 'solid',
    borderWidth: StyleSheet.hairlineWidth,
    accent: color.signal,
    chipSelectedBg: color.signal,
    chipSelectedBorderStyle: 'solid',
    chipSelectedText: color.onInk,
  },
  forecast: {
    // Warm ground + dashed edge — the §6 "predicted state / forecast zone" language.
    cardBg: 'rgba(38,28,10,0.94)',
    cardBorder: color.warn,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    accent: color.warn,
    chipSelectedBg: 'rgba(200,133,26,0.20)',
    chipSelectedBorderStyle: 'dashed',
    chipSelectedText: '#F0C572',
  },
  historical: {
    // Desaturated, receded — reads as past, not as present.
    cardBg: 'rgba(20,22,24,0.94)',
    cardBorder: 'rgba(250,249,246,0.22)',
    borderStyle: 'solid',
    borderWidth: 1.5,
    accent: '#9BB4BD',
    chipSelectedBg: 'rgba(155,180,189,0.18)',
    chipSelectedBorderStyle: 'solid',
    chipSelectedText: '#CFE0E6',
  },
};

const CHIP_IDLE_BG = 'rgba(250,249,246,0.07)';
const CHIP_IDLE_BORDER = 'rgba(250,249,246,0.12)';

export interface TimeMachineControlProps {
  /** The control's current position. */
  offset: TimeOffset;
  /** Called with the newly selected offset. The parent owns the state. */
  onChange: (offset: TimeOffset) => void;
  /**
   * Forecast confidence for the currently-shown projection. §15 requires a
   * forecast to carry one; when it is missing the control says so rather than
   * implying certainty.
   */
  forecastConfidence?: ConfidenceState | null;
  /** Optional §15 city timeline, rendered under the controls when present. */
  timeline?: CityTimelineData | null;
  /** Injected clock — keeps the component pure and testable. */
  now?: Date;
  /** IANA zone the labels are computed in. Omit for device-local. */
  tz?: string;
  /** Extra bottom inset (safe area / bottom sheet peek). */
  bottomInset?: number;
  style?: StyleProp<ViewStyle>;
  /** Set false to hide the Yesterday/Tonight/Tomorrow/Last Friday row. */
  showNamedControls?: boolean;
}

export function TimeMachineControl({
  offset,
  onChange,
  forecastConfidence,
  timeline,
  now,
  tz,
  bottomInset = 0,
  style,
  showNamedControls = true,
}: TimeMachineControlProps) {
  const resolved = useMemo(() => resolveOffset(offset, now ?? new Date(), tz), [offset, now, tz]);
  const mode = resolved.mode;
  const skin = SKIN[mode];

  return (
    <View
      style={[
        s.card,
        {
          backgroundColor: skin.cardBg,
          borderColor: skin.cardBorder,
          borderStyle: skin.borderStyle,
          borderWidth: skin.borderWidth,
          marginBottom: bottomInset,
        },
        style,
      ]}
      accessibilityLabel="Time Machine"
    >
      {/* ── Primary row: NOW · +30m · +60m · +120m ── */}
      <View style={s.primaryRow}>
        {PRIMARY_OFFSETS.map((o) => (
          <OffsetChip
            key={offsetKey(o)}
            offset={o}
            selected={offsetsEqual(o, offset)}
            skin={skin}
            onPress={onChange}
            emphasis="primary"
          />
        ))}
      </View>

      {/* ── Secondary row: the §15 later controls ── */}
      {showNamedControls && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.secondaryRow}
          keyboardShouldPersistTaps="handled"
        >
          {SECONDARY_OFFSETS.map((o) => (
            <OffsetChip
              key={offsetKey(o)}
              offset={o}
              selected={offsetsEqual(o, offset)}
              skin={skin}
              onPress={onChange}
              emphasis="secondary"
            />
          ))}
        </ScrollView>
      )}

      {/* ── Status strip: which of the three modes is on screen, in words ── */}
      <StatusStrip
        mode={mode}
        skin={skin}
        atLabel={formatClock(resolved.at, tz)}
        offsetTitle={resolved.label}
        forecastConfidence={forecastConfidence ?? undefined}
      />

      {timeline && <CityTimeline timeline={timeline} tz={tz} style={s.timeline} />}
    </View>
  );
}

// ── Chip ──────────────────────────────────────────────────────────────────────

function OffsetChip({
  offset,
  selected,
  skin,
  onPress,
  emphasis,
}: {
  offset: TimeOffset;
  selected: boolean;
  skin: ModeSkin;
  onPress: (o: TimeOffset) => void;
  emphasis: 'primary' | 'secondary';
}) {
  const label = offsetLabel(offset);
  return (
    <Pressable
      onPress={() => onPress(offset)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Show ${label}`}
      style={({ pressed }) => [
        emphasis === 'primary' ? s.chip : s.chipSmall,
        {
          backgroundColor: selected ? skin.chipSelectedBg : CHIP_IDLE_BG,
          borderColor: selected ? skin.accent : CHIP_IDLE_BORDER,
          borderStyle: selected ? skin.chipSelectedBorderStyle : 'solid',
          opacity: pressed ? 0.72 : 1,
        },
      ]}
    >
      <Text
        style={[
          emphasis === 'primary' ? s.chipText : s.chipTextSmall,
          { color: selected ? skin.chipSelectedText : color.onInkMute },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Status strip ──────────────────────────────────────────────────────────────

function StatusStrip({
  mode,
  skin,
  atLabel,
  offsetTitle,
  forecastConfidence,
}: {
  mode: TemporalMode;
  skin: ModeSkin;
  atLabel: string;
  offsetTitle: string;
  forecastConfidence?: ConfidenceState;
}) {
  if (mode === 'now') {
    return (
      <View style={[s.status, { borderLeftColor: skin.accent }]}>
        <Radio size={13} color={skin.accent} />
        <View style={s.statusTextWrap}>
          <Text style={[s.statusTitle, { color: color.onInk }]} numberOfLines={1}>
            Live · observed now
          </Text>
        </View>
        <View style={[s.liveDot, { backgroundColor: skin.accent }]} />
      </View>
    );
  }

  if (mode === 'historical') {
    return (
      <View style={[s.status, s.statusHistorical, { borderLeftColor: skin.accent }]}>
        <History size={13} color={skin.accent} />
        <View style={s.statusTextWrap}>
          <Text style={[s.statusTitle, { color: skin.chipSelectedText }]} numberOfLines={1}>
            {`Historical · ${offsetTitle}`}
          </Text>
          <Text style={s.statusSub} numberOfLines={1}>
            {`Observed ${atLabel} — not the current state`}
          </Text>
        </View>
        <Clock size={13} color={color.faint} />
      </View>
    );
  }

  // Forecast. §15: a forecast MUST carry forecast confidence, so the label
  // states it — and when the projection failed to supply one, the control says
  // that outright instead of quietly rendering a bare "Forecast".
  return (
    <View
      style={[
        s.status,
        s.statusForecast,
        { borderLeftColor: skin.accent, borderColor: skin.accent },
      ]}
    >
      <TrendingUp size={13} color={skin.accent} />
      <View style={s.statusTextWrap}>
        <Text style={[s.statusTitle, { color: skin.chipSelectedText }]} numberOfLines={1}>
          {forecastConfidence
            ? forecastBadgeLabel(forecastConfidence)
            : 'Forecast · confidence unavailable'}
        </Text>
        <Text style={s.statusSub} numberOfLines={1}>
          {`Predicted for ${atLabel} — not observed`}
        </Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: space.sm,
    gap: space.sm,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  primaryRow: {
    flexDirection: 'row',
    gap: 6,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 6,
    paddingRight: 2,
  },
  chip: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1.5,
    paddingHorizontal: 6,
  },
  chipSmall: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1.5,
    paddingHorizontal: 12,
  },
  chipText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  chipTextSmall: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingVertical: 7,
    paddingHorizontal: 9,
    backgroundColor: 'rgba(250,249,246,0.05)',
  },
  statusForecast: {
    borderWidth: 1,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(200,133,26,0.10)',
  },
  statusHistorical: {
    backgroundColor: 'rgba(155,180,189,0.09)',
  },
  statusTextWrap: {
    flex: 1,
    gap: 1,
  },
  statusTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  statusSub: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
    color: color.onInkMute,
  },
  liveDot: {
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
  },
  timeline: {
    marginTop: 2,
  },
});

export default TimeMachineControl;
