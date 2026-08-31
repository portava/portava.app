/**
 * RequestAViewPrompt — Media v2 Phase 10 (§19) Request-a-View affordance.
 *
 * On a place whose visual coverage is STALE ("Last visual update 28m ago"), a
 * calm "Show what's happening?" affordance that asks opted-in contributors for a
 * current perspective (POST /api/v1/media/view-requests).
 *
 * FLAG-GATED + DORMANT BY DEFAULT (§19 hard constraint):
 *   - reads `media_request_a_view_enabled` client-side; when off/unknown the
 *     component renders NOTHING (fail-soft to hidden), so existing place screens
 *     are visually untouched until the capability is enabled.
 *   - even when on, it only appears for a real coverage GAP (stale / no coverage);
 *     a fresh place shows nothing.
 *
 * DEGRADE (§33/§46): coverage 404 / empty / error ⇒ hidden, never throws. Backend
 * refusals (rate_limited / protected_location / disabled / duplicate) render a
 * single calm inline line — never an error toast storm. No fake-live: the "Nm ago"
 * label comes only from the server. No precise-location UI.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Eye } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import {
  fetchVisualCoverage,
  requestView,
  shouldShowRequestPrompt,
} from '../services/viewRequest.ts';
import type { VisualCoverage, ViewRequestOutcome } from '../types/viewRequest.ts';

export const REQUEST_A_VIEW_FLAG = 'media_request_a_view_enabled';

/** A calm question the requester can send. `label` is the chip, `question` the payload. */
interface QuestionPreset {
  key: string;
  label: string;
  question: string;
  claimFamily: string;
}

// The §19 example ("Is the entrance still busy?") plus one general prompt. Each
// maps to a real claim family the intel layer already understands.
const QUESTION_PRESETS: QuestionPreset[] = [
  { key: 'now', label: 'Show what’s happening', question: 'Show me what’s happening here right now', claimFamily: 'crowd.level' },
  { key: 'busy', label: 'Is it busy?', question: 'Is the entrance still busy?', claimFamily: 'crowd.level' },
];

export interface RequestAViewPromptProps {
  /** Canonical places.id (a UUID). Required. */
  placeId: string;
  city?: string | null;
  /** Optional coverage-gap score (0..1) that motivated surfacing this. */
  coverageScore?: number | null;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; outcome: ViewRequestOutcome };

export function RequestAViewPrompt({ placeId, city = null, coverageScore = null }: RequestAViewPromptProps) {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(REQUEST_A_VIEW_FLAG);

  const [coverage, setCoverage] = useState<VisualCoverage | null>(null);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load coverage only when the flag is on and we have a place. Fail-soft: any
  // error leaves coverage null ⇒ the component stays hidden.
  useEffect(() => {
    if (!enabled || !placeId) {
      setCoverage(null);
      return;
    }
    const controller = new AbortController();
    void fetchVisualCoverage(placeId, { city, signal: controller.signal }).then((res) => {
      if (controller.signal.aborted || !mounted.current) return;
      setCoverage(res.ok ? res.data : null);
    });
    return () => controller.abort();
  }, [enabled, placeId, city]);

  const onAsk = useCallback(
    (preset: QuestionPreset) => {
      setSend({ kind: 'sending' });
      void requestView({
        placeId,
        question: preset.question,
        claimFamily: preset.claimFamily,
        city,
        coverageScore,
      }).then((outcome) => {
        if (!mounted.current) return;
        setSend({ kind: 'done', outcome });
      });
    },
    [placeId, city, coverageScore],
  );

  // ── Dormant by default: hidden when the flag is off, or the place is fresh ──
  if (!shouldShowRequestPrompt(coverage, enabled)) return null;

  const cov = coverage as VisualCoverage;
  const freshnessLine = cov.noCoverage || !cov.lastUpdateLabel
    ? 'No recent visual update'
    : `Last visual update ${cov.lastUpdateLabel}`;

  return (
    <View style={s.card} accessibilityRole="summary">
      <View style={s.headerRow}>
        <Eye size={16} color={color.deep} strokeWidth={2.2} />
        <Text style={s.freshness} numberOfLines={1}>{freshnessLine}</Text>
      </View>

      {send.kind === 'done' ? (
        <ResultLine outcome={send.outcome} />
      ) : (
        <>
          <Text style={s.prompt}>Want a current perspective? Ask nearby contributors for a fresh view.</Text>
          <View style={s.chipRow}>
            {QUESTION_PRESETS.map((p) => (
              <Pressable
                key={p.key}
                style={({ pressed }) => [s.chip, pressed && s.chipPressed]}
                onPress={() => onAsk(p)}
                disabled={send.kind === 'sending'}
                accessibilityRole="button"
                accessibilityLabel={p.label}
              >
                <Text style={s.chipText}>{p.label}</Text>
              </Pressable>
            ))}
            {send.kind === 'sending' ? (
              <ActivityIndicator size="small" color={color.deep} style={s.spinner} />
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

/** A single calm line for the request outcome — success OR a refusal reason. */
function ResultLine({ outcome }: { outcome: ViewRequestOutcome }) {
  if (outcome.ok) {
    const line =
      outcome.recipientCount > 0
        ? 'Asked nearby contributors — fresh perspectives will appear here as they arrive.'
        : 'Noted. No contributors are nearby yet — we’ll ask as soon as someone can help.';
    return <Text style={s.resultOk}>{line}</Text>;
  }
  // Calm refusal — a single line, never an error toast storm.
  return <Text style={s.resultMuted}>{outcome.message}</Text>;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    marginBottom: space.md,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  freshness: { ...t.small, color: color.mute, flexShrink: 1 },
  prompt: { ...t.bodyStrong, color: color.ink },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  chip: {
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.deep,
    borderRadius: radius.pill,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  chipPressed: { opacity: 0.7 },
  chipText: { ...t.small, color: color.deep, fontWeight: '700' },
  spinner: { marginLeft: space.xs },
  resultOk: { ...t.small, color: color.success },
  resultMuted: { ...t.small, color: color.mute },
});
