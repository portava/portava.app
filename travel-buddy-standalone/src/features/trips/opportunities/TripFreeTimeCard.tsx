/**
 * TripFreeTimeCard — TM-live (WP-11) TRIP-F21, part one: §7.3 freedom windows,
 * §13 opportunities per window, and §11.3 "I'm bored". census-trips TR133,
 * TR186, TR195, TR197.
 *
 *   - Free time: the server's windows (and whether they are certified), with
 *     the options §13 compiled for each; a conflict count when there is one.
 *   - "I'm bored": the window containing now and what can be done in it, or
 *     the server's own sentence for "not free now" / "nothing compiled".
 *   - "Add to plan": ADD_PLAN through the kernel; shown as added only when the
 *     server says so, and refused by name when the kernel is off.
 *
 * Discovery is withheld when the server's §17.2 switch is not NORMAL, in the
 * server's words. A failed or refused projection is "couldn't load", never a
 * free day. Off renders nothing.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Clock, Sparkles } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { failureLine } from '../../live/liveApi.ts';
import {
  fetchFreedomWindows, fetchTripOpportunities, fetchBored, acceptOpportunity, writeLine,
  type TripRead, type FreedomView, type OpportunitiesView, type BoredView, type TripExperience,
} from './tripFreeTime.ts';

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '?';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '?';
}

export function TripFreeTimeCard({ tripId }: { tripId: string }) {
  const [free, setFree] = useState<TripRead<FreedomView> | undefined>(undefined);
  const [opps, setOpps] = useState<TripRead<OpportunitiesView> | undefined>(undefined);
  const [bored, setBored] = useState<TripRead<BoredView> | null>(null);
  const [asking, setAsking] = useState(false);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFree(undefined); setOpps(undefined);
    const [f, o] = await Promise.all([fetchFreedomWindows(tripId), fetchTripOpportunities(tripId)]);
    setFree(f); setOpps(o);
  }, [tripId]);
  useEffect(() => { void load(); }, [load]);

  const askBored = useCallback(async () => {
    setAsking(true);
    setBored(await fetchBored(tripId));
    setAsking(false);
  }, [tripId]);

  const add = useCallback(async (e: TripExperience) => {
    if (busy) return;
    setBusy(true);
    const r = await acceptOpportunity(tripId, e.id);
    setBusy(false);
    setAdded((m) => ({ ...m, [e.id]: r.ok ? (r.value.duplicate ? 'Already in your plan.' : 'Added to your plan (tentative).') : writeLine(r) }));
  }, [busy, tripId]);

  if (free?.state === 'off' && opps?.state !== 'ok') return null;

  const byWindow = new Map((opps?.state === 'ok' ? opps.value.windows : []).map((w) => [w.windowId, w]));

  const option = (where: string) => (e: TripExperience) => (
    <View key={e.id} style={s.option} testID={`trip-${where}-option-${e.id}`}>
      <View style={{ flex: 1 }}>
        <Text style={s.optTitle}>{e.name}</Text>
        <Text style={s.meta}>{hhmm(e.arriveAt)}–{hhmm(e.leaveBy)}{e.stayMinutes ? ` · ${e.stayMinutes} min there` : ''}</Text>
        {e.explanation.slice(0, 1).map((x) => <Text key={x} style={s.meta}>{x}</Text>)}
        {added[e.id] ? <Text style={s.note} testID={`trip-${where}-option-${e.id}-result`}>{added[e.id]}</Text> : null}
      </View>
      {!added[e.id] || !added[e.id].startsWith('Added') ? (
        <Pressable style={s.chip} disabled={busy} onPress={() => void add(e)} testID={`trip-${where}-option-${e.id}-add`}><Text style={s.chipText}>Add to plan</Text></Pressable>
      ) : null}
    </View>
  );

  return (
    <View style={s.wrap} testID="trip-free-time-card">
      <View style={s.headRow}><Clock size={16} color={color.deep} /><Text style={s.title}>Free time</Text></View>

      {free === undefined ? <ActivityIndicator size="small" color={color.signal} testID="trip-free-loading" />
        : free.state === 'failed' ? (
          <View testID="trip-free-failed">
            <Text style={s.error}>{failureLine(free.call, 'your free time')}</Text>
            <Pressable onPress={() => void load()} testID="trip-free-retry"><Text style={s.action}>Try again</Text></Pressable>
          </View>
        ) : free.state === 'ok' ? (
          <>
            {free.value.windows.length === 0 ? <Text style={s.detail} testID="trip-free-none">{free.value.reading || 'No free windows on this timeline.'}</Text> : null}
            {free.value.conflicts.length > 0 ? <Text style={s.error} testID="trip-free-conflicts">{free.value.conflicts.length} timing conflict{free.value.conflicts.length === 1 ? '' : 's'} on this trip — free time around them may be wrong.</Text> : null}
            {free.value.windows.slice(0, 4).map((w) => {
              const p = byWindow.get(w.id);
              return (
                <View key={w.id} style={s.window} testID={`trip-window-${w.id}`}>
                  <Text style={s.optTitle}>{hhmm(w.beginsAt)}–{hhmm(w.endsAt)} · {w.durationMinutes} min{w.certified ? '' : ' (estimate)'}</Text>
                  {w.requiredDestination ? <Text style={s.meta}>then be at your next commitment by {hhmm(w.requiredDestination.arriveBy)}</Text> : null}
                  {opps?.state === 'ok' && opps.value.suppressed ? null : p ? p.executable.slice(0, 2).map(option('window')) : null}
                </View>
              );
            })}
          </>
        ) : null}

      {opps?.state === 'failed' ? <Text style={s.error} testID="trip-opps-failed">{failureLine(opps.call, 'options for your free time')}</Text> : null}
      {opps?.state === 'ok' && opps.value.suppressed ? (
        <Text style={s.detail} testID="trip-opps-suppressed">Suggestions are held back while the trip is in {opps.value.attentionMode.replace(/_/g, ' ').toLowerCase()} — {opps.value.reading}</Text>
      ) : null}

      <Pressable style={s.goBtn} disabled={asking} onPress={() => void askBored()} testID="trip-bored">
        <Sparkles size={12} color={color.onInk} /><Text style={s.goText}>I'm bored</Text>
      </Pressable>
      {asking ? <ActivityIndicator size="small" color={color.signal} /> : null}
      {bored?.state === 'failed' ? <Text style={s.error} testID="trip-bored-failed">{failureLine(bored.call, 'what you could do now')}</Text> : null}
      {bored?.state === 'off' ? <Text style={s.detail} testID="trip-bored-off">This isn't switched on in this build.</Text> : null}
      {bored?.state === 'ok' ? (
        <View testID="trip-bored-answer">
          <Text style={s.detail}>{bored.value.readings.window}</Text>
          {bored.value.candidates && !bored.value.candidates.suppressed ? bored.value.candidates.executable.slice(0, 4).map(option('bored')) : null}
          <Text style={s.meta} testID="trip-bored-reading">{bored.value.readings.candidates}</Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs, ...shadow.card },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  window: { paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, gap: 2 },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  optTitle: { ...t.bodyStrong, color: color.ink },
  detail: { ...t.small, color: color.ink },
  meta: { ...t.stamp, color: color.mute },
  error: { ...t.small, color: color.warn },
  note: { ...t.small, color: color.deep },
  action: { ...t.stamp, color: color.deep, fontWeight: '600' },
  chip: { paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.stamp, color: color.ink },
  goBtn: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', marginTop: space.sm, paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: color.deep },
  goText: { ...t.stamp, color: color.onInk, fontWeight: '700' },
});
