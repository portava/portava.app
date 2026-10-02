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
 *     a fresh, UNDISPUTED place shows nothing (a §18 dispute: see the tail).
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
  viewRequestOutcomeLine,
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

export function RequestAViewPrompt({ placeId, city = null, coverageScore = null, requestAnotherObservation = false, onTakePhoto, onAnswerNow, tone = 'paper' }: RequestAViewPromptProps & RequestAViewMissionProps) {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(REQUEST_A_VIEW_FLAG);
  // §19 mission half, "Is the entrance still busy? [Quiet] [Moderate] [Busy]":
  // answering is an Intelligence Gathering capture, so it keeps THAT surface's
  // gates — its own flag, and never during Safe Return — the same two the Living
  // page's "Share a signal" entry uses. The Safe Return read is inert (no
  // network call) unless everything else would already show the chip.
  const captureGate = enabled && Boolean(onAnswerNow) && isEnabled(INTEL_FLAGS.quickSignal);
  const safeReturn = useSafeReturnActive(captureGate);
  const canAnswer = captureGate && !safeReturn.active && !safeReturn.loading;

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

  // ── Dormant by default: hidden when the flag is off, or the place is fresh
  //    and nothing on it is in dispute (§18 routes a dispute here) ──
  if (!shouldShowMissionPrompt(coverage, enabled, requestAnotherObservation)) return null;

  const cov = coverage as VisualCoverage;
  const freshnessLine = cov.noCoverage || !cov.lastUpdateLabel
    ? 'No recent visual update'
    : `Last visual update ${cov.lastUpdateLabel}`;
  const st = tone === 'ink' ? ink : s;
  const showMission = Boolean(onTakePhoto) || canAnswer;

  return (
    <View style={st.card} accessibilityRole="summary" testID="request-a-view-prompt">
      <View style={s.headerRow}>
        <Eye size={16} color={tone === 'ink' ? color.onInkMute : color.deep} strokeWidth={2.2} />
        <Text style={st.freshness} numberOfLines={1}>{freshnessLine}</Text>
      </View>

      {showMission ? (
        // §19's mission: the viewer who is THERE shows what is happening.
        <>
          <Text style={st.prompt}>Show what’s happening?</Text>
          <View style={s.chipRow}>
            {onTakePhoto ? (
              <MissionChip label="Take a photo" testID="mission-take-photo" onPress={onTakePhoto} tone={tone} />
            ) : null}
            {canAnswer && onAnswerNow ? (
              <MissionChip label="Say how busy it is" testID="mission-answer-now" onPress={onAnswerNow} tone={tone} />
            ) : null}
          </View>
        </>
      ) : null}

      {send.kind === 'done' ? (
        <ResultLine outcome={send.outcome} tone={tone} />
      ) : (
        <>
          <Text style={st.prompt}>
            {showMission
              ? 'Not there? Ask nearby contributors for a fresh view.'
              : 'Want a current perspective? Ask nearby contributors for a fresh view.'}
          </Text>
          <View style={s.chipRow}>
            {QUESTION_PRESETS.map((p) => (
              <Pressable
                key={p.key}
                style={({ pressed }) => [st.chip, pressed && s.chipPressed]}
                onPress={() => onAsk(p)}
                disabled={send.kind === 'sending'}
                accessibilityRole="button"
                accessibilityLabel={p.label}
              >
                <Text style={st.chipText}>{p.label}</Text>
              </Pressable>
            ))}
            {send.kind === 'sending' ? (
              <ActivityIndicator size="small" color={tone === 'ink' ? color.onInk : color.deep} style={s.spinner} />
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * A single calm line for the request outcome — success OR a refusal reason.
 * The wording decision itself lives in the PURE `viewRequestOutcomeLine`, so the
 * "a zero that was never counted is not a zero" rule is unit-tested rather than
 * buried in a render.
 */
function ResultLine({ outcome, tone = 'paper' }: { outcome: ViewRequestOutcome; tone?: PromptTone }) {
  const line = viewRequestOutcomeLine(outcome);
  const st = tone === 'ink' ? ink : s;
  // Calm refusal — a single line, never an error toast storm.
  return <Text style={outcome.ok ? st.resultOk : st.resultMuted}>{line}</Text>;
}

/** One §19 mission action: a user-initiated step, never an automatic write. */
function MissionChip({ label, testID, onPress, tone }: { label: string; testID: string; onPress: () => void; tone: PromptTone }) {
  const st = tone === 'ink' ? ink : s;
  return (
    <Pressable
      style={({ pressed }) => [st.chip, pressed && s.chipPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={st.chipText}>{label}</Text>
    </Pressable>
  );
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

/** The same card on the Media World shell's dark surface (`tone="ink"`). */
const ink = StyleSheet.create({
  card: {
    backgroundColor: color.ink,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.onInkMute,
    padding: space.md,
    gap: space.sm,
  },
  freshness: { ...t.small, color: color.onInkMute, flexShrink: 1 },
  prompt: { ...t.bodyStrong, color: color.onInk },
  chip: {
    backgroundColor: color.ink,
    borderWidth: 1,
    borderColor: color.onInk,
    borderRadius: radius.pill,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  chipText: { ...t.small, color: color.onInk, fontWeight: '700' },
  // `success` green measures 3.78:1 on `ink` (census-media §28.6); the words carry the outcome.
  resultOk: { ...t.small, color: color.onInk },
  resultMuted: { ...t.small, color: color.onInkMute },
});

// ── §19 mission half and §18 routing (census-media §26, MD153) ───────────────
//
// Declared BELOW the component so the line census-media cites
// (`export function RequestAViewPrompt(`) stays where it is: TypeScript
// resolves types regardless of order, and ESM hoists the imports.

type PromptTone = 'paper' | 'ink';

/**
 * What a HOST may add to the prompt. Every field is optional, so the existing
 * mount on the place detail screen (app/place/[id].tsx) renders exactly as it
 * did: the Request-a-View half only.
 */
export interface RequestAViewMissionProps {
  /**
   * §18 "optionally request another observation": the server's consensus says a
   * fresh observation would settle a MATERIAL dispute here. Shows the prompt
   * even when coverage is fresh — the dispute, not the age, is the gap. Still
   * flag-gated, and still hidden when coverage could not be read.
   */
  requestAnotherObservation?: boolean;
  /** §19 [Take Photo]: the host's existing contribution flow for this place. */
  onTakePhoto?: () => void;
  /**
   * §19 [Quiet] [Moderate] [Busy]: the host opens the existing Quick Signal
   * composer for this place. Shown only while `intel_capture_quick_signal` is
   * on and no Safe Return session is active; the composer keeps its own
   * consent gate and private-by-default visibility.
   */
  onAnswerNow?: () => void;
  /** 'ink' on the Media World shell's dark surface; 'paper' (default) elsewhere. */
  tone?: PromptTone;
}

/**
 * PURE: should the §19 prompt render? The flag must be on and coverage must
 * have been READ — an unread coverage is never a reason to prompt. Then either
 * the place's visual coverage is stale or absent (the §19 gap), or the
 * server's §18 consensus asked for another observation.
 */
export function shouldShowMissionPrompt(
  coverage: VisualCoverage | null,
  flagEnabled: boolean,
  requestAnotherObservation: boolean,
): boolean {
  if (shouldShowRequestPrompt(coverage, flagEnabled)) return true;
  return flagEnabled && coverage !== null && requestAnotherObservation === true;
}

import { useSafeReturnActive } from '../../../hooks/useSafeReturnActive.ts';
import { INTEL_FLAGS } from '../../../lib/intel/contracts.ts';
