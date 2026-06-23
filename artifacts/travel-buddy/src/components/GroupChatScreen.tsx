/**
 * GroupChatScreen — reusable group chat UI for trip and circle contexts.
 *
 * Handles all 5 states:
 *   loading, empty, no-access (removed), pending-invite, error
 *
 * Features: day dividers, system-event pills, long-press action sheet,
 * read receipts, rich header with type badge + action icons,
 * updated composer with Discovery / AI stub icons.
 */
import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  Alert,
  Modal,
  Share,
} from 'react-native';
import { router } from 'expo-router';
import {
  ArrowLeft, Send, Users, Globe, Info, VolumeX, Languages, Paperclip,
  Compass, Bot, Copy, Trash2, Flag, Reply, CheckCheck, Search, BookmarkPlus,
  AlertCircle, RefreshCw,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroupChat } from '../hooks/useGroupChat';
import { useSession } from '../context/SessionContext';
import { color, space, radius, type as t } from '../theme/tokens';
import { TelegraphSystemNotice } from './TelegraphSystemNotice';
import type { Message } from '../services/messaging';
import { deleteMessage } from '../services/messaging';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(isoDay: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (isoDay === today) return 'Today';
  if (isoDay === yest) return 'Yesterday';
  return new Date(isoDay + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function DayDivider({ label }: { label: string }) {
  return (
    <View style={dd.wrap}>
      <View style={dd.line} />
      <Text style={dd.label}>{label}</Text>
      <View style={dd.line} />
    </View>
  );
}
const dd = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, paddingHorizontal: 4 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.haze },
  label: { ...t.stamp, fontFamily: 'Courier', fontSize: 10, color: color.mute, paddingHorizontal: 10, letterSpacing: 0.5 },
});

function LongPressActionSheet({
  message,
  mine,
  onClose,
  onDeleteForMe,
}: {
  message: Message | null;
  mine: boolean;
  onClose: () => void;
  onDeleteForMe: (id: string) => Promise<void>;
}) {
  if (!message) return null;
  const text = message.displayBody ?? message.body ?? '';
  const actions: [string, string, React.ComponentType<{ size: number; color: string }>][] = [
    ['reply',     'Reply',         Reply        ],
    ['copy',      'Copy text',     Copy         ],
    ['translate', 'Translate',     Languages    ],
    ['save',      'Save message',  BookmarkPlus ],
    ['report',    'Report',        Flag         ],
  ];
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={las.overlay} onPress={onClose} />
      <View style={las.sheet}>
        <View style={las.handle} />
        {text.length > 0 && (
          <Text style={las.preview} numberOfLines={2}>{text}</Text>
        )}
        {actions.map(([key, label, Icon]) => (
          <Pressable
            key={key}
            style={las.row}
            onPress={async () => {
              onClose();
              if (key === 'copy') {
                await Clipboard.setStringAsync(text);
                Alert.alert('Copied', 'Message copied to clipboard.');
              } else if (key === 'report') {
                Alert.alert('Report message', 'Are you sure you want to report this message?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Report', style: 'destructive', onPress: () => {} },
                ]);
              } else {
                Alert.alert(label, 'This feature is coming soon.');
              }
            }}
          >
            <Icon size={18} color={color.ink} />
            <Text style={las.rowLabel}>{label}</Text>
          </Pressable>
        ))}
        {mine && (
          <Pressable
            style={las.row}
            onPress={() => {
              onClose();
              Alert.alert('Delete message', 'Remove this message for you? Others will still see it.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => onDeleteForMe(message.id),
                },
              ]);
            }}
          >
            <Trash2 size={18} color="#EF4444" />
            <Text style={[las.rowLabel, { color: '#EF4444' }]}>Delete for me</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}
const las = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 34,
    paddingTop: space.sm,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  preview: { ...t.small, color: color.mute, fontSize: 12, marginBottom: space.sm, fontStyle: 'italic' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  rowLabel: { ...t.body, color: color.ink },
});

function GroupMessageBubble({
  item,
  mine,
  onLongPress,
  isLastOwn,
}: {
  item: Message;
  mine: boolean;
  onLongPress?: () => void;
  isLastOwn?: boolean;
}) {
  if (item.deleted) {
    return (
      <Pressable
        style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}
        onLongPress={onLongPress}
        delayLongPress={300}
      >
        <Text style={[styles.bubbleText, { fontStyle: 'italic', color: mine ? color.onInk + 'AA' : color.mute }]}>
          This message was deleted.
        </Text>
      </Pressable>
    );
  }

  const bodyToShow = item.displayBody ?? item.body ?? '';

  return (
    <View>
      {!mine && item.senderName ? (
        <Text style={styles.senderName}>{item.senderName}</Text>
      ) : null}
      <Pressable
        style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}
        onLongPress={onLongPress}
        delayLongPress={300}
      >
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{bodyToShow}</Text>
        <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
          {formatTime(item.createdAt)}
          {item.editedAt ? '  ·  edited' : ''}
        </Text>
      </Pressable>
      {mine && isLastOwn && (
        <View style={styles.receiptRow}>
          <CheckCheck size={11} color={color.signal} />
          <Text style={styles.receiptSent}>Sent</Text>
        </View>
      )}
    </View>
  );
}

interface Props {
  type: 'trip' | 'circle';
  id: string;
  title?: string;
  memberLabel?: string;
}

export function GroupChatScreen({ type, id, title, memberLabel }: Props) {
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { state, thread, messages, sending, errorMessage, reload, send } = useGroupChat(type, id);
  const [input, setInput] = useState('');
  const [sendFailed, setSendFailed] = useState(false);
  const [lastSentText, setLastSentText] = useState<string | undefined>(undefined);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [actionMsgMine, setActionMsgMine] = useState(false);
  const listRef = useRef<FlatList>(null);

  const displayTitle = thread?.title ?? title ?? (type === 'trip' ? 'Trip Chat' : 'Circle Chat');
  const isNoAccess = state === 'no_access' || thread?.memberAccess === 'removed';

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  // Build list items with day separators
  type ListItem =
    | { _t: 'msg'; data: Message }
    | { _t: 'day'; label: string; key: string };

  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = [];
    let lastDay = '';
    for (const m of messages) {
      const day = m.createdAt.slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        items.push({ _t: 'day', label: formatDayLabel(day), key: `day-${day}` });
      }
      items.push({ _t: 'msg', data: m });
    }
    return items;
  }, [messages]);

  const lastOwnMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId === userId) return messages[i].id;
    }
    return null;
  }, [messages, userId]);

  const handleDeleteForMe = useCallback(async (msgId: string) => {
    await deleteMessage(msgId);
    reload();
  }, [reload]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending || isNoAccess) return;
    setInput('');
    setLastSentText(text);
    setSendFailed(false);
    const res = await send(text);
    if (!res?.ok) setSendFailed(true);
    listRef.current?.scrollToEnd({ animated: true });
  }

  const Header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
        <ArrowLeft size={20} color={color.ink} />
      </Pressable>
      <View style={[styles.headerIconBadge, type === 'circle' && { backgroundColor: color.ink }]}>
        {type === 'trip'
          ? <Globe size={14} color={color.onInk} />
          : <Users size={14} color={color.onInk} />}
      </View>
      <View style={styles.headerMeta}>
        <Text style={styles.headerName} numberOfLines={1}>{displayTitle}</Text>
        {memberLabel ? (
          <View style={styles.headerTagRow}>
            <Users size={9} color={color.mute} />
            <Text style={styles.headerTag}>{memberLabel}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.headerActions}>
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          onPress={() => Alert.alert('Thread info', 'Members, shared media, and settings — coming soon.')}
        >
          <Info size={18} color={color.mute} />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          onPress={() => Alert.alert('Search messages', 'Message search coming soon.')}
        >
          <Search size={18} color={color.mute} />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          onPress={() => Alert.alert('Translation settings', 'Adjust translation preferences in Settings → Language.')}
        >
          <Languages size={18} color={color.mute} />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          onPress={() => Alert.alert('Mute thread', 'Mute controls coming soon.')}
        >
          <VolumeX size={18} color={color.mute} />
        </Pressable>
      </View>
    </View>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (state === 'pending_invite') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateIcon}>✉️</Text>
          <Text style={styles.stateTitle}>Invite Pending</Text>
          <Text style={styles.stateNote}>Accept the invite to join this chat.</Text>
        </View>
      </View>
    );
  }

  if (state === 'no_access') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔒</Text>
          <Text style={styles.stateTitle}>No longer a member</Text>
          <Text style={styles.stateNote}>You no longer have access to this chat.</Text>
        </View>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateNote}>{errorMessage ?? "Couldn't load chat. Try again."}</Text>
          <Pressable style={styles.retryBtn} onPress={reload}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {Header}

      <FlatList
        ref={listRef}
        data={listItems}
        keyExtractor={(item) => item._t === 'day' ? item.key : item.data.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>💬</Text>
            <Text style={styles.stateTitle}>Start the conversation</Text>
            <Text style={styles.stateNote}>
              {type === 'trip'
                ? 'Start the trip conversation.'
                : 'Say something to your circle.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item._t === 'day') {
            return <DayDivider label={item.label} />;
          }
          const m = item.data;
          const mine = m.senderId === userId;
          // System-event messages render as centred pill labels
          if (m.msgType === 'system') {
            return <TelegraphSystemNotice text={m.body ?? ''} />;
          }
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              {!mine && (
                <View style={[styles.avatar, styles.avatarSmall]}>
                  {m.senderAvatarUrl ? (
                    <Image source={{ uri: m.senderAvatarUrl }} style={styles.avatarSmall} />
                  ) : (
                    <Text style={styles.avatarInitial}>
                      {(m.senderName?.[0] ?? '?').toUpperCase()}
                    </Text>
                  )}
                </View>
              )}
              <GroupMessageBubble
                item={m}
                mine={mine}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setActionMsg(m);
                  setActionMsgMine(mine);
                }}
                isLastOwn={m.id === lastOwnMsgId && !sendFailed}
              />
            </View>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      {/* Failed-send banner — sits above the composer, offers retry */}
      {sendFailed && lastSentText && (
        <View style={styles.failedBanner}>
          <AlertCircle size={14} color="#EF4444" />
          <Text style={styles.failedBannerText} numberOfLines={1}>
            Failed to send: "{lastSentText}"
          </Text>
          <Pressable
            style={styles.failedRetryBtn}
            onPress={() => {
              const text = lastSentText;
              setSendFailed(false);
              setInput(text);
            }}
          >
            <RefreshCw size={12} color="#EF4444" />
            <Text style={styles.failedRetryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {isNoAccess ? (
          <View style={styles.noAccessBar}>
            <Text style={styles.noAccessText}>You no longer have access to this chat.</Text>
          </View>
        ) : (
          <>
            <Pressable
              style={styles.composeIconBtn}
              onPress={() => Alert.alert('Attach', 'File attachments coming soon.')}
              hitSlop={6}
            >
              <Paperclip size={18} color={color.mute} />
            </Pressable>
            <Pressable
              style={styles.composeIconBtn}
              onPress={() => Alert.alert('Share Discovery', 'Share a place from Discovery — coming soon.')}
              hitSlop={6}
            >
              <Compass size={18} color={color.mute} />
            </Pressable>
            <Pressable
              style={styles.composeIconBtn}
              onPress={() => Alert.alert('AI Suggestions', 'Compass AI suggestions — coming soon.')}
              hitSlop={6}
            >
              <Bot size={18} color={color.mute} />
            </Pressable>
            <TextInput
              style={styles.inputField}
              placeholder="Write a Telegraph…"
              placeholderTextColor={color.faint}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              editable={!sending}
              multiline
            />
            <Pressable
              style={[
                styles.sendBtn,
                (input.trim() && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled,
              ]}
              onPress={handleSend}
              disabled={!input.trim() || sending}
            >
              {sending ? (
                <ActivityIndicator size="small" color={color.onInk} />
              ) : (
                <Send size={16} color={input.trim() ? color.onInk : color.faint} />
              )}
            </Pressable>
          </>
        )}
      </View>

      <LongPressActionSheet
        message={actionMsg}
        mine={actionMsgMine}
        onClose={() => setActionMsg(null)}
        onDeleteForMe={handleDeleteForMe}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  backBtn: { padding: 4, flexShrink: 0 },
  headerIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerMeta: { flex: 1, minWidth: 0 },
  headerName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
  headerIconBtn: { padding: 5 },

  stateIcon: { fontSize: 36, marginBottom: space.md },
  stateTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center', marginBottom: space.sm },
  stateNote: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },

  retryBtn: {
    marginTop: space.lg,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
  },
  retryText: { ...t.bodyStrong, color: color.onInk },

  emptyIcon: { fontSize: 32, marginBottom: space.md },

  list: { paddingHorizontal: space.lg, paddingVertical: space.md, flexGrow: 1 },

  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, maxWidth: '86%' },
  bubbleRowMine: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },

  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.haze, overflow: 'hidden', flexShrink: 0 },
  avatarSmall: { width: 28, height: 28, borderRadius: 14 },
  avatarInitial: { fontSize: 12, color: color.ink, textAlign: 'center', lineHeight: 28 },

  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 6,
    flexShrink: 1,
    maxWidth: '100%',
  },
  bubbleOther: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: { backgroundColor: color.signal, borderBottomRightRadius: 4 },

  senderName: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, marginBottom: 2, letterSpacing: 0.2 },

  bubbleText: { ...t.body, color: color.ink, lineHeight: 20, flexShrink: 1, flexWrap: 'wrap' },
  bubbleTextMine: { color: color.onInk },

  bubbleTime: { ...t.stamp, fontFamily: 'Courier', color: color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' },
  bubbleTimeMine: { color: color.onInk + '88' },

  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  receiptSent: { fontSize: 10, color: color.signal, fontFamily: 'Courier' },

  compose: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  composeIconBtn: { width: 32, height: 38, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  inputField: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    ...t.body,
    color: color.ink,
  },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sendBtnActive: { backgroundColor: color.signal },
  sendBtnDisabled: { backgroundColor: color.haze },

  noAccessBar: { flex: 1, paddingVertical: space.md, alignItems: 'center' },
  noAccessText: { ...t.small, color: color.mute, textAlign: 'center' },

  failedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    backgroundColor: '#FEF2F2',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#FECACA',
  },
  failedBannerText: { ...t.small, color: '#EF4444', flex: 1, fontSize: 11 },
  failedRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  failedRetryText: { ...t.stamp, color: '#EF4444', fontSize: 10, fontWeight: '600' },
});
