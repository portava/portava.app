/**
 * ZonedTimeField — one date + time, typed as the wall clock reads in a NAMED
 * zone that the field states, and read back to the person before anything is
 * sent: "Fri 23 Oct 2026, 19:00 (GMT+7)".
 *
 * The date is year-month-day and the time is 24-hour, so nothing about it
 * depends on the phone's locale or its own zone. A time the clocks skip is
 * said and not moved; a time that happens twice offers both and sends neither
 * until one is chosen; with no zone known the field is closed and says so
 * (shared/tripLocalTime.ts holds the rules). Controlled: the parent keeps the
 * value and reads it with `readTypedTime`.
 */
import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';

import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { readTypedTime, typedTimeProblem, offsetWords, dateWords, type TypedTime } from './tripLocalTime.ts';

interface Props {
  label: string;
  zone: string | null;
  /** Whose zone it is, said after it: " (the stage's)", " (this phone's)". */
  zoneNote?: string;
  value: TypedTime;
  onChange: (v: TypedTime) => void;
  testID: string;
}

export function ZonedTimeField({ label, zone, zoneNote = '', value, onChange, testID }: Props) {
  const r = readTypedTime(value, zone);
  const problem = typedTimeProblem(r, zone);
  const open = zone !== null;
  return (
    <View testID={testID}>
      <Text style={s.detail}>{label}{zone ? ` — ${zone}${zoneNote}` : ''}</Text>
      <View style={s.row}>
        <TextInput
          value={value.date} editable={open} onChangeText={(date) => onChange({ ...value, date, pick: null })}
          placeholder="YYYY-MM-DD" placeholderTextColor={color.faint} maxLength={10} autoCorrect={false}
          style={[s.input, s.date, !open && s.closed]} testID={`${testID}-date`} accessibilityLabel={`${label}: date, as year-month-day`}
        />
        <TextInput
          value={value.time} editable={open} onChangeText={(time) => onChange({ ...value, time, pick: null })}
          placeholder="HH:MM" placeholderTextColor={color.faint} maxLength={5} autoCorrect={false}
          style={[s.input, s.time, !open && s.closed]} testID={`${testID}-time`} accessibilityLabel={`${label}: time, 24-hour`}
        />
        {value.date || value.time ? (
          <Pressable onPress={() => onChange({ date: '', time: '', pick: null })} style={s.clear} testID={`${testID}-clear`} accessibilityRole="button" accessibilityLabel={`Clear ${label.toLowerCase()}`}>
            <Text style={s.clearText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      {r.kind === 'ok' ? (
        <Text style={s.detail} testID={`${testID}-reads`}>{dateWords(value.date.trim())}, {value.time.trim()} ({offsetWords(r.iso)})</Text>
      ) : problem ? (
        <Text style={[s.detail, { color: color.signal }]} testID={`${testID}-problem`}>{problem}</Text>
      ) : null}
      {r.kind === 'twice' ? (
        <View style={s.row}>
          {(['earlier', 'later'] as const).map((which) => (
            <Pressable
              key={which} onPress={() => onChange({ ...value, pick: which })} style={s.chip}
              testID={`${testID}-pick-${which}`} accessibilityRole="button"
              accessibilityLabel={`The ${which === 'earlier' ? 'first' : 'second'} ${value.time.trim()}, ${offsetWords(which === 'earlier' ? r.earlier : r.later)}`}
            >
              <Text style={s.chipText}>{which === 'earlier' ? 'First' : 'Second'} ({offsetWords(which === 'earlier' ? r.earlier : r.later)})</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  detail: { ...t.stamp, color: color.mute, marginTop: space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  input: { ...t.small, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  date: { minWidth: 112 },
  time: { minWidth: 64 },
  closed: { opacity: 0.5 },
  clear: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  clearText: { ...t.small, color: color.mute },
  chip: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.small, color: color.ink },
});
