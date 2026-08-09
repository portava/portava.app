/**
 * LayoverPlanSection — the mini-itinerary. Ordered stops, fit-vs-window
 * meter, inline add form, and the non-negotiable "back at the airport"
 * terminal row.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, Switch, ActivityIndicator,
} from 'react-native';
import {
  ArrowDown, ArrowUp, ListChecks, Plane, Plus, Trash2, X,
} from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
import {
  addPlanStop, deletePlanStop, reorderPlanStops,
  type PlanFit, type PlanStop, type StopsResponse,
} from '../../services/layover.ts';

interface Props {
  sessionId: string;
  stops: PlanStop[];
  planFit: PlanFit;
  timezone: string;
  canEdit: boolean;
  onChanged: (res: StopsResponse) => void;
  onError: (msg: string) => void;
}

const DUR_CHOICES = [30, 45, 60, 90, 120];
const TRAVEL_CHOICES = [0, 10, 20, 30, 45];

export function LayoverPlanSection({
  sessionId, stops, planFit, timezone, canEdit, onChanged, onError,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [durationMin, setDurationMin] = useState(60);
  const [travelMin, setTravelMin] = useState(20);
  const [insideAirport, setInsideAirport] = useState(false);

  const run = async (fn: () => Promise<StopsResponse | null>, failMsg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      if (res) onChanged(res);
      else onError(failMsg);
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () => {
    const name = title.trim();
    if (!name) { onError('Give the stop a name first.'); return; }
    run(
      () => addPlanStop(sessionId, {
        title: name, durationMin, travelMin: insideAirport ? 0 : travelMin, insideAirport,
      }),
      'Could not add the stop.',
    ).then(() => { setTitle(''); setAdding(false); });
  };

  const handleMove = (index: number, dir: -1 | 1) => {
    const next = [...stops];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    run(() => reorderPlanStops(sessionId, next.map((s) => s.id)), 'Could not reorder.');
  };

  const handleDelete = (stopId: string) =>
    run(() => deletePlanStop(sessionId, stopId), 'Could not remove the stop.');

  const pct = planFit.usableMinutes > 0
    ? Math.min(100, (planFit.neededMin / planFit.usableMinutes) * 100)
    : 100;

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <ListChecks size={18} color={color.ink} />
        <Text style={styles.heading}>Your mini-plan</Text>
        {busy && <ActivityIndicator size="small" color={color.deep} />}
      </View>

      {/* Fit meter */}
      {stops.length > 0 && (
        <View style={styles.fitBox}>
          <View style={styles.fitTrack}>
            <View style={[
              styles.fitFill,
              { width: `${pct}%`, backgroundColor: planFit.fitsWindow ? color.success : color.signal },
            ]} />
          </View>
          <Text style={styles.fitText}>
            {planFit.fitsWindow
              ? `Planned ${fmtDur(planFit.totalPlannedMin)} of ${fmtDur(planFit.usableMinutes)} usable — fits with room`
              : `Over by ${fmtDur(planFit.overflowMin)} — trim ${stops.length > 1 ? 'a stop' : 'this stop'} or shorten it`}
          </Text>
        </View>
      )}

      {stops.length === 0 && (
        <Text style={styles.empty}>
          No stops yet. Add one below or tap “Add to plan” on a recommendation.
        </Text>
      )}

      {stops.map((s, i) => (
        <View key={s.id} style={styles.stopRow}>
          <View style={styles.orderCol}>
            <Text style={styles.orderNum}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stopTitle} numberOfLines={1}>{s.title}</Text>
            <View style={styles.stopMeta}>
              <Text style={styles.metaStamp}>{fmtDur(s.durationMin)}</Text>
              {!s.insideAirport && s.travelMin > 0 && (
                <Text style={styles.metaStamp}>+{s.travelMin}m travel</Text>
              )}
              {s.insideAirport && <Text style={[styles.metaStamp, { color: color.deep }]}>in airport</Text>}
              {s.locationLabel ? <Text style={styles.metaStamp} numberOfLines={1}>{s.locationLabel}</Text> : null}
            </View>
          </View>
          {canEdit && (
            <View style={styles.stopActions}>
              <Pressable hitSlop={6} disabled={i === 0} onPress={() => handleMove(i, -1)}>
                <ArrowUp size={16} color={i === 0 ? color.haze : color.mute} />
              </Pressable>
              <Pressable hitSlop={6} disabled={i === stops.length - 1} onPress={() => handleMove(i, 1)}>
                <ArrowDown size={16} color={i === stops.length - 1 ? color.haze : color.mute} />
              </Pressable>
              <Pressable hitSlop={6} onPress={() => handleDelete(s.id)}>
                <Trash2 size={16} color={color.signalDim} />
              </Pressable>
            </View>
          )}
        </View>
      ))}

      {/* Hard terminal row — always the last line of any plan */}
      {stops.length > 0 && (
        <View style={styles.terminalRow}>
          <Plane size={14} color={color.signal} />
          <Text style={styles.terminalText}>
            Back at {`the airport`} by <Text style={styles.terminalTime}>{fmtClock(planFit.backByTime, timezone)}</Text> — no exceptions
          </Text>
        </View>
      )}

      {/* Add stop */}
      {canEdit && !adding && (
        <Pressable style={styles.addBtn} onPress={() => setAdding(true)}>
          <Plus size={15} color={color.deep} />
          <Text style={styles.addBtnText}>Add a stop</Text>
        </Pressable>
      )}

      {canEdit && adding && (
        <View style={styles.form}>
          <View style={styles.formHead}>
            <Text style={styles.formTitle}>New stop</Text>
            <Pressable hitSlop={8} onPress={() => setAdding(false)}><X size={16} color={color.mute} /></Pressable>
          </View>
          <TextInput
            style={styles.input}
            placeholder="e.g. Ramen at the old market"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={setTitle}
          />
          <Text style={styles.formLabel}>How long there?</Text>
          <View style={styles.chipRow}>
            {DUR_CHOICES.map((d) => (
              <Pressable key={d} style={[styles.chip, durationMin === d && styles.chipActive]} onPress={() => setDurationMin(d)}>
                <Text style={[styles.chipText, durationMin === d && styles.chipTextActive]}>{fmtDur(d)}</Text>
              </Pressable>
            ))}
          </View>
          {!insideAirport && (
            <>
              <Text style={styles.formLabel}>Travel time (one way)</Text>
              <View style={styles.chipRow}>
                {TRAVEL_CHOICES.map((d) => (
                  <Pressable key={d} style={[styles.chip, travelMin === d && styles.chipActive]} onPress={() => setTravelMin(d)}>
                    <Text style={[styles.chipText, travelMin === d && styles.chipTextActive]}>{d === 0 ? 'none' : `${d}m`}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <View style={styles.switchRow}>
            <Text style={styles.formLabel}>Inside the airport</Text>
            <Switch value={insideAirport} onValueChange={setInsideAirport} trackColor={{ true: color.deep, false: color.haze }} />
          </View>
          <Pressable style={[styles.saveBtn, busy && { opacity: 0.6 }]} onPress={handleAdd} disabled={busy}>
            <Text style={styles.saveBtnText}>Add to plan</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink, flex: 1 },
  empty:     { ...t.small, color: color.faint },

  fitBox:    { gap: 6 },
  fitTrack:  { height: 6, borderRadius: 3, backgroundColor: color.haze, overflow: 'hidden' },
  fitFill:   { height: 6, borderRadius: 3 },
  fitText:   { ...t.small, color: color.mute },

  stopRow:   { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  orderCol:  { width: icon.s26, height: icon.s26, borderRadius: icon.s26 / 2, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' },
  orderNum:  { ...t.stamp, color: color.mute },
  stopTitle: { ...t.bodyStrong, color: color.ink },
  stopMeta:  { flexDirection: 'row', gap: space.sm, marginTop: 2, flexWrap: 'wrap' },
  metaStamp: { ...t.stamp, color: color.faint },
  stopActions: { flexDirection: 'row', gap: space.md, alignItems: 'center' },

  terminalRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: 'rgba(255,77,46,0.08)', borderRadius: radius.md, padding: space.md },
  terminalText:{ ...t.small, color: color.ink, flex: 1 },
  terminalTime:{ fontWeight: '800', color: color.signalDim },

  addBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: color.deep, borderStyle: 'dashed', borderRadius: radius.md, paddingVertical: space.md },
  addBtnText:{ ...t.bodyStrong, color: color.deep },

  form:      { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm },
  formHead:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  formTitle: { ...t.bodyStrong, color: color.ink },
  input:     { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.md, ...t.body, color: color.ink },
  formLabel: { ...t.stamp, color: color.mute, marginTop: 4 },
  chipRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip:      { borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.paperRaised },
  chipActive:{ backgroundColor: color.ink, borderColor: color.ink },
  chipText:  { ...t.small, color: color.mute },
  chipTextActive: { color: color.onInk },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  saveBtn:   { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: 4 },
  saveBtnText: { ...t.bodyStrong, color: color.onInk },
});
