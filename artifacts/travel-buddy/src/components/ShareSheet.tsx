/**
 * ShareSheet — share options for a post.
 *
 * Targets and how they're recorded:
 *   Share Post   → native OS share sheet        → target='external'
 *   Copy Link    → copies URL only              → target='copy_link'
 *   Send in a chat → real recipient picker; sends the post as a post_card
 *                    system message into the chosen Telegraph thread.
 *                    target derived from thread type:
 *                      direct → 'dm', trip → 'trip_crew', circle → 'circle'
 *
 * The in-app share is real end-to-end: it fetches the post (getPostById),
 * lets the user pick one of their threads (getMyThreads), and sends a
 * post_card message (sendMessage) that renders as a rich card in the thread
 * (see PostCardMessage). No fake "shared!" confirmations.
 *
 * The parent (PostEngagementBar) calls recordShare(postId, target) via
 * onShareSuccess so the correct target is always persisted.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Platform,
  Alert,
  ScrollView,
  ToastAndroid,
  TextInput,
  Image,
  ActivityIndicator,
  FlatList,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Share2,
  Link,
  MessageCircle,
  Send,
  Globe,
  Users,
  PlusCircle,
  X,
} from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, shadow } from '../theme/tokens.ts';
import { getMyThreads, sendMessage } from '../services/messaging.ts';
import type { ThreadSummary } from '../services/messaging.ts';
import { getPostById } from '../services/posts.ts';

export type ShareTarget = 'external' | 'copy_link' | 'dm' | 'group_chat' | 'trip_crew' | 'circle';

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
  onShareSuccess?: (target: ShareTarget) => void;
}

interface PostPreview {
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string | null;
  snippet?: string;
  thumbnail?: string | null;
  city?: string | null;
  country?: string | null;
  likeCount?: number;
  commentCount?: number;
}

function postPermalink(postId: string): string {
  return `https://travelbuddy.app/posts/${postId}`;
}

function targetForThread(threadType: ThreadSummary['threadType']): ShareTarget {
  if (threadType === 'trip') return 'trip_crew';
  if (threadType === 'circle') return 'circle';
  return 'dm';
}

export function ShareSheet({ visible, postId, onClose, onShareSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'menu' | 'picker'>('menu');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<PostPreview | null>(null);

  // Reset + hydrate whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setMode('menu');
    setSelectedId(null);
    setCaption('');
    setSending(false);
    setPreview(null);
    // Fetch a lightweight preview of the post so the sent card is rich and real.
    getPostById(postId)
      .then((res) => {
        if (res.ok && res.data) {
          const p = res.data;
          setPreview({
            authorName: p.author?.name,
            authorHandle: p.author?.handle,
            authorAvatar: p.author?.avatarUrl ?? null,
            snippet: (p.content ?? '').slice(0, 220),
            thumbnail: p.mediaUrls?.[0] ?? p.mediaThumbnailUrl ?? null,
            city: p.locationCity ?? null,
            country: p.locationCountry ?? null,
            likeCount: p.likeCount,
            commentCount: p.commentCount,
          });
        }
      })
      .catch(() => {});
  }, [visible, postId]);

  const openPicker = useCallback(() => {
    setMode('picker');
    setLoadingThreads(true);
    getMyThreads()
      .then((res) => {
        if (res.ok && res.data) setThreads(res.data.threads.slice(0, 15));
      })
      .catch(() => {})
      .finally(() => setLoadingThreads(false));
  }, []);

  const handleNativeShare = useCallback(async () => {
    onClose();
    try {
      const result = await Share.share({
        message: `Check out this post on Travel Buddy!\n${postPermalink(postId)}`,
        ...(Platform.OS === 'ios' ? { url: postPermalink(postId) } : {}),
      });
      if (result.action === Share.sharedAction) {
        onShareSuccess?.('external');
      }
    } catch (_) {
      // User cancelled or share unavailable — silent
    }
  }, [postId, onClose, onShareSuccess]);

  const handleCopyLink = useCallback(async () => {
    onClose();
    try {
      await Clipboard.setStringAsync(postPermalink(postId));
      onShareSuccess?.('copy_link');
      if (Platform.OS === 'android') {
        ToastAndroid.show('Link copied', ToastAndroid.SHORT);
      } else {
        Alert.alert('Copied', 'Post link copied to clipboard.');
      }
    } catch (_) {
      Alert.alert('Error', 'Could not copy link. Please try again.');
    }
  }, [postId, onClose, onShareSuccess]);

  const handleSend = useCallback(async () => {
    if (!selectedId) return;
    const thread = threads.find((t) => t.id === selectedId);
    if (!thread) return;
    setSending(true);
    try {
      const payload = {
        postId,
        permalink: postPermalink(postId),
        authorName: preview?.authorName,
        authorHandle: preview?.authorHandle,
        authorAvatar: preview?.authorAvatar ?? null,
        snippet: preview?.snippet,
        thumbnail: preview?.thumbnail ?? null,
        city: preview?.city ?? null,
        country: preview?.country ?? null,
        likeCount: preview?.likeCount,
        commentCount: preview?.commentCount,
        caption: caption.trim() || undefined,
      };
      const res = await sendMessage(selectedId, JSON.stringify(payload), {
        msgType: 'system',
        subtype: 'post_card',
      });
      if (res.ok) {
        onShareSuccess?.(targetForThread(thread.threadType));
        onClose();
        Alert.alert('Sent!', 'Post shared to your chat.');
      } else {
        Alert.alert('Could not send', 'Something went wrong. Please try again.');
      }
    } catch {
      Alert.alert('Could not send', 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }, [selectedId, threads, postId, preview, caption, onClose, onShareSuccess]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {mode === 'menu' ? (
          <>
            <View style={s.header}>
              <Text style={s.title}>Share Post</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={s.scrollContent}
            >
              <ShareOption
                iconBg="#EEF1FF"
                icon={<Share2 size={20} color="#4A6CF7" />}
                label="Share Post"
                sub="Open share menu"
                onPress={handleNativeShare}
              />

              <ShareOption
                iconBg="#EDF7EE"
                icon={<Link size={20} color={color.success} />}
                label="Copy Link"
                sub="Share the post URL"
                onPress={handleCopyLink}
              />

              <View style={s.sectionLabel}>
                <Text style={s.sectionLabelText}>Share in app</Text>
              </View>

              <ShareOption
                iconBg="#FFF3EE"
                icon={<MessageCircle size={20} color="#F97316" />}
                label="Send in a chat"
                sub="Send this post to a Telegraph chat, trip crew, or circle"
                onPress={openPicker}
              />
            </ScrollView>

            <Pressable style={s.cancel} onPress={onClose}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={s.header}>
              <Pressable onPress={() => setMode('menu')} hitSlop={10}>
                <Text style={s.backText}>‹ Back</Text>
              </Pressable>
              <Text style={s.title}>Send to</Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            <TextInput
              style={s.captionInput}
              placeholder="Add a note (optional)…"
              placeholderTextColor={color.faint}
              value={caption}
              onChangeText={setCaption}
              maxLength={200}
              multiline
            />

            <Text style={s.chooseLabel}>CHOOSE A CHAT</Text>

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
                ItemSeparatorComponent={() => (
                  <View style={{ height: 1, backgroundColor: color.haze }} />
                )}
              />
            )}

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
          </>
        )}
      </View>
    </Modal>
  );
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
          {thread.threadType === 'trip'
            ? 'Trip chat'
            : thread.threadType === 'circle'
            ? 'Circle'
            : 'Direct message'}
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

function ShareOption({
  iconBg,
  icon,
  label,
  sub,
  onPress,
}: {
  iconBg: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={s.option} onPress={onPress}>
      <View style={[s.iconWrap, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={s.optionText}>
        <Text style={s.optionLabel}>{label}</Text>
        <Text style={s.optionSub}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.md,
    maxHeight: '80%',
    ...shadow.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  backText: {
    fontSize: 15,
    fontWeight: '600',
    color: color.signal,
  },
  scrollContent: {
    gap: 0,
  },
  sectionLabel: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  sectionLabelText: {
    fontSize: 11,
    fontWeight: '700',
    color: color.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },
  optionSub: {
    fontSize: 12,
    color: color.faint,
  },
  cancel: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.haze,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: color.ink,
  },

  // Picker
  captionInput: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 14,
    color: color.ink,
    minHeight: 42,
    maxHeight: 80,
  },
  chooseLabel: {
    fontSize: 10,
    fontFamily: 'Courier',
    color: color.mute,
    letterSpacing: 0.5,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  newThreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
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
  newThreadLabel: { fontSize: 14, fontWeight: '700', color: color.signal },
  newThreadSub: { fontSize: 11, color: color.mute, marginTop: 1 },

  loadingRow: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyLabel: { fontSize: 13, color: color.mute, textAlign: 'center' },

  list: {
    maxHeight: 240,
    marginHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.md,
  },
  threadRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 12 },
  threadRowSelected: { backgroundColor: color.signal + '0A' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.haze },
  avatarFallback: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarFallbackSelected: { backgroundColor: color.signal + '22' },
  avatarInitial: { fontSize: 14, fontWeight: '700', color: color.signal },
  threadName: { fontSize: 14, fontWeight: '700', color: color.ink },
  threadNameSelected: { color: color.signal },
  threadSub: { fontSize: 11, color: color.mute, marginTop: 1 },
  checkBadge: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  checkText: { fontSize: 12, color: color.onInk, fontWeight: '700' },

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendLabel: { fontSize: 15, fontWeight: '700', color: color.onInk },
});
