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
  Image,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
  Share,
  Switch,
  TextInput,
  Animated,
} from 'react-native';
import { supabase } from '../lib/supabase.ts';
import { AvatarImage } from './ui/DisplayMediaImage.tsx';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import type { AnyMentionSuggestion } from '../services/tagging.ts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { router } from 'expo-router';
import {
  ArrowLeft, Send, Users, Globe, Info, VolumeX, Languages, Paperclip,
  Compass, Bot, Copy, Trash2, Flag, Reply, Check, CheckCheck, Search, BookmarkPlus, X,
  AlertCircle, RefreshCw, CalendarClock, Clock,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroupChat } from '../hooks/useGroupChat.ts';
import { useSession } from '../context/SessionContext.tsx';
import { color, space, radius, type as t, avatar, icon } from '../theme/tokens.ts';
import { TG, TG_SPACING } from '../theme/telegraphTokens.ts';
import { TelegraphSystemNotice } from './TelegraphSystemNotice.tsx';
import { TranslationSettingsSheet } from './TranslationSettingsSheet.tsx';
import { TripMembersSheet } from './TripMembersSheet.tsx';
import type { Message } from '../services/messaging.ts';
import { deleteMessage, saveMessage, sendMediaMessage, muteThread } from '../services/messaging.ts';
import { useMessageMediaPicker } from '../hooks/useMessageMediaPicker.ts';
import { MessageMediaBubble } from './MessageMediaBubble.tsx';
import { reportContent, type ReasonCode } from '../services/reports.ts';
import { getTripMembers, getCircleMembers, type FriendUser } from '../services/friends.ts';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { MessageEntrance, useMessageEntranceGate } from './MessageEntrance.tsx';
import { UserIdentityLink } from './interaction/UserIdentityLink.tsx';
import { localDateKey, localTodayKey } from '../utils/localDate.ts';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(isoDay: string): string {
  // LOCAL calendar day, not UTC. With toISOString() a message shown as "07:30 PM"
  // could sit under "Yesterday", and one local day straddling two UTC days
  // mislabels scrollback permanently.
  const today = localTodayKey();
  const yest = localDateKey(new Date(Date.now() - 86400000));
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

const REPORT_MSG_REASONS: { code: ReasonCode; label: string }[] = [
  { code: 'spam',           label: 'Spam or misleading' },
  { code: 'harassment',     label: 'Harassment or bullying' },
  { code: 'hate_speech',    label: 'Hate speech' },
  { code: 'violence',       label: 'Violent or dangerous content' },
  { code: 'nudity',         label: 'Nudity or sexual content' },
  { code: 'misinformation', label: 'Misinformation' },
  { code: 'other',          label: 'Something else' },
];

function LongPressActionSheet({
  message,
  mine,
  onClose,
  onDeleteForMe,
  onReply,
  onSave,
}: {
  message: Message | null;
  mine: boolean;
  onClose: () => void;
  onDeleteForMe: (id: string) => Promise<void>;
  onReply: (msg: Message) => void;
  onSave: (msg: Message) => void;
}) {
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState<ReasonCode | null>(null);
  const [reportDetail, setReportDetail] = useState('');
  const [reportSending, setReportSending] = useState(false);

  async function submitReport() {
    if (!reportReason || !message) return;
    setReportSending(true);
    const detail = reportDetail.trim();
    const result = await reportContent({
      target_type: 'message',
      target_id: message.id,
      reason_code: reportReason,
      ...(detail ? { reason_detail: detail } : {}),
    }).catch(() => ({ ok: false as const }));
    setReportSending(false);
    if (result.ok) {
      setShowReport(false);
      onClose();
      Alert.alert('Report submitted', 'Thank you. Our team will review this message.');
    } else {
      Alert.alert('Error', (result as any).error ?? 'Could not submit report');
    }
  }

  if (!message) return null;
  const text = message.displayBody ?? message.body ?? '';
  const actions: [string, string, React.ComponentType<{ size: number; color: string }>][] = [
    // 'translate' removed — translations are automatic per language settings;
    // a menu item that only explained that was a dead end.
    ['reply',     'Reply',         Reply        ],
    ['copy',      'Copy text',     Copy         ],
    ['save',      'Save message',  BookmarkPlus ],
    ['report',    'Report',        Flag         ],
  ];
  if (showReport) {
    return (
      <Modal visible animationType="slide" transparent onRequestClose={onClose}>
        <Pressable style={las.overlay} onPress={onClose} />
        <View style={las.sheet}>
          <View style={las.handle} />
          <Text style={las.reportTitle}>Report this message</Text>
          <Text style={las.reportSub}>What's wrong with this message?</Text>
          {REPORT_MSG_REASONS.map((r) => (
            <Pressable
              key={r.code}
              style={[las.reasonOption, reportReason === r.code && las.reasonSelected]}
              onPress={() => setReportReason(r.code)}
            >
              <Text style={[las.reasonText, reportReason === r.code && las.reasonTextSelected]}>{r.label}</Text>
              {reportReason === r.code && <Text style={las.reasonCheck}>✓</Text>}
            </Pressable>
          ))}
          {reportReason !== null && (
            <TextInput
              style={las.detailInput}
              value={reportDetail}
              onChangeText={setReportDetail}
              placeholder="Tell us more (optional)"
              placeholderTextColor={color.mute}
              multiline
              maxLength={500}
            />
          )}
          <Pressable
            style={[las.reportBtn, (!reportReason || reportSending) && las.reportBtnDisabled]}
            onPress={submitReport}
            disabled={!reportReason || reportSending}
          >
            {reportSending
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={las.reportBtnLabel}>Submit Report</Text>}
          </Pressable>
          <Pressable style={las.backBtn} onPress={() => setShowReport(false)}>
            <Text style={las.backLabel}>Back</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }
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
              if (key === 'copy') {
                onClose();
                await Clipboard.setStringAsync(text);
                Alert.alert('Copied', 'Message copied to clipboard.');
              } else if (key === 'report') {
                setShowReport(true);
              } else if (key === 'reply') {
                onClose();
                onReply(message);
              } else if (key === 'save') {
                onClose();
                onSave(message);
              } else {
                onClose();
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
  reportTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15, marginBottom: 2 },
  reportSub: { ...t.small, color: color.mute, marginBottom: space.md },
  reasonOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginBottom: 6 },
  reasonSelected: { borderColor: color.signal, backgroundColor: color.signal + '0A' },
  reasonText: { ...t.body, color: color.ink },
  reasonTextSelected: { color: color.signal, fontWeight: '700' },
  reasonCheck: { fontSize: 14, color: color.signal, fontWeight: '700' },
  detailInput: { ...t.body, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: 10, minHeight: 64, textAlignVertical: 'top', marginTop: 2 },
  reportBtn: { marginTop: space.md, backgroundColor: '#EF4444', borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  reportBtnDisabled: { opacity: 0.45 },
  reportBtnLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  backBtn: { paddingVertical: 10, alignItems: 'center' },
  backLabel: { ...t.body, color: color.mute },
});

function GroupMessageBubble({
  item,
  mine,
  onLongPress,
  receiptState,
  readerAvatars,
  autoTranslate,
  defaultShowOriginal,
  deliveryStatus,
  onRetry,
}: {
  item: Message;
  mine: boolean;
  onLongPress?: () => void;
  receiptState?: 'sent' | 'delivered' | 'read' | null;
  /** Up to 3 avatar URIs of members who've read past this message. */
  readerAvatars?: string[];
  autoTranslate: boolean;
  defaultShowOriginal: boolean;
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null;
  onRetry?: () => void;
}) {
  const [showOriginal, setShowOriginal] = useState(defaultShowOriginal || !autoTranslate);

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

  // Choose which body to display based on translation settings
  let bodyToShow: string;
  if (mine || !autoTranslate || showOriginal) {
    bodyToShow = item.originalBody ?? item.body ?? '';
  } else {
    bodyToShow = item.displayBody ?? item.body ?? '';
  }

  const isTranslated = !mine && item.translated && autoTranslate && !showOriginal;
  const isPending = !mine && item.translationStatus === 'pending';
  const isTranslationFailed = !mine && item.translationStatus === 'failed' && autoTranslate;
  const showLabel = !mine && (
    isPending ||
    (isTranslated && !!item.translationLabel) ||
    !!item.canShowOriginal
  );

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
        {item.replyToId && item.replyToBody ? (
          <View style={[styles.replyQuote, mine && styles.replyQuoteMine]}>
            <View style={styles.replyQuoteAccent} />
            <View style={{ flex: 1 }}>
              {item.replyToSenderName ? (
                <Text style={styles.replyQuoteSender}>{item.replyToSenderName}</Text>
              ) : null}
              <Text style={styles.replyQuoteBody} numberOfLines={2}>{item.replyToBody}</Text>
            </View>
          </View>
        ) : null}
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{bodyToShow}</Text>
        <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
          {formatTime(item.createdAt)}
          {item.editedAt ? '  ·  edited' : ''}
        </Text>

        {/* Translation label + original/translated toggle */}
        {showLabel && (
          <View style={styles.translationRow}>
            {isPending ? (
              <Text style={styles.transLabel}>Translating…</Text>
            ) : isTranslated && item.translationLabel ? (
              <Text style={styles.transLabel}>{item.translationLabel}</Text>
            ) : null}
            {item.canShowOriginal && autoTranslate && (
              <Pressable onPress={() => setShowOriginal((v) => !v)} hitSlop={8}>
                <Text style={styles.transToggle}>
                  {showOriginal ? 'Show translation' : 'Show original'}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Translation unavailable */}
        {isTranslationFailed && (
          <Text style={styles.transUnavailable}>Translation unavailable.</Text>
        )}
      </Pressable>
      {/* Delivery status — sending / sent / failed (tap-to-retry) */}
      {mine && deliveryStatus === 'sending' && (
        <View style={styles.deliveryRow}>
          <Clock size={11} color={color.mute} />
          <Text style={styles.deliverySending}>Sending…</Text>
        </View>
      )}
      {mine && deliveryStatus === 'sent' && !receiptState && (
        <View style={styles.deliveryRow}>
          <Check size={11} color={color.signal} />
          <Text style={styles.deliverySent}>Sent</Text>
        </View>
      )}
      {mine && deliveryStatus === 'failed' && (
        <Pressable style={styles.deliveryRow} onPress={onRetry} hitSlop={8}>
          <AlertCircle size={11} color="#EF4444" />
          <Text style={styles.deliveryFailed}>Tap to retry</Text>
        </Pressable>
      )}

      {/* Read receipt — shown on every confirmed own message */}
      {mine && receiptState && deliveryStatus !== 'sending' && deliveryStatus !== 'failed' && (
        <View style={styles.receiptRow}>
          {receiptState === 'read' ? (
            <>
              <CheckCheck size={11} color={color.signal} />
              <Text style={styles.receiptSent}>Read</Text>
            </>
          ) : receiptState === 'delivered' ? (
            <>
              <CheckCheck size={11} color={color.mute} />
              <Text style={[styles.receiptSent, { color: color.mute }]}>Delivered</Text>
            </>
          ) : (
            <>
              <Check size={11} color={color.signal} />
              <Text style={styles.receiptSent}>Sent</Text>
            </>
          )}
        </View>
      )}

      {/* Group reader avatar chips — up to 3 members who've read past this message */}
      {mine && readerAvatars && readerAvatars.length > 0 && deliveryStatus !== 'sending' && deliveryStatus !== 'failed' && (
        <View style={styles.readerAvatarRow}>
          {readerAvatars.map((uri, i) => (
            <Image key={i} source={{ uri }} style={styles.readerAvatar} />
          ))}
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
  // Mute state for the header toggle — persisted via the existing
  // muteThread service (beta-audit: replaces the 'coming soon' stub).
  const [threadMuted, setThreadMuted] = useState(false);
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { state, thread, messages, sending, errorMessage, reload, send, retrySend, notifyTyping, typingUserIds } = useGroupChat(type, id);
  const [input, setInput] = useState('');
  const mediaPicker = useMessageMediaPicker();
  const [showMediaPickerSheet, setShowMediaPickerSheet] = useState(false);

  // Send button springs in/out with input content
  const sendAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(sendAnim, {
      toValue: (input.trim().length > 0 || mediaPicker.media !== null) ? 1 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 120,
    }).start();
  }, [input, sendAnim, mediaPicker.media]);
  const [sendFailed, setSendFailed] = useState(false);
  const [lastSentText, setLastSentText] = useState<string | undefined>(undefined);
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [actionMsgMine, setActionMsgMine] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // Per-thread translation settings (AsyncStorage-persisted)
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [defaultShowOriginal, setDefaultShowOriginal] = useState(false);
  const [showTranslationSheet, setShowTranslationSheet] = useState(false);
  const [showMembersSheet, setShowMembersSheet] = useState(false);
  const [memberPreview, setMemberPreview] = useState<FriendUser[]>([]);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const listRef = useRef<FlatList>(null);
  const shouldAnimateMessage = useMessageEntranceGate();

  const displayTitle = thread?.title ?? title ?? (type === 'trip' ? 'Trip Chat' : 'Circle Chat');
  const isNoAccess = state === 'no_access' || thread?.memberAccess === 'removed';

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  // Load per-thread translation prefs from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(`thread_translation:${id}`)
      .then((raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { autoTranslate?: boolean; showOriginal?: boolean };
          if (typeof parsed.autoTranslate === 'boolean') setAutoTranslate(parsed.autoTranslate);
          if (typeof parsed.showOriginal === 'boolean') setDefaultShowOriginal(parsed.showOriginal);
        } catch { /* ignore corrupt entries */ }
      })
      .catch(() => {});
  }, [id]);

  async function saveTranslationPrefs(at: boolean, so: boolean) {
    await AsyncStorage.setItem(`thread_translation:${id}`, JSON.stringify({ autoTranslate: at, showOriginal: so }));
  }

  // Load a small member preview (count + avatar stack) for the header chip.
  // Re-runs after the sheet closes so a fresh invite is reflected immediately.
  useEffect(() => {
    if (state !== 'active' || showMembersSheet) return;
    let cancelled = false;
    (async () => {
      const res = type === 'trip' ? await getTripMembers(id) : await getCircleMembers(id);
      if (cancelled || !res.ok || !res.data) return;
      // Backend excludes the caller, so add 1 for the current user.
      setMemberPreview(res.data.members.slice(0, 3));
      setMemberCount(res.data.members.length + 1);
    })();
    return () => { cancelled = true; };
  }, [type, id, state, showMembersSheet]);

  // Build list items with day separators
  type ListItem =
    | { _t: 'msg'; data: Message }
    | { _t: 'day'; label: string; key: string };

  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = [];
    let lastDay = '';
    for (const m of messages) {
      const day = localDateKey(m.createdAt);
      if (day !== lastDay) {
        lastDay = day;
        items.push({ _t: 'day', label: formatDayLabel(day), key: `day-${day}` });
      }
      items.push({ _t: 'msg', data: m });
    }
    return items;
  }, [messages]);

  // Per-message receipt: 'delivered' once confirmed (>3 s), 'sent' while fresh.
  // Reader avatar chips (readerAvatarsForMsg) surface WHO read, complementing the state label.
  const receiptForMsg = useCallback((msg: Message): 'sent' | 'delivered' | null => {
    const ageSecs = (Date.now() - new Date(msg.createdAt).getTime()) / 1000;
    return ageSecs > 3 ? 'delivered' : 'sent';
  }, []);

  // Group-thread member reads — fetched once per thread to drive per-message reader chips.
  const [groupMemberReads, setGroupMemberReads] = useState<
    { userId: string; lastReadAt: string | null; avatarUrl: string | null }[]
  >([]);

  useEffect(() => {
    if (!thread?.id) return;
    let active = true;
    (async () => {
      const { data: members } = await supabase
        .from('message_thread_members')
        .select('user_id, last_read_at')
        .eq('thread_id', thread.id)
        .is('left_at', null)
        .neq('user_id', userId ?? '');
      if (!active || !members || members.length === 0) return;
      const ids = (members as any[]).map((m) => m.user_id as string);
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, avatar_url')
        .in('id', ids);
      if (!active) return;
      const avatarMap = new Map(((profs ?? []) as any[]).map((p) => [p.id as string, p.avatar_url as string | null]));
      setGroupMemberReads(
        (members as any[]).map((m) => ({
          userId: m.user_id as string,
          lastReadAt: (m.last_read_at as string | null) ?? null,
          avatarUrl: avatarMap.get(m.user_id as string) ?? null,
        })),
      );
    })();
    return () => { active = false; };
  }, [thread?.id, userId]);

  // Derive up to 3 reader avatar URIs for a given message.
  const readerAvatarsForMsg = useCallback((msg: Message): string[] => {
    if (!msg.createdAt) return [];
    return groupMemberReads
      .filter((m) => m.lastReadAt !== null && new Date(m.lastReadAt) >= new Date(msg.createdAt))
      .slice(0, 3)
      .map((m) => m.avatarUrl)
      .filter((u): u is string => !!u);
  }, [groupMemberReads]);

  const handleDeleteForMe = useCallback(async (msgId: string) => {
    await deleteMessage(msgId);
    reload();
  }, [reload]);

  async function handleSend() {
    const text = input.trim();
    if (isNoAccess) return;

    // ── Media send path ───────────────────────────────────────────────────
    if (mediaPicker.media !== null && thread?.id) {
      notifyTyping(false);
      setSendFailed(false);
      let uploadRes = mediaPicker.uploadResult;
      if (!uploadRes) {
        uploadRes = await mediaPicker.upload();
      }
      if (!uploadRes) return; // cancelled or failed
      const res = await sendMediaMessage(thread.id, {
        mediaUrl: uploadRes.url,
        mediaType: uploadRes.mediaType,
        thumbnailUrl: uploadRes.thumbnailUrl,
        durationSeconds: uploadRes.durationSeconds,
        body: text || undefined,
      });
      if (res.ok) {
        mediaPicker.clearMedia();
        if (text) setInput('');
        listRef.current?.scrollToEnd({ animated: true });
        reload();
      } else {
        setSendFailed(true);
      }
      return;
    }

    // ── Text send path ────────────────────────────────────────────────────
    if (!text || sending) return;
    notifyTyping(false);
    setInput('');
    setLastSentText(text);
    setSendFailed(false);
    const currentReplyId = replyingTo?.id;
    setReplyingTo(null);
    const res = await send(text, currentReplyId);
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
      <Pressable style={styles.headerMeta} onPress={() => setShowMembersSheet(true)} hitSlop={6}>
        <Text style={styles.headerName} numberOfLines={1}>{displayTitle}</Text>
        <View style={styles.headerTagRow}>
          {memberPreview.length > 0 && (
            <View style={styles.avatarStack}>
              {memberPreview.map((m, i) => (
                <AvatarImage
                  key={m.id}
                  uri={m.avatarUrl}
                  user={{ name: m.name ?? undefined, handle: m.handle ?? undefined }}
                  size={16}
                  style={[styles.stackAvatar, i > 0 && styles.stackAvatarOverlap]}
                />
              ))}
            </View>
          )}
          {memberCount === null && <Users size={9} color={color.signal} />}
          <Text style={styles.headerMembersChip}>
            {memberCount !== null
              ? `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
              : (memberLabel ?? 'Members')}
          </Text>
        </View>
      </Pressable>
      <View style={styles.headerActions}>
        {/* Thread info + message search hidden until built (beta-audit) */}
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          onPress={() => setShowTranslationSheet(true)}
        >
          <Languages size={18} color={autoTranslate ? color.signal : color.mute} />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={styles.headerIconBtn}
          accessibilityLabel={threadMuted ? 'Unmute thread' : 'Mute thread'}
          onPress={async () => {
            const next = !threadMuted;
            const res = await muteThread(id, next);
            if (res.ok) setThreadMuted(next);
          }}
        >
          <VolumeX size={18} color={threadMuted ? color.signal : color.mute} />
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
    <KeyboardSafeScrollView style={styles.screen}>
      {Header}

      {/* Quick-action bar — context-sensitive shortcuts */}
      <View style={styles.quickBar}>
        {type === 'trip' ? (
          <>
            <Pressable style={styles.quickBtn} onPress={() => router.push(`/trip/${id}` as any)}>
              <Globe size={12} color={color.signal} />
              <Text style={styles.quickBtnText}>View Trip</Text>
            </Pressable>
            {/* Add Plan hidden until the in-chat plan flow is built (beta-audit) */}
          </>
        ) : (
          <>
            <Pressable style={styles.quickBtn} onPress={() => router.push('/circle' as any)}>
              <Users size={12} color={color.signal} />
              <Text style={styles.quickBtnText}>View Circle</Text>
            </Pressable>
            {/* Share Discovery hidden until the picker flow is built (beta-audit) */}
          </>
        )}
      </View>

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
            return (
              <MessageEntrance animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}>
                <TelegraphSystemNotice text={m.body ?? ''} />
              </MessageEntrance>
            );
          }
          // Media messages — image or video
          if (m.msgType === 'media' && m.mediaUrl) {
            return (
              <MessageEntrance
                animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}
                style={[styles.bubbleRow, mine && styles.bubbleRowMine]}
              >
                <MessageMediaBubble
                  mediaType={(m.mediaType as 'image' | 'video') ?? 'image'}
                  mediaUrl={m.mediaUrl}
                  thumbnailUrl={m.mediaThumbnailUrl}
                  durationSeconds={m.mediaDurationSeconds}
                  mine={mine}
                  senderName={!mine ? m.senderName : null}
                  createdAt={m.createdAt}
                  uploadState={m.uploadState ?? null}
                  uploadProgress={m.uploadProgress ?? 0}
                  onCancel={m.uploadState === 'uploading' ? () => mediaPicker.cancel() : undefined}
                  onRetry={m.uploadState === 'failed' ? () => mediaPicker.retry() : undefined}
                />
              </MessageEntrance>
            );
          }
          return (
            <MessageEntrance
              animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}
              style={[styles.bubbleRow, mine && styles.bubbleRowMine]}
            >
              {!mine && (
                <UserIdentityLink
                  userId={m.senderId}
                  handle={m.senderHandle}
                  currentUserId={userId}
                  testID={`msg-sender-identity-${m.id}`}
                >
                  <AvatarImage
                    uri={m.senderAvatarUrl}
                    user={{ name: m.senderName ?? undefined, handle: m.senderHandle ?? undefined }}
                    size={28}
                    style={[styles.avatar, styles.avatarSmall]}
                  />
                </UserIdentityLink>
              )}
              <GroupMessageBubble
                item={m}
                mine={mine}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setActionMsg(m);
                  setActionMsgMine(mine);
                }}
                receiptState={mine ? receiptForMsg(m) : null}
                readerAvatars={mine ? readerAvatarsForMsg(m) : undefined}
                autoTranslate={autoTranslate}
                defaultShowOriginal={defaultShowOriginal}
                deliveryStatus={mine ? (m.deliveryStatus ?? null) : null}
                onRetry={mine && m.clientId ? () => retrySend(m.clientId!) : undefined}
              />
            </MessageEntrance>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      {/* Typing indicator */}
      {typingUserIds.length > 0 && (
        <View style={styles.typingRow}>
          <Text style={styles.typingText}>
            {typingUserIds.length === 1
              ? 'Someone is typing…'
              : `${typingUserIds.length} people are typing…`}
          </Text>
        </View>
      )}

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

      {/* Mention suggestions — rendered above compose bar */}
      <MentionSuggestionList
        suggestions={mentionSuggestions}
        loading={mentionLoading}
        visible={mentionVisible}
        onSelect={(s) => mentionRef.current?.insertTag(s)}
      />

      {/* Media attachment preview chip */}
      {mediaPicker.media && (
        <View style={styles.attachPreviewBar}>
          <View style={styles.attachPreviewChip}>
            <Text style={styles.attachPreviewIcon}>
              {mediaPicker.media.mediaType === 'video' ? '🎬' : '🖼️'}
            </Text>
            <Text style={styles.attachPreviewLabel} numberOfLines={1}>
              {mediaPicker.state === 'uploading'
                ? `Uploading… ${Math.round((mediaPicker.uploadProgress ?? 0) * 100)}%`
                : mediaPicker.state === 'failed'
                ? (mediaPicker.uploadError ?? 'Upload failed — tap retry')
                : mediaPicker.media.mediaType === 'video' ? 'Video attached' : 'Image attached'}
            </Text>
          </View>
          <Pressable onPress={mediaPicker.clearMedia} hitSlop={8}>
            <X size={16} color={color.mute} />
          </Pressable>
        </View>
      )}

      {replyingTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarAccent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.replyBarSender} numberOfLines={1}>
              {replyingTo.senderName ?? 'Someone'}
            </Text>
            <Text style={styles.replyBarBody} numberOfLines={1}>
              {replyingTo.body ?? ''}
            </Text>
          </View>
          <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
            <X size={16} color={color.mute} />
          </Pressable>
        </View>
      )}

      {/* Media picker bottom sheet */}
      <Modal
        visible={showMediaPickerSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowMediaPickerSheet(false)}
      >
        <Pressable style={styles.pickerOverlay} onPress={() => setShowMediaPickerSheet(false)} />
        <View style={[styles.pickerSheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
          <View style={styles.pickerHandle} />
          <Text style={styles.pickerTitle}>Attach media</Text>
          <Pressable style={styles.pickerRow} onPress={async () => { setShowMediaPickerSheet(false); await mediaPicker.pickFromLibrary(); }}>
            <Text style={styles.pickerRowIcon}>🖼️</Text>
            <Text style={styles.pickerRowLabel}>Photo Library</Text>
          </Pressable>
          <Pressable style={styles.pickerRow} onPress={async () => { setShowMediaPickerSheet(false); await mediaPicker.pickFromCamera(); }}>
            <Text style={styles.pickerRowIcon}>📷</Text>
            <Text style={styles.pickerRowLabel}>Camera</Text>
          </Pressable>
          <Pressable style={styles.pickerRow} onPress={async () => { setShowMediaPickerSheet(false); await mediaPicker.pickVideo(); }}>
            <Text style={styles.pickerRowIcon}>🎬</Text>
            <Text style={styles.pickerRowLabel}>Video Library</Text>
          </Pressable>
          <Pressable style={styles.pickerCancelRow} onPress={() => setShowMediaPickerSheet(false)}>
            <Text style={styles.pickerCancelLabel}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>

      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {isNoAccess ? (
          <View style={styles.noAccessBar}>
            <Text style={styles.noAccessText}>You no longer have access to this chat.</Text>
          </View>
        ) : (
          <>
            <Pressable
              style={styles.composeIconBtn}
              onPress={() => setShowMediaPickerSheet(true)}
              hitSlop={6}
            >
              <Paperclip size={18} color={mediaPicker.media ? color.signal : color.mute} />
            </Pressable>
            {/* Share Discovery + AI Suggestions hidden until built (beta-audit) */}
            <MentionInput
              ref={mentionRef}
              style={styles.inputField}
              placeholder="Write a Telegraph…"
              placeholderTextColor={color.faint}
              value={input}
              onChangeText={(text) => { setInput(text); notifyTyping(text.trim().length > 0); }}
              onBlur={() => notifyTyping(false)}
              onSubmitEditing={handleSend}
              returnKeyType="send"
              editable={!sending}
              multiline
              surface="message"
              onSuggestionsChange={(items, isLoading, trigger) => {
                setMentionSuggestions(items);
                setMentionLoading(isLoading);
                setMentionVisible(!!trigger && (items.length > 0 || isLoading));
              }}
            />
            <Animated.View
              style={{
                transform: [{ scale: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
                opacity: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              }}
            >
              <Pressable
                style={[
                  styles.sendBtn,
                  ((input.trim() || mediaPicker.media) && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled,
                ]}
                onPress={handleSend}
                disabled={(!input.trim() && !mediaPicker.media) || sending}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={color.onInk} />
                ) : (
                  <Send size={16} color={(input.trim() || mediaPicker.media) ? '#FFFFFF' : color.faint} />
                )}
              </Pressable>
            </Animated.View>
          </>
        )}
      </View>

      <LongPressActionSheet
        message={actionMsg}
        mine={actionMsgMine}
        onClose={() => setActionMsg(null)}
        onDeleteForMe={handleDeleteForMe}
        onReply={(msg) => { setReplyingTo(msg); setActionMsg(null); }}
        onSave={(msg) => {
          const tid = thread?.id;
          setActionMsg(null);
          if (!tid) return;
          saveMessage(tid, msg.id).then((r) => {
            if (r.ok) Alert.alert('Saved', 'Message saved to your collection.');
          });
        }}
      />

      {/* Per-thread translation settings */}
      <TranslationSettingsSheet
        visible={showTranslationSheet}
        autoTranslate={autoTranslate}
        showOriginalFirst={defaultShowOriginal}
        onChangeAutoTranslate={(v) => {
          setAutoTranslate(v);
          saveTranslationPrefs(v, defaultShowOriginal);
        }}
        onChangeShowOriginalFirst={(v) => {
          setDefaultShowOriginal(v);
          saveTranslationPrefs(autoTranslate, v);
        }}
        onClose={() => setShowTranslationSheet(false)}
      />

      {/* Members list + invite */}
      {showMembersSheet && (
        <TripMembersSheet
          type={type}
          id={id}
          onDismiss={() => setShowMembersSheet(false)}
        />
      )}
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: TG.surface },
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
  headerMembersChip: { ...t.stamp, fontFamily: 'Courier', color: color.signal, fontSize: 10, letterSpacing: 0.4 },
  avatarStack: { flexDirection: 'row', alignItems: 'center', marginRight: 2 },
  stackAvatar: { width: icon.s16, height: icon.s16, borderRadius: icon.s16 / 2, borderWidth: 1, borderColor: color.paperRaised },
  stackAvatarOverlap: { marginLeft: -6 },
  stackAvatarFallback: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  stackAvatarInitial: { fontSize: 8, fontWeight: '700', color: color.ink },
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

  avatar: { width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: color.haze, overflow: 'hidden', flexShrink: 0 },
  avatarSmall: { width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2 },
  avatarInitial: { fontSize: 12, color: color.ink, textAlign: 'center', lineHeight: 28 },

  bubble: {
    borderRadius: TG_SPACING.bubbleRadius,
    paddingHorizontal: 13,
    paddingTop: 8,
    paddingBottom: 6,
    flexShrink: 1,
    maxWidth: '100%',
  },
  bubbleOther: {
    backgroundColor: TG.recvBubble,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderBottomLeftRadius: TG_SPACING.bubbleTail,
  },
  bubbleMine: { backgroundColor: TG.sentBubble, borderBottomRightRadius: TG_SPACING.bubbleTail },

  senderName: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, marginBottom: 2, letterSpacing: 0.2 },

  bubbleText: { ...t.body, color: TG.recvText, lineHeight: 21, flexShrink: 1, flexWrap: 'wrap' },
  bubbleTextMine: { color: TG.sentText },

  bubbleTime: { ...t.stamp, fontFamily: 'Courier', color: color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' },
  bubbleTimeMine: { color: TG.sentTextMute },

  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  receiptSent: { fontSize: 10, color: color.signal, fontFamily: 'Courier' },

  deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  deliverySending: { fontSize: 10, color: color.mute, fontFamily: 'Courier' },
  deliverySent: { fontSize: 10, color: color.signal, fontFamily: 'Courier' },
  deliveryFailed: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier', fontWeight: '600' },

  typingRow: { paddingHorizontal: space.lg, paddingVertical: 5, backgroundColor: color.paper },
  typingText: { ...t.small, color: color.mute, fontSize: 11, fontStyle: 'italic' },

  translationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  transLabel: {
    fontSize: 10,
    color: color.mute,
    fontFamily: 'Courier',
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  transToggle: {
    fontSize: 10,
    color: color.signal,
    fontFamily: 'Courier',
    textDecorationLine: 'underline',
  },
  transUnavailable: {
    fontSize: 10,
    color: color.mute,
    fontFamily: 'Courier',
    fontStyle: 'italic',
    letterSpacing: 0.2,
    marginTop: 4,
  },

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
    minHeight: 40,
    maxHeight: 120, // ~5 lines
    backgroundColor: TG.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: TG.hairline,
    paddingHorizontal: space.lg,
    paddingVertical: 9,
    ...t.body,
    color: color.ink,
  },
  sendBtn: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, alignItems: 'center', justifyContent: 'center' },
  sendBtnActive: { backgroundColor: TG.sentBubble },
  sendBtnDisabled: { backgroundColor: color.haze },

  noAccessBar: { flex: 1, paddingVertical: space.md, alignItems: 'center' },
  noAccessText: { ...t.small, color: color.mute, textAlign: 'center' },

  quickBar: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '40',
    backgroundColor: color.signal + '0D',
  },
  quickBtnText: { ...t.stamp, color: color.signal, fontSize: 11, fontWeight: '600' },

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
  readerAvatarRow: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  readerAvatar: { width: icon.s14, height: icon.s14, borderRadius: icon.s14 / 2, backgroundColor: color.haze },

  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: color.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  replyBarAccent: { width: 3, height: 32, borderRadius: 2, backgroundColor: color.deep },
  replyBarSender: { ...t.stamp, color: color.deep, fontWeight: '600', marginBottom: 1 },
  replyBarBody: { ...t.small, color: color.mute, fontSize: 12 },

  // Media attach preview bar
  attachPreviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: color.paperRaised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  attachPreviewChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.signal + '12',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '30',
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  attachPreviewIcon: { fontSize: 14 },
  attachPreviewLabel: { ...t.small, color: color.signal, fontSize: 12, flex: 1 },

  // Media picker sheet
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  pickerSheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: 2,
  },
  pickerHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  pickerTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15, marginBottom: space.sm },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  pickerRowIcon: { fontSize: 20 },
  pickerRowLabel: { ...t.body, color: color.ink },
  pickerCancelRow: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, marginTop: 4 },
  pickerCancelLabel: { ...t.body, color: color.mute },

  replyQuote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: radius.sm,
    padding: 6,
    marginBottom: 4,
  },
  replyQuoteMine: { backgroundColor: 'rgba(255,255,255,0.18)' },
  replyQuoteAccent: { width: 3, borderRadius: 2, alignSelf: 'stretch', backgroundColor: color.deep },
  replyQuoteSender: { ...t.stamp, color: color.deep, fontWeight: '600', marginBottom: 1 },
  replyQuoteBody: { ...t.small, color: color.ink, fontSize: 12, lineHeight: 16 },
});
