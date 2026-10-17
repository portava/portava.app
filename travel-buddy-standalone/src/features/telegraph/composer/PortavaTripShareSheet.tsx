import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { PortavaSheet } from '../../../components/ui/PortavaSheet.tsx';
import { color, radius, space, type as typography } from '../../../theme/tokens.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { ConversationProjectionState } from '../conversation/conversationProjection.ts';
import { loadOwnedTripChoices, shareOwnedTripReference, type OwnedTripChoice, type PortavaTripIntent } from './portavaTripPickerApi.ts';

function eligible(projection: ConversationProjectionState): boolean {
  return projection.status === 'ready' && projection.canSendMessage === true
    && projection.degraded === false && projection.isE2ee === false;
}

export function usePortavaTripComposer(threadId: string | null, ownerId: string | null, projection: ConversationProjectionState, onSent: () => void) {
  const [intent, setIntent] = useState<PortavaTripIntent | null>(null);
  const active = useRef<{ intent: PortavaTripIntent; controller: AbortController } | null>(null);
  const generation = useRef(0);
  const latest = useRef({ threadId, ownerId, projection, onSent });
  latest.current = { threadId, ownerId, projection, onSent };
  const available = Boolean(threadId && ownerId && eligible(projection));
  const close = useCallback(() => {
    active.current?.controller.abort();
    active.current?.intent.owner.invalidate();
    active.current = null;
    setIntent(null);
  }, []);
  useEffect(() => close, [threadId, ownerId, available, close]);

  const open = useCallback(() => {
    close();
    const target = latest.current;
    if (!target.threadId || !target.ownerId || !eligible(target.projection)) return false;
    const owner = captureMessagingOwnerRequest();
    if (!owner || owner.ownerId !== target.ownerId) return false;
    const controller = new AbortController();
    const next: PortavaTripIntent = Object.freeze({
      generation: ++generation.current, threadId: target.threadId, owner, signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && active.current?.intent === next && owner.isCurrent()
        && latest.current.threadId === target.threadId && latest.current.ownerId === target.ownerId
        && eligible(latest.current.projection),
    });
    active.current = { intent: next, controller };
    setIntent(next);
    return true;
  }, [close]);

  const sent = useCallback((completed: PortavaTripIntent) => {
    if (!completed.isCurrent()) return;
    close();
    latest.current.onSent();
  }, [close]);

  return { available, open, close, sent, intent: intent?.isCurrent() ? intent : null };
}

export function PortavaTripShareSheet({ intent, onClose, onSent }: {
  intent: PortavaTripIntent; onClose: () => void; onSent: (intent: PortavaTripIntent) => void;
}) {
  const [trips, setTrips] = useState<OwnedTripChoice[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<OwnedTripChoice | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const current = useCallback(() => mounted.current && !intent.signal.aborted && intent.isCurrent(), [intent]);

  const load = useCallback(async () => {
    if (!current()) return;
    const attempt = ++generation.current;
    setTrips(null); setLoadError('');
    try {
      const result = await loadOwnedTripChoices(intent);
      if (!current() || attempt !== generation.current) return;
      if (result.ok) setTrips(result.trips);
      else setLoadError(result.message);
    } catch {
      if (current() && attempt === generation.current) setLoadError('Your trips could not be loaded. Please try again.');
    }
  }, [intent, current]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; generation.current += 1; };
  }, [load]);

  const send = async () => {
    if (!selected || locked.current || uncertain || !current()) return;
    locked.current = true; setSending(true); setSendError('');
    try {
      const result = await shareOwnedTripReference(intent, selected.id);
      if (!current()) return;
      if (result.ok) { onSent(intent); return; }
      setSendError(result.message);
      setUncertain(result.reason === 'unknown');
    } catch {
      if (current()) {
        setUncertain(true);
        setSendError('We could not confirm whether this trip was shared. Check the conversation before trying again.');
      }
    } finally {
      if (current()) { locked.current = false; setSending(false); }
    }
  };

  return (
    <PortavaSheet visible={current()} onClose={onClose} accessibilityLabel="Share one of your trips" testID="portava-trip-picker">
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">Share one of your trips</Text>
        <Text style={styles.note}>This shares a reference, not an invitation. It does not change who can see the trip. People without access may see an unavailable item.</Text>
        {loadError ? <View><Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.button}><Text style={styles.action}>Try loading again</Text></Pressable></View>
          : trips === null ? <ActivityIndicator accessibilityLabel="Loading your trips" color={color.signal} />
            : trips.length === 0 ? <Text style={styles.note}>You have no owned trips to share.</Text>
              : <FlatList data={trips} keyExtractor={trip => trip.id} style={styles.list}
                renderItem={({ item }) => <Pressable testID={`portava-trip-choice-${item.id}`} accessibilityRole="radio"
                  accessibilityState={{ selected: selected?.id === item.id, disabled: sending || uncertain }} disabled={sending || uncertain}
                  onPress={() => { if (current()) { setSelected(item); setSendError(''); } }} style={styles.choice}>
                  <Text style={selected?.id === item.id ? styles.action : styles.note}>{item.title}</Text>
                </Pressable>} />}
        {selected ? <Text style={styles.note}>Share “{selected.title}” in this conversation?</Text> : null}
        {sendError ? <Text accessibilityRole="alert" style={styles.error}>{sendError}</Text> : null}
        <Pressable testID="portava-trip-confirm" accessibilityRole="button" accessibilityLabel="Share trip reference"
          accessibilityState={{ disabled: !selected || sending || uncertain, busy: sending }} disabled={!selected || sending || uncertain}
          onPress={() => void send()} style={styles.button}>
          <Text style={styles.action}>{sending ? 'Sharing…' : 'Share trip reference'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.action}>Close</Text></Pressable>
      </View>
    </PortavaSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md, padding: space.lg },
  title: { ...typography.bodyStrong, color: color.ink },
  note: { ...typography.body, color: color.ink },
  error: { ...typography.body, color: color.signalStrong },
  action: { ...typography.bodyStrong, color: color.deep },
  button: { minHeight: 44, padding: space.sm, justifyContent: 'center', alignItems: 'center', borderRadius: radius.md },
  choice: { minHeight: 44, paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze },
  list: { maxHeight: 280 },
});
