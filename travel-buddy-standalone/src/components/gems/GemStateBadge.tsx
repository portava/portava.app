/**
 * GemStateBadge — the §16 / §46.1 Hidden Gem Intelligence visual language.
 *
 * Renders the ten-state gem status as a calm, PROTECTIVE pill (a discovery /
 * geometric marker + a human label + a subtle edge glow) plus an optional calm
 * confidence indicator and, for detail views, the protective one-line note.
 *
 * §16.2 / §46.1 hard rules honoured here:
 *   • No popularity-first / viral / trending / hot / vanity-counter language —
 *     every string comes from gemStateDisplay.ts, which is hype-free by test.
 *   • overcrowding_risk (and the other fragile / discovery-pressure states) get
 *     a protective treatment, never an enticement.
 *
 * Degrade: when `state` is absent / unrecognised AND there is no usable
 * confidence, the component renders `null` — the card looks exactly as it did
 * before Phase 8 (older payloads never break).
 *
 * All three gem surfaces (list card, detail, media overlay) sit on dark
 * backgrounds, so this component carries its own calm dark-surface palette.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  gemStateTreatment,
  gemConfidenceIndicator,
  type GemState,
  type GemConfidence,
  type GemTone,
  type GemConfidenceTone,
} from '../../lib/gems/gemStateDisplay.ts';

// ── Calm, protective tone → colour (dark-surface palette) ─────────────────────
// Intentionally muted. `protective` reads as care (warm), never alarm; `aware`
// is a gentle heads-up, never excitement.

const TONE_COLORS: Record<GemTone, { fg: string; bg: string; border: string }> = {
  confirmed:  { fg: '#6FD39A', bg: 'rgba(46,125,91,0.20)',  border: 'rgba(111,211,154,0.40)' },
  hidden:     { fg: '#7FD4E0', bg: 'rgba(10,61,74,0.42)',   border: 'rgba(127,212,224,0.38)' },
  calm:       { fg: '#9DB8E8', bg: 'rgba(76,139,245,0.16)', border: 'rgba(157,184,232,0.34)' },
  aware:      { fg: '#E0B36A', bg: 'rgba(200,133,26,0.16)', border: 'rgba(224,179,106,0.36)' },
  caution:    { fg: '#E8B24D', bg: 'rgba(200,133,26,0.20)', border: 'rgba(232,178,77,0.40)' },
  protective: { fg: '#F0A98C', bg: 'rgba(230,120,80,0.18)', border: 'rgba(240,169,140,0.42)' },
};

const CONFIDENCE_COLORS: Record<GemConfidenceTone, string> = {
  strong:   '#6FD39A',
  good:     '#9DB8E8',
  emerging: '#C9B382',
  faint:    '#8A9BB5',
};

export interface GemStateBadgeProps {
  state: GemState | string | null | undefined;
  confidence?: GemConfidence | null;
  /** Show the calm confidence indicator next to the state pill. */
  showConfidence?: boolean;
  /** Show the protective one-line note beneath the pill (detail view). */
  showNote?: boolean;
  /** 'compact' for list cards, 'full' for the detail header. */
  size?: 'compact' | 'full';
  style?: any;
  testID?: string;
}

export function GemStateBadge({
  state,
  confidence,
  showConfidence = false,
  showNote = false,
  size = 'compact',
  style,
  testID,
}: GemStateBadgeProps) {
  const treatment = gemStateTreatment(state);
  const confInd = showConfidence ? gemConfidenceIndicator(confidence) : null;

  // Degrade: nothing meaningful to show → render as today (nothing).
  if (!treatment && !confInd) return null;

  const full = size === 'full';
  const iconSize = full ? 15 : 13;

  return (
    <View style={[styles.wrap, style]} testID={testID}>
      <View style={styles.row}>
        {treatment && (() => {
          const c = TONE_COLORS[treatment.tone];
          return (
            <View
              style={[
                styles.pill,
                full && styles.pillFull,
                { backgroundColor: c.bg, borderColor: c.border },
              ]}
              accessibilityLabel={`Gem status: ${treatment.label}`}
            >
              <Ionicons name={treatment.icon as any} size={iconSize} color={c.fg} />
              <Text style={[styles.pillText, full && styles.pillTextFull, { color: c.fg }]}>
                {treatment.label}
              </Text>
            </View>
          );
        })()}

        {confInd && (
          <View style={styles.confRow} accessibilityLabel={`Confidence: ${confInd.label}`}>
            <Ionicons
              name="pulse-outline"
              size={full ? 13 : 11}
              color={CONFIDENCE_COLORS[confInd.tone]}
            />
            <Text style={[styles.confText, { color: CONFIDENCE_COLORS[confInd.tone] }]}>
              {confInd.label}
            </Text>
          </View>
        )}
      </View>

      {showNote && treatment?.note ? (
        <Text style={[styles.note, treatment.protective && styles.noteProtective]}>
          {treatment.note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillFull: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  pillTextFull: {
    fontSize: 13,
  },
  confRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  confText: {
    fontSize: 12,
    fontWeight: '600',
  },
  note: {
    fontSize: 12,
    lineHeight: 17,
    color: '#B0C4DE',
  },
  noteProtective: {
    color: '#F0A98C',
  },
});
