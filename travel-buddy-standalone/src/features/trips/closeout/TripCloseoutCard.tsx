/**
 * TripCloseoutCard — §20.3 on screen. census-trips TR390: "the smallest
 * useful post-trip question set", asked, at last, by a screen.
 *
 * The questions and their two answers are the server's; the card asks them
 * in the spec's own words and records an answer through
 * POST /closeout/answers, which is RECORD_OUTCOME through the kernel. When
 * the server refuses by name — TRIP_KERNEL_UNAVAILABLE on a deployment with
 * the kernel off — the card says the answer was NOT recorded and why. It
 * never marks a question answered on its own authority.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { CheckCircle2, CloudOff, HelpCircle } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import {
  fetchTripCloseout, answerCloseoutQuestion, closeoutSummary, ANSWER_LABEL,
  type CloseoutRead, type CloseoutAnswer, type AnswerResult,
} from './tripCloseout.ts';

interface Props {
  tripId: string;
  /** Test seams — the real fetcher and recorder by default. */
  load?: typeof fetchTripCloseout;
  record?: typeof answerCloseoutQuestion;
}

type Outcome = { answer: CloseoutAnswer; result: AnswerResult };

export function TripCloseoutCard({ tripId, load = fetchTripCloseout, record = answerCloseoutQuestion }: Props) {
  const [read, setRead] = useState<CloseoutRead | undefined>(undefined);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome | 'pending'>>({});

  const run = useCallback(async () => {
    setRead(undefined);
    try { setRead(await load(tripId)); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load]);
  useEffect(() => { void run(); }, [run]);

  const answer = useCallback(async (planId: string, a: CloseoutAnswer) => {
    setOutcomes((o) => ({ ...o, [planId]: 'pending' }));
    const result = await record(tripId, planId, a);
    setOutcomes((o) => ({ ...o, [planId]: { answer: a, result } }));
  }, [tripId, record]);

  if (read === undefined) {
    return <View style={s.wrap} testID="trip-closeout-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-closeout-unavailable">
        <View style={s.row}>
          <CloudOff size={16} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Closeout unavailable</Text>
            <Text style={s.detail}>{read.detail}. Nothing was asked and nothing is answered.</Text>
          </View>
        </View>
      </View>
    );
  }

  const c = read.closeout;
  return (
    <View style={s.wrap} testID="trip-closeout-card">
      <View style={s.row}>
        <HelpCircle size={16} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>{c.questions.length === 0 ? 'Nothing left to reconcile' : c.questions.length === 1 ? 'One thing to confirm' : `${c.questions.length} things to confirm`}</Text>
          <Text style={s.detail}>{closeoutSummary(c)}</Text>
        </View>
      </View>
      {c.questions.map((q) => {
        const o = outcomes[q.planId];
        return (
          <View key={q.planId} style={s.question} testID={`trip-closeout-question-${q.planId}`}>
            <Text style={s.questionText}>{q.question}</Text>
            {o === undefined ? (
              <View style={s.buttons}>
                {q.answers.map((a) => (
                  <Pressable key={a} onPress={() => void answer(q.planId, a)} style={s.button} testID={`trip-closeout-answer-${q.planId}-${a}`} accessibilityRole="button">
                    <Text style={s.buttonText}>{ANSWER_LABEL[a] ?? a}</Text>
                  </Pressable>
                ))}
              </View>
            ) : o === 'pending' ? (
              <ActivityIndicator size="small" color={color.signal} />
            ) : o.result.state === 'recorded' ? (
              <View style={s.recorded} testID={`trip-closeout-recorded-${q.planId}`}>
                <CheckCircle2 size={14} color={color.success} />
                <Text style={[s.detail, { color: color.success }]}>{ANSWER_LABEL[o.answer]} — recorded{o.result.duplicate ? ' (already was)' : ''}</Text>
              </View>
            ) : (
              <Text style={[s.detail, { color: color.signal }]} testID={`trip-closeout-not-recorded-${q.planId}`}>
                Not recorded — {o.result.state === 'refused' ? `${o.result.reason}: ${o.result.detail}` : o.result.detail}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  question: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs },
  questionText: { ...t.small, color: color.ink },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  button: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  buttonText: { ...t.small, color: color.ink },
  recorded: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
