/**
 * TripRescueEntry — §17.3's entry point on screen, shown when §17.2's switch
 * is not NORMAL. census-trips TR318, TR320–TR328.
 *
 * The traveller names the problem in the server's vocabulary; the server
 * answers with a plan — steps, who does each, where to escalate and when —
 * and says whether the disruption was declared. The card renders the plan
 * as given and the declaration line in the server's words: with the kernel
 * off it reads "not declared", never a claim.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { LifeBuoy, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { requestRescue, declaredLine, RESCUE_PROBLEMS, PROBLEM_LABEL, type RescueProblem, type RescueResult } from './tripRescue.ts';

interface Props {
  tripId: string;
  /** The §17.2 mode from the Today projection; the entry renders only when it is not NORMAL. */
  attentionMode: string | null;
  /** Test seam — the real requester by default. */
  request?: typeof requestRescue;
}

export function TripRescueEntry({ tripId, attentionMode, request = requestRescue }: Props) {
  const [chosen, setChosen] = useState<RescueProblem | null>(null);
  const [result, setResult] = useState<RescueResult | 'pending' | null>(null);

  const ask = useCallback(async (p: RescueProblem) => {
    setChosen(p); setResult('pending');
    try { setResult(await request(tripId, p)); }
    catch (e: any) { setResult({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, request]);

  if (!attentionMode || attentionMode === 'NORMAL') return null;

  return (
    <View style={[s.wrap, s.wrapAlarm]} testID="trip-rescue-entry">
      <View style={s.row}>
        <LifeBuoy size={16} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: color.signal }]}>Need help right now?</Text>
          <Text style={s.detail}>Name the problem and get a plan: who does what, and where to escalate.</Text>
        </View>
      </View>
      {result === null ? (
        <View style={s.buttons}>
          {RESCUE_PROBLEMS.map((p) => (
            <Pressable key={p} onPress={() => void ask(p)} style={s.button} testID={`trip-rescue-problem-${p}`} accessibilityRole="button">
              <Text style={s.buttonText}>{PROBLEM_LABEL[p]}</Text>
            </Pressable>
          ))}
        </View>
      ) : result === 'pending' ? (
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.md }} />
      ) : result.state === 'off' ? (
        <Text style={[s.detail, s.pad]} testID="trip-rescue-off">Rescue plans are not available here.</Text>
      ) : result.state === 'unavailable' ? (
        <View style={[s.row]} testID="trip-rescue-unavailable">
          <CloudOff size={14} color={color.mute} />
          <Text style={s.detail}>Could not get a plan: {result.detail}. Call local emergency services if you are unsafe.</Text>
        </View>
      ) : (
        <View style={s.plan} testID="trip-rescue-plan">
          <Text style={s.planTitle}>{chosen ? PROBLEM_LABEL[chosen] : result.response.plan.problem} — {result.response.plan.severity}</Text>
          {result.response.plan.steps.map((st) => (
            <Text key={st.order} style={s.step}>{st.order}. {st.action} <Text style={s.who}>({st.who})</Text> — {st.detail}</Text>
          ))}
          {result.response.plan.escalation.map((e, i) => (
            <Text key={`${e.to}-${i}`} style={s.detail}>Escalate to {e.to.replace(/_/g, ' ')} {e.when.replace(/_/g, ' ')}: {e.why}</Text>
          ))}
          <Text style={[s.detail, result.response.declared.ok ? { color: color.success } : { color: color.warn }]} testID="trip-rescue-declared">
            {declaredLine(result.response)}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  wrapAlarm: { borderColor: color.signal },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  pad: { paddingHorizontal: space.lg, paddingBottom: space.md },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  button: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  buttonText: { ...t.small, color: color.ink },
  plan: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs },
  planTitle: { ...t.small, fontWeight: '600', color: color.ink },
  step: { ...t.small, color: color.ink },
  who: { ...t.stamp, color: color.faint },
});
