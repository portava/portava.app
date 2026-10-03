/**
 * TripBallotsCard — §9.3 ballots on screen (TRIP-F15, WP-10).
 *
 * The decisions card says what the trip is waiting on; this card is where the
 * crew answers. Each open proposal shows its rule, the tally exactly as the
 * server computed it, and the viewer's own ballot in three states (voted,
 * abstained, not voted). A vote is VOTE_ON_PROPOSAL through the kernel;
 * Accept / Reject are ACCEPT_PROPOSAL / REJECT_PROPOSAL, which the kernel
 * applies under the proposal's own rule. Nothing is marked as voted until the
 * kernel says so, and a vote the kernel could not be reached for is offered
 * again with the SAME key, so the retry cannot count twice.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useLatestRead } from '../shared/latestRead.ts';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { Vote, CloudOff, CheckCircle2 } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { fetchTripDecisions, myVoteLabel, type DecisionRead } from './tripDecisions.ts';
import {
  castBallot, decideProposal, ballotKey, openBallots, canOfferDecision, proposalTitle, tallyLine, BALLOTS,
  type Ballot, type BallotResult, type BoardProposal,
} from './tripBallots.ts';

interface Props {
  tripId: string;
  isOwner: boolean;
  /** Test seams. */
  load?: typeof fetchTripDecisions;
  cast?: typeof castBallot;
  decide?: typeof decideProposal;
}

type Intent = { kind: Ballot | 'accept' | 'reject'; key: string };
type Outcome = { intent: Intent; result: BallotResult | 'pending' };

const BALLOT_LABEL: Record<Ballot, string> = { yes: 'Yes', no: 'No', abstain: 'Abstain' };
const RULE_LABEL: Record<string, string> = { host: 'the host decides', majority: 'majority of the crew', unanimous: 'everyone must agree', anyone: 'anyone may decide' };

export function TripBallotsCard({ tripId, isOwner, load = fetchTripDecisions, cast = castBallot, decide = decideProposal }: Props) {
  const [read, setRead] = useState<DecisionRead | undefined>(undefined);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  // Latest read wins: two votes' re-reads can answer out of order (§79).
  const begin = useLatestRead();
  const run = useCallback(async () => {
    const current = begin();
    setRead(undefined);
    try { const r = await load(tripId); if (current()) setRead(r); }
    catch (e: any) { if (current()) setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load, begin]);
  useEffect(() => { void run(); }, [run]);

  const send = useCallback(async (p: BoardProposal, intent: Intent) => {
    setOutcomes((o) => ({ ...o, [p.id]: { intent, result: 'pending' } }));
    const result = intent.kind === 'accept' || intent.kind === 'reject'
      ? await decide(tripId, p.id, intent.kind, intent.key)
      : await cast(tripId, p.id, intent.kind, intent.key);
    setOutcomes((o) => ({ ...o, [p.id]: { intent, result } }));
    // The tally and the viewer's ballot are the server's: read them again.
    if (result.state === 'recorded') {
      const current = begin();
      try { const next = await load(tripId); if (current() && next.state === 'ok') setRead(next); } catch { /* the recorded line stays */ }
    }
  }, [tripId, cast, decide, load, begin]);

  if (read === undefined) {
    return <View style={s.wrap} testID="trip-ballots-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-ballots-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Votes unavailable</Text>
            <Text style={s.detail}>We couldn&apos;t read this trip&apos;s open votes. That isn&apos;t the same as there being none.</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="trip-ballots-retry" accessibilityRole="button">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const open = openBallots(read.board);
  if (open.length === 0) {
    return (
      <View style={s.wrap} testID="trip-ballots-empty">
        <View style={s.row}>
          <Vote size={14} color={color.mute} />
          <Text style={[s.detail, { flex: 1, marginTop: 0 }]}>No open votes on this trip.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.wrap} testID="trip-ballots-card">
      <Text style={s.heading}>Open votes</Text>
      {open.map((p) => {
        const o = outcomes[p.id];
        const busy = o?.result === 'pending';
        const res = o && o.result !== 'pending' ? o.result : null;
        return (
          <View key={p.id} style={s.row} testID={`ballot-${p.id}`}>
            <Vote size={14} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{proposalTitle(p)}</Text>
              <Text style={s.detail}>Rule: {RULE_LABEL[p.decisionRule] ?? p.decisionRule}</Text>
              <Text style={s.detail} testID={`ballot-tally-${p.id}`}>{tallyLine(p)}</Text>
              <Text style={s.detail} testID={`ballot-myvote-${p.id}`}>{myVoteLabel(p.myVote)}</Text>
              <View style={s.buttons}>
                {BALLOTS.map((b) => (
                  <Pressable
                    key={b}
                    disabled={busy}
                    onPress={() => void send(p, { kind: b, key: ballotKey(p.id, b) })}
                    style={[s.button, p.myVote === b && s.buttonOn, busy && { opacity: 0.5 }]}
                    testID={`ballot-${p.id}-${b}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: p.myVote === b }}
                  >
                    <Text style={[s.buttonText, p.myVote === b && s.buttonTextOn]}>{BALLOT_LABEL[b]}</Text>
                  </Pressable>
                ))}
                {canOfferDecision(p, isOwner) && (['accept', 'reject'] as const).map((d) => (
                  <Pressable
                    key={d}
                    disabled={busy}
                    onPress={() => void send(p, { kind: d, key: ballotKey(p.id, d) })}
                    style={[s.button, busy && { opacity: 0.5 }]}
                    testID={`ballot-${p.id}-${d}`}
                    accessibilityRole="button"
                  >
                    <Text style={s.buttonText}>{d === 'accept' ? 'Accept' : 'Reject'}</Text>
                  </Pressable>
                ))}
              </View>
              {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} /> : null}
              {res?.state === 'recorded' ? (
                <View style={s.inline} testID={`ballot-recorded-${p.id}`}>
                  <CheckCircle2 size={12} color={color.success} />
                  <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>
                    {o!.intent.kind === 'accept' ? 'Accepted' : o!.intent.kind === 'reject' ? 'Rejected' : 'Vote recorded'}{res.duplicate ? ' (already was)' : ''}
                  </Text>
                </View>
              ) : res?.state === 'refused' ? (
                <Text style={[s.detail, { color: color.signal }]} testID={`ballot-refused-${p.id}`}>Not recorded — {res.detail}</Text>
              ) : res?.state === 'unavailable' ? (
                <View testID={`ballot-unavailable-${p.id}`}>
                  <Text style={[s.detail, { color: color.signal }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was counted.</Text>
                  <Pressable onPress={() => void send(p, o!.intent)} style={s.button} testID={`ballot-retry-${p.id}`} accessibilityRole="button">
                    <Text style={s.buttonText}>Try again</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
