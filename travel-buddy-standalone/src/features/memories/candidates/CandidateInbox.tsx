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
 *
 * PHOTOS FOR A MEMORY YOU ALREADY HAVE (census H180, migration 3806). Photos
 * taken during one of the owner's Memories — typically from another phone or
 * camera — are offered for THAT Memory instead of as a second suggestion. They
 * are added only when the owner presses Add, and the card says in plain words
 * who will see them. When the Memory is shared and the photos would be too,
 * Add asks once more, naming the audience; the server refuses (and the card
 * says so) if the Memory's audience changed since it was shown.
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
  keepConvergence, dismissConvergence,
  type MemoryCandidate, type ConvergenceGroup, type ConvergenceInbox,
} from './memoryCandidatesApi.ts';

type State =
  | { s: 'loading' }
  | { s: 'hidden' }
  | { s: 'error'; message: string }
  | { s: 'ok'; candidates: MemoryCandidate[]; convergence: ConvergenceInbox };

type Trips = { s: 'closed' } | { s: 'loading' } | { s: 'error' } | { s: 'ok'; trips: TripRow[] };

/** Who can see a Memory, in the owner's words. */
export function audienceWords(visibility: string): string {
  switch (visibility) {
    case 'only_me': return 'only you';
    case 'public': return 'anyone';
    case 'friends_only': return 'your friends';
    case 'trip_crew': return 'your trip crew';
    case 'circle_only': return 'your circle';
    case 'custom': return 'the people you picked';
    default: return 'other people';
  }
}

/** What adding these photos means for who sees them — one plain sentence, from what the server said. */
export function convergenceAudienceSentence(g: Pick<ConvergenceGroup, 'visibility' | 'attachAudience'>, n: number): string {
  const them = n === 1 ? 'it' : 'them';
  if (g.visibility === 'only_me') return `Only you can see this Memory, so only you will see ${them}.`;
  const who = audienceWords(g.visibility);
  if (g.attachAudience === 'only_me') return `This Memory is shared with ${who}, but only you will see ${n === 1 ? 'this photo' : 'these photos'}.`;
  return `This Memory is shared with ${who}, so ${who} will see ${n === 1 ? 'this photo' : 'these photos'} too.`;
}

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
    if (r.ok) setState({ s: 'ok', candidates: r.candidates, convergence: r.convergence ?? { state: 'not_deployed' } });
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
    const matched = r.report.convergence?.state === 'ready' ? r.report.convergence.capturesMatched : 0;
    setFound(`${fresh === 0 ? 'No new suggestions' : `${fresh} new suggestion${fresh === 1 ? '' : 's'}`} from that trip.${matched > 0 ? ` ${matched} photo${matched === 1 ? ' belongs' : 's belong'} with Memories you already have — see below.` : ''}${undated > 0 ? ` ${undated} photo${undated === 1 ? ' has' : 's have'} no capture time and could not be placed.` : ''}`);
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
    setState((prev) => (prev.s === 'ok' ? { ...prev, candidates: prev.candidates.filter((x) => x.id !== c.id) } : prev));
  }, []);

  /** Take decided photos off one Memory's card; drop the card when none are left. */
  const removePhotos = useCallback((memoryId: string, assetIds: readonly string[]) => {
    const gone = new Set(assetIds);
    setState((prev) => {
      if (prev.s !== 'ok' || prev.convergence.state !== 'ready') return prev;
      const groups = prev.convergence.groups
        .map((g) => (g.memoryId === memoryId ? { ...g, photos: g.photos.filter((p) => !gone.has(p.assetId)) } : g))
        .filter((g) => g.photos.length > 0);
      return { ...prev, convergence: { state: 'ready', groups } };
    });
  }, []);

  const addToMemory = useCallback(async (g: ConvergenceGroup) => {
    if (inFlight.current) return;
    inFlight.current = `conv:${g.memoryId}`;
    setBusy(`conv:${g.memoryId}`);
    const assetIds = g.photos.map((p) => p.assetId);
    // The audience the owner SAW is echoed back; the server refuses if it changed.
    const r = await keepConvergence(g.memoryId, assetIds, g.visibility);
    inFlight.current = null;
    setBusy(null);
    if (!r.ok) {
      if (r.reason === 'audience_unconfirmed') {
        Alert.alert('Who can see this Memory changed', `It is now shared with ${audienceWords(r.currentAudience ?? '')}. Check the photos again before adding them.`);
        void load();
        return;
      }
      Alert.alert('Could not add these photos', r.message);
      if (r.kind === 'conflict') void load();
      return;
    }
    removePhotos(g.memoryId, r.kept.map((k) => k.assetId).concat(r.skipped.map((k) => k.assetId)));
    // The server says per photo who sees it. A photo meant to be private that
    // could not be made private is said, never left for the owner to discover.
    const notPrivate = g.attachAudience === 'only_me' ? r.kept.filter((k) => k.itemAudience === 'memory').length : 0;
    if (notPrivate > 0) {
      const who = audienceWords(g.visibility);
      Alert.alert('Not every photo is private', `${notPrivate} photo${notPrivate === 1 ? ' was' : 's were'} added but could not be made private, so ${who} can see ${notPrivate === 1 ? 'it' : 'them'}, like the rest of this Memory. Open the Memory to remove ${notPrivate === 1 ? 'it' : 'them'}.`);
    }
  }, [load, removePhotos]);

  /** Adding to a Memory other people can see asks once more, naming who sees the Memory and who will see the photos. */
  const confirmAdd = useCallback((g: ConvergenceGroup) => {
    if (g.visibility !== 'only_me') {
      const n = g.photos.length;
      Alert.alert(`Add ${n} photo${n === 1 ? '' : 's'}?`, convergenceAudienceSentence(g, n), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Add', onPress: () => { void addToMemory(g); } },
      ]);
      return;
    }
    void addToMemory(g);
  }, [addToMemory]);

  const notThisMemory = useCallback(async (g: ConvergenceGroup) => {
    if (inFlight.current) return;
    inFlight.current = `conv:${g.memoryId}`;
    setBusy(`conv:${g.memoryId}`);
    const assetIds = g.photos.map((p) => p.assetId);
    const r = await dismissConvergence(g.memoryId, assetIds);
    inFlight.current = null;
    setBusy(null);
    if (!r.ok) { Alert.alert('Could not dismiss these photos', r.message); return; }
    removePhotos(g.memoryId, assetIds);
  }, [removePhotos]);

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
      {state.convergence.state === 'unavailable' ? (
        <View testID="convergence-error">
          <Text style={s.note}>Photos for Memories you already have could not be checked.</Text>
          <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Try again"><Text style={s.link}>Try again</Text></Pressable>
        </View>
      ) : state.convergence.state === 'ready' ? state.convergence.groups.map((g) => {
        const n = g.photos.length;
        const interrupted = g.photos.some((p) => p.state === 'interrupted');
        return (
          <View key={g.memoryId} style={s.card} testID={`convergence-${g.memoryId}`}>
            <Text style={s.body}>{`${n} photo${n === 1 ? '' : 's'} from the same time that ${n === 1 ? 'is' : 'are'} not in “${g.title || 'this Memory'}” yet`}</Text>
            {interrupted ? <Text style={s.note} testID={`convergence-interrupted-${g.memoryId}`}>You added some of these and it did not finish saving. Add finishes it.</Text> : null}
            <View style={s.previews}>
              {g.photos.slice(0, 4).map((p) => <CachedImage key={p.assetId} source={{ uri: p.previewUrl }} style={s.thumb} resizeMode="cover" />)}
            </View>
            <Text style={s.note} testID={`convergence-audience-${g.memoryId}`}>{convergenceAudienceSentence(g, n)}</Text>
            <View style={s.row}>
              <Pressable style={s.primary} onPress={() => { confirmAdd(g); }} disabled={busy !== null} testID={`convergence-add-${g.memoryId}`} accessibilityRole="button" accessibilityLabel="Add these photos to the Memory">
                {busy === `conv:${g.memoryId}` ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.primaryText}>Add to Memory</Text>}
              </Pressable>
              <Pressable style={s.secondary} onPress={() => { void notThisMemory(g); }} disabled={busy !== null} testID={`convergence-dismiss-${g.memoryId}`} accessibilityRole="button" accessibilityLabel="These photos do not belong to this Memory">
                <Text style={s.secondaryText}>Not this Memory</Text>
              </Pressable>
            </View>
          </View>
        );
      }) : null}
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
  link: { ...(t.small as object), color: color.deep, fontWeight: '600', textDecorationLine: 'underline', marginTop: space.xs },
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
