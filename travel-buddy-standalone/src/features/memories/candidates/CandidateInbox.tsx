/**
 * CandidateInbox — §7's candidate inbox, at the top of the owner's timeline
 * (census-highlights-memories H18/H19/H23/H24).
 *
 * Memories the system thinks happened — photos taken close together on a trip
 * — are SUGGESTIONS, private to the owner, and become Memories only when the
 * owner keeps them. Nothing runs on its own: the owner asks ("Find memories
 * from a trip"), reviews, and keeps or dismisses each one. A kept suggestion
 * becomes a private Memory with its photos; a dismissed one is never suggested
 * again.
 *
 * HONEST STATES. Storage not deployed (the server says feature_disabled) →
 * nothing is shown: there is nothing to offer, which is not a failure. A read
 * that FAILED → "Could not check" with Try again — never "no suggestions".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import { CachedImage } from '../../../components/CachedImage.tsx';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { listMyTrips, type TripRow } from '../../../services/trips.ts';
import {
  listMemoryCandidates, detectMemoryCandidates, confirmMemoryCandidate, rejectMemoryCandidate,
  type MemoryCandidate,
} from './memoryCandidatesApi.ts';

type State =
  | { s: 'loading' }
  | { s: 'hidden' }
  | { s: 'error'; message: string }
  | { s: 'ok'; candidates: MemoryCandidate[] };

type Trips = { s: 'closed' } | { s: 'loading' } | { s: 'error' } | { s: 'ok'; trips: TripRow[] };

function range(c: MemoryCandidate): string {
  const d = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const tm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return c.endedAt ? `${d(c.startedAt)}, ${tm(c.startedAt)}–${tm(c.endedAt)}` : `${d(c.startedAt)}, ${tm(c.startedAt)}`;
}

export function CandidateInbox() {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trips>({ s: 'closed' });
  const [found, setFound] = useState<string | null>(null);
  // A REF, not state: two taps in one frame both see `busy === null` in a
  // state closure, and both would send. The ref is set synchronously.
  const inFlight = useRef<string | null>(null);

  const load = useCallback(async () => {
    setState({ s: 'loading' });
    const r = await listMemoryCandidates();
    if (r.ok) setState({ s: 'ok', candidates: r.candidates });
    else if (r.kind === 'not_deployed') setState({ s: 'hidden' });
    else setState({ s: 'error', message: r.message });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openTrips = useCallback(async () => {
    setTrips({ s: 'loading' });
    try {
      const all = await listMyTrips();
      setTrips({ s: 'ok', trips: all.filter((tr) => tr.startDate && tr.endDate) });
    } catch {
      setTrips({ s: 'error' });
    }
  }, []);

  const detect = useCallback(async (tripId: string) => {
    if (inFlight.current) return;
    inFlight.current = `detect:${tripId}`;
    setBusy(`detect:${tripId}`);
    const r = await detectMemoryCandidates(tripId);
    inFlight.current = null;
    setBusy(null);
    if (!r.ok) { Alert.alert('Could not look through that trip', r.message); return; }
    setTrips({ s: 'closed' });
    const fresh = r.report.candidates.filter((c) => c.created).length;
    const undated = r.report.capturesWithoutTime;
    setFound(`${fresh === 0 ? 'No new suggestions' : `${fresh} new suggestion${fresh === 1 ? '' : 's'}`} from that trip.${undated > 0 ? ` ${undated} photo${undated === 1 ? ' has' : 's have'} no capture time and could not be placed.` : ''}`);
    await load();
  }, [load]);

  const keep = useCallback(async (c: MemoryCandidate) => {
    if (inFlight.current) return;
    inFlight.current = c.id;
    setBusy(c.id);
    const r = await confirmMemoryCandidate(c.id, null);
    inFlight.current = null;
    setBusy(null);
    if (!r.ok) { Alert.alert('Could not keep this', r.message); return; }
    router.push(`/memory/${r.memoryId}` as never);
  }, []);

  const dismiss = useCallback(async (c: MemoryCandidate) => {
    if (inFlight.current) return;
    inFlight.current = c.id;
    setBusy(c.id);
    const r = await rejectMemoryCandidate(c.id);
    inFlight.current = null;
    setBusy(null);
    if (!r.ok) { Alert.alert('Could not dismiss this', r.message); return; }
    setState((prev) => (prev.s === 'ok' ? { s: 'ok', candidates: prev.candidates.filter((x) => x.id !== c.id) } : prev));
  }, []);

  if (state.s === 'hidden') return null;
  if (state.s === 'loading') return <View style={s.wrap} testID="candidates-loading"><ActivityIndicator size="small" color={color.signal} /></View>;
  if (state.s === 'error') {
    return (
      <View style={s.wrap} testID="candidates-error">
        <Text style={s.note}>Could not check for memory suggestions. {state.message}</Text>
        <Pressable onPress={load} testID="candidates-retry" accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={s.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.wrap} testID="candidates">
      <View style={s.headRow}>
        <Sparkles size={16} color={color.deep} />
        <Text style={s.heading}>Memories to review</Text>
      </View>
      <Text style={s.note}>Only you see these. Nothing becomes a Memory until you keep it.</Text>
      {state.candidates.map((c) => (
        <View key={c.id} style={s.card} testID={`candidate-${c.id}`}>
          <Text style={s.body}>{range(c)}</Text>
          {c.state === 'interrupted' ? <Text style={s.note} testID={`candidate-interrupted-${c.id}`}>You kept this and it did not finish saving. Keep finishes it.</Text> : null}
          <Text style={s.note}>{[c.city, c.country].filter(Boolean).join(', ') || 'Place not known'} · {c.captureCount} photo{c.captureCount === 1 ? '' : 's'}</Text>
          {c.previewUrls.length > 0 ? (
            <View style={s.previews}>
              {c.previewUrls.map((u) => <CachedImage key={u} source={{ uri: u }} style={s.thumb} resizeMode="cover" />)}
            </View>
          ) : null}
          <View style={s.row}>
            <Pressable style={s.primary} onPress={() => { void keep(c); }} disabled={busy !== null} testID={`candidate-keep-${c.id}`} accessibilityRole="button" accessibilityLabel="Keep as a Memory">
              {busy === c.id ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.primaryText}>Keep</Text>}
            </Pressable>
            <Pressable style={s.secondary} onPress={() => { void dismiss(c); }} disabled={busy !== null} testID={`candidate-dismiss-${c.id}`} accessibilityRole="button" accessibilityLabel="Dismiss this suggestion">
              <Text style={s.secondaryText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {found ? <Text style={s.note} testID="candidates-found">{found}</Text> : null}
      {trips.s === 'closed' ? (
        <Pressable onPress={() => { void openTrips(); }} testID="candidates-find" accessibilityRole="button">
          <Text style={s.link}>Find memories from a trip</Text>
        </Pressable>
      ) : trips.s === 'loading' ? (
        <ActivityIndicator size="small" color={color.signal} />
      ) : trips.s === 'error' ? (
        <View testID="candidates-trips-error">
          <Text style={s.note}>Your trips could not be loaded.</Text>
          <Pressable onPress={() => { void openTrips(); }} accessibilityRole="button"><Text style={s.link}>Try again</Text></Pressable>
        </View>
      ) : trips.trips.length === 0 ? (
        <Text style={s.note} testID="candidates-no-trips">You have no trips with dates to look through.</Text>
      ) : (
        <View testID="candidates-trips">
          {trips.trips.map((tr) => (
            <Pressable key={tr.id} onPress={() => { void detect(tr.id); }} disabled={busy !== null} testID={`candidates-trip-${tr.id}`} accessibilityRole="button">
              <Text style={s.link}>{busy === `detect:${tr.id}` ? 'Looking…' : tr.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingBottom: space.md, marginBottom: space.md, borderBottomWidth: 1, borderColor: color.haze, gap: space.xs, paddingHorizontal: space.lg, paddingTop: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  heading: { ...(t.bodyStrong as object), color: color.ink },
  note: { ...(t.small as object), color: color.mute },
  link: { ...(t.small as object), color: color.signalStrong, fontWeight: '600', marginTop: space.xs },
  body: { ...(t.body as object), color: color.ink },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs, marginTop: space.sm },
  previews: { flexDirection: 'row', gap: space.xs },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: color.haze },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  primary: { backgroundColor: color.deep, borderRadius: radius.pill, paddingVertical: space.xs + 2, paddingHorizontal: space.lg },
  primaryText: { ...(t.small as object), color: color.onInk, fontWeight: '700' },
  secondary: { borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, paddingVertical: space.xs + 2, paddingHorizontal: space.lg },
  secondaryText: { ...(t.small as object), color: color.ink, fontWeight: '600' },
});
