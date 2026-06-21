import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Zap, Send, Users, Globe, Check, CalendarClock, ArrowRight, CheckCircle, MoreVertical } from 'lucide-react-native';
import { useThreadMessages, useLanguageSettings, markThreadRead } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { TelegraphSuggestionTray } from '../../src/components/TelegraphSuggestionTray';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { supabase } from '../../src/lib/supabase';
import { getMeetup, rsvpMeetup } from '../../src/services/meetups';
import type { MeetupCounts, MeetupCreator, RsvpStatus } from '../../src/services/meetups';
import type { Message } from '../../src/services/messaging';
import type { TelegraphSuggestion, MeetupPrefill } from '../../src/services/telegraphChat';
import { blockUser } from '../../src/services/blocks';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "YYYY-MM-DD" or full ISO → "Fri Jun 27" */
function fmtDate(isoDate: string): string {
  const d = new Date(isoDate.length === 10 ? isoDate + 'T12:00:00' : isoDate);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Full ISO timestamp → "Fri Jun 27 · 7:00 PM" */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${datePart} · ${timePart}`;
}

const BLOCK_SHORT: Record<string, string> = {
  morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late: 'Late night',
};

// ── Meetup card ───────────────────────────────────────────────────────────────

interface MeetupCardPayload {
  type: 'meetup_card' | 'meetup_confirmed';
  meetupId: string;
  title: string;
  locationName?: string;
  timeBlock?: string;
  approximateDate?: string;
  plannedByName?: string;
  isConfirmed?: boolean;
  confirmedTime?: string;
  creatorName?: string;
}

function parseMeetupCard(
  body: string,
  msg?: Pick<Message, 'msgType' | 'subtype'>,
): MeetupCardPayload | null {
  if (!body.startsWith('{')) return null;
  try {
    const obj = JSON.parse(body);
    // Confirmation system message: subtype = 'meetup_confirmed'
    if (msg?.msgType === 'system' && msg?.subtype === 'meetup_confirmed') {
      if (obj.meetupId && obj.title) {
        return {
          type: 'meetup_confirmed',
          meetupId: obj.meetupId,
          title: obj.title,
          locationName: obj.locationName,
          creatorName: obj.creatorName,
          confirmedTime: obj.startsAt,
          isConfirmed: true,
        };
      }
      return null;
    }
    // Primary: structured system message with meetup subtype (creation card)
    if (msg?.msgType === 'system' && msg?.subtype === 'meetup') {
      if (obj.meetupId && obj.title) return { type: 'meetup_card', ...obj } as MeetupCardPayload;
      return null;
    }
    // Legacy fallback: JSON body with explicit type field
    if (obj.type === 'meetup_card' && obj.meetupId && obj.title) return obj as MeetupCardPayload;
  } catch { /* ignore */ }
  return null;
}

type RsvpAction = 'going' | 'maybe' | 'declined';

const RSVP_BTNS: { key: RsvpAction; label: string; emoji: string }[] = [
  { key: 'going',    label: 'Going', emoji: '✅' },
  { key: 'maybe',   label: 'Maybe', emoji: '🤔' },
  { key: 'declined', label: "Can't", emoji: '❌' },
];

function CreatorAvatar({ creator }: { creator: MeetupCreator | null }) {
  const size = 20;
  if (creator?.avatarUrl) {
    return <Image source={{ uri: creator.avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.haze }} />;
  }
  const initial = creator?.displayName?.charAt(0)?.toUpperCase() ?? '?';
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.signal + '33', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: color.signal }}>{initial}</Text>
    </View>
  );
}

function MeetupCard({ payload, mine }: { payload: MeetupCardPayload; mine: boolean }) {
  const { isAuthed } = useSession();
  const [counts, setCounts] = useState<MeetupCounts | null>(null);
  const [myRsvp, setMyRsvp] = useState<RsvpStatus | null>(null);
  const [rsvping, setRsvping] = useState<RsvpAction | null>(null);
  const [isCancelled, setIsCancelled] = useState(false);
  // undefined = still loading; null = loaded but creator not found
  const [creator, setCreator] = useState<MeetupCreator | null | undefined>(undefined);
  // startsAt from the live meetup — used for unconfirmed cards with exact time set
  const [fetchedStartsAt, setFetchedStartsAt] = useState<string | null>(null);

  useEffect(() => {
    getMeetup(payload.meetupId).then((res) => {
      if (res.ok && res.data) {
        setCounts(res.data.counts);
        setMyRsvp(res.data.myRsvp ?? null);
        setIsCancelled(res.data.status === 'cancelled');
        setCreator(res.data.creator ?? null);
        setFetchedStartsAt(res.data.startsAt ?? null);
      }
    });
  }, [payload.meetupId]);

  async function handleRsvp(status: RsvpAction) {
    if (rsvping) return;
    const prev = myRsvp;
    const prevCounts = counts;
    // Optimistic update
    setMyRsvp(status);
    if (counts) {
      const next = { ...counts };
      if (prev === 'going') next.going = Math.max(0, next.going - 1);
      else if (prev === 'maybe') next.maybe = Math.max(0, next.maybe - 1);
      else if (prev === 'declined') next.declined = Math.max(0, next.declined - 1);
      else next.pending = Math.max(0, next.pending - 1);
      if (status === 'going') next.going++;
      else if (status === 'maybe') next.maybe++;
      else if (status === 'declined') next.declined++;
      setCounts(next);
    }
    setRsvping(status);
    const res = await rsvpMeetup(payload.meetupId, status);
    setRsvping(null);
    if (res.ok && res.data) {
      setMyRsvp(res.data.status);
      setCounts(res.data.counts);
    } else {
      setMyRsvp(prev);
      setCounts(prevCounts);
      Alert.alert('Error', res.message ?? 'Could not RSVP');
    }
  }

  const isConfirmed = payload.isConfirmed ?? false;
  const when = isConfirmed
    ? (payload.confirmedTime ? fmtDateTime(payload.confirmedTime) : null)
    : fetchedStartsAt
      ? fmtDateTime(fetchedStartsAt)
      : payload.approximateDate
        ? `${fmtDate(payload.approximateDate)}${payload.timeBlock ? ` · ${BLOCK_SHORT[payload.timeBlock] ?? payload.timeBlock}` : ''}`
        : null;
  const rsvpLabel = counts
    ? `${counts.going} going${counts.maybe > 0 ? ` · ${counts.maybe} maybe` : ''}`
    : null;
  const showRsvpButtons = isAuthed && !isCancelled && !isConfirmed;

  return (
    <Pressable
      style={[mc.card, mine && mc.cardMine, isConfirmed && mc.cardConfirmed]}
      onPress={() => router.push(`/meetup/${payload.meetupId}` as any)}
    >
      <View style={mc.row}>
        <View style={[mc.icon, isConfirmed && mc.iconConfirmed]}>
          {isConfirmed
            ? <CheckCircle size={14} color={color.success} />
            : <CalendarClock size={14} color={color.signal} />}
        </View>
        <Text style={[mc.label, isConfirmed && mc.labelConfirmed]}>
          {isConfirmed ? 'Confirmed' : 'Meetup'}
        </Text>
        {!isConfirmed && (
          <View style={mc.pendingBadge}>
            <Text style={mc.pendingBadgeText}>Voting in progress</Text>
          </View>
        )}
      </View>

      {/* Creator row — shown once getMeetup() resolves */}
      {creator !== undefined ? (
        <View style={mc.creatorRow}>
          <CreatorAvatar creator={creator} />
          <Text style={mc.creatorText} numberOfLines={1}>
            {creator?.displayName ?? 'Someone'} planned a meetup
          </Text>
        </View>
      ) : null}

      <Text style={[mc.title, mine && mc.titleMine]} numberOfLines={2}>{payload.title}</Text>
      {payload.locationName ? (
        <View style={mc.metaRow}>
          <Text style={mc.meta} numberOfLines={1}>📍 {payload.locationName}</Text>
        </View>
      ) : null}
      {when ? (
        <View style={mc.metaRow}>
          <Text style={[mc.meta, isConfirmed && mc.metaConfirmed]}>
            {isConfirmed ? '✅' : '🗓'} {when}
          </Text>
        </View>
      ) : null}
      {rsvpLabel ? (
        <View style={mc.metaRow}>
          <Text style={mc.meta}>👋 {rsvpLabel}</Text>
        </View>
      ) : null}

      {isConfirmed ? (
        <View style={mc.footer}>
          <Text style={[mc.see, mine && mc.seeMine]}>Tap to view details</Text>
          <ArrowRight size={12} color={mine ? color.onInk + 'AA' : color.success} />
        </View>
      ) : showRsvpButtons ? (
        <View style={mc.rsvpRow}>
          {RSVP_BTNS.map((opt) => {
            const isActive = myRsvp === opt.key;
            const isBusy = rsvping === opt.key;
            return (
              <Pressable
                key={opt.key}
                style={[mc.rsvpBtn, isActive && mc.rsvpBtnActive]}
                onPress={() => handleRsvp(opt.key)}
                disabled={rsvping !== null}
              >
                {isBusy
                  ? <ActivityIndicator size="small" color={isActive ? color.onInk : color.signal} style={{ width: 14, height: 14 }} />
                  : <Text style={mc.rsvpEmoji}>{opt.emoji}</Text>
                }
                <Text style={[mc.rsvpLabel, isActive && mc.rsvpLabelActive]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={mc.footer}>
          <Text style={[mc.see, mine && mc.seeMine]}>Tap to view meetup</Text>
          <ArrowRight size={12} color={mine ? color.onInk + 'AA' : color.signal} />
        </View>
      )}
    </Pressable>
  );
}

const mc = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, padding: space.md, gap: space.sm, minWidth: 200, maxWidth: 280 },
  cardMine: { backgroundColor: color.signal + '22', borderColor: color.signal + '55' },
  cardConfirmed: { borderColor: color.success + '55', backgroundColor: color.success + '0A' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  icon: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center' },
  iconConfirmed: { backgroundColor: color.success + '22' },
  label: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' },
  labelConfirmed: { color: color.success },
  pendingBadge: { marginLeft: 'auto', backgroundColor: '#FFF3CD', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  pendingBadgeText: { fontSize: 9, fontWeight: '600', color: '#856404', letterSpacing: 0.3 },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  titleMine: { color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  meta: { ...t.small, color: color.mute, fontSize: 11 },
  metaConfirmed: { color: color.success, fontWeight: '600' },
  plannedBy: { ...t.small, color: color.faint, fontSize: 10, fontStyle: 'italic' },
  creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  creatorText: { ...t.small, color: color.mute, fontSize: 11, flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  see: { ...t.small, color: color.signal, fontSize: 11 },
  seeMine: { color: color.signal },
  rsvpRow: { flexDirection: 'row', gap: 5, marginTop: 6 },
  rsvpBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 5, paddingHorizontal: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, minWidth: 0 },
  rsvpBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  rsvpEmoji: { fontSize: 11 },
  rsvpLabel: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 10 },
  rsvpLabelActive: { color: color.onInk },
});

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  item,
  mine,
  autoTranslate,
  defaultShowOriginal,
  isGroupThread,
}: {
  item: Message;
  mine: boolean;
  autoTranslate: boolean;
  defaultShowOriginal: boolean;
  isGroupThread: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(defaultShowOriginal || !autoTranslate);

  if (item.deleted) {
    return (
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text
          style={[
            styles.bubbleText,
            { fontStyle: 'italic', color: mine ? color.onInk + 'AA' : color.mute },
          ]}
        >
          This message was deleted.
        </Text>
      </View>
    );
  }

  // Meetup card — special rendering
  const meetupPayload = parseMeetupCard(item.body ?? '', item);
  if (meetupPayload) {
    return <MeetupCard payload={meetupPayload} mine={mine} />;
  }

  let bodyToShow: string;
  if (mine || !autoTranslate || showOriginal) {
    bodyToShow = item.originalBody ?? item.body ?? '';
  } else {
    bodyToShow = item.displayBody ?? item.body ?? '';
  }

  const isTranslated = item.translated && autoTranslate && !showOriginal;
  const isPending = item.translationStatus === 'pending';
  // Show the translation row only when there's something meaningful to render:
  // a pending indicator, an actual label, or the show-original toggle.
  const showLabel = !mine && (
    isPending ||
    (isTranslated && !!item.translationLabel) ||
    !!item.canShowOriginal
  );

  return (
    <View>
      {isGroupThread && !mine && item.senderName && (
        <Text style={styles.senderLabel}>
          {item.senderName}
          {item.senderHandle ? ` @${item.senderHandle}` : ''}
        </Text>
      )}
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
          {bodyToShow}
        </Text>

        <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
          {formatTime(item.createdAt)}
          {item.editedAt ? '  ·  edited' : ''}
        </Text>

        {showLabel && (
          <View style={styles.translationRow}>
            {isPending ? (
              <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                Translating…
              </Text>
            ) : isTranslated && item.translationLabel ? (
              <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                {item.translationLabel}
              </Text>
            ) : null}

            {item.canShowOriginal && autoTranslate && (
              <Pressable onPress={() => setShowOriginal((v) => !v)} hitSlop={8}>
                <Text style={[styles.transToggle, mine && styles.transToggleMine]}>
                  {showOriginal ? 'Show translation' : 'Show original'}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// ── Add-to-Plan sheet ─────────────────────────────────────────────────────────

function AddToPlanSheet({
  visible,
  suggestion,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  suggestion: TelegraphSuggestion | null;
  onClose: () => void;
  onConfirm: (tripId: string) => void;
}) {
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);

  if (!suggestion) return null;

  function handleConfirm() {
    if (!selectedTripId) {
      Alert.alert('Select a trip', 'Please choose a trip to add this to.');
      return;
    }
    onConfirm(selectedTripId);
    setSelectedTripId(null);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sheetStyles.overlay} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.handle} />
        <Text style={sheetStyles.title}>Add to Trip Plan</Text>
        <Text style={sheetStyles.subtitle} numberOfLines={2}>
          {suggestion.title}
        </Text>

        <Text style={sheetStyles.sectionLabel}>Choose your trip</Text>
        <View style={sheetStyles.tripOption}>
          <Text style={sheetStyles.tripName}>My Trip</Text>
          <Pressable
            style={[
              sheetStyles.radioBtn,
              selectedTripId === 'current' && sheetStyles.radioBtnSelected,
            ]}
            onPress={() => setSelectedTripId('current')}
          >
            {selectedTripId === 'current' && <Check size={12} color={color.onInk} />}
          </Pressable>
        </View>

        <Text style={sheetStyles.hint}>
          To add to a specific trip, open the trip chat and use the suggestion there.
        </Text>

        <Pressable style={sheetStyles.confirmBtn} onPress={handleConfirm}>
          <Text style={sheetStyles.confirmLabel}>Add to Plan</Text>
        </Pressable>
        <Pressable style={sheetStyles.cancelBtn} onPress={onClose}>
          <Text style={sheetStyles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}


// ── Main screen ───────────────────────────────────────────────────────────────

interface MeetupSheetCtx {
  tripId?: string;
  circleOwnerId?: string;
  initialTitle?: string;
  initialLocation?: string;
}

export default function TelegraphThread() {
  const { id, title, threadType, contextId, otherUserId } = useLocalSearchParams<{ id: string; title?: string; threadType?: string; contextId?: string; otherUserId?: string }>();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { messages, loading, error, sending, send, reload } = useThreadMessages(id ?? null);
  const { data: langSettings } = useLanguageSettings();
  const [input, setInput] = useState('');
  const [lastSentMessage, setLastSentMessage] = useState<string | undefined>(undefined);
  const [addToPlanSuggestion, setAddToPlanSuggestion] = useState<TelegraphSuggestion | null>(null);
  const [meetupSheetCtx, setMeetupSheetCtx] = useState<MeetupSheetCtx | null>(null);
  const [isAcceptedMember, setIsAcceptedMember] = useState(threadType === 'direct');
  const [plannedByName, setPlannedByName] = useState<string | undefined>(undefined);
  const [blockingUser, setBlockingUser] = useState(false);
  const listRef = useRef<FlatList>(null);

  function handleBlockPress() {
    if (!otherUserId || blockingUser) return;
    Alert.alert(
      'Block user?',
      'They won\'t be able to message you or see your profile. You can manage blocks in Settings → Blocked accounts.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setBlockingUser(true);
            await blockUser(otherUserId);
            setBlockingUser(false);
            router.replace('/messages');
          },
        },
      ],
    );
  }

  // Resolve display name once (for the planned-by label in meetup cards)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const meta = data?.user?.user_metadata as Record<string, unknown> | undefined;
      const name = (meta?.full_name ?? meta?.name ?? data?.user?.email) as string | undefined;
      if (name) setPlannedByName(name);
    });
  }, []);

  // Permission gate: accepted thread members only (DMs always pass; trip/circle
  // check message_thread_members — only accepted members are in the thread).
  useEffect(() => {
    if (threadType === 'direct') { setIsAcceptedMember(true); return; }
    if (!id || !userId) return;
    supabase.from('message_thread_members')
      .select('user_id')
      .eq('thread_id', id)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle()
      .then(({ data }) => setIsAcceptedMember(Boolean(data)));
  }, [id, threadType, userId]);

  // Mark thread as read when the user opens it. Fire-and-forget.
  useEffect(() => {
    if (!id) return;
    markThreadRead(id).catch(() => {});
  }, [id]);

  const autoTranslate = langSettings?.auto_translate_messages ?? true;
  const defaultShowOriginal = langSettings?.show_original_messages ?? false;
  const isGroupThread = threadType === 'trip' || threadType === 'circle';

  const headerTitle = title && title.trim() ? title : 'Chat';
  const HeaderIcon = threadType === 'trip' ? Globe : threadType === 'circle' ? Users : null;

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setLastSentMessage(text);
    await send(text);
    listRef.current?.scrollToEnd({ animated: true });
  }

  const handleAddToPlan = useCallback(
    async (suggestion: TelegraphSuggestion): Promise<string | null> => {
      return new Promise((resolve) => {
        setAddToPlanSuggestion(suggestion);
        // The sheet calls resolve via onConfirm; we store the resolver to call later
        // Simplified: we use inline Alert for trip selection in DM threads
        if (threadType !== 'trip') {
          Alert.alert(
            'Add to Trip Plan',
            `Add "${suggestion.title}" to your trip plan?`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
              {
                text: 'Add',
                onPress: () => {
                  setAddToPlanSuggestion(null);
                  resolve('current');
                },
              },
            ],
          );
        } else {
          resolve(id ?? null);
          setAddToPlanSuggestion(null);
        }
      });
    },
    [threadType, id],
  );

  const handleCreateMeetup = useCallback((prefill: MeetupPrefill) => {
    setMeetupSheetCtx({
      tripId: prefill.tripId ?? undefined,
      initialTitle: prefill.title,
      initialLocation: prefill.location,
    });
  }, []);

  const handlePlanMeetupButton = useCallback(() => {
    setMeetupSheetCtx({
      tripId: threadType === 'trip' ? contextId : undefined,
      circleOwnerId: threadType === 'circle' ? contextId : undefined,
    });
  }, [threadType, contextId]);

  const handleViewPlace = useCallback((suggestion: TelegraphSuggestion) => {
    Alert.alert(
      suggestion.title,
      suggestion.reason + (suggestion.location_context ? `\n\n📍 ${suggestion.location_context}` : ''),
      [{ text: 'OK' }],
    );
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={styles.headerMeta}>
            <Text style={styles.headerName}>{headerTitle}</Text>
            <View style={styles.headerTagRow}>
              <Zap size={9} color={color.signal} fill={color.signal} />
              <Text style={styles.headerTag}>Telegraph</Text>
            </View>
          </View>
        </View>
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={styles.headerMeta}>
            <Text style={styles.headerName}>{headerTitle}</Text>
          </View>
        </View>
        <View style={styles.center}><Text style={styles.errText}>{error}</Text></View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        {HeaderIcon && (
          <View style={styles.headerIconBadge}>
            <HeaderIcon size={14} color={color.onInk} />
          </View>
        )}
        <View style={styles.headerMeta}>
          <Text style={styles.headerName} numberOfLines={1}>{headerTitle}</Text>
          <View style={styles.headerTagRow}>
            <Zap size={9} color={color.signal} fill={color.signal} />
            <Text style={styles.headerTag}>Telegraph</Text>
          </View>
        </View>
        {threadType === 'direct' && otherUserId ? (
          <Pressable style={styles.headerMenuBtn} onPress={handleBlockPress} hitSlop={8}>
            <MoreVertical size={20} color={color.mute} />
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.senderId === userId;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <MessageBubble
                item={item}
                mine={mine}
                autoTranslate={autoTranslate}
                defaultShowOriginal={defaultShowOriginal}
                isGroupThread={isGroupThread}
              />
            </View>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      {/* Telegraph suggestion tray — above the composer */}
      {id && (
        <TelegraphSuggestionTray
          threadId={id}
          lastSentMessage={lastSentMessage}
          onAddToPlan={handleAddToPlan}
          onCreateMeetup={handleCreateMeetup}
          onViewPlace={handleViewPlace}
        />
      )}

      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {/* Plan meetup button — only accepted trip/circle members; DMs always shown unscoped */}
        {isAcceptedMember && (
          <Pressable style={styles.planMeetupBtn} onPress={handlePlanMeetupButton} hitSlop={6}>
            <CalendarClock size={18} color={color.signal} />
          </Pressable>
        )}

        <TextInput
          style={styles.inputField}
          placeholder="Message…"
          placeholderTextColor={color.faint}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!sending}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, (input.trim() && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : (
            <Send size={16} color={input.trim() ? color.onInk : color.faint} />
          )}
        </Pressable>
      </View>

      {/* Meetup creation sheet — triggered by button or Telegraph suggestion */}
      {meetupSheetCtx && (
        <MeetupCreationSheet
          tripId={meetupSheetCtx.tripId}
          circleOwnerId={meetupSheetCtx.circleOwnerId}
          initialTitle={meetupSheetCtx.initialTitle}
          initialLocation={meetupSheetCtx.initialLocation}
          onDismiss={() => setMeetupSheetCtx(null)}
          onCreated={(meetup) => {
            if (!id) return;
            const isScoped = Boolean(meetupSheetCtx?.tripId || meetupSheetCtx?.circleOwnerId);
            if (isScoped) {
              // Backend already posts the system message via postMeetupSystemMessage —
              // just reload to pick it up.
              reload();
            } else {
              // DM or unscoped meetup: backend has no thread to post to, so the
              // client sends the card directly.
              send(JSON.stringify({
                type: 'meetup_card',
                meetupId: meetup.id,
                title: meetup.title,
                locationName: meetup.locationName ?? undefined,
                approximateDate: meetup.approximateDate ?? undefined,
                timeBlock: meetup.timeBlock ?? undefined,
                plannedByName,
              }), { msgType: 'system', subtype: 'meetup' });
            }
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errText: { ...t.body, color: color.mute },
  emptyText: { ...t.small, color: color.mute },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  backBtn: { padding: 4 },
  headerMenuBtn: { padding: 4, marginLeft: 4 },
  headerIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerMeta: { flex: 1 },
  headerName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },

  senderLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    fontFamily: 'Courier',
    marginBottom: 2,
    marginLeft: 2,
  },

  list: { paddingHorizontal: space.lg, paddingVertical: space.md },

  bubbleRow: { alignSelf: 'flex-start', maxWidth: '82%' },
  bubbleRowMine: { alignSelf: 'flex-end' },

  bubble: { borderRadius: radius.lg, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: 6 },
  bubbleOther: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: { backgroundColor: color.signal, borderBottomRightRadius: 4 },

  bubbleText: { ...t.body, color: color.ink, lineHeight: 20 },
  bubbleTextMine: { color: color.onInk },

  bubbleTime: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.faint,
    fontSize: 10,
    marginTop: 2,
    textAlign: 'right',
  },
  bubbleTimeMine: { color: color.onInk + '88' },

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
  transLabelMine: { color: color.onInk + '99' },

  transToggle: {
    fontSize: 10,
    color: color.signal,
    fontFamily: 'Courier',
    textDecorationLine: 'underline',
  },
  transToggleMine: { color: color.onInk + 'CC' },

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
  planMeetupBtn: { width: 36, height: 38, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sendBtnActive: { backgroundColor: color.signal },
  sendBtnDisabled: { backgroundColor: color.haze },
});

const sheetStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: space.xl,
    paddingBottom: 40,
    gap: space.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, fontWeight: '700', fontSize: 18 },
  subtitle: { ...t.body, color: color.mute, fontSize: 13 },
  sectionLabel: { ...t.stamp, fontFamily: 'Courier', fontSize: 11, color: color.mute, marginTop: space.md, letterSpacing: 0.5 },
  tripOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.sm },
  tripName: { ...t.body, color: color.ink },
  radioBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioBtnSelected: { backgroundColor: color.signal, borderColor: color.signal },
  hint: { ...t.small, color: color.mute, fontSize: 12 },
  input: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    ...t.body,
    color: color.ink,
  },
  confirmBtn: {
    marginTop: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelLabel: { ...t.body, color: color.mute },
});
