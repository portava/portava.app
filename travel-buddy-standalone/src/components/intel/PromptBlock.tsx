/**
 * PromptBlock — one §6 question rendered as prompt copy + a one-tap option row,
 * wired to the capture service.
 *
 * Owns the submit lifecycle for its single question: it mints one idempotency
 * key per chosen option (so a retry of the SAME option can't double-write, while
 * changing the answer is a new write the server supersedes), shows a spinner on
 * the pill in flight, a check when it lands, and an inline retry on error.
 *
 * Non-Phase-1 questions (`question.phase1 === false`, e.g. the exit set) are
 * presented but their options are inert here and marked "planned" — those feed
 * the Trail follow-up path (`intel_trail_followup`) once that lands.
 */
import React, { useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Check, AlertCircle } from 'lucide-react-native';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { OptionPills } from './OptionPills.tsx';
import {
  submitQuickSignal,
  submitWalkIn,
  submitMusic,
  makeIdempotencyKey,
  type CaptureResult,
  type ObservationEnvelope,
} from '../../services/intelCapture.ts';
import type { PromptQuestion, Visibility, PartySizeBucket, CommercialDisclosure } from '../../lib/intel/contracts.ts';

export interface PromptBlockProps {
  subjectId: string;
  question: PromptQuestion;
  visibility: Visibility;
  zoneId?: string | null;
  /**
   * The observer's "who are you here with?" answer (§independent-group signal),
   * collected once at the screen level and attached to each label-eligible write.
   * Undefined when the traveler skipped it — the server then fail-closes.
   */
  partySize?: PartySizeBucket;
  /**
   * §22 commercial disclosure the traveler declared once at the screen level.
   * Attached to every write from this block; 'none'/undefined sends nothing.
   */
  commercialDisclosure?: CommercialDisclosure;
  onSent?: (question: PromptQuestion, option: string, observation?: ObservationEnvelope) => void;
}

export function PromptBlock({ subjectId, question, visibility, zoneId, partySize, commercialDisclosure, onSent }: PromptBlockProps) {
  const [busyOption, setBusyOption] = useState<string | null>(null);
  const [sentOption, setSentOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Idempotency key is stable per (option) so a retry of the same choice dedups.
  const keyRef = useRef<{ option: string; key: string } | null>(null);

  const submit = useCallback(
    async (option: string) => {
      if (!question.phase1) return; // presented but not collected yet
      setError(null);
      setBusyOption(option);
      if (!keyRef.current || keyRef.current.option !== option) {
        keyRef.current = { option, key: makeIdempotencyKey(question.id) };
      }
      const idempotencyKey = keyRef.current.key;

      let res: CaptureResult;
      if (question.kind === 'walkIn') {
        res = await submitWalkIn({ subjectId, accepted: option === 'accepted', visibility, partySize, commercialDisclosure, idempotencyKey });
      } else if (question.kind === 'music') {
        res = await submitMusic({ subjectId, genre: option, visibility, zoneId, partySize, commercialDisclosure, idempotencyKey });
      } else {
        res = await submitQuickSignal({
          subjectId,
          context: question.context!,
          option,
          visibility,
          zoneId,
          partySize,
          commercialDisclosure,
          idempotencyKey,
        });
      }

      setBusyOption(null);
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        setSentOption(option);
        keyRef.current = null;
        onSent?.(question, option, res.observation);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        setError(
          res.code === 'feature_disabled'
            ? 'Capture is turned off right now.'
            : res.error === 'not_configured'
              ? 'Not connected.'
              : 'Could not send — tap to retry.',
        );
      }
    },
    [question, subjectId, visibility, zoneId, partySize, commercialDisclosure, onSent],
  );

  return (
    <View style={styles.block}>
      <View style={styles.promptRow}>
        <Text style={styles.prompt}>{question.prompt}</Text>
        {sentOption ? (
          <View style={styles.sentTag}>
            <Check size={12} color={color.success} />
            <Text style={styles.sentTagText}>Sent</Text>
          </View>
        ) : null}
      </View>
      <OptionPills
        options={question.options}
        onSelect={submit}
        busyOption={busyOption}
        selectedOption={sentOption}
        disabled={!question.phase1}
        labelFor={question.labelFor}
        testIDPrefix={`intel-q-${question.id}`}
      />
      {!question.phase1 ? (
        <Text style={styles.plannedNote}>Planned — this signal will collect as capture expands.</Text>
      ) : null}
      {error ? (
        <View style={styles.errorRow}>
          <AlertCircle size={13} color={color.signal} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm },
  promptRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  prompt: { ...typography.cardTitle, color: color.ink, flexShrink: 1 },
  sentTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.success + '14',
  },
  sentTagText: { ...typography.metadata, color: color.success, textTransform: 'uppercase' },
  plannedNote: { ...typography.caption, color: color.faint, fontStyle: 'italic' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { ...typography.caption, color: color.signal },
});
