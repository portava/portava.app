/**
 * TripStageControls — dating a stage and moving it through its lifecycle
 * (census-trips TR13, TR65; TR78's stages finally get boundaries).
 *
 * The spine card draws the stages and the composer adds them; until this
 * control a stage could never be dated after it was added, never started and
 * never completed, so every product stage stayed `planned` and undated and
 * `trip.stage_started` never happened. Each stage here shows its state and its
 * boundaries IN ITS OWN TIME ZONE (2760 gives every stage one), and offers:
 *
 *   Set dates        UPDATE_STAGE with only the boundaries that changed.
 *   Start stage      START_STAGE, a planned stage only.
 *   Complete stage   COMPLETE_STAGE, a stage in progress only.
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not claim a change it has not seen: "Saved" / "Started" /
 * "Completed" is shown on the kernel's word, and the stage is then read again
 * so what is drawn is the server's. A refusal is shown with its reason. An
 * unreachable kernel is "nothing was changed" with a retry of THE SAME command
 * and key. A structure read that failed is said, never drawn as a trip with no
 * stages. A boundary is never shown in another zone than the stage's: when the
 * stage's zone cannot be computed here, the served instant is shown as it is.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, CalendarRange } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { useLatestRead } from '../shared/latestRead.ts';
import { fetchTripStructure, type StructureRead, type TripStructure } from '../planning/tripDecisions.ts';
import { ZonedTimeField } from '../shared/ZonedTimeField.tsx';
import { typedTimeOf, instantInZone, dateWords, usableZone, EMPTY_TYPED_TIME, type TypedTime } from '../shared/tripLocalTime.ts';
import { stageBoundsDraft } from '../planning/structureDetailDrafts.ts';
import { nextArrow, stageBoundsCommand, type Bounds, type StageArrow } from './tripStagePayloads.ts';
import { setStageBounds, moveStage, stageControlKey, type StageChangeResult } from './tripStageEntries.ts';

type Stage = TripStructure['stages'][number];

interface Props {
  tripId: string;
  /** Changes when the screen knows the stages changed (one was added): read again. */
  refreshKey?: number;
  /** Called after the kernel recorded a change, so the screen can refresh the spine. */
  onChanged?: () => void;
  /** Test seams. */
  load?: typeof fetchTripStructure;
  setBounds?: typeof setStageBounds;
  move?: typeof moveStage;
}

/** What one tap sent, kept whole so a retry re-sends exactly it. */
type Sent =
  | { kind: 'dates'; current: Bounds; next: Bounds }
  | { kind: StageArrow; state: string };
type Attempt = { sent: Sent; key: string; result: StageChangeResult | 'pending' };

const TYPE_LABEL: Record<string, string> = { city: 'City', transit: 'Transit', lodging: 'Lodging', excursion: 'Excursion', layover: 'Layover' };
const STATE_LABEL: Record<string, string> = { planned: 'Planned', active: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const DONE_LABEL: Record<Sent['kind'], string> = { dates: 'Dates saved', start: 'Started', complete: 'Completed' };

function stageName(st: Stage): string {
  return `${st.sequence}. ${TYPE_LABEL[st.stageType] ?? st.stageType}`;
}

/** One boundary in the stage's own zone, or the served instant as it is when the zone cannot be computed here. */
function boundaryWords(iso: string | null, zone: string): string {
  if (!iso) return 'not set';
  const local = instantInZone(iso, zone);
  return local ? `${dateWords(local.date)}, ${local.time}` : iso;
}

export function TripStageControls({ tripId, refreshKey = 0, onChanged, load = fetchTripStructure, setBounds = setStageBounds, move = moveStage }: Props) {
  const [read, setRead] = useState<StructureRead | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null);
  const [starts, setStarts] = useState<TypedTime>(EMPTY_TYPED_TIME);
  const [ends, setEnds] = useState<TypedTime>(EMPTY_TYPED_TIME);
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});

  // Latest read wins: a change's re-read can race the refresh the screen asks for.
  const begin = useLatestRead();
  const reread = useCallback(async (clearFirst: boolean) => {
    const current = begin();
    if (clearFirst) setRead(undefined);
    try { const r = await load(tripId); if (current()) setRead(r); }
    catch (e: unknown) { if (current()) setRead({ state: 'unavailable', detail: e instanceof Error ? e.message : 'unexpected error' }); }
  }, [tripId, load, begin]);
  // The first read starts from the loading state; a refresh keeps the stages drawn until the answer arrives.
  useEffect(() => {
    const current = begin();
    load(tripId).then(
      (r) => { if (current()) setRead(r); },
      (e: unknown) => { if (current()) setRead({ state: 'unavailable', detail: e instanceof Error ? e.message : 'unexpected error' }); },
    );
  }, [tripId, load, begin, refreshKey]);

  const send = useCallback(async (st: Stage, sent: Sent, key: string) => {
    setAttempts((a) => ({ ...a, [st.id]: { sent, key, result: 'pending' } }));
    const result = sent.kind === 'dates'
      ? await setBounds(tripId, st.id, sent.current, sent.next, key)
      : await move(tripId, st.id, sent.state, sent.kind, key);
    setAttempts((a) => ({ ...a, [st.id]: { sent, key, result } }));
    if (result.state === 'recorded') {
      if (sent.kind === 'dates') setEditing(null);
      onChanged?.();
    }
    // Recorded or refused, the stage the next tap is built from may not be the
    // one drawn: read it again. Unreachable decided nothing, so nothing moves.
    if (result.state !== 'unavailable') void reread(false);
  }, [tripId, setBounds, move, onChanged, reread]);

  if (read === undefined) {
    return <View style={s.wrap} testID="stage-controls-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} accessibilityLabel="Reading this trip's stages" /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="stage-controls-read-failed">
        <View style={s.row}>
          <CalendarRange size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Stage dates and progress</Text>
            <Text style={[s.detail, { color: color.signal }]}>Couldn&apos;t read this trip&apos;s stages — {read.detail}. That isn&apos;t the same as it having none.</Text>
            <Pressable onPress={() => void reread(true)} style={s.button} testID="stage-controls-reread" accessibilityRole="button" accessibilityLabel="Read this trip's stages again">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const stages = [...read.structure.stages].sort((a, b) => a.sequence - b.sequence);
  // The read answered and the trip has no stages: the composer beside this is where one is added.
  if (stages.length === 0) return null;

  return (
    <View style={s.wrap} testID="stage-controls">
      <Text style={s.heading}>Stage dates and progress</Text>
      {stages.map((st) => {
        const a = attempts[st.id];
        const busy = a?.result === 'pending';
        const res = a && a.result !== 'pending' ? a.result : null;
        const arrow = nextArrow(st.state);
        // A zone this phone cannot compute in cannot show the stage's dates, so
        // they are not offered for editing: an empty field would CLEAR them.
        const zoneOk = usableZone(st.timezone) !== null && [st.startsAt, st.endsAt].every((v) => v == null || Number.isFinite(Date.parse(v))); // and a served boundary it cannot parse would prefill as empty and CLEAR it
        const isEditing = zoneOk && editing === st.id;
        const draft = isEditing ? stageBoundsDraft({ starts, ends }, st.timezone) : null;
        const current: Bounds = { startsAt: st.startsAt, endsAt: st.endsAt };
        const next: Bounds | null = draft?.ready ? { startsAt: draft.value.startsAt ?? null, endsAt: draft.value.endsAt ?? null } : null;
        // Offered only when it would be sent: something changed and the two agree.
        const canSave = next !== null && stageBoundsCommand(st.id, current, next).ok;
        return (
          <View key={st.id} style={s.row} testID={`stage-control-${st.id}`}>
            <CalendarRange size={14} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{stageName(st)} · {STATE_LABEL[st.state] ?? st.state}</Text>
              <Text style={s.detail} testID={`stage-control-dates-${st.id}`}>
                Starts {boundaryWords(st.startsAt, st.timezone)} · Ends {boundaryWords(st.endsAt, st.timezone)} — {st.timezone}
              </Text>
              {!zoneOk ? <Text style={s.detail} testID={`stage-control-zone-unusable-${st.id}`}>{usableZone(st.timezone) === null ? 'This stage\'s time zone can\'t be used on this phone, so its dates can\'t be set here.' : 'This stage\'s saved dates can\'t be read on this phone, so they can\'t be changed here.'}</Text> : null}
              <View style={s.buttons}>
                {zoneOk ? <Pressable
                  disabled={busy}
                  onPress={() => {
                    if (isEditing) { setEditing(null); return; }
                    setEditing(st.id); setStarts(typedTimeOf(st.startsAt, st.timezone)); setEnds(typedTimeOf(st.endsAt, st.timezone));
                  }}
                  style={[s.button, isEditing && s.buttonOn, busy && { opacity: 0.5 }]} testID={`stage-control-edit-${st.id}`}
                  accessibilityRole="button" accessibilityLabel={isEditing ? `Stop setting dates for stage ${stageName(st)}` : `Set dates for stage ${stageName(st)}`} accessibilityState={{ selected: isEditing, disabled: busy }}
                >
                  <Text style={[s.buttonText, isEditing && s.buttonTextOn]}>{isEditing ? 'Cancel' : 'Set dates'}</Text>
                </Pressable> : null}
                {arrow ? (
                  <Pressable
                    disabled={busy}
                    onPress={() => void send(st, { kind: arrow, state: st.state }, stageControlKey(st.id, arrow))}
                    style={[s.button, busy && { opacity: 0.5 }]} testID={`stage-control-${arrow}-${st.id}`}
                    accessibilityRole="button" accessibilityLabel={`${arrow === 'start' ? 'Start' : 'Complete'} stage ${stageName(st)}`} accessibilityState={{ disabled: busy }}
                  >
                    <Text style={s.buttonText}>{arrow === 'start' ? 'Start stage' : 'Complete stage'}</Text>
                  </Pressable>
                ) : null}
              </View>

              {isEditing ? (
                <View testID={`stage-control-form-${st.id}`}>
                  <ZonedTimeField label="Starts" zone={st.timezone} zoneNote=" (the stage's)" value={starts} onChange={setStarts} testID={`stage-control-starts-${st.id}`} />
                  <ZonedTimeField label="Ends" zone={st.timezone} zoneNote=" (the stage's)" value={ends} onChange={setEnds} testID={`stage-control-ends-${st.id}`} />
                  {draft && draft.where === 'group' ? <Text style={[s.detail, { color: color.signal }]} testID={`stage-control-problem-${st.id}`}>{draft.problem}</Text> : null}
                  <Pressable
                    disabled={!canSave || busy}
                    onPress={() => { if (canSave && next) void send(st, { kind: 'dates', current, next }, stageControlKey(st.id, 'dates')); }}
                    style={[s.button, (!canSave || busy) && { opacity: 0.5 }]} testID={`stage-control-save-${st.id}`}
                    accessibilityRole="button" accessibilityLabel={`Save dates for stage ${stageName(st)}`} accessibilityState={{ disabled: !canSave || busy }}
                  >
                    <Text style={s.buttonText}>Save dates</Text>
                  </Pressable>
                </View>
              ) : null}

              {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID={`stage-control-busy-${st.id}`} accessibilityLabel="Saving" /> : null}
              {res?.state === 'recorded' ? (
                <View style={s.inline} testID={`stage-control-recorded-${st.id}`}>
                  <CheckCircle2 size={12} color={color.success} />
                  <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>{DONE_LABEL[a!.sent.kind]}{res.duplicate ? ' (already was)' : ''}</Text>
                </View>
              ) : res?.state === 'refused' ? (
                <Text style={[s.detail, { color: color.signal }]} testID={`stage-control-refused-${st.id}`}>Not changed — {res.detail}</Text>
              ) : res?.state === 'unavailable' ? (
                <View testID={`stage-control-unavailable-${st.id}`}>
                  <Text style={[s.detail, { color: color.signal }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was changed.</Text>
                  <Pressable onPress={() => void send(st, a!.sent, a!.key)} style={s.button} testID={`stage-control-retry-${st.id}`} accessibilityRole="button" accessibilityLabel={`Try that change to stage ${stageName(st)} again`}>
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
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
