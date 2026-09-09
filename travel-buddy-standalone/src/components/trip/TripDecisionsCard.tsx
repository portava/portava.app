/**
 * TripDecisionsCard — §8 on screen.
 *
 * THE ONE THING THIS COMPONENT MUST NOT DO
 * ========================================
 * Make INSUFFICIENT_BASIS look like approval. It is the engine's way of saying
 * the question was not answerable on what was available, and the natural UI
 * mistake — showing nothing, or a neutral grey row, for a decision nobody could
 * advise on — reads to a user as "no problem here". So every recommendation
 * renders, its kind is named in words, and the reasons are shown rather than
 * summarised away.
 *
 * The second mistake, one layer down: a proposal whose vote tally could not be
 * computed showing as 0 votes. `acceptanceMet` returns NULL for that and this
 * card says "can't tell", never "not yet".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, XCircle, HelpCircle, CloudOff, AlertTriangle } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  fetchTripDecisions, recommendationHeadline, reasonText, acceptanceMet,
  type DecisionRead, type Recommendation, type DecisionBoard,
} from '../../services/tripDecisions.ts';

interface Props {
  tripId: string;
  load?: typeof fetchTripDecisions;
}

function KindIcon({ kind }: { kind: Recommendation['kind'] }) {
  if (kind === 'RECOMMEND') return <CheckCircle2 size={15} color={color.success} />;
  if (kind === 'DO_NOT_RECOMMEND') return <XCircle size={15} color={color.signal} />;
  return <HelpCircle size={15} color={color.faint} />;
}

function RecommendationRow({ rec, board }: { rec: Recommendation; board: DecisionBoard }) {
  const task = board.decisionTasks.find((d) => d.id === rec.decisionTaskId);
  const chosen = rec.proposalId ? board.proposals.find((p) => p.id === rec.proposalId) : null;
  const met = chosen ? acceptanceMet(chosen) : null;

  return (
    <View style={s.row} testID={`decision-${rec.decisionTaskId}`}>
      <KindIcon kind={rec.kind} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>
          {task ? task.type : 'Decision'} — {recommendationHeadline(rec)}
        </Text>
        {/* The reasons, not a summary of them. A recommendation whose grounds
            are hidden is an instruction, not advice. */}
        <Text style={s.detail}>
          {rec.reasons.map(reasonText).join('; ')}
        </Text>
        {chosen && (
          <Text style={s.detail}>
            Under its {chosen.decisionRule} rule:{' '}
            {met === true ? 'ready to accept'
              : met === false ? 'not yet agreed'
              // NULL is not `false`. "We could not work out whether it can be
              // accepted" is a different thing to tell someone holding a
              // decision, and the tally being unreadable is why.
              : chosen.tally === null ? "we couldn't check the vote"
              : 'decided by the host'}
          </Text>
        )}
        {task?.consequence && (
          <Text style={s.detail}>If nothing is decided: {task.consequence}</Text>
        )}
      </View>
    </View>
  );
}

export function TripDecisionsCard({ tripId, load = fetchTripDecisions }: Props) {
  const [read, setRead] = useState<DecisionRead | undefined>(undefined);

  const run = useCallback(async () => {
    setRead(undefined);
    try {
      setRead(await load(tripId));
    } catch (e: any) {
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
    }
  }, [tripId, load]);

  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="trip-decisions-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-decisions-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Decisions unavailable</Text>
            <Text style={s.detail}>
              We couldn&apos;t work out what this trip is waiting on. That isn&apos;t the same as nothing.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const board = read.board;
  const openRisks = board.risks.filter((r) => r.status === 'open');

  // A trip with nothing pending renders nothing rather than an empty card —
  // this is the ONE empty state that is honest, because the board was read and
  // it really is empty.
  if (board.recommendations.length === 0 && openRisks.length === 0) return null;

  return (
    <View style={s.wrap} testID="trip-decisions-card">
      <Text style={s.heading}>What this trip is waiting on</Text>

      {board.recommendations.map((rec) => (
        <RecommendationRow key={rec.decisionTaskId} rec={rec} board={board} />
      ))}

      {openRisks.length > 0 && (
        <View style={s.row} testID="trip-decisions-risks">
          <AlertTriangle size={14} color={openRisks.some((r) => r.impact === 'high') ? color.signal : color.warn} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>
              {openRisks.length} open risk{openRisks.length === 1 ? '' : 's'}
            </Text>
            {/* §8.4: which plan elements inherit them. A register nothing
                propagates from is a list, and this is the propagation. */}
            <Text style={s.detail}>
              {board.elementRisks.length === 0
                ? 'None of them names a plan element yet.'
                : `${board.elementRisks.length} plan element${board.elementRisks.length === 1 ? '' : 's'} affected.`}
            </Text>
          </View>
        </View>
      )}

      {board.tallyFailures > 0 && (
        // Visible rather than inferred from a null: a reader has to know that
        // some governance state on this card is missing, not zero.
        <Text style={[s.detail, { paddingHorizontal: space.lg, paddingBottom: space.sm }]}>
          {board.tallyFailures} proposal{board.tallyFailures === 1 ? "'s" : "s'"} vote count
          {board.tallyFailures === 1 ? '' : 's'} could not be read.
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, ...shadow.card,
    overflow: 'hidden', paddingVertical: space.sm,
  },
  heading: {
    ...t.small, fontWeight: '700', color: color.ink,
    paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
});
