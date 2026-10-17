/**
 * The structure composer's optional time and §7.1 fields (census-trips TR13,
 * TR15, TR78, TR122–TR125, TR127):
 *
 *   StageBoundsFields        a stage's start and end, in the stage's zone.
 *   CommitmentDetailsFields  a commitment's start, the time to be there by,
 *                            how late is still fine, how long getting ready
 *                            takes, and how sure it is — in its stage's zone,
 *                            else the trip's, else this phone's once chosen.
 *
 * Every field is optional, as every column is. What a field means is said
 * before anything is sent, and a field that cannot be sent as typed keeps the
 * composer's submit disabled with the reason shown (structureDetailDrafts.ts).
 *
 * WHERE IS NOT ASKED FOR. `trip_commitments.place_id` names a `public.places`
 * row (tripFeasibility and the map read it so), and nothing this app can pick
 * returns one: the location registry's ids are cities, and a gateway venue is a
 * `discovery_places` id. Writing either into place_id would be a place nobody
 * can resolve, so the composer does not offer a place.
 */
import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';

import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { ZonedTimeField } from '../shared/ZonedTimeField.tsx';
import { CONFIDENCE_STEPS } from './tripStructureDetails.ts';
import { stageBoundsDraft, commitmentDetailsDraft, type StageBoundsValue, type CommitmentDetailsValue } from './structureDetailDrafts.ts';

const ZONE_NOTE: Record<string, string> = { stage: " (the stage's)", city: " (the city's)", trip: " (the trip's)", device: " (this phone's)" };

export function StageBoundsFields({ value, onChange, zone, zoneFrom }: {
  value: StageBoundsValue; onChange: (v: StageBoundsValue) => void; zone: string | null; zoneFrom: string | null;
}) {
  const draft = stageBoundsDraft(value, zone);
  const note = zoneFrom ? ZONE_NOTE[zoneFrom] ?? '' : '';
  return (
    <View testID="stage-bounds-fields">
      <Text style={s.detail}>Dates (optional)</Text>
      <ZonedTimeField label="Starts" zone={zone} zoneNote={note} value={value.starts} onChange={(starts) => onChange({ ...value, starts })} testID="stage-starts" />
      <ZonedTimeField label="Ends" zone={zone} zoneNote={note} value={value.ends} onChange={(ends) => onChange({ ...value, ends })} testID="stage-ends" />
      {draft.where === 'group' ? (
        <Text style={[s.detail, { color: color.signal }]} testID="stage-bounds-problem">{draft.problem}</Text>
      ) : null}
    </View>
  );
}

const CONFIDENCE_LABEL: Record<number, string> = { 0.25: 'Unlikely (25%)', 0.5: 'Maybe (50%)', 0.75: 'Likely (75%)', 1: 'Certain (100%)' };

function MinutesField({ label, value, onChange, testID }: { label: string; value: string; onChange: (v: string) => void; testID: string }) {
  return (
    <View style={s.row}>
      <TextInput
        value={value} onChangeText={onChange} keyboardType="number-pad" maxLength={5} placeholder="—" placeholderTextColor={color.faint}
        style={[s.input, { minWidth: 56 }]} testID={testID} accessibilityLabel={`${label}, in minutes`}
      />
      <Text style={[s.detail, { marginTop: 0 }]}>{label} (minutes)</Text>
    </View>
  );
}

export function CommitmentDetailsFields({ value, onChange, zone, zoneFrom, phoneZone, onUsePhoneZone }: {
  value: CommitmentDetailsValue; onChange: (v: CommitmentDetailsValue) => void;
  zone: string | null; zoneFrom: 'stage' | 'trip' | 'device' | null;
  /** This phone's zone, offered only when no stage or trip zone is known; used only on a tap. */
  phoneZone: string | null; onUsePhoneZone: () => void;
}) {
  const draft = commitmentDetailsDraft(value, zone);
  const note = zoneFrom ? ZONE_NOTE[zoneFrom] ?? '' : '';
  return (
    <View testID="commitment-details-fields">
      <Text style={s.detail}>Timing (optional)</Text>
      {zone === null ? (
        <View testID="commitment-zone-missing">
          <Text style={[s.detail, { color: color.signal }]}>No time zone is known for this trip or stage, so times can&apos;t be set yet.</Text>
          {phoneZone ? (
            <Pressable onPress={onUsePhoneZone} style={s.chip} testID="commitment-zone-device" accessibilityRole="button" accessibilityLabel={`Use this phone's time zone, ${phoneZone}`}>
              <Text style={s.chipText}>Use this phone&apos;s: {phoneZone}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ZonedTimeField label="Starts" zone={zone} zoneNote={note} value={value.starts} onChange={(starts) => onChange({ ...value, starts })} testID="commitment-starts" />
      <ZonedTimeField label="Be there by" zone={zone} zoneNote={note} value={value.arriveBy} onChange={(arriveBy) => onChange({ ...value, arriveBy })} testID="commitment-arrive-by" />
      <MinutesField label="Still fine if late by" value={value.lateness} onChange={(lateness) => onChange({ ...value, lateness })} testID="commitment-lateness" />
      <MinutesField label="Time needed to get ready" value={value.prep} onChange={(prep) => onChange({ ...value, prep })} testID="commitment-prep" />
      {draft.where === 'group' ? <Text style={[s.detail, { color: color.signal }]} testID="commitment-details-problem">{draft.problem}</Text> : null}
      <Text style={s.detail}>How sure is it?</Text>
      <View style={s.row}>
        <Pressable onPress={() => onChange({ ...value, confidence: null })} style={[s.chip, value.confidence === null && s.chipOn]} testID="commitment-confidence-none" accessibilityRole="button" accessibilityState={{ selected: value.confidence === null }} accessibilityLabel="Not stated">
          <Text style={[s.chipText, value.confidence === null && s.chipTextOn]}>Not stated</Text>
        </Pressable>
        {CONFIDENCE_STEPS.map((c) => (
          <Pressable key={c} onPress={() => onChange({ ...value, confidence: c })} style={[s.chip, value.confidence === c && s.chipOn]} testID={`commitment-confidence-${c}`} accessibilityRole="button" accessibilityState={{ selected: value.confidence === c }} accessibilityLabel={CONFIDENCE_LABEL[c]}>
            <Text style={[s.chipText, value.confidence === c && s.chipTextOn]}>{CONFIDENCE_LABEL[c]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  input: { ...t.small, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  chip: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  chipOn: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.small, color: color.ink },
  chipTextOn: { color: '#fff' },
});
