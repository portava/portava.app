/**
 * TripOfflineCard — §18 on screen. census-trips TR334 (client half), TR343,
 * TR349, TR421.
 *
 * What is kept for offline use, how old it is and whether it is still the
 * trip's current version; what is queued to replay; and the two actions —
 * refresh the copy, replay the queue — each reported in the server's words.
 * A stale copy is shown AS stale (§18.1: the last certified context beats
 * nothing, as long as it is not drawn as current). An operation the server
 * asks to revalidate stays visible until the traveller confirms it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { Download, RefreshCw, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import {
  fetchOfflineBundle, storeBundle, loadStoredBundle, loadQueue, replayQueue, revalidateOperation, bundleStaleness,
  type StoredBundle, type QueuedEntry, type ReplayResult,
} from './tripOffline.ts';

interface Props {
  tripId: string;
  /** The trip's current aggregate version when the screen knows it; null when it does not. */
  currentTripVersion?: number | null;
  now?: () => number;
  /** Test seams — the real functions by default. */
  fetchBundle?: typeof fetchOfflineBundle;
  loadStored?: typeof loadStoredBundle;
  store?: typeof storeBundle;
  queue?: typeof loadQueue;
  replay?: typeof replayQueue;
  revalidate?: typeof revalidateOperation;
}

export function TripOfflineCard({
  tripId, currentTripVersion = null, now = () => Date.now(),
  fetchBundle = fetchOfflineBundle, loadStored = loadStoredBundle, store = storeBundle, queue = loadQueue, replay = replayQueue, revalidate = revalidateOperation,
}: Props) {
  const [stored, setStored] = useState<StoredBundle | null | undefined>(undefined);
  const [pending, setPending] = useState<QueuedEntry[]>([]);
  const [busy, setBusy] = useState<'refresh' | 'replay' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lastReplay, setLastReplay] = useState<ReplayResult | null>(null);

  const load = useCallback(async () => {
    try { setStored(await loadStored(tripId)); setPending(await queue(tripId)); }
    catch (e: any) { setStored(null); setNote(String(e?.message ?? 'storage unavailable')); }
  }, [tripId, loadStored, queue]);
  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy('refresh'); setNote(null);
    const r = await fetchBundle(tripId);
    if (r.state === 'ok') { setStored(await store(tripId, r.signed, now())); setNote(r.signed.readings?.staleness ?? 'offline copy refreshed'); }
    else if (r.state === 'off') setNote('Offline copies are not issued here.');
    else setNote(`Could not refresh: ${r.reason ? `${r.reason}: ` : ''}${r.detail}. The stored copy, if any, is unchanged.`);
    setBusy(null);
  }, [tripId, fetchBundle, store, now]);

  const doReplay = useCallback(async () => {
    setBusy('replay'); setNote(null);
    const r = await replay(tripId);
    setLastReplay(r);
    if (r.state === 'replayed') { setPending(r.remaining); }
    else if (r.state === 'unavailable') setNote(`Could not replay: ${r.detail}. Nothing was dropped.`);
    else if (r.state === 'off') setNote('Replay is not available here; the queue is kept.');
    setBusy(null);
  }, [tripId, replay]);

  const confirm = useCallback(async (operationId: string) => {
    if (currentTripVersion === null) return;
    await revalidate(tripId, operationId, currentTripVersion);
    setPending(await queue(tripId));
  }, [tripId, revalidate, queue, currentTripVersion]);

  if (stored === undefined) {
    return <View style={s.wrap} testID="trip-offline-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }

  const staleness = stored ? bundleStaleness(stored.signed.bundle, now(), currentTripVersion) : null;
  const c = stored?.signed.bundle.contents;

  return (
    <View style={[s.wrap, staleness?.stale && s.wrapWarn]} testID="trip-offline-card">
      <View style={s.row}>
        {stored ? <Download size={16} color={staleness?.stale ? color.warn : color.success} /> : <CloudOff size={16} color={color.mute} />}
        <View style={{ flex: 1 }}>
          <Text style={s.title} testID="trip-offline-headline">
            {stored ? (staleness?.stale ? 'Offline copy is stale' : 'Offline copy ready') : 'No offline copy yet'}
          </Text>
          {stored && c ? (
            <Text style={s.detail} testID="trip-offline-summary">
              Read at version {stored.signed.bundle.sourceTripVersion}, valid until {stored.signed.bundle.expiresAt}: {c.plans.length} plan(s), {c.nextCommitments.length} commitment(s), {c.criticalAddresses.length} address(es), {c.meetingPoints.length} meeting point(s).
            </Text>
          ) : (
            <Text style={s.detail}>Refresh once while online to keep the plan, the addresses and the meeting points with you.</Text>
          )}
          {staleness?.stale ? <Text style={[s.detail, { color: color.warn }]} testID="trip-offline-stale">{staleness.detail}</Text> : null}
        </View>
      </View>

      {pending.length > 0 ? (
        <View style={s.queue} testID="trip-offline-queue">
          <Text style={s.title}>{pending.length} change(s) queued for reconnect</Text>
          {pending.map((e) => (
            <View key={e.op.operationId} style={s.queueRow} testID={`trip-offline-op-${e.op.operationId}`}>
              <Text style={s.detail}>{e.op.type} · {e.state}{e.note ? ` — ${e.note}` : ''}</Text>
              {e.state === 'revalidate' && currentTripVersion !== null ? (
                <Pressable onPress={() => void confirm(e.op.operationId)} style={s.button} testID={`trip-offline-confirm-${e.op.operationId}`} accessibilityRole="button">
                  <Text style={s.buttonText}>Confirm against the current trip</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {lastReplay && lastReplay.state === 'replayed' ? (
        <View style={s.queue} testID="trip-offline-replay-result">
          <Text style={s.detail}>
            Replayed {lastReplay.counts.replayed ?? 0}, already applied {lastReplay.counts.duplicates ?? 0}, conflicts {lastReplay.counts.conflicted ?? 0}, rejected {lastReplay.counts.rejected ?? 0}, to confirm {lastReplay.counts.revalidate ?? 0}.
          </Text>
          {lastReplay.settled.filter((x) => x.outcome === 'conflict' || x.outcome === 'rejected').map((x) => (
            <Text key={x.op.operationId} style={[s.detail, { color: color.warn }]}>{x.op.type}: {x.outcome}{x.detail ? ` — ${x.detail}` : ''}</Text>
          ))}
        </View>
      ) : null}

      {note ? <Text style={[s.detail, s.pad]} testID="trip-offline-note">{note}</Text> : null}

      <View style={s.buttons}>
        <Pressable onPress={() => void refresh()} disabled={busy !== null} style={s.button} testID="trip-offline-refresh" accessibilityRole="button">
          <RefreshCw size={12} color={color.ink} /><Text style={s.buttonText}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh offline copy'}</Text>
        </Pressable>
        {pending.some((e) => e.state !== 'revalidate') ? (
          <Pressable onPress={() => void doReplay()} disabled={busy !== null} style={s.button} testID="trip-offline-replay" accessibilityRole="button">
            <Text style={s.buttonText}>{busy === 'replay' ? 'Replaying…' : 'Replay queued changes'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  wrapWarn: { borderColor: color.warn },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  pad: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  queue: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.xs },
  queueRow: { gap: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  button: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  buttonText: { ...t.small, color: color.ink },
});
