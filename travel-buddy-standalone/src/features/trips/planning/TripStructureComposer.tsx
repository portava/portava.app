/**
 * TripStructureComposer — the product's writer for §5.1's stages, legs and
 * commitments, and §8's goals.
 *
 * TripStageSpineCard draws the stage spine (GET /trips/:tripId/structure) and
 * the decisions read serves goals; until this control nothing in the app could
 * ADD to either, so `trip_stages`, `trip_legs`, `trip_commitments` and
 * `trip_goals` stayed empty on every real trip (census-trips TR78, TR79, TR81,
 * TR84, and the lead's ruling that a table row is correct only when the product
 * can populate it). Each entry goes through the kernel (tripStructureEntries.ts).
 *
 * WHAT IT ASKS FOR, AND WHY NO MORE
 * =================================
 *   Stage       its type and its city. The city is the anchor 2760 requires;
 *               its time zone comes from the city (the canonical gateway's
 *               city rows carry one; the location registry does not), else
 *               from the trip, and is shown before anything is sent. A city
 *               with neither is said, and this phone's zone is OFFERED — used
 *               only on a tap, and labelled as the phone's. The position is
 *               the next free one on the spine, read from the structure.
 *   Leg         two different stages of this trip and how you travel between.
 *   Commitment  its type, how fixed it is, and optionally its stage.
 *   Goal        its type, priority, and whether it is the crew's or yours alone.
 * Dates and times are not asked for: every one of those columns is optional in
 * the table and nothing here pretends to know them.
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not claim a write it has not seen. "Added" is shown only on the
 * kernel's word; a refusal is shown with its reason; an unreachable kernel is
 * "nothing was added" with a retry of THE SAME command (same key, same
 * payload), so a retry can never add the row twice. A structure read that
 * failed is said, not drawn as a trip with no stages.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { CheckCircle2, Milestone } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import type { Place } from '../../../lib/location/placeTypes.ts';
import { GlobalPlacePicker } from '../../../components/selectors/GlobalPlacePicker.tsx';
import { GEO_FIELD_IDS } from '../../../platform/input-assistance/geographic/geoFields.ts';
import type { InputContext } from '../../../platform/input-assistance/types/inputContext.ts';
import { fetchTripStructure, fetchTripDecisions, type StructureRead, type DecisionRead } from './tripDecisions.ts'; import { TripItineraryPaste } from './TripItineraryPaste.tsx'; // census G160
import {
  addStage, addLeg, addCommitment, addGoal, structureEntryKey, nextStageSequence, isUuid,
  STAGE_TYPES, LEG_TYPES, COMMITMENT_TYPES, COMMITMENT_FLEXIBILITIES, GOAL_TYPES, GOAL_PRIORITIES, GOAL_SCOPES,
  type StageType, type LegType, type CommitmentType, type CommitmentFlexibility, type GoalType, type GoalPriority, type GoalScope,
  type StructureEntryResult,
} from './tripStructureEntries.ts'; import { StageBoundsFields, CommitmentDetailsFields } from './StructureDetailFields.tsx'; import { stageBoundsDraft, commitmentDetailsDraft, commitmentZone, EMPTY_STAGE_BOUNDS, EMPTY_COMMITMENT_DETAILS, type StageBoundsValue, type CommitmentDetailsValue } from './structureDetailDrafts.ts'; import type { StageBounds, CommitmentFields } from './tripStructureDetails.ts'; // census-trips TR13/TR15/TR78/TR122-TR127: boundaries and §7.1 fields

export type StructureKind = 'stage' | 'leg' | 'commitment' | 'goal';

/** The slice of GlobalPlacePicker this composer uses; a test hands in its own. */
export interface CityPickerProps {
  visible: boolean;
  onSelect: (place: Place) => void;
  onClose: () => void;
  mode?: 'all' | 'city';
  title?: string;
  usedFor?: string;
  /** Opts the picker into the canonical gateway, whose city rows carry a time zone. */
  assistContext?: InputContext;
  assistFieldId?: string;
}

interface Props {
  tripId: string;
  /** The trip's own time zone, used only when the picked city carries none. */
  tripTimezone?: string | null;
  onAdded?: (kind: StructureKind) => void;
  /** Test seams. */
  loadStructure?: typeof fetchTripStructure;
  loadDecisions?: typeof fetchTripDecisions;
  addStageEntry?: typeof addStage;
  addLegEntry?: typeof addLeg;
  addCommitmentEntry?: typeof addCommitment;
  addGoalEntry?: typeof addGoal;
  PlacePicker?: React.ComponentType<CityPickerProps>;
  deviceTimezone?: () => string | null;
}

const STAGE_LABEL: Record<StageType, string> = { city: 'City', transit: 'Transit', lodging: 'Lodging', excursion: 'Excursion', layover: 'Layover' };
const LEG_LABEL: Record<LegType, string> = { flight: 'Flight', train: 'Train', bus: 'Bus', ferry: 'Ferry', car: 'Car', walk: 'Walk', other: 'Other' };
const COMMITMENT_LABEL: Record<CommitmentType, string> = { lodging: 'Lodging', transport: 'Transport', event: 'Event', booking: 'Booking', meeting: 'Meeting', other: 'Other' };
const FLEX_LABEL: Record<CommitmentFlexibility, string> = { fixed: 'Fixed', shiftable: 'Can shift', flexible: 'Flexible' };
const GOAL_LABEL: Record<GoalType, string> = { rest: 'Rest', budget: 'Budget', experience: 'Experience', social: 'Social', logistics: 'Logistics', safety: 'Safety', other: 'Other' };
const PRIORITY_LABEL: Record<GoalPriority, string> = { low: 'Low', normal: 'Normal', high: 'High' };
const SCOPE_LABEL: Record<GoalScope, string> = { shared: 'Shared with the crew', personal: 'Just me' };
const KIND_LABEL: Record<StructureKind, string> = { stage: 'Stage', leg: 'Leg', commitment: 'Commitment', goal: 'Goal' };
const SUBMIT_LABEL: Record<StructureKind, string> = { stage: 'Add stage', leg: 'Add leg', commitment: 'Add commitment', goal: 'Add goal' };

type Stage = { id: string; stageType: string; sequence: number };
type PickedCity = { name: string; cityId: string | null; timezone: string | null; timezoneFrom: 'city' | 'trip' | 'device' | null };

/** This phone's IANA zone, or null where the runtime cannot say. Only ever used on an explicit tap. */
export function phoneTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

/** What one tap sent, kept whole so a retry re-sends exactly it. */
type Sent =
  | { kind: 'stage'; input: { stageType: string; cityId: string | null; timezone: string | null; sequence: number } & StageBounds }
  | { kind: 'leg'; input: { legType: string; fromStageId: string; toStageId: string } }
  | { kind: 'commitment'; input: { type: string; flexibility: string; stageId: string | null } & CommitmentFields }
  | { kind: 'goal'; input: { type: string; priority: string; scope: string } };
type Attempt = { sent: Sent; key: string; result: StructureEntryResult | 'pending' };

function stageName(s: Stage): string {
  return `${s.sequence}. ${STAGE_LABEL[s.stageType as StageType] ?? s.stageType}`;
}

function Chip({ label, on, onPress, testID, a11y }: { label: string; on: boolean; onPress: () => void; testID: string; a11y?: string }) {
  return (
    <Pressable
      onPress={onPress} style={[s.button, on && s.buttonOn]} testID={testID}
      accessibilityRole="button" accessibilityLabel={a11y ?? label} accessibilityState={{ selected: on }}
    >
      <Text style={[s.buttonText, on && s.buttonTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function TripStructureComposer({
  tripId, tripTimezone = null, onAdded,
  loadStructure = fetchTripStructure, loadDecisions = fetchTripDecisions,
  addStageEntry = addStage, addLegEntry = addLeg, addCommitmentEntry = addCommitment, addGoalEntry = addGoal,
  PlacePicker = GlobalPlacePicker, deviceTimezone = phoneTimezone,
}: Props) {
  const [mode, setMode] = useState<StructureKind | null>(null);
  const [structure, setStructure] = useState<StructureRead | undefined>(undefined);
  const [decisions, setDecisions] = useState<DecisionRead | undefined>(undefined);

  const [stageType, setStageType] = useState<StageType | null>(null);
  const [city, setCity] = useState<PickedCity | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false); const [bounds, setBounds] = useState<StageBoundsValue>(EMPTY_STAGE_BOUNDS);

  const [legType, setLegType] = useState<LegType | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);

  const [commitmentType, setCommitmentType] = useState<CommitmentType | null>(null);
  // The kernel's own default, shown selected rather than applied unseen.
  const [flexibility, setFlexibility] = useState<CommitmentFlexibility>('flexible');
  const [commitmentStage, setCommitmentStage] = useState<string | null>(null); const [details, setDetails] = useState<CommitmentDetailsValue>(EMPTY_COMMITMENT_DETAILS); const [detailsPhoneZone, setDetailsPhoneZone] = useState<string | null>(null);

  const [goalType, setGoalType] = useState<GoalType | null>(null);
  const [priority, setPriority] = useState<GoalPriority>('normal');
  const [scope, setScope] = useState<GoalScope>('shared');

  const [attempt, setAttempt] = useState<Attempt | null>(null);

  // A re-read replaces the answer when it arrives; only "Try again" clears it first.
  const readStructure = useCallback(async () => { setStructure(await loadStructure(tripId)); }, [tripId, loadStructure]);
  const readGoals = useCallback(async () => { setDecisions(await loadDecisions(tripId)); }, [tripId, loadDecisions]);

  useEffect(() => {
    let current = true;
    void loadStructure(tripId).then((r) => { if (current) setStructure(r); });
    return () => { current = false; };
  }, [tripId, loadStructure]);

  const stages: Stage[] = structure?.state === 'ok'
    ? [...structure.structure.stages].sort((a, b) => a.sequence - b.sequence)
    : [];
  const detailsZone = commitmentZone(structure?.state === 'ok' ? structure.structure.stages : [], commitmentStage, tripTimezone, detailsPhoneZone); // a commitment's times: its stage's zone, else the trip's, else this phone's once chosen
  const send = useCallback(async (sent: Sent, key: string) => {
    setAttempt({ sent, key, result: 'pending' });
    const result =
      sent.kind === 'stage' ? await addStageEntry(tripId, sent.input, key)
      : sent.kind === 'leg' ? await addLegEntry(tripId, sent.input, key)
      : sent.kind === 'commitment' ? await addCommitmentEntry(tripId, sent.input, key)
      : await addGoalEntry(tripId, sent.input, key);
    setAttempt({ sent, key, result });
    if (result.state === 'recorded') {
      if (sent.kind === 'stage') { setStageType(null); setCity(null); setBounds(EMPTY_STAGE_BOUNDS); }
      if (sent.kind === 'leg') { setLegType(null); setFromId(null); setToId(null); }
      if (sent.kind === 'commitment') { setCommitmentType(null); setFlexibility('flexible'); setCommitmentStage(null); setDetails(EMPTY_COMMITMENT_DETAILS); }
      if (sent.kind === 'goal') { setGoalType(null); setPriority('normal'); setScope('shared'); }
      onAdded?.(sent.kind);
    }
    // A stage, leg or commitment refused or added changes what the next one is
    // built from (the free position, the stages to choose); re-read rather than
    // build the next tap on a spine that is no longer the trip's.
    if (result.state !== 'unavailable') {
      if (sent.kind === 'goal') void readGoals(); else void readStructure();
    }
  }, [tripId, addStageEntry, addLegEntry, addCommitmentEntry, addGoalEntry, onAdded, readStructure, readGoals]);

  const draft = (): Sent | null => {
    switch (mode) {
      case 'stage':
        if (!stageType || !city || structure?.state !== 'ok' || !stageBoundsDraft(bounds, city.timezone).ready) return null;
        return { kind: 'stage', input: { stageType, cityId: city.cityId, timezone: city.timezone, sequence: nextStageSequence(stages), ...stageBoundsDraft(bounds, city.timezone).value } };
      case 'leg':
        if (!legType || !fromId || !toId || fromId === toId) return null;
        return { kind: 'leg', input: { legType, fromStageId: fromId, toStageId: toId } };
      case 'commitment':
        if (!commitmentType || !commitmentDetailsDraft(details, detailsZone.zone).ready) return null;
        return { kind: 'commitment', input: { type: commitmentType, flexibility, stageId: commitmentStage, ...commitmentDetailsDraft(details, detailsZone.zone).value } };
      case 'goal':
        if (!goalType) return null;
        return { kind: 'goal', input: { type: goalType, priority, scope } };
      default:
        return null;
    }
  };

  const onCity = (place: Place) => {
    setPickerOpen(false);
    const fromCity = typeof place.timezone === 'string' && place.timezone.trim() ? place.timezone.trim() : null;
    const tz = fromCity ?? (tripTimezone && tripTimezone.trim() ? tripTimezone.trim() : null);
    setCity({
      name: place.displayName || place.name,
      cityId: isUuid(place.canonicalId) ? place.canonicalId : null,
      timezone: tz,
      timezoneFrom: fromCity ? 'city' : tz ? 'trip' : null,
    });
  };

  const phoneZone = city && !city.timezone ? deviceTimezone() : null;
  const busy = attempt?.result === 'pending';
  const res = attempt && attempt.result !== 'pending' ? attempt.result : null;
  const next = draft();
  const stageAnchorOk = city !== null && city.cityId !== null && city.timezone !== null;
  const ready = next !== null && (mode !== 'stage' || stageAnchorOk);

  return (
    <View style={s.wrap} testID="trip-structure-composer">
      <View style={s.row}>
        <Milestone size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Add a stage, leg, commitment or goal</Text>
          <View style={s.buttons}>
            {(['stage', 'leg', 'commitment', 'goal'] as const).map((k) => (
              <Chip key={k} label={KIND_LABEL[k]} on={mode === k} onPress={() => { setMode(k); setAttempt(null); if (k === 'goal' && decisions === undefined) void readGoals(); }} testID={`structure-compose-${k}`} a11y={`Add a ${KIND_LABEL[k].toLowerCase()}`} />
            ))}
          </View>
          <TripItineraryPaste tripId={tripId} tripTimezone={tripTimezone} stages={stages} deviceTimezone={deviceTimezone} onAdded={() => onAdded?.('commitment')} />
          {mode && mode !== 'goal' ? (
            structure === undefined ? (
              <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="structure-compose-reading" accessibilityLabel="Reading this trip's stages" />
            ) : structure.state !== 'ok' ? (
              <View testID="structure-compose-read-failed">
                <Text style={[s.detail, { color: color.signalStrong }]}>
                  Couldn&apos;t read this trip&apos;s stages — {structure.state === 'off' ? 'not signed in' : structure.detail}
                </Text>
                <Pressable onPress={() => { setStructure(undefined); void readStructure(); }} style={s.button} testID="structure-compose-reread" accessibilityRole="button" accessibilityLabel="Read this trip's stages again">
                  <Text style={s.buttonText}>Try again</Text>
                </Pressable>
              </View>
            ) : null
          ) : null}

          {mode === 'stage' ? (
            <View testID="structure-compose-stage-form">
              <Text style={s.detail}>What kind of stage?</Text>
              <View style={s.buttons}>
                {STAGE_TYPES.map((v) => (
                  <Chip key={v} label={STAGE_LABEL[v]} on={stageType === v} onPress={() => setStageType(v)} testID={`stage-type-${v}`} />
                ))}
              </View>
              <Pressable onPress={() => setPickerOpen(true)} style={s.button} testID="stage-city-pick" accessibilityRole="button" accessibilityLabel="Choose the stage's city">
                <Text style={s.buttonText}>{city ? 'Change city' : 'Choose city'}</Text>
              </Pressable>
              {city ? (
                <View testID="stage-city-chosen">
                  <Text style={s.detail}>City: {city.name}</Text>
                  {city.cityId === null ? (
                    <Text style={[s.detail, { color: color.signalStrong }]} testID="stage-city-unmatched">That city couldn&apos;t be matched to a known city. Choose it again.</Text>
                  ) : null}
                  {city.timezone ? (
                    <Text style={s.detail} testID="stage-timezone">Time zone: {city.timezone}{city.timezoneFrom === 'trip' ? " (the trip's)" : city.timezoneFrom === 'device' ? " (this phone's)" : ''}</Text>
                  ) : (
                    <View testID="stage-timezone-missing">
                      <Text style={[s.detail, { color: color.signalStrong }]}>No time zone is known for that city.</Text>
                      {phoneZone ? (
                        <Chip label={`Use this phone's: ${phoneZone}`} on={false} onPress={() => setCity({ ...city, timezone: phoneZone, timezoneFrom: 'device' })} testID="stage-timezone-device" a11y={`Use this phone's time zone, ${phoneZone}`} />
                      ) : null}
                    </View>
                  )}
                </View>
              ) : null}
              <PlacePicker visible={pickerOpen} mode="city" title="Stage city" usedFor="trip_stage" assistContext="city_picker" assistFieldId={GEO_FIELD_IDS.cityPicker} onSelect={onCity} onClose={() => setPickerOpen(false)} />
              {city ? <StageBoundsFields value={bounds} onChange={setBounds} zone={city.timezone} zoneFrom={city.timezoneFrom} /> : null}</View>
          ) : null}

          {mode === 'leg' && structure?.state === 'ok' ? (
            stages.length < 2 ? (
              <Text style={s.detail} testID="structure-compose-leg-needs-stages">A leg joins two stages. Add two stages first.</Text>
            ) : (
              <View testID="structure-compose-leg-form">
                <Text style={s.detail}>From</Text>
                <View style={s.buttons}>
                  {stages.map((st) => (
                    <Chip key={st.id} label={stageName(st)} on={fromId === st.id} onPress={() => setFromId(st.id)} testID={`leg-from-${st.id}`} a11y={`From stage ${stageName(st)}`} />
                  ))}
                </View>
                <Text style={s.detail}>To</Text>
                <View style={s.buttons}>
                  {stages.map((st) => (
                    <Chip key={st.id} label={stageName(st)} on={toId === st.id} onPress={() => setToId(st.id)} testID={`leg-to-${st.id}`} a11y={`To stage ${stageName(st)}`} />
                  ))}
                </View>
                {fromId && toId && fromId === toId ? (
                  <Text style={[s.detail, { color: color.signalStrong }]} testID="leg-same-stage">A leg needs two different stages.</Text>
                ) : null}
                <Text style={s.detail}>How?</Text>
                <View style={s.buttons}>
                  {LEG_TYPES.map((v) => (
                    <Chip key={v} label={LEG_LABEL[v]} on={legType === v} onPress={() => setLegType(v)} testID={`leg-type-${v}`} />
                  ))}
                </View>
              </View>
            )
          ) : null}

          {mode === 'commitment' ? (
            <View testID="structure-compose-commitment-form">
              <Text style={s.detail}>What kind of commitment?</Text>
              <View style={s.buttons}>
                {COMMITMENT_TYPES.map((v) => (
                  <Chip key={v} label={COMMITMENT_LABEL[v]} on={commitmentType === v} onPress={() => setCommitmentType(v)} testID={`commitment-type-${v}`} />
                ))}
              </View>
              <Text style={s.detail}>How fixed is it?</Text>
              <View style={s.buttons}>
                {COMMITMENT_FLEXIBILITIES.map((v) => (
                  <Chip key={v} label={FLEX_LABEL[v]} on={flexibility === v} onPress={() => setFlexibility(v)} testID={`commitment-flex-${v}`} />
                ))}
              </View>
              <Text style={s.detail}>Stage</Text>
              <View style={s.buttons}>
                <Chip label="No stage" on={commitmentStage === null} onPress={() => setCommitmentStage(null)} testID="commitment-stage-none" />
                {stages.map((st) => (
                  <Chip key={st.id} label={stageName(st)} on={commitmentStage === st.id} onPress={() => setCommitmentStage(st.id)} testID={`commitment-stage-${st.id}`} a11y={`At stage ${stageName(st)}`} />
                ))}
              </View>
              <CommitmentDetailsFields value={details} onChange={setDetails} zone={detailsZone.zone} zoneFrom={detailsZone.from} phoneZone={detailsZone.zone ? null : deviceTimezone()} onUsePhoneZone={() => setDetailsPhoneZone(deviceTimezone())} /></View>
          ) : null}

          {mode === 'goal' ? (
            <View testID="structure-compose-goal-form">
              {decisions === undefined ? (
                <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="goal-list-reading" accessibilityLabel="Reading this trip's goals" />
              ) : decisions.state === 'ok' ? (
                <View testID="goal-list">
                  {decisions.board.goals.length === 0 ? (
                    <Text style={s.detail} testID="goal-list-empty">No goals yet.</Text>
                  ) : decisions.board.goals.map((g) => (
                    <Text key={g.id} style={s.detail} testID={`goal-${g.id}`}>
                      {GOAL_LABEL[g.type as GoalType] ?? g.type} · {PRIORITY_LABEL[g.priority as GoalPriority] ?? g.priority}{g.scope === 'personal' ? ' · just you' : ''}{g.status !== 'open' ? ` · ${g.status}` : ''}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text style={[s.detail, { color: color.signalStrong }]} testID="goal-list-failed">
                  Couldn&apos;t read this trip&apos;s goals — {decisions.state === 'off' ? 'not signed in' : decisions.detail}
                </Text>
              )}
              <Text style={s.detail}>What kind of goal?</Text>
              <View style={s.buttons}>
                {GOAL_TYPES.map((v) => (
                  <Chip key={v} label={GOAL_LABEL[v]} on={goalType === v} onPress={() => setGoalType(v)} testID={`goal-type-${v}`} />
                ))}
              </View>
              <Text style={s.detail}>Priority</Text>
              <View style={s.buttons}>
                {GOAL_PRIORITIES.map((v) => (
                  <Chip key={v} label={PRIORITY_LABEL[v]} on={priority === v} onPress={() => setPriority(v)} testID={`goal-priority-${v}`} a11y={`Priority ${PRIORITY_LABEL[v]}`} />
                ))}
              </View>
              <Text style={s.detail}>Whose goal?</Text>
              <View style={s.buttons}>
                {GOAL_SCOPES.map((v) => (
                  <Chip key={v} label={SCOPE_LABEL[v]} on={scope === v} onPress={() => setScope(v)} testID={`goal-scope-${v}`} />
                ))}
              </View>
            </View>
          ) : null}

          {mode ? (
            <Pressable
              disabled={!ready || busy}
              onPress={() => { const sent = draft(); if (sent) void send(sent, structureEntryKey(sent.kind)); }}
              style={[s.button, (!ready || busy) && { opacity: 0.5 }]}
              testID="structure-compose-submit" accessibilityRole="button" accessibilityLabel={SUBMIT_LABEL[mode]} accessibilityState={{ disabled: !ready || busy }}
            >
              <Text style={s.buttonText}>{SUBMIT_LABEL[mode]}</Text>
            </Pressable>
          ) : null}

          {busy ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="structure-compose-busy" accessibilityLabel="Adding" /> : null}
          {res?.state === 'recorded' ? (
            <View style={s.inline} testID="structure-compose-recorded">
              <CheckCircle2 size={12} color={color.success} />
              <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>Added{res.duplicate ? ' (already was)' : ''}</Text>
            </View>
          ) : res?.state === 'refused' ? (
            <Text style={[s.detail, { color: color.signalStrong }]} testID="structure-compose-refused">Not added — {res.detail}</Text>
          ) : res?.state === 'unavailable' ? (
            <View testID="structure-compose-unavailable">
              <Text style={[s.detail, { color: color.signalStrong }]}>Couldn&apos;t reach the trip — {res.detail}. Nothing was added.</Text>
              <Pressable onPress={() => attempt && void send(attempt.sent, attempt.key)} style={s.button} testID="structure-compose-retry" accessibilityRole="button" accessibilityLabel="Try adding it again">
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
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
