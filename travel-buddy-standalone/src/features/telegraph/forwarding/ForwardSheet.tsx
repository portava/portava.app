/**
 * Telegraph §30A.9 — "Forward" from a message's action sheet (census T406).
 *
 * Lists the caller's other live conversations and forwards the ONE message into the one they pick.
 * Honest in each state: loading; a failed list read says so with Try again and offers nothing (an
 * unreadable list is not "you have no other conversations"); a refusal is the server's sentence; and
 * "Forwarded" is said only after the server answered that the copy exists. The sheet tells the person,
 * before they pick, what the new audience will and will not see.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { getMyThreads, type ThreadSummary } from '../../../services/messaging.ts';
import { forwardMessage, forwardTargets } from './forwardApi.ts';

export interface ForwardSheetProps {
  visible: boolean;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  onClose: () => void;
  /** Told once the server has created the forwarded copy. */
  onForwarded?: (targetThreadId: string) => void;
}

export const FORWARD_AUDIENCE_COPY =
  'They will see it marked "Forwarded". Where it came from, and who else is in this conversation, stays here.';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; threads: ThreadSummary[] };

export function threadLabel(t: ThreadSummary): string {
  if (t.title && t.title.trim()) return t.title.trim();
  const names = (t.otherMembers ?? []).map((m) => m.name || (m.handle ? `@${m.handle}` : '')).filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'Conversation';
}

export function ForwardSheet({ visible, sourceThreadId, sourceMessageId, onClose, onForwarded }: ForwardSheetProps) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const read = useCallback(async () => {
    setLoad({ status: 'loading' });
    const r = await getMyThreads();
    if (r.ok && Array.isArray(r.data?.threads)) setLoad({ status: 'ready', threads: forwardTargets(r.data.threads, sourceThreadId) });
    else setLoad({ status: 'error' });
  }, [sourceThreadId]);

  useEffect(() => {
    if (!visible) return;
    setError(null); setDone(false); setSendingTo(null);
    void read();
  }, [visible, read]);

  const send = async (target: ThreadSummary) => {
    if (!sourceMessageId || sendingTo) return;
    setSendingTo(target.id);
    setError(null);
    const r = await forwardMessage(target.id, sourceMessageId);
    setSendingTo(null);
    if (r.ok) { setDone(true); onForwarded?.(target.id); }
    else setError(r.message);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close forward" />
      <View style={styles.sheet} testID="forward-sheet">
        <Text style={styles.title} accessibilityRole="header">Forward to…</Text>
        <Text style={styles.note} testID="forward-audience-copy">{FORWARD_AUDIENCE_COPY}</Text>
        {done ? (
          <Text style={styles.done} testID="forward-done">Forwarded.</Text>
        ) : load.status === 'loading' ? (
          <ActivityIndicator testID="forward-loading" color={palette.operational} />
        ) : load.status === 'error' ? (
          <View testID="forward-list-error">
            <Text style={styles.error}>We could not load your conversations.</Text>
            <Pressable onPress={() => { void read(); }} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryLabel}>Try again</Text>
            </Pressable>
          </View>
        ) : load.threads.length === 0 ? (
          <Text style={styles.note} testID="forward-none">You have no other conversation to forward this to.</Text>
        ) : (
          <ScrollView style={styles.list}>
            {load.threads.map((th) => (
              <Pressable
                key={th.id}
                testID={`forward-target-${th.id}`}
                accessibilityRole="button"
                disabled={sendingTo !== null}
                onPress={() => { void send(th); }}
                style={styles.row}
              >
                <Text style={styles.rowLabel}>{threadLabel(th)}</Text>
                {sendingTo === th.id ? <ActivityIndicator color={palette.operational} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        )}
        {error ? <Text style={styles.error} testID="forward-error">{error}</Text> : null}
      </View>
    </Modal>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette; ordinary emphasis is teal
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: p.surface, padding: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: space.sm, maxHeight: '80%' },
  title: { ...t.bodyStrong, color: p.recvText },
  note: { ...t.small, color: p.mute },
  list: { maxHeight: 360 },
  row: { paddingVertical: space.sm, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { ...t.body, color: p.recvText },
  done: { ...t.body, color: p.operational },
  error: { ...t.small, color: p.recvText, fontWeight: '600' },
  retry: { paddingVertical: space.xs, minHeight: 44, justifyContent: 'center' },
  retryLabel: { ...t.small, color: p.operational, fontWeight: '700' },
});

export default ForwardSheet;
