/**
 * TripReplanCard — TM-live (WP-11) TRIP-F21, part two: §11.3 "Replan today",
 * §12.1 simulatePlan, §9.4 impact preview, and §16 Trip Pulse. census-trips
 * TR196, TR209.
 *
 *   - "Replan today" asks for a candidate diff. It NEVER changes the plan: the
 *     card says so, lists each proposed move / cancel / add with the server's
 *     reason, and offers two read-only checks per change — Simulate (is the
 *     schedule it implies feasible?) and Impact (who and what it touches).
 *   - "Send as proposals" is the only write: shared changes become proposals
 *     the crew votes on (CREATE_PROPOSAL, kernel only). The server's own word
 *     on what it created or skipped is shown.
 *   - Trip Pulse: how many signals the server kept for this trip, and which of
 *     its sources could not be read — an unread source is named, never
 *     silently a quiet trip.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Shuffle, Radio } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { failureLine } from '../../live/liveApi.ts';
import {
  replanToday, simulateChange, previewChange, fetchTripPulse, changeOf, writeLine,
  type TripRead, type TripWrite, type ReplanView, type ReplanEntry, type TripPulseView,
} from './tripFreeTime.ts';

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '?';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '?';
}
const OP_WORDS: Record<string, string> = { move: 'Move', cancel: 'Cancel', add: 'Add', keep: 'Keep' };

export function TripReplanCard({ tripId }: { tripId: string }) {
  const [pulse, setPulse] = useState<TripRead<TripPulseView> | undefined>(undefined);
  const [plan, setPlan] = useState<TripWrite<ReplanView> | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const loadPulse = useCallback(async () => { setPulse(undefined); setPulse(await fetchTripPulse(tripId)); }, [tripId]);
  useEffect(() => { void loadPulse(); }, [loadPulse]);

  const replan = useCallback(async () => {
    if (busy) return;
    setBusy(true); setChecks({}); setSent(null);
    setPlan(await replanToday(tripId));
    setBusy(false);
  }, [busy, tripId]);

  const check = useCallback(async (i: number, e: ReplanEntry, what: 'simulate' | 'impact') => {
    const change = changeOf(e);
    if (!change) return;
    const key = `${i}:${what}`;
    setChecks((c) => ({ ...c, [key]: '…' }));
    if (what === 'simulate') {
      const r = await simulateChange(tripId, change);
      setChecks((c) => ({ ...c, [key]: r.ok ? `${r.value.feasibility === 'FEASIBLE' ? 'Feasible' : r.value.feasibility === 'INFEASIBLE' ? `Not feasible — ${r.value.conflicts} conflict${r.value.conflicts === 1 ? '' : 's'}` : "Can't tell"}. ${r.value.explanation.slice(0, 1).join('')}` : writeLine(r) }));
    } else {
      const r = await previewChange(tripId, change);
      setChecks((c) => ({ ...c, [key]: r.ok ? `${r.value.summary}${r.value.bookingsAtRisk > 0 ? ` · ${r.value.bookingsAtRisk} booking${r.value.bookingsAtRisk === 1 ? '' : 's'} at risk` : ''} · decided by ${r.value.decisionRule}` : writeLine(r) }));
    }
  }, [tripId]);

  const propose = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const r = await replanToday(tripId, { createProposals: true });
    setBusy(false);
    if (!r.ok) { setSent(writeLine(r)); return; }
    if (r.value.skipped) { setSent(`No proposals were created: ${r.value.skipped}.`); return; }
    const made = r.value.created.filter((c) => c.proposalId).length;
    const refused = r.value.created.filter((c) => !c.proposalId);
    setSent(`${made} proposal${made === 1 ? '' : 's'} sent to the crew${refused.length ? `; ${refused.length} refused (${refused.map((c) => c.reason).join(', ')})` : ''}.`);
  }, [busy, tripId]);

  // Pulse and replan sit behind the same operational gate: off means this card has nothing to offer.
  if (pulse?.state === 'off') return null;

  return (
    <View style={s.wrap} testID="trip-replan-card">
      {(
        <View testID="trip-pulse">
          <View style={s.headRow}><Radio size={16} color={color.deep} /><Text style={s.title}>Trip pulse</Text></View>
          {pulse === undefined ? <ActivityIndicator size="small" color={color.signal} />
            : pulse.state === 'failed' ? (
              <View testID="trip-pulse-failed">
                <Text style={s.error}>{failureLine(pulse.call, 'the trip pulse')}</Text>
                <Pressable onPress={() => void loadPulse()} testID="trip-pulse-retry"><Text style={s.action}>Try again</Text></Pressable>
              </View>
            ) : (
              <>
                <Text style={s.detail} testID="trip-pulse-counts">{pulse.value.signals} signal{pulse.value.signals === 1 ? '' : 's'} that matter to this trip; {pulse.value.dropped} filtered out.</Text>
                {pulse.value.unreadSources.length > 0 ? <Text style={s.error} testID="trip-pulse-unread">Couldn't read: {pulse.value.unreadSources.join(', ')} — signals from there may be missing.</Text> : null}
                {pulse.value.reading ? <Text style={s.meta}>{pulse.value.reading}</Text> : null}
              </>
            )}
        </View>
      )}

      <View style={[s.headRow, { marginTop: space.sm }]}><Shuffle size={16} color={color.deep} /><Text style={s.title}>Replan today</Text></View>
      <Text style={s.meta}>A suggestion only — nothing in your plan changes unless the crew accepts a proposal.</Text>
      <Pressable style={s.goBtn} disabled={busy} onPress={() => void replan()} testID="trip-replan"><Text style={s.goText}>Replan today</Text></Pressable>
      {busy && !plan ? <ActivityIndicator size="small" color={color.signal} /> : null}
      {plan && !plan.ok ? <Text style={s.error} testID="trip-replan-failed">{writeLine(plan)}</Text> : null}
      {plan?.ok ? (
        <View testID="trip-replan-diff">
          <Text style={s.detail}>{plan.value.summary}</Text>
          {plan.value.unread.length > 0 ? <Text style={s.error} testID="trip-replan-unread">Worked out without: {plan.value.unread.join(', ')} (couldn't be read).</Text> : null}
          {plan.value.entries.map((e, i) => (e.op === 'keep' ? null : (
            <View key={`${e.op}-${e.planId ?? e.experienceId ?? i}`} style={s.entry} testID={`trip-replan-entry-${i}`}>
              <Text style={s.optTitle}>{OP_WORDS[e.op] ?? e.op} {e.title ?? 'a plan'}{e.to?.startsAt ? ` → ${hhmm(e.to.startsAt)}` : ''}</Text>
              <Text style={s.meta}>{e.detail}{e.sharedMutation ? ' · the crew decides' : ''}</Text>
              <View style={s.chips}>
                <Pressable style={s.chip} onPress={() => void check(i, e, 'simulate')} testID={`trip-replan-entry-${i}-simulate`}><Text style={s.chipText}>Simulate</Text></Pressable>
                <Pressable style={s.chip} onPress={() => void check(i, e, 'impact')} testID={`trip-replan-entry-${i}-impact`}><Text style={s.chipText}>Impact</Text></Pressable>
              </View>
              {checks[`${i}:simulate`] ? <Text style={s.note} testID={`trip-replan-entry-${i}-simulation`}>{checks[`${i}:simulate`]}</Text> : null}
              {checks[`${i}:impact`] ? <Text style={s.note} testID={`trip-replan-entry-${i}-impact-result`}>{checks[`${i}:impact`]}</Text> : null}
            </View>
          )))}
          {plan.value.proposals > 0 ? (
            <Pressable style={s.chip} disabled={busy} onPress={() => void propose()} testID="trip-replan-propose">
              <Text style={s.chipText}>Send {plan.value.proposals} as proposals</Text>
            </Pressable>
          ) : null}
          {sent ? <Text style={s.note} testID="trip-replan-sent">{sent}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs, ...shadow.card },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  entry: { paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, gap: 2 },
  optTitle: { ...t.bodyStrong, color: color.ink },
  detail: { ...t.small, color: color.ink },
  meta: { ...t.stamp, color: color.mute },
  error: { ...t.small, color: color.warn },
  note: { ...t.small, color: color.deep },
  action: { ...t.stamp, color: color.deep, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { alignSelf: 'flex-start', paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.stamp, color: color.ink },
  goBtn: { alignSelf: 'flex-start', marginTop: space.xs, paddingVertical: space.xs, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: color.deep },
  goText: { ...t.stamp, color: color.onInk, fontWeight: '700' },
});
