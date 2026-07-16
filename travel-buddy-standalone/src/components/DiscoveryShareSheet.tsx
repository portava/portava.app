/**
 * DiscoveryShareSheet — bottom sheet for sending a Discovery item to a Telegraph thread.
 *
 * Usage: open with an item payload (title, category, city, blurb, sourceId, sourceType).
 * The user picks a recent thread and optionally adds a caption.
 * Sends the card as msgType='system', subtype='discovery_card'.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
} from 'react-native';
import {
  X,
  Send,
  Compass,
  MapPin,
  Globe,
  Users,
  MessageCircle,
  PlusCircle,
} from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { getMyThreads, sendMessage } from '../services/messaging.ts';
import type { ThreadSummary } from '../services/messaging.ts';

export interface DiscoverySharePayload {
  sourceId: string;
  sourceType: 'hidden_gem' | 'traveler_pick' | 'for_you' | 'place';
  title: string;
  category: string;
  city: string;
  blurb?: string;
  imageUrl?: string;
  priceLevel?: string;
}

interface Props {
  visible: boolean;
  item: DiscoverySharePayload | null;
  onClose: () => void;
}

function ThreadRow({
  thread,
  selected,
  onPress,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const isDirect = thread.threadType === 'direct';
  const other = thread.otherMembers[0];
  const displayName = thread.title ?? (isDirect && other ? other.name : 'Chat');
  const avatarUrl = isDirect && other ? other.avatarUrl : null;
  const initials = displayName[0]?.toUpperCase() ?? '?';

  return (
    <Pressable style={[s.threadRow, selected && s.threadRowSelected]} onPress={onPress}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={s.avatar} />
      ) : (
        <View style={[s.avatarFallback, selected && s.avatarFallbackSelected]}>
          {thread.threadType === 'trip' ? (
            <Globe size={14} color={selected ? color.onInk : color.signal} />
          ) : thread.threadType === 'circle' ? (
            <Users size={14} color={selected ? color.onInk : color.signal} />
          ) : (
            <Text style={[s.avatarInitial, selected && { color: color.onInk }]}>{initials}</Text>
          )}
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[s.threadName, selected && s.threadNameSelected]} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={s.threadSub} numberOfLines={1}>
          {thread.threadType === 'trip' ? 'Trip chat' : thread.threadType === 'circle' ? 'Circle' : 'Direct message'}
        </Text>
      </View>
      {selected && (
        <View style={s.checkBadge}>
          <Text style={s.checkText}>✓</Text>
        </View>
      )}
    </Pressable>
  );
}

export function DiscoveryShareSheet({ visible, item, onClose }: Props) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSelectedId(null);
    setCaption('');
    setLoadingThreads(true);
    getMyThreads()
      .then((res) => {
        if (res.ok && res.data) {
          setThreads(res.data.threads.slice(0, 15));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingThreads(false));
  }, [visible]);

  async function handleSend() {
    if (!selectedId || !item) return;
    setSending(true);
    try {
      const payload = {
        sourceId: item.sourceId,
        sourceType: item.sourceType,
        title: item.title,
        category: item.category,
        city: item.city,
        blurb: item.blurb,
        imageUrl: item.imageUrl,
        priceLevel: item.priceLevel,
        caption: caption.trim() || undefined,
      };
      const res = await sendMessage(
        selectedId,
        JSON.stringify(payload),
        { msgType: 'system', subtype: 'discovery_card' },
      );
      if (res.ok) {
        onClose();
        Alert.alert('Sent!', 'Discovery place shared to your chat.');
      } else {
        Alert.alert('Could not send', 'Something went wrong. Please try again.');
      }
    } catch {
      Alert.alert('Could not send', 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <View style={s.compassBadge}>
              <Compass size={14} color={color.onInk} />
            </View>
            <Text style={s.title}>Share to Telegraph</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        {/* Item preview */}
        {item && (
          <View style={s.preview}>
            <View style={s.previewChip}>
              <Text style={s.previewChipText}>{item.category}</Text>
            </View>
            <Text style={s.previewTitle} numberOfLines={1}>{item.title}</Text>
            <View style={s.previewLocRow}>
              <MapPin size={11} color={color.mute} />
              <Text style={s.previewLoc} numberOfLines={1}>{item.city}</Text>
            </View>
          </View>
        )}

        {/* Caption */}
        <TextInput
          style={s.captionInput}
          placeholder="Add a note (optional)…"
          placeholderTextColor={color.faint}
          value={caption}
          onChangeText={setCaption}
          maxLength={200}
          multiline
        />

        {/* Thread list */}
        <Text style={s.sectionLabel}>CHOOSE A CHAT</Text>

        {/* New Telegraph option — always shown at the top */}
        <Pressable
          style={s.newThreadRow}
          onPress={() => {
            onClose();
            router.push('/(tabs)/messages' as any);
          }}
        >
          <View style={s.newThreadIcon}>
            <PlusCircle size={16} color={color.signal} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.newThreadLabel}>New Telegraph</Text>
            <Text style={s.newThreadSub}>Start a new conversation</Text>
          </View>
        </Pressable>

        {loadingThreads ? (
          <View style={s.loadingRow}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        ) : threads.length === 0 ? (
          <View style={s.loadingRow}>
            <MessageCircle size={24} color={color.faint} />
            <Text style={s.emptyLabel}>No existing chats yet.</Text>
          </View>
        ) : (
          <FlatList
            data={threads}
            keyExtractor={(t) => t.id}
            style={s.list}
            renderItem={({ item: thread }) => (
              <ThreadRow
                thread={thread}
                selected={selectedId === thread.id}
                onPress={() => setSelectedId(thread.id)}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: color.haze }} />}
          />
        )}

        {/* Send button */}
        <Pressable
          style={[s.sendBtn, (!selectedId || sending) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!selectedId || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : (
            <>
              <Send size={15} color={color.onInk} />
              <Text style={s.sendLabel}>Send</Text>
            </>
          )}
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    paddingTop: space.sm,
    maxHeight: '85%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  compassBadge: { width: 28, height: 28, borderRadius: 8, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },

  preview: {
    backgroundColor: color.signal + '0A',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal + '30',
    padding: space.md,
    gap: 4,
    marginBottom: space.md,
  },
  previewChip: { alignSelf: 'flex-start', backgroundColor: color.signal + '22', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  previewChipText: { ...t.stamp, fontFamily: 'Courier', fontSize: 10, color: color.signal, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  previewTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  previewLocRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  previewLoc: { ...t.small, color: color.mute, fontSize: 11 },

  captionInput: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    ...t.body,
    color: color.ink,
    minHeight: 42,
    maxHeight: 80,
    marginBottom: space.md,
  },

  sectionLabel: { ...t.stamp, fontFamily: 'Courier', fontSize: 10, color: color.mute, letterSpacing: 0.5, marginBottom: space.sm },

  loadingRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyLabel: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },

  list: { maxHeight: 220, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.md },
  threadRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 12 },
  threadRowSelected: { backgroundColor: color.signal + '0A' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.haze },
  avatarFallback: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarFallbackSelected: { backgroundColor: color.signal + '22' },
  avatarInitial: { fontSize: 14, fontWeight: '700', color: color.signal },
  threadName: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  threadNameSelected: { color: color.signal },
  threadSub: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  checkBadge: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  checkText: { fontSize: 12, color: color.onInk, fontWeight: '700' },

  newThreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal + '40',
    backgroundColor: color.signal + '07',
    marginBottom: space.sm,
  },
  newThreadIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.signal + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newThreadLabel: { ...t.bodyStrong, color: color.signal, fontWeight: '700', fontSize: 14 },
  newThreadSub: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginTop: space.sm,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700', fontSize: 15 },
});
