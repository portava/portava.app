/**
 * DiscoveryCandidateChips — renders the server-built DiscoveryCandidate on a
 * Discovery card. census-discovery DSV2-04 and DC-22.
 *
 * WHAT IT SHOWS, AND WHY EACH PART IS THERE
 * =========================================
 *   truth-class chip   DSV2-04 / Sensing §5.1: "prediction must never be
 *                      rendered indistinguishably from observation." Every
 *                      class gets its own label AND its own testID suffix
 *                      (`candidate-truth-observation` / `-prediction` /
 *                      `-conflict` / `-unknown`), so the distinction is a
 *                      structural property of the tree a test can hold, not a
 *                      colour a redesign can drop.
 *   why-now line       The grounded live claims, in the claims' own vocabulary.
 *                      When the serve says the reading is stale, or the claims'
 *                      validity runs out on THIS DEVICE's clock while the card
 *                      is on screen or in the device cache, the line says "no
 *                      longer current" in words — DSV2-04's "disappear or become
 *                      explicitly stale", taking the second branch, because
 *                      silently dropping a claim hides that anything was ever
 *                      observed. A claim that carries no validity at all is not
 *                      shown (the first branch): nothing says it is current.
 *                      The component re-renders itself AT the expiry instant, so
 *                      a card left open does not go on asserting a claim past it.
 *   reason labels      DC-22: `11` §5 lists reason labels among the five
 *                      Recommendation API outputs. The server produces the
 *                      plain-language text (`lib/discoveryReasonCodes.ts`); this
 *                      renders it verbatim and composes nothing.
 *
 * RENDERS NOTHING AT ALL when the projection is absent or unparseable — which
 * is the normal case, since `discovery_candidate_projection_enabled` is seeded
 * FALSE. The component is additive by construction: no projection, no tree.
 *
 * No hardcoded circular sizes: the chips are text-only, so there is nothing in
 * the avatar/icon sizing bands to get wrong.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  parseDiscoveryCandidate,
  whyNowPresentation,
  TRUTH_CLASS_PRESENTATION,
} from '../../features/discovery/candidateProjection.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** setTimeout's ceiling (~24.8 days); a longer wait is re-armed rather than overflowing to 0. */
const MAX_TIMER_MS = 2_147_483_647;

export function DiscoveryCandidateChips({ candidate }: { candidate?: unknown }) {
  const parsed = parseDiscoveryCandidate(candidate);
  // The why-now line is judged at the device clock AT RENDER, never at mount: a
  // card that re-renders with a page painted from the device cache must not
  // judge that page's claims at the moment the card first appeared. `nowMs` is
  // the tick the timer below advances at the expiry instant, so the line flips
  // even when nothing else re-renders the card.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const whyNow = whyNowPresentation(parsed, Math.max(nowMs, Date.now()));
  const expiresAtMs = whyNow.expiresAtMs;

  useEffect(() => {
    if (expiresAtMs === null) return undefined;
    // Re-armed on every tick (`nowMs` is a dependency): a wait capped at the
    // timer ceiling, or a timer that fires a hair early, just schedules again.
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, expiresAtMs - Date.now()));
    const timer = setTimeout(() => setNowMs((prev) => Math.max(Date.now(), prev + 1)), wait);
    return () => clearTimeout(timer);
  }, [expiresAtMs, nowMs]);

  if (!parsed) return null;

  const presentation = TRUTH_CLASS_PRESENTATION[parsed.truthClass];

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Text
          testID="candidate-truth-class"
          accessibilityLabel={presentation.accessibilityLabel}
          style={[s.chip, presentation.kind === 'prediction' ? s.chipPrediction : s.chipObservation]}
        >
          {presentation.label}
        </Text>
        {/*
          The family marker. A separate, empty node rather than a prop on the
          chip so the observed/predicted distinction survives in the rendered
          tree even if the chip's own styling is later changed.
        */}
        <View testID={`candidate-truth-${presentation.kind}`} />
      </View>

      {whyNow.claims.length > 0 ? (
        <View testID="candidate-why-now" style={s.row}>
          {whyNow.stale ? (
            <Text testID="candidate-why-now-stale" style={s.staleMark}>
              No longer current —
            </Text>
          ) : null}
          <Text style={whyNow.stale ? s.whyNowStale : s.whyNow}>
            {whyNow.claims.join(' · ')}
          </Text>
        </View>
      ) : null}

      {parsed.reasons.length > 0 ? (
        <View testID="candidate-reasons" style={s.reasons}>
          {parsed.reasons.map((r) => (
            <Text key={r.code} style={s.reasonText}>{r.text}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap:    { gap: space.xs, marginTop: space.xs },
  row:     { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  chip: {
    ...t.stamp,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  chipObservation: { backgroundColor: color.haze,  color: color.mute },
  chipPrediction:  { backgroundColor: '#FDF3E0',   color: color.warn },
  whyNow:      { ...t.small, color: color.mute },
  whyNowStale: { ...t.small, color: color.faint },
  staleMark:   { ...t.stamp, color: color.warn },
  reasons:     { gap: 2 },
  reasonText:  { ...t.small, color: color.faint },
});
