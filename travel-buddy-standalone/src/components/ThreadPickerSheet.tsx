/**
 * ThreadPickerSheet — pick one of your Telegraph chats.
 *
 * Sharing a hidden gem asked the traveller to type a raw "Thread ID", which
 * nobody knows. This lists their chats (GET /api/me/threads, the list the
 * post ShareSheet uses) and answers the chosen thread's id.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { getMyThreads, type ThreadSummary } from '../services/messaging.ts';
import { color, radius, space, type as t } from '../theme/tokens.ts';

interface Props {
  visible: boolean;
  title: string;
  onCancel: () => void;
  onPick: (threadId: string) => void;
}

export function threadPickerLabel(thread: ThreadSummary): { name: string; kind: string } {
  const other = thread.otherMembers?.[0];
  const isDirect = thread.threadType === 'direct';
  const name = thread.title ?? (isDirect && other ? other.name : 'Chat');
  const kind = thread.threadType === 'trip' ? 'Trip chat'
    : thread.threadType === 'circle' ? 'Circle chat'
      : isDirect && other?.handle ? `@${other.handle}` : 'Chat';
  return { name, kind };
}

export function ThreadPickerSheet({ visible, title, onCancel, onPick }: Props) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setThreads(null);
    setFailed(false);
    getMyThreads().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        setThreads((res.data.threads ?? []).filter((th) => !th.archivedAt && th.threadType !== 'rent_buddy_booking'));
      } else {
        setFailed(true);
        setThreads([]);
      }
    });
    return () => { alive = false; };
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel="Close">
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel">
              <X size={20} color={color.ink} />
            </Pressable>
          </View>
          {threads === null ? (
            <ActivityIndicator color={color.signal} style={{ marginVertical: space.xl }} />
          ) : threads.length === 0 ? (
            <Text style={s.empty}>
              {failed ? 'Your chats could not be loaded. Check your connection and try again.' : 'You have no chats yet. Start one from Messages, then share here.'}
            </Text>
          ) : (
            <FlatList
              data={threads}
              keyExtractor={(th) => th.id}
              style={{ maxHeight: 420 }}
              renderItem={({ item }) => {
                const { name, kind } = threadPickerLabel(item);
                return (
                  <Pressable
                    style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
                    onPress={() => onPick(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Share to ${name}`}
                  >
                    <Text style={s.rowName} numberOfLines={1}>{name}</Text>
                    <Text style={s.rowSub} numberOfLines={1}>{kind}</Text>
                  </Pressable>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.lg, paddingBottom: space.xl * 2,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  title: { ...t.bodyStrong, color: color.ink },
  empty: { ...t.body, color: color.mute, marginVertical: space.lg },
  row: { paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  rowName: { ...t.bodyStrong, color: color.ink },
  rowSub: { ...t.small, color: color.mute, marginTop: 2 },
});
