/**
 * TripPostTripCard — §20 after the trip, on screen (TRIP-F22, WP-10).
 *
 * The viewer's memory candidates, each with the row it comes from, and what
 * the trip adds to their Passport. "Keep as memory" hands the candidate's own
 * draft to POST /memories as a DRAFT (WP10-D6): the traveller opens and
 * publishes it; nothing is published on a projection's say-so. Candidates a
 * memory already answers are shown as kept. The inputs the projections could
 * not read are counted, so a short list is never mistaken for a complete one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Sparkles, Stamp, CloudOff, CheckCircle2 } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import type { ApiRead } from '../shared/tripApi.ts';
import {
  fetchMemoryCandidates, fetchPassportPreview, candidateStatus, unreadLine, draftToMemoryInput, passportLine,
  type TripMemoryProjection, type TripPassportProjection, type MemoryCandidate, type KeepMemoryInput,
} from './tripPostTrip.ts';

type KeepResult = { ok: true; memoryId: string | null } | { ok: false; message: string };
type Keeper = (input: KeepMemoryInput) => Promise<KeepResult>;

async function keepWithMemories(input: KeepMemoryInput): Promise<KeepResult> {
  const { createMemory } = await import('../../../services/memories.ts');
  const r = await createMemory(input);
  return r.ok ? { ok: true, memoryId: (r.memory as { id?: string } | undefined)?.id ?? null } : { ok: false, message: r.message };
}

interface Props {
  tripId: string;
  /** Test seams. */
  loadMemory?: typeof fetchMemoryCandidates;
  loadPassport?: typeof fetchPassportPreview;
  keep?: Keeper;
}

const KIND_LABEL: Record<string, string> = {
  place_visited: 'Place you went', activity_completed: 'Something you did', regroup_met: 'Where the crew met up', people: 'Who you travelled with', stamp: 'Stamp earned',
};

export function TripPostTripCard({ tripId, loadMemory = fetchMemoryCandidates, loadPassport = fetchPassportPreview, keep = keepWithMemories }: Props) {
  const [mem, setMem] = useState<ApiRead<TripMemoryProjection> | undefined>(undefined);
  const [pass, setPass] = useState<ApiRead<TripPassportProjection> | undefined>(undefined);
  const [kept, setKept] = useState<Record<string, KeepResult | 'pending'>>({});

  const run = useCallback(async () => {
    setMem(undefined); setPass(undefined);
    const [m, p] = await Promise.all([
      loadMemory(tripId).catch((e: any) => ({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }) as ApiRead<TripMemoryProjection>),
      loadPassport(tripId).catch((e: any) => ({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }) as ApiRead<TripPassportProjection>),
    ]);
    setMem(m); setPass(p);
  }, [tripId, loadMemory, loadPassport]);
  useEffect(() => { void run(); }, [run]);

  const onKeep = useCallback(async (c: MemoryCandidate) => {
    const input = draftToMemoryInput(c);
    if (!input) return;
    setKept((k) => ({ ...k, [c.id]: 'pending' }));
    let r: KeepResult;
    try { r = await keep(input); } catch (e: any) { r = { ok: false, message: String(e?.message ?? 'unexpected error') }; }
    setKept((k) => ({ ...k, [c.id]: r }));
  }, [keep]);

  if (mem === undefined || pass === undefined) {
    return <View style={s.wrap} testID="trip-posttrip-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (mem.state === 'off' && pass.state === 'off') return null;

  return (
    <View style={s.wrap} testID="trip-posttrip-card">
      <Text style={s.heading}>After the trip</Text>

      {pass.state === 'ok' ? (
        <View style={s.row} testID="trip-posttrip-passport">
          <Stamp size={14} color={color.deep} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Your Passport</Text>
            <Text style={s.detail}>{passportLine(pass.data)}</Text>
            {pass.data.cities.length > 0 ? <Text style={s.detail}>{pass.data.cities.join(' · ')}</Text> : null}
          </View>
        </View>
      ) : pass.state === 'unavailable' ? (
        <View style={s.row} testID="trip-posttrip-passport-unavailable">
          <CloudOff size={14} color={color.mute} />
          <Text style={[s.detail, { flex: 1, marginTop: 0 }]}>Couldn&apos;t read what this trip adds to your Passport.</Text>
        </View>
      ) : null}

      {mem.state === 'unavailable' ? (
        <View style={s.row} testID="trip-posttrip-memory-unavailable">
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.detail}>Couldn&apos;t read your memory candidates ({mem.detail}). That isn&apos;t the same as having none.</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="trip-posttrip-retry" accessibilityRole="button"><Text style={s.buttonText}>Try again</Text></Pressable>
          </View>
        </View>
      ) : mem.state === 'ok' ? (
        <View>
          {mem.data.candidates.length === 0 ? (
            <Text style={[s.detail, s.pad]} testID="trip-posttrip-empty">Nothing from this trip to turn into a memory yet.</Text>
          ) : mem.data.candidates.map((c) => {
            const st = candidateStatus(c);
            const k = kept[c.id];
            return (
              <View key={c.id} style={s.row} testID={`trip-posttrip-candidate-${c.id}`}>
                <Sparkles size={14} color={color.deep} />
                <View style={{ flex: 1 }}>
                  <Text style={s.title}>{c.title}</Text>
                  <Text style={s.detail}>{KIND_LABEL[c.kind] ?? c.kind}{c.occurredAt ? ` · ${new Date(c.occurredAt).toLocaleDateString()}` : ''}</Text>
                  {st === 'kept' ? (
                    <Pressable onPress={() => router.push(`/memory/${c.realized!.memoryId}` as any)} testID={`trip-posttrip-open-${c.id}`} accessibilityRole="link">
                      <Text style={s.link}>Kept as a memory{c.realized!.mediaCount > 0 ? ` · ${c.realized!.mediaCount} photo${c.realized!.mediaCount === 1 ? '' : 's'}` : ''} — open</Text>
                    </Pressable>
                  ) : st === 'keepable' ? (
                    k === 'pending' ? <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start' }} />
                    : k && k.ok ? (
                      <View style={s.inline} testID={`trip-posttrip-kept-${c.id}`}>
                        <CheckCircle2 size={12} color={color.success} />
                        <Text style={[s.detail, { marginTop: 0, color: color.success }]}>Saved as a draft memory</Text>
                        {k.memoryId ? <Pressable onPress={() => router.push(`/memory/${k.memoryId}` as any)} accessibilityRole="link"><Text style={s.link}>Open</Text></Pressable> : null}
                      </View>
                    ) : (
                      <View>
                        <Pressable onPress={() => void onKeep(c)} style={s.button} testID={`trip-posttrip-keep-${c.id}`} accessibilityRole="button">
                          <Text style={s.buttonText}>{k && !k.ok ? 'Try again' : 'Keep as memory'}</Text>
                        </Pressable>
                        {k && !k.ok ? <Text style={[s.detail, { color: color.signalStrong }]}>Not saved — {k.message}</Text> : null}
                      </View>
                    )
                  ) : null}
                </View>
              </View>
            );
          })}
          {unreadLine(mem.data.unread) ? <Text style={[s.detail, s.pad]} testID="trip-posttrip-unread">{unreadLine(mem.data.unread)}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', paddingVertical: space.xs },
  heading: { ...t.small, fontWeight: '700', color: color.ink, paddingHorizontal: space.lg, paddingTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  pad: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  link: { ...t.stamp, color: color.signalStrong, fontWeight: '600', marginTop: 2 },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonText: { ...t.small, color: color.ink },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
