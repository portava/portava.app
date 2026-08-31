/**
 * ConfidenceIndicator — the §7 certainty band, as a compact indicator.
 *
 * The certainty axis kept visually separate from activity, trend and freshness
 * (§7), and the thing the §9 Why? panel resolves to ("Confidence: Strong").
 *
 * WHY UNVERIFIED IS NOT ONE BAR OF FOUR
 * =====================================
 * A four-segment meter tells the reader that every state is the same KIND of
 * claim at a different strength — that `unverified` is a weak `confirmed`. It
 * isn't. `Confirmed`, `Strong signal`, `Reports indicate` and `Limited data`
 * all say Portava has evidence; `Unconfirmed` says Portava does not know.
 *
 * So `unverified` renders as a different object entirely: a dashed hollow chip
 * with a question glyph and no segments at all. There is no filled bar to
 * compare against the others, because there is nothing to compare.
 *
 * Dark-mode first (§4).
 */
import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { CircleQuestionMark } from 'lucide-react-native';
import { color, dot, radius, typography } from '../../theme/tokens.ts';
import { confidenceLabel } from '../../features/map/truth/liveTruth.ts';
import type { ConfidenceState } from '../../types/mapObjects.ts';

/**
 * Per-band colour. Shared with the Why? panel so one band can never read as
 * two different strengths on two surfaces.
 */
export const CONFIDENCE_COLORS: Record<ConfidenceState, string> = {
  strong: '#3DD68C',
  live: '#7FD8B0',
  likely_current: '#D9A441',
  provisional: '#A9A49A',
  unverified: '#8C8880',
};

/**
 * How many of the four segments a band fills. `unverified` is absent on
 * purpose: it does not take a place on this scale.
 */
const FILLED_SEGMENTS: Record<Exclude<ConfidenceState, 'unverified'>, number> = {
  strong: 4,
  live: 3,
  likely_current: 2,
  provisional: 1,
};

const SEGMENT_COUNT = 4;

const TRACK = 'rgba(250,249,246,0.16)';
const HAIRLINE = 'rgba(250,249,246,0.18)';

export interface ConfidenceIndicatorProps {
  /** The band from the projection. Absent reads as `unverified` — fail-closed. */
  confidence?: ConfidenceState | null;
  /** Show the §7 wording next to the meter. Default true. */
  showLabel?: boolean;
  /** Prefix the label with "Confidence: " (the §9 panel's phrasing). */
  prefixLabel?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ConfidenceIndicator({
  confidence,
  showLabel = true,
  prefixLabel = false,
  style,
}: ConfidenceIndicatorProps) {
  const band: ConfidenceState = confidence ?? 'unverified';
  const label = confidenceLabel(band);
  const text = prefixLabel ? `Confidence: ${label}` : label;
  const tint = CONFIDENCE_COLORS[band];

  if (band === 'unverified') {
    return (
      <View
        style={[s.row, s.unknownChip, style]}
        accessibilityRole="text"
        accessibilityLabel={`Confidence: ${label}. Portava has no confirmed evidence for this.`}
      >
        <CircleQuestionMark size={dot.s12} color={tint} />
        {showLabel && <Text style={[s.label, { color: color.onInkMute }]}>{text}</Text>}
      </View>
    );
  }

  const filled = FILLED_SEGMENTS[band];

  return (
    <View
      style={[s.row, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={`Confidence: ${label}`}
      accessibilityValue={{ min: 1, max: SEGMENT_COUNT, now: filled, text: label }}
    >
      <View style={s.meter}>
        {Array.from({ length: SEGMENT_COUNT }, (_, i) => (
          <View
            key={i}
            style={[
              s.segment,
              i < filled ? { backgroundColor: tint } : s.segmentEmpty,
            ]}
          />
        ))}
      </View>
      {showLabel && <Text style={[s.label, { color: color.onInk }]}>{text}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
  },
  meter: {
    flexDirection: 'row',
    gap: 3,
    alignItems: 'center',
  },
  segment: {
    width: 9,
    height: 4,
    borderRadius: 2,
  },
  segmentEmpty: {
    backgroundColor: TRACK,
  },
  // Deliberately a different silhouette from the meter above.
  unknownChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: HAIRLINE,
    backgroundColor: 'rgba(17,17,15,0.46)',
  },
  label: {
    ...typography.metadata,
    color: color.onInk,
  },
});
