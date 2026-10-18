/**
 * TripDecisionComposer — the product's writer for §8's decision tasks and risks.
 *
 * TripDecisionsCard draws what a trip is waiting on (GET /trips/:tripId/decisions);
 * until this control, nothing in the app could ADD to it, so `trip_decision_tasks`
 * and `trip_risks` stayed empty on every real trip (census-trips TR85, TR86, TR21,
 * TR22, and the lead's ruling that a table row is correct only when the product
 * can populate it). This is the smallest honest writer: a decision task by its
 * 2762 type with an optional consequence, and a risk by likelihood and impact
 * with an optional note. Both go through the kernel (tripDecisionEntries.ts).
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not claim a write it has not seen. "Added" is shown only on the
 * kernel's word; a refusal is shown with its reason; an unreachable kernel is
 * "nothing was added" with a retry of THE SAME tap (same key), so a retry can
 * never add the entry twice. `onAdded` lets the screen re-read the board.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, ListPlus } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import {
  addDecisionTask, addRisk, entryKey, DECISION_TASK_TYPES, RISK_LEVELS, ENTRY_TEXT_MAX,
  type DecisionTaskType, type RiskLevel, type EntryResult,
} from './tripDecisionEntries.ts';

interface Props {
  tripId: string;
  onAdded?: () => void;
  /** Test seams. */
  addTask?: typeof addDecisionTask;
  addRiskEntry?: typeof addRisk;
}

const TYPE_LABEL: Record<DecisionTaskType, string> = {
  booking: 'Booking', transport: 'Transport', lodging: 'Lodging', document: 'Document',
  payment: 'Payment', logistics: 'Logistics', other: 'Other',
};
const LEVEL_LABEL: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

type Mode = 'task' | 'risk';
type Attempt = { mode: Mode; key: string; result: EntryResult | 'pending' };

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} style={[s.button, on && s.buttonOn]} testID={testID} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[s.buttonText, on && s.buttonTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function TripDecisionComposer({ tripId, onAdded, addTask = addDecisionTask, addRiskEntry = addRisk }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [taskType, setTaskType] = useState<DecisionTaskType | null>(null);
  const [consequence, setConsequence] = useState('');
  const [likelihood, setLikelihood] = useState<RiskLevel | null>(null);
  const [impact, setImpact] = useState<RiskLevel | null>(null);
  const [note, setNote] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  const send = useCallback(async (m: Mode, key: string) => {
    setAttempt({ mode: m, key, result: 'pending' });
    const result = m === 'task'
      ? await addTask(tripId, { type: taskType ?? '', consequence }, key)
      : await addRiskEntry(tripId, { likelihood: likelihood ?? '', impact: impact ?? '', note }, key);
    setAttempt({ mode: m, key, result });
    if (result.state === 'recorded') {
      if (m === 'task') { setTaskType(null); setConsequence(''); } else { setLikelihood(null); setImpact(null); setNote(''); }
      onAdded?.();
    }
  }, [tripId, taskType, consequence, likelihood, impact, note, addTask, addRiskEntry, onAdded]);

  const busy = attempt?.result === 'pending';
  const res = attempt && attempt.result !== 'pending' ? attempt.result : null;
  const ready = mode === 'task' ? taskType !== null : mode === 'risk' ? likelihood !== null && impact !== null : false;

  return (
    <View style={s.wrap} testID="trip-decision-composer">
      <View style={s.row}>
        <ListPlus size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Add to what this trip is waiting on</Text>
          <View style={s.buttons}>
            <Chip label="Something to decide" on={mode === 'task'} onPress={() => { setMode('task'); setAttempt(null); }} testID="decision-compose-task" />
            <Chip label="A risk" on={mode === 'risk'} onPress={() => { setMode('risk'); setAttempt(null); }} testID="decision-compose-risk" />
          </View>

          {mode === 'task' ? (
            <View testID="decision-compose-task-form">
              <Text style={s.detail}>What kind of decision?</Text>
              <View style={s.buttons}>
                {DECISION_TASK_TYPES.map((type) => (
                  <Chip key={type} label={TYPE_LABEL[type]} on={taskType === type} onPress={() => setTaskType(type)} testID={`decision-type-${type}`} />
                ))}
              </View>
              <TextInput
                value={consequence} onChangeText={setConsequence} maxLength={ENTRY_TEXT_MAX}
                placeholder="If nothing is decided… (optional)" placeholderTextColor={color.mute}
                style={s.input} testID="decision-consequence" accessibilityLabel="What happens if nothing is decided"
              />
            </View>
          ) : null}

          {mode === 'risk' ? (
            <View testID="decision-compose-risk-form">
              <Text style={s.detail}>How likely?</Text>
              <View style={s.buttons}>
                {RISK_LEVELS.map((level) => (
                  <Chip key={level} label={LEVEL_LABEL[level]} on={likelihood === level} onPress={() => setLikelihood(level)} testID={`risk-likelihood-${level}`} />
                ))}
              </View>
              <Text style={s.detail}>How much would it hurt?</Text>
              <View style={s.buttons}>
                {RISK_LEVELS.map((level) => (
                  <Chip key={level} label={LEVEL_LABEL[level]} on={impact === level} onPress={() => setImpact(level)} testID={`risk-impact-${level}`} />
                ))}
              </View>
              <TextInput
                value={note} onChangeText={setNote} maxLength={ENTRY_TEXT_MAX}
                placeholder="What would set it off? (optional)" placeholderTextColor={color.mute}
                style={s.input} testID="risk-note" accessibilityLabel="What would set this risk off"
              />
            </View>
          ) : null}

          {mode ? (
            <Pressable
              disabled={!ready || busy}
              onPress={() => void send(mode, entryKey(mode))}
              style={[s.button, (!ready || busy) && { opacity: 0.5 }]}
              testID="decision-compose-submit" accessibilityRole="button" accessibilityState={{ disabled: !ready || busy }}
            >
              <Text style={s.buttonText}>{mode === 'task' ? 'Add decision' : 'Flag risk'}</Text>
            </Pressable>
          ) : null}

          {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} /> : null}
          {res?.state === 'recorded' ? (
            <View style={s.inline} testID="decision-compose-recorded">
              <CheckCircle2 size={12} color={color.success} />
              <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>Added{res.duplicate ? ' (already was)' : ''}</Text>
            </View>
          ) : res?.state === 'refused' ? (
            <Text style={[s.detail, { color: color.signalStrong }]} testID="decision-compose-refused">Not added — {res.detail}</Text>
          ) : res?.state === 'unavailable' ? (
            <View testID="decision-compose-unavailable">
              <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was added.</Text>
              <Pressable onPress={() => attempt && void send(attempt.mode, attempt.key)} style={s.button} testID="decision-compose-retry" accessibilityRole="button">
                <Text style={s.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
  input: { ...t.small, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, marginTop: space.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
