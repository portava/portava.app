/**
 * TripStageSpineCard — §5.1's stage spine on screen.
 *
 * WHAT WAS INVISIBLE
 * ==================
 * trip_stages, trip_legs and trip_plan_participants had no reader anywhere
 * until GET /trips/:tripId/structure landed, and no SCREEN until this card. A
 * stage a user cannot be shown is not a stage — the mirror of census-trips'
 * own rule that a table nothing writes satisfies nothing.
 *
 * WHAT IS SHOWN THAT A TIDIER CARD WOULD HIDE
 * ===========================================
 *   ORPHANS. A leg pointing at a stage this trip does not have, or an
 *   attendance row on a plan that is gone, should be impossible — the foreign
 *   keys enforce it. That is exactly why it is displayed when it happens: a
 *   count that should always be zero is worth showing, because the day it is
 *   not, a tidy card would have silently dropped a row.
 *
 *   A STAGE WITH NO TIMES. `startsAt`/`endsAt` are nullable, and a stage with
 *   neither is not a zero-length stage — it is a stage nobody has dated. The
 *   card says "no dates yet" rather than rendering an empty range.
 *
 *   THE PARTY SIZE comes from `goingUserIds`, computed server-side. Counting
 *   `participants.length` here would count `interested` and `maybe` as
 *   attending, which is how transport gets booked for six people who are four.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { MapPin, ArrowRight, CloudOff, AlertTriangle } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { fetchTripStructure, type StructureRead, type TripStructure } from '../../services/tripDecisions.ts';

interface Props {
  tripId: string;
  load?: typeof fetchTripStructure;
}

/** A stage's dates in words. Null dates are said, not rendered as a blank
 *  range — "no dates yet" and "starts and ends at the same unknown instant"
 *  are different, and only the first is true. */
export function stageDates(startsAt: string | null, endsAt: string | null): string {
  const d = (iso: string) => iso.slice(0, 10);
  if (startsAt && endsAt) return `${d(startsAt)} → ${d(endsAt)}`;
  if (startsAt) return `from ${d(startsAt)}`;
  if (endsAt) return `until ${d(endsAt)}`;
  return 'no dates yet';
}

function StageRow({ stage, structure }: { stage: TripStructure['stages'][number]; structure: TripStructure }) {
  const outbound = stage.legsFrom
    .map((id) => structure.legs.find((l) => l.id === id))
    .filter(Boolean);
  return (
    <View style={s.row} testID={`stage-${stage.id}`}>
      <MapPin size={14} color={color.signal} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>
          {stage.sequence}. {stage.stageType}
          {stage.state !== 'planned' ? ` · ${stage.state}` : ''}
        </Text>
        <Text style={s.detail}>
          {stageDates(stage.startsAt, stage.endsAt)}
          {stage.commitmentIds.length > 0
            ? ` · ${stage.commitmentIds.length} commitment${stage.commitmentIds.length === 1 ? '' : 's'}`
            : ''}
        </Text>
        {outbound.map((l) => (
          <View key={l!.id} style={s.legRow}>
            <ArrowRight size={12} color={color.mute} />
            <Text style={s.detail}>{l!.legType}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function TripStageSpineCard({ tripId, load = fetchTripStructure }: Props) {
  const [read, setRead] = useState<StructureRead | undefined>(undefined);

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
      <View style={s.wrap} testID="trip-spine-loading">
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  if (read.state === 'off') return null;

  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-spine-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Trip structure unavailable</Text>
            <Text style={s.detail}>
              We couldn&apos;t read this trip&apos;s stages. That isn&apos;t the same as it having none.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const st = read.structure;
  const orphanCount = st.orphanedLegs.length + st.orphanedCommitments.length + st.orphanedAttendance.length;
  const goingTotal = st.planAttendance.reduce((n, p) => n + p.goingUserIds.length, 0);

  // The board was READ and the trip genuinely has no stages. That is the one
  // honest blank, and it is distinct from `off` and from `unavailable`.
  if (st.stages.length === 0 && st.commitments.length === 0 && orphanCount === 0) return null;

  return (
    <View style={s.wrap} testID="trip-spine-card">
      <Text style={s.heading}>Stages</Text>

      {st.stages.map((stage) => <StageRow key={stage.id} stage={stage} structure={st} />)}

      {st.stages.length === 0 && st.commitments.length > 0 && (
        // Commitments without stages is a real state, not an error: §5.1's
        // stage_id is nullable. Saying so beats an empty card.
        <Text style={s.detail2}>
          {st.commitments.length} commitment{st.commitments.length === 1 ? '' : 's'} not attached to a stage yet.
        </Text>
      )}

      {goingTotal > 0 && (
        <Text style={s.detail2}>
          {/* §9.1's party — `going` only. Counting participants.length here
              would count `interested` and `maybe` as attending. */}
          {goingTotal} plan attendance{goingTotal === 1 ? '' : 's'} confirmed.
        </Text>
      )}

      {orphanCount > 0 && (
        // Should be impossible; shown BECAUSE it should be impossible.
        <View style={s.row} testID="trip-spine-orphans">
          <AlertTriangle size={14} color={color.signal} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>{orphanCount} item{orphanCount === 1 ? '' : 's'} point somewhere missing</Text>
            <Text style={s.detail}>
              This should not be possible. Nothing has been hidden — the affected items are still counted above.
            </Text>
          </View>
        </View>
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
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  detail2: { ...t.stamp, color: color.mute, paddingHorizontal: space.lg, paddingBottom: space.sm },
});
