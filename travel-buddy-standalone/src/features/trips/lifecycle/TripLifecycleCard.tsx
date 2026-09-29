/**
 * TripLifecycleCard — the trip's §3.1 lifecycle and the owner's lifecycle
 * actions (TRIP-F23, WP-10).
 *
 * Shows the lifecycle the server derives (GET /lifecycle), with the facts it
 * could not read counted, and — for the owner — the arrows the status
 * registry draws from the stored status: cancel, archive, delete (and
 * complete, unless the screen already offers it). Each action is confirmed,
 * sent once with a key minted for that confirmation, and reported as the
 * server answered it: done, refused by name (a kernel refusal keeps its
 * reason), or not reached — with a retry that reuses the same key.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable, Alert } from 'react-native';
import { Archive, Ban, Trash2, CheckCircle2, CloudOff, Flag } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { intentKey, writeFailureText, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';
import {
  lifecycleActions, runLifecycleAction, fetchTripLifecycle, lifecycleLabel, ACTION_COPY,
  type LifecycleAction, type TripLifecycleRead,
} from './tripLifecycle.ts';

interface Props {
  tripId: string;
  isOwner: boolean;
  storedStatus: string | null | undefined;
  /** Actions the screen already offers elsewhere (e.g. its own "Mark complete"). */
  exclude?: LifecycleAction[];
  /** Called after an action the server accepted, so the screen re-reads the trip. */
  onChanged?: (action: LifecycleAction) => void;
  /** Test seams. */
  load?: typeof fetchTripLifecycle;
  act?: typeof runLifecycleAction;
  confirm?: (title: string, body: string, destructive: boolean) => Promise<boolean>;
}

function alertConfirm(title: string, body: string, destructive: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

const ICON: Record<LifecycleAction, typeof Archive> = { cancel: Ban, complete: Flag, archive: Archive, delete: Trash2 };

export function TripLifecycleCard({
  tripId, isOwner, storedStatus, exclude = [], onChanged,
  load = fetchTripLifecycle, act = runLifecycleAction, confirm = alertConfirm,
}: Props) {
  const [read, setRead] = useState<ApiRead<TripLifecycleRead> | undefined>(undefined);
  const [busy, setBusy] = useState<LifecycleAction | null>(null);
  const [last, setLast] = useState<{ action: LifecycleAction; result: ApiWrite<unknown> } | null>(null);
  const keys = useRef<Partial<Record<LifecycleAction, string>>>({});

  const run = useCallback(async () => {
    setRead(undefined);
    try { setRead(await load(tripId)); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load]);
  useEffect(() => { void run(); }, [run]);

  const actions = lifecycleActions(storedStatus, isOwner).filter((a) => !exclude.includes(a));

  const send = useCallback(async (action: LifecycleAction, retry: boolean) => {
    if (!retry) {
      const copy = ACTION_COPY[action];
      if (!(await confirm(copy.confirmTitle, copy.confirmBody, action !== 'complete'))) return;
      keys.current[action] = intentKey(`trip-${action}:${tripId}`);
    }
    const key = keys.current[action] ?? intentKey(`trip-${action}:${tripId}`);
    setBusy(action);
    const result = await act(tripId, action, key);
    setBusy(null);
    setLast({ action, result });
    if (result.state === 'done') {
      delete keys.current[action];
      onChanged?.(action);
      void run();
    }
  }, [tripId, act, confirm, onChanged, run]);

  // Nothing to show a crew member when the lifecycle could not even be read.
  if (!isOwner && read?.state !== 'ok') return null;

  return (
    <View style={s.wrap} testID="trip-lifecycle-card">
      <View style={s.row}>
        <Flag size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Trip status</Text>
          {read === undefined ? (
            <ActivityIndicator size="small" color={color.signal} style={{ alignSelf: 'flex-start', marginTop: space.xs }} testID="trip-lifecycle-loading" />
          ) : read.state === 'ok' ? (
            <Text style={s.detail} testID="trip-lifecycle-state">{lifecycleLabel(read.data)}</Text>
          ) : read.state === 'unavailable' ? (
            <View style={s.inline} testID="trip-lifecycle-unavailable">
              <CloudOff size={12} color={color.mute} />
              <Text style={[s.detail, { marginTop: 0, flex: 1 }]}>Couldn&apos;t read where this trip is in its life.</Text>
              <Pressable onPress={() => void run()} testID="trip-lifecycle-retry" accessibilityRole="button"><Text style={s.link}>Retry</Text></Pressable>
            </View>
          ) : null}

          {actions.length > 0 ? (
            <View style={s.buttons}>
              {actions.map((a) => {
                const Icon = ICON[a];
                return (
                  <Pressable
                    key={a}
                    disabled={busy !== null}
                    onPress={() => void send(a, false)}
                    style={[s.button, (a === 'delete' || a === 'cancel') && s.buttonDanger, busy !== null && { opacity: 0.5 }]}
                    testID={`trip-lifecycle-${a}`}
                    accessibilityRole="button"
                  >
                    {busy === a ? <ActivityIndicator size="small" color={color.signal} /> : <Icon size={13} color={a === 'delete' || a === 'cancel' ? color.signal : color.ink} />}
                    <Text style={[s.buttonText, (a === 'delete' || a === 'cancel') && { color: color.signal }]}>{ACTION_COPY[a].label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {last?.result.state === 'done' ? (
            <View style={s.inline} testID={`trip-lifecycle-done-${last.action}`}>
              <CheckCircle2 size={12} color={color.success} />
              <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>{ACTION_COPY[last.action].done}</Text>
            </View>
          ) : last?.result.state === 'refused' ? (
            <Text style={[s.detail, { color: color.signal }]} testID={`trip-lifecycle-refused-${last.action}`}>
              {ACTION_COPY[last.action].label} was refused — {writeFailureText(last.result)}
            </Text>
          ) : last?.result.state === 'unavailable' ? (
            <View testID={`trip-lifecycle-unreached-${last.action}`}>
              <Text style={[s.detail, { color: color.signal }]}>{writeFailureText(last.result)}</Text>
              <Pressable onPress={() => void send(last.action, true)} style={s.button} testID="trip-lifecycle-action-retry" accessibilityRole="button">
                <Text style={s.buttonText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  link: { ...t.stamp, color: color.signal, fontWeight: '600' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  button: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonDanger: { borderColor: color.signal },
  buttonText: { ...t.small, color: color.ink },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
