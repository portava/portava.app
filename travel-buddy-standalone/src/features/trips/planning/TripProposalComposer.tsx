/**
 * TripProposalComposer — "propose a change" for the crew to decide, under a
 * rule the proposer picks (census-trips TR154; TR88's `trip_proposals` gets a
 * product writer). Mounted inside TripBallotsCard, so the proposal appears in
 * the open votes the moment the card reads it back.
 *
 * It asks for what is being proposed (the ballot's title), what kind of change
 * it is, how it is decided — the host decides, a majority of the crew,
 * everyone, or anyone — and optionally why and what it changes. The kernel's
 * own default rule, the host's, is shown selected rather than applied unseen.
 *
 * Accepting one of these records the crew's decision and changes nothing by
 * itself (tripProposalPayloads.ts says why only these types are offered), and
 * the composer says so.
 *
 * "Proposed" is shown only on the kernel's word; a refusal is shown with its
 * reason; an unreachable kernel is "nothing was proposed" with a retry of THE
 * SAME proposal and key.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, MessageSquarePlus } from 'lucide-react-native';

import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { OFFERED_PROPOSAL_TYPES, DECISION_RULES, PROPOSAL_TITLE_MAX, PROPOSAL_TEXT_MAX, type OfferedProposalType, type DecisionRule, type ProposalInput } from './tripProposalPayloads.ts';
import { createProposal, proposalKey, type ProposalResult } from './tripProposals.ts';

interface Props {
  tripId: string;
  onProposed?: () => void;
  /** Test seam. */
  propose?: typeof createProposal;
}

const TYPE_LABEL: Record<OfferedProposalType, string> = { stage_change: 'A stage change', add_commitment: 'A new commitment', other: 'Something else' };
const RULE_LABEL: Record<DecisionRule, string> = { host: 'The host decides', majority: 'Majority of the crew', unanimous: 'Everyone must agree', anyone: 'Anyone may decide' };

type Attempt = { input: ProposalInput; key: string; result: ProposalResult | 'pending' };

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} style={[s.button, on && s.buttonOn]} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }}>
      <Text style={[s.buttonText, on && s.buttonTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function TripProposalComposer({ tripId, onProposed, propose = createProposal }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [proposalType, setProposalType] = useState<OfferedProposalType | null>(null);
  const [rule, setRule] = useState<DecisionRule>('host');
  const [rationale, setRationale] = useState('');
  const [impact, setImpact] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  const send = useCallback(async (input: ProposalInput, key: string) => {
    setAttempt({ input, key, result: 'pending' });
    const result = await propose(tripId, input, key);
    setAttempt({ input, key, result });
    if (result.state === 'recorded') {
      setTitle(''); setProposalType(null); setRule('host'); setRationale(''); setImpact('');
      onProposed?.();
    }
  }, [tripId, propose, onProposed]);

  const busy = attempt?.result === 'pending';
  const res = attempt && attempt.result !== 'pending' ? attempt.result : null;
  const ready = title.trim().length > 0 && proposalType !== null;

  return (
    <View style={s.block} testID="proposal-composer">
      {!open ? (
        <Pressable onPress={() => { setOpen(true); setAttempt(null); }} style={s.button} testID="proposal-compose-open" accessibilityRole="button" accessibilityLabel="Propose a change for the crew to decide">
          <View style={s.inline}><MessageSquarePlus size={12} color={color.deep} /><Text style={[s.buttonText, { marginLeft: 2 }]}>Propose a change</Text></View>
        </Pressable>
      ) : (
        <View testID="proposal-compose-form">
          <Text style={s.title}>Propose a change</Text>
          <TextInput
            value={title} onChangeText={setTitle} maxLength={PROPOSAL_TITLE_MAX}
            placeholder="What are you proposing?" placeholderTextColor={color.faint}
            style={s.input} testID="proposal-title" accessibilityLabel="What you are proposing"
          />
          <Text style={s.detail}>What kind of change?</Text>
          <View style={s.buttons}>
            {OFFERED_PROPOSAL_TYPES.map((v) => <Chip key={v} label={TYPE_LABEL[v]} on={proposalType === v} onPress={() => setProposalType(v)} testID={`proposal-type-${v}`} />)}
          </View>
          <Text style={s.detail}>How is it decided?</Text>
          <View style={s.buttons}>
            {DECISION_RULES.map((v) => <Chip key={v} label={RULE_LABEL[v]} on={rule === v} onPress={() => setRule(v)} testID={`proposal-rule-${v}`} />)}
          </View>
          <TextInput
            value={rationale} onChangeText={setRationale} maxLength={PROPOSAL_TEXT_MAX}
            placeholder="Why? (optional)" placeholderTextColor={color.faint}
            style={s.input} testID="proposal-rationale" accessibilityLabel="Why you are proposing it"
          />
          <TextInput
            value={impact} onChangeText={setImpact} maxLength={PROPOSAL_TEXT_MAX}
            placeholder="What would it change? (optional)" placeholderTextColor={color.faint}
            style={s.input} testID="proposal-impact" accessibilityLabel="What it would change"
          />
          <Text style={s.detail} testID="proposal-effect-note">Accepting it records the crew&apos;s decision. It doesn&apos;t change the trip by itself.</Text>
          <View style={s.buttons}>
            <Pressable
              disabled={!ready || busy}
              onPress={() => { if (proposalType) void send({ proposalType, decisionRule: rule, title, rationale, impactSummary: impact }, proposalKey()); }}
              style={[s.button, (!ready || busy) && { opacity: 0.5 }]}
              testID="proposal-compose-submit" accessibilityRole="button" accessibilityLabel="Propose it" accessibilityState={{ disabled: !ready || busy }}
            >
              <Text style={s.buttonText}>Propose</Text>
            </Pressable>
            <Pressable onPress={() => { setOpen(false); setAttempt(null); }} style={s.button} testID="proposal-compose-close" accessibilityRole="button" accessibilityLabel="Close the proposal form">
              <Text style={s.buttonText}>Close</Text>
            </Pressable>
          </View>
        </View>
      )}
      {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="proposal-compose-busy" accessibilityLabel="Proposing" /> : null}
      {res?.state === 'recorded' ? (
        <View style={s.inline} testID="proposal-compose-recorded">
          <CheckCircle2 size={12} color={color.success} />
          <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>Proposed{res.duplicate ? ' (already was)' : ''} — it&apos;s in the open votes.</Text>
        </View>
      ) : res?.state === 'refused' ? (
        <Text style={[s.detail, { color: color.signal }]} testID="proposal-compose-refused">Not proposed — {res.detail}</Text>
      ) : res?.state === 'unavailable' ? (
        <View testID="proposal-compose-unavailable">
          <Text style={[s.detail, { color: color.signal }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was proposed.</Text>
          <Pressable onPress={() => attempt && void send(attempt.input, attempt.key)} style={s.button} testID="proposal-compose-retry" accessibilityRole="button" accessibilityLabel="Try proposing it again">
            <Text style={s.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  block: { paddingHorizontal: space.lg, paddingVertical: space.sm },
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
