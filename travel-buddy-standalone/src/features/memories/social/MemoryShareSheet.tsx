/**
 * MemoryShareSheet — share a Memory into a Telegraph chat (HM-F13).
 *
 * 1. `POST /memories/:id/share` is the gate. It answers the Telegraph §5
 *    MEMORY reference only when this person may read the Memory; otherwise
 *    the sheet says so and offers nothing.
 * 2. The share is the REFERENCE, posted with `POST /threads/:id/share`. Each
 *    reader's card is resolved at read time (services/telegraph/shareables.ts),
 *    so a Memory later narrowed, blocked or deleted stops showing in the chat —
 *    no snapshot of it is copied into the thread.
 * 3. "Share link" appears only for a PUBLIC Memory: a link outside Portava
 *    opens nothing for a private one, so offering it would be a false promise.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Link as LinkIcon } from 'lucide-react-native';
import { PortavaSheet } from '../../../components/ui/PortavaSheet.tsx';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { prepareMemoryShare, type MemoryShareReference } from '../../../services/memorySocial.ts';
import { getMyThreads, type ThreadSummary } from '../../../services/messaging.ts';
import { shareObjectIntoThread } from '../../telegraph/sharing/shareApi.ts';
import { canonicalUrl } from '../../../constants/canonicalUrl.ts';

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; share: MemoryShareReference; threads: ThreadSummary[] | null; threadsError: string | null };

function threadLabel(th: ThreadSummary): string {
  if (th.title) return th.title;
  const names = th.otherMembers.map((m) => m.name || m.handle).filter(Boolean);
  return names.length ? names.join(', ') : 'Chat';
}

export function MemoryShareSheet({ visible, memoryId, onClose }: { visible: boolean; memoryId: string; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [note, setNote] = useState('');
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const gate = await prepareMemoryShare(memoryId);
    if (!gate.ok) { setPhase({ kind: 'refused', message: gate.message }); return; }
    const threads = await getMyThreads();
    if (threads.ok && threads.data) {
      setPhase({ kind: 'ready', share: gate.share, threads: threads.data.threads ?? [], threadsError: null });
    } else {
      setPhase({ kind: 'ready', share: gate.share, threads: null, threadsError: (!threads.ok && threads.message) || 'Your chats could not be loaded.' });
    }
  }, [memoryId]);

  useEffect(() => { if (visible) { setNote(''); void load(); } }, [visible, load]);

  const sendTo = useCallback(async (thread: ThreadSummary) => {
    if (phase.kind !== 'ready' || sendingTo) return;
    setSendingTo(thread.id);
    const res = await shareObjectIntoThread(thread.id, 'MEMORY', phase.share.objectId, note.trim() || null);
    setSendingTo(null);
    if (res.ok) {
      onClose();
      Alert.alert('Shared', `Memory shared to ${threadLabel(thread)}.`);
    } else {
      Alert.alert('Could not share', 'The memory was not shared. Please try again.');
    }
  }, [phase, sendingTo, note, onClose]);

  const shareLink = useCallback(async () => {
    if (phase.kind !== 'ready' || !phase.share.public) return;
    const url = canonicalUrl(phase.share.deepLink);
    try { await Share.share({ message: url, url }); } catch { Alert.alert('Could not open sharing', 'Please try again.'); }
  }, [phase]);

  return (
    <PortavaSheet visible={visible} onClose={onClose} avoidKeyboard accessibilityLabel="Share memory" testID="memory-share-sheet">
      <Text style={s.title}>Share memory</Text>
      {phase.kind === 'loading' ? (
        <ActivityIndicator color={color.signal} style={s.pad} />
      ) : phase.kind === 'refused' ? (
        <View style={s.pad}>
          <Text style={s.body} testID="memory-share-refused">{phase.message}</Text>
          <Pressable onPress={load} style={s.retry} accessibilityRole="button"><Text style={s.retryText}>Try again</Text></Pressable>
        </View>
      ) : (
        <View style={s.content}>
          {phase.share.public ? (
            <Pressable onPress={shareLink} style={s.linkRow} accessibilityRole="button" testID="memory-share-link">
              <LinkIcon size={18} color={color.ink} />
              <Text style={s.bodyStrong}>Share link</Text>
            </Pressable>
          ) : (
            <Text style={s.caption}>This memory is not public, so it can be shared into a chat but not as a link.</Text>
          )}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Add a note (optional)"
            placeholderTextColor={color.faint}
            style={s.input}
            maxLength={500}
          />
          <Text style={s.section}>Send in a chat</Text>
          <Text style={s.caption}>People in the chat see it only if they are allowed to see this memory.</Text>
          {phase.threads === null ? (
            <View>
              <Text style={s.body}>{phase.threadsError}</Text>
              <Pressable onPress={load} style={s.retry} accessibilityRole="button"><Text style={s.retryText}>Try again</Text></Pressable>
            </View>
          ) : phase.threads.length === 0 ? (
            <Text style={s.body}>You have no chats yet.</Text>
          ) : (
            <FlatList
              data={phase.threads}
              keyExtractor={(th) => th.id}
              style={s.list}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => sendTo(item)}
                  disabled={sendingTo !== null}
                  style={s.threadRow}
                  accessibilityRole="button"
                  testID={`memory-share-thread-${item.id}`}
                >
                  <Text style={s.bodyStrong} numberOfLines={1}>{threadLabel(item)}</Text>
                  {sendingTo === item.id ? <ActivityIndicator size="small" color={color.signal} /> : <Text style={s.send}>Send</Text>}
                </Pressable>
              )}
            />
          )}
        </View>
      )}
    </PortavaSheet>
  );
}

const s = StyleSheet.create({
  title: { ...(t.heading as object), color: color.ink, marginBottom: space.md },
  pad: { paddingVertical: space.lg, gap: space.sm },
  content: { gap: space.sm },
  body: { ...(t.body as object), color: color.mute },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink, flexShrink: 1 },
  caption: { ...(t.small as object), color: color.mute },
  section: { ...(t.bodyStrong as object), color: color.ink, marginTop: space.sm },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, ...(t.body as object), color: color.ink },
  list: { maxHeight: 280 },
  threadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze, gap: space.md },
  send: { ...(t.small as object), color: color.deep, fontWeight: '700' },
  retry: { alignSelf: 'flex-start', paddingVertical: space.sm },
  retryText: { ...(t.bodyStrong as object), color: color.deep },
});
