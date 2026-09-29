/**
 * TripRegroupCard — TM-live (WP-11) TRIP-F19: §11.3 "Return / regroup" and
 * §10.4 meeting checkpoints on the trip screen. census-trips TR170, TR177.
 *
 *   - "Where should we meet?" asks §14.3 for a meeting point (positions come
 *     through the crew map, every §10 rule first) and shows the recommended
 *     place, its reasoning and who could not be placed.
 *   - "Regroup here" / "Call a regroup" agrees a checkpoint through the kernel.
 *   - Each open checkpoint lists everyone's arrival state; I set mine
 *     (on the way / arrived / running late); the caller or host closes it.
 *
 * Nothing is shown as done until the server says it is: a write the kernel
 * did not take (off in this build, not a participant, not the host) is said
 * by name, and the list is re-read after every write. A failed read of the
 * checkpoints is "couldn't load", never "no checkpoints". Off renders nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Users, MapPin } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { failureLine } from '../../live/liveApi.ts';
import {
  fetchCheckpoints, previewMeetingPoint, callRegroup, setArrival, closeCheckpoint, actionKey, refusalLine, ARRIVAL_WORDS,
  type RegroupRead, type MeetingCheckpoint, type MeetingPoint, type ArrivalState,
} from './tripRegroup.ts';

function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
}

/** "2 arrived · 1 on the way · 1 not yet" — the crew's states without naming anyone's position. */
export function arrivalSummary(cp: MeetingCheckpoint): string {
  const counts = new Map<string, number>();
  for (const p of cp.participants) counts.set(String(p.arrivalState), (counts.get(String(p.arrivalState)) ?? 0) + 1);
  const order = ['arrived', 'en_route', 'late', 'pending', 'no_show'];
  const parts = [...counts.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, n]) => `${n} ${ARRIVAL_WORDS[k] ?? k}`);
  return parts.length > 0 ? parts.join(' · ') : 'No one is listed for this checkpoint.';
}

export function TripRegroupCard({ tripId }: { tripId: string }) {
  const [list, setList] = useState<RegroupRead<MeetingCheckpoint[]> | undefined>(undefined);
  const [point, setPoint] = useState<MeetingPoint | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per user action, kept until that action succeeds, so a retry is one kernel command.
  const keys = useRef(new Map<string, string>());
  const keyFor = (action: string) => { const k = keys.current.get(action) ?? actionKey(action); keys.current.set(action, k); return k; };

  const load = useCallback(async () => { setList(undefined); setList(await fetchCheckpoints(tripId)); }, [tripId]);
  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (action: string, fn: (key: string) => Promise<{ ok: true } | { ok: false; kind: any; reason: string; detail: string }>, done: string) => {
    if (busy) return;
    setBusy(true);
    const r = await fn(keyFor(action));
    setBusy(false);
    if (!r.ok) { setNote(refusalLine(r as any)); return; }
    keys.current.delete(action);
    setNote(done);
    void load();
  }, [busy, load]);

  const suggest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const r = await previewMeetingPoint(tripId);
    setBusy(false);
    if (!r.ok) { setNote(refusalLine(r)); setPoint(null); return; }
    setNote(null);
    setPoint(r.value);
  }, [busy, tripId]);

  if (list?.state === 'off') return null;

  return (
    <View style={s.wrap} testID="trip-regroup-card">
      <View style={s.headRow}><Users size={16} color={color.deep} /><Text style={s.title}>Regroup</Text></View>

      {list === undefined ? <ActivityIndicator size="small" color={color.signal} testID="trip-regroup-loading" />
        : list.state === 'failed' ? (
          <View testID="trip-regroup-failed">
            <Text style={s.error}>{failureLine(list.call, 'meeting checkpoints')}</Text>
            <Pressable onPress={() => void load()} testID="trip-regroup-retry"><Text style={s.action}>Try again</Text></Pressable>
          </View>
        ) : list.value.length === 0 ? <Text style={s.detail} testID="trip-regroup-none">No open meeting checkpoints.</Text>
        : list.value.map((cp) => (
          <View key={cp.id} style={s.checkpoint} testID={`trip-checkpoint-${cp.id}`}>
            <Text style={s.cpTitle}><MapPin size={12} color={color.deep} /> {cp.label}{hhmm(cp.meetAt) ? ` · ${hhmm(cp.meetAt)}` : ''}</Text>
            <Text style={s.detail}>{cp.pendingCount === 0 ? 'Everyone expected is here.' : `${cp.pendingCount} still expected`}</Text>
            <Text style={s.meta} testID={`trip-checkpoint-${cp.id}-states`}>{arrivalSummary(cp)}</Text>
            <View style={s.chips}>
              {(['en_route', 'arrived', 'late'] as ArrivalState[]).map((st) => (
                <Pressable key={st} style={s.chip} disabled={busy} testID={`trip-checkpoint-${cp.id}-${st}`}
                  onPress={() => void run(`arrival:${cp.id}:${st}`, (k) => setArrival(tripId, cp.id, st, k), `Marked you as ${ARRIVAL_WORDS[st]}.`)}>
                  <Text style={s.chipText}>{ARRIVAL_WORDS[st]}</Text>
                </Pressable>
              ))}
              <Pressable style={s.chip} disabled={busy} testID={`trip-checkpoint-${cp.id}-met`}
                onPress={() => void run(`close:${cp.id}:met`, (k) => closeCheckpoint(tripId, cp.id, 'met', k), 'Closed — everyone met.')}>
                <Text style={s.chipText}>We met</Text>
              </Pressable>
              <Pressable style={s.chip} disabled={busy} testID={`trip-checkpoint-${cp.id}-cancel`}
                onPress={() => void run(`close:${cp.id}:cancelled`, (k) => closeCheckpoint(tripId, cp.id, 'cancelled', k), 'Checkpoint cancelled.')}>
                <Text style={s.chipText}>Cancel it</Text>
              </Pressable>
            </View>
          </View>
        ))}

      {point ? (
        <View style={s.point} testID="trip-meeting-point">
          {point.recommended ? (
            <>
              <Text style={s.cpTitle}>Meet at {point.recommended.name}</Text>
              <Text style={s.meta}>Longest journey {point.recommended.longestJourneyMinutes} min · crew total {point.recommended.groupBurdenMinutes} min</Text>
              {point.recommended.explanation.slice(0, 3).map((e) => <Text key={e} style={s.meta}>• {e}</Text>)}
            </>
          ) : <Text style={s.detail} testID="trip-meeting-point-none">No meeting point could be worked out.</Text>}
          {point.explanation.slice(0, 2).map((e) => <Text key={e} style={s.meta}>{e}</Text>)}
          {point.unplaced.length > 0 ? <Text style={s.meta}>{point.unplaced.length} of the crew couldn't be placed (no shared location).</Text> : null}
          {point.recommended ? (
            <Pressable style={s.goBtn} disabled={busy} testID="trip-regroup-here"
              onPress={() => void run(`regroup:${point.recommended!.candidateId}`, (k) => callRegroup(tripId, { candidateId: point.recommended!.candidateId, idempotencyKey: k }), `Regroup called at ${point.recommended!.name}.`)}>
              <Text style={s.goText}>Regroup here</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={s.chips}>
        <Pressable style={s.chip} disabled={busy} onPress={() => void suggest()} testID="trip-meeting-point-ask"><Text style={s.chipText}>Where should we meet?</Text></Pressable>
        <Pressable style={s.chip} disabled={busy} testID="trip-regroup-call"
          onPress={() => void run('regroup:recommended', (k) => callRegroup(tripId, { idempotencyKey: k }), 'Regroup called — the crew has a meeting checkpoint.')}>
          <Text style={s.chipText}>Call a regroup</Text>
        </Pressable>
      </View>
      {note ? <Text style={s.note} testID="trip-regroup-note">{note}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs, ...shadow.card },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  checkpoint: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, gap: 2 },
  cpTitle: { ...t.bodyStrong, color: color.ink },
  point: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, gap: 2 },
  detail: { ...t.small, color: color.ink },
  meta: { ...t.stamp, color: color.mute },
  error: { ...t.small, color: color.warn },
  note: { ...t.small, color: color.deep },
  action: { ...t.stamp, color: color.deep, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  chip: { paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.stamp, color: color.ink },
  goBtn: { alignSelf: 'flex-start', marginTop: space.xs, paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: color.deep },
  goText: { ...t.stamp, color: color.onInk, fontWeight: '700' },
});
