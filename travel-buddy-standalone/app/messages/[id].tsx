import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
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
  AppState,
  Animated,
  Share,
  Switch,
  TextInput,
  type AppStateStatus,
} from 'react-native';
import { Avatar } from '../../src/components/ui/Avatar';
import { localDateKey, localTodayKey } from '../../src/utils/localDate';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Zap, Send, Users, Globe, Check, CalendarClock, ArrowRight,
  CheckCircle, MoreVertical, Info, VolumeX, Languages, Paperclip, Compass,
  Bot, Reply, Copy, Trash2, Flag, CheckCheck, AlertCircle, Search, BookmarkPlus,
  RefreshCw, Clock, ChevronDown, X, Phone, Video, Lock,
} from 'lucide-react-native';
import { resolveCircleCardNav } from '../../src/lib/circleCardNavigation.ts';
import { useCallState, useCallActions } from '../../src/context/CallContext';
import { useBlockedIds } from '../../src/context/BlockedIdsContext';
import { ensureCallMediaPermissions } from '../../src/services/callPermissions';
import { CallHistoryMessage } from '../../src/components/calls/CallHistoryMessage';
import { canShowThreadCallButtons, threadCallContextType } from '../../src/components/calls/callEntryGating';
import { getBooking } from '../../src/services/rentABuddy';
import { useThreadMessages, useLanguageSettings, useOutgoingRequestStatus, markThreadRead } from '../../src/hooks/useMessaging';
import { useTrip } from '../../src/hooks/useBackend';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, avatar, icon } from '../../src/theme/tokens';
import { TG, TG_SPACING } from '../../src/theme/telegraphTokens';
import { TelegraphSuggestionTray, clearTelegraphSuggestionsCache } from '../../src/components/TelegraphSuggestionTray';
import { TelegraphSystemNotice } from '../../src/components/TelegraphSystemNotice';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { RsvpBar } from '../../src/components/RsvpBar';
import { supabase } from '../../src/lib/supabase';
import { getMeetup, rsvpMeetup } from '../../src/services/meetups';
import type { MeetupCounts, MeetupCreator, RsvpStatus, MeetupTimeOption, AttendeePreview } from '../../src/services/meetups';
import type { Message } from '../../src/services/messaging';
import { deleteMessage, muteThread, leaveThread, reportThread, retryTranslation, saveMessage } from '../../src/services/messaging';
import { DiscoveryCardMessage } from '../../src/components/DiscoveryCardMessage';
import { PostCardMessage } from '../../src/components/PostCardMessage';
import { ThreadSafetySheet } from '../../src/components/ThreadSafetySheet';
import { TelegraphRecommendationCard } from '../../src/components/TelegraphRecommendationCard';
import type { TelegraphSuggestion, MeetupPrefill } from '../../src/services/telegraphChat';
import { blockUser } from '../../src/services/blocks';
import { sendFeedback } from '../../src/services/intelligence';
import { ReportSheet } from '../../src/components/ReportSheet';
import { TripWishlistPicker, type AddToTripPayload } from '../../src/components/discovery/TripWishlistPicker';
import { TranslationSettingsSheet } from '../../src/components/TranslationSettingsSheet';
import { MentionInput, type MentionInputHandle } from '../../src/components/MentionInput';
import { MentionSuggestionList } from '../../src/components/MentionSuggestionList';
import type { AnyMentionSuggestion } from '../../src/services/tagging';
import { RichText } from '../../src/components/RichText';
import { CompassTelegraphTray } from '../../src/components/CompassTelegraphTray';
import { checkCompassTelegraphAvailable, type CompassTelegraphCard } from '../../src/services/compass';
import { CompassCardMessage } from '../../src/components/CompassCardMessage';
import { CircleStatusCardMessage } from '../../src/components/CircleStatusCardMessage';
import { checkCircleMembership } from '../../src/services/circle';
import { sendMessage, sendMediaMessage } from '../../src/services/messaging';
import { useMessageMediaPicker } from '../../src/hooks/useMessageMediaPicker';
import { MessageMediaBubble } from '../../src/components/MessageMediaBubble';
import * as Haptics from 'expo-haptics';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';
import * as Clipboard from 'expo-clipboard';
import { RentABuddyThreadHeader } from '../../src/components/rentabuddy/BookingThreadHeader';
import { MessageEntrance, useMessageEntranceGate } from '../../src/components/MessageEntrance';
import { BookingMilestoneMessage } from '../../src/components/rentabuddy/BookingMilestoneMessage';
import { E2EE_VERIFICATION_UI_ENABLED, E2EE_CLAIM_UI_ENABLED } from '../../src/lib/e2ee/verificationGate';

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

// ── Day label helpers ─────────────────────────────────────────────────────────

function formatDayLabel(isoDay: string): string {
  // LOCAL calendar day, not UTC — see src/utils/localDate. toISOString() here
  // mislabels dividers by a day for most of the world and permanently in scrollback.
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

// ── Long-press action sheet ───────────────────────────────────────────────────

function LongPressActionSheet({
  message,
  mine,
  threadId,
  onClose,
  onDeleteForMe,
  onReply,
  onSave,
}: {
  message: Message | null;
  mine: boolean;
  threadId?: string;
  onClose: () => void;
  onDeleteForMe: (id: string) => Promise<void>;
  onReply: (msg: Message) => void;
  onSave: (msg: Message) => void;
}) {
  const plainInsetForSheets = usePlainBottomInset();
  const [showReport, setShowReport] = useState(false);

  if (!message) return null;
  const text = message.displayBody ?? message.body ?? '';
  return (
    <>
      <Modal visible animationType="slide" transparent onRequestClose={onClose}>
        <Pressable style={las.overlay} onPress={onClose} />
        <View style={[las.sheet, { paddingBottom: plainInsetForSheets }]}>
          <View style={las.handle} />
          {text.length > 0 && (
            <Text style={las.preview} numberOfLines={2}>{text}</Text>
          )}
          {([
            // 'translate' removed — translations are automatic per language
            // settings; a menu item that only explained that was a dead end.
            ['reply',     'Reply',         Reply        ],
            ['copy',      'Copy text',     Copy         ],
            ['save',      'Save message',  BookmarkPlus ],
            ...(!mine ? [['report', 'Report', Flag]] : []),
          ] as [string, string, React.ComponentType<{ size: number; color: string }>][]).map(([key, label, Icon]) => (
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
                  { text: 'Delete', style: 'destructive', onPress: () => onDeleteForMe(message.id) },
                ]);
              }}
            >
              <Trash2 size={18} color="#EF4444" />
              <Text style={[las.rowLabel, { color: '#EF4444' }]}>Delete for me</Text>
            </Pressable>
          )}
        </View>
      </Modal>

      {/* Unified report sheet for non-mine messages */}
      {!mine && (
        <ReportSheet
          visible={showReport}
          onClose={() => { setShowReport(false); onClose(); }}
          subjectType="message"
          subjectId={message.id}
          subjectUserId={message.senderId}
          threadId={threadId}
          onReported={() => { setShowReport(false); onClose(); }}
        />
      )}
    </>
  );
}
const las = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: space.lg, paddingBottom: 34, paddingTop: space.sm },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  preview: { ...t.small, color: color.mute, fontSize: 12, marginBottom: space.sm, fontStyle: 'italic' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
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

/** Format a single time-poll slot as "Fri Jun 27 · 7:00 PM" (exact) or "Fri Jun 27 · Evening" (block) */
function fmtTimeOption(opt: MeetupTimeOption): string {
  const datePart = fmtDate(opt.proposedDate);
  if (opt.proposedTime) {
    const [h, m] = opt.proposedTime.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
  }
  if (opt.timeBlock) {
    return `${datePart} · ${BLOCK_SHORT[opt.timeBlock] ?? opt.timeBlock}`;
  }
  return datePart;
}

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
  return <Avatar uri={creator?.avatarUrl} name={creator?.displayName} size={20} />;
}

const AVATAR_SIZE = 26;
const AVATAR_OVERLAP = 8;

function AttendeeAvatar({ attendee }: { attendee: AttendeePreview }) {
  const onPress = () => {
    if (attendee.handle) router.push(`/u/${attendee.handle}` as any);
  };
  return (
    <Pressable onPress={onPress} style={as.avatarWrap}>
      <Avatar uri={attendee.avatarUrl} name={attendee.displayName} size={AVATAR_SIZE} style={as.avatarRing} />
    </Pressable>
  );
}

function AvatarStack({ attendees, totalGoing }: { attendees: AttendeePreview[]; totalGoing: number }) {
  if (attendees.length === 0) return null;
  const overflow = totalGoing - attendees.length;
  return (
    <View style={as.row}>
      {attendees.map((a, i) => (
        <View key={a.id} style={[as.avatarSlot, { marginLeft: i === 0 ? 0 : -AVATAR_OVERLAP }]}>
          <AttendeeAvatar attendee={a} />
        </View>
      ))}
      {overflow > 0 && (
        <View style={[as.overflowBadge, { marginLeft: -AVATAR_OVERLAP }]}>
          <Text style={as.overflowText}>+{overflow}</Text>
        </View>
      )}
      <Text style={as.goingLabel}>going</Text>
    </View>
  );
}

const as = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  avatarSlot: { zIndex: 1 },
  avatarWrap: {},
  // Sizing/shape come from <Avatar size>; this is the overlap ring only.
  avatarRing: { borderWidth: 2, borderColor: color.paperRaised },
  overflowBadge: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, borderWidth: 2, borderColor: color.paperRaised, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  overflowText: { fontSize: 9, fontWeight: '700', color: color.mute },
  goingLabel: { fontSize: 10, color: color.mute, fontWeight: '500', marginLeft: 2 },
});

function MeetupCard({ payload, mine }: { payload: MeetupCardPayload; mine: boolean }) {
  const { isAuthed } = useSession();
  const [counts, setCounts] = useState<MeetupCounts | null>(null);
  const [myRsvp, setMyRsvp] = useState<RsvpStatus | null>(null);
  const [rsvping, setRsvping] = useState<RsvpAction | null>(null);
  const rsvpingLockRef = useRef(false);
  const [isCancelled, setIsCancelled] = useState(false);
  // undefined = still loading; null = loaded but creator not found
  const [creator, setCreator] = useState<MeetupCreator | null | undefined>(undefined);
  // Live meetup fields used to enrich card display beyond what's in the stored payload
  const [fetchedStartsAt, setFetchedStartsAt] = useState<string | null>(null);
  const [fetchedApproxDate, setFetchedApproxDate] = useState<string | null>(null);
  const [fetchedTimeOptions, setFetchedTimeOptions] = useState<MeetupTimeOption[]>([]);
  const [goingAttendees, setGoingAttendees] = useState<AttendeePreview[]>([]);
  const [totalGoing, setTotalGoing] = useState(0);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const refreshMeetup = useCallback(() => {
    if (appStateRef.current !== 'active') return;
    getMeetup(payload.meetupId).then((res) => {
      if (res.ok && res.data) {
        setCounts(res.data.counts);
        setMyRsvp(res.data.myRsvp ?? null);
        setIsCancelled(res.data.status === 'cancelled');
        setCreator(res.data.creator ?? null);
        setFetchedStartsAt(res.data.startsAt ?? null);
        setFetchedApproxDate(res.data.approximateDate ?? null);
        setFetchedTimeOptions(res.data.timeOptions ?? []);
        setGoingAttendees(res.data.goingAttendees ?? []);
        setTotalGoing(res.data.totalGoing ?? 0);
      }
    });
  }, [payload.meetupId]);

  useEffect(() => {
    // Initial load — always fetch regardless of AppState
    getMeetup(payload.meetupId).then((res) => {
      if (res.ok && res.data) {
        setCounts(res.data.counts);
        setMyRsvp(res.data.myRsvp ?? null);
        setIsCancelled(res.data.status === 'cancelled');
        setCreator(res.data.creator ?? null);
        setFetchedStartsAt(res.data.startsAt ?? null);
        setFetchedApproxDate(res.data.approximateDate ?? null);
        setFetchedTimeOptions(res.data.timeOptions ?? []);
        setGoingAttendees(res.data.goingAttendees ?? []);
        setTotalGoing(res.data.totalGoing ?? 0);
      }
    });
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
    });
    const interval = setInterval(refreshMeetup, 30_000);
    return () => {
      sub.remove();
      clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.meetupId, refreshMeetup]);

  async function handleRsvp(status: RsvpAction) {
    if (rsvpingLockRef.current) return;
    rsvpingLockRef.current = true;
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
    try {
      const res = await rsvpMeetup(payload.meetupId, status);
      if (res.ok && res.data) {
        setMyRsvp(res.data.status);
        setCounts(res.data.counts);
        // Re-fetch full meetup to update going attendees after RSVP change
        refreshMeetup();
      } else {
        setMyRsvp(prev);
        setCounts(prevCounts);
        Alert.alert('Error', res.message ?? 'Could not RSVP');
      }
    } finally {
      rsvpingLockRef.current = false;
      setRsvping(null);
    }
  }

  const isConfirmed = payload.isConfirmed ?? false;
  // Fallback chain for the date/time row:
  //   confirmed  → confirmedTime (payload) → fetchedStartsAt → date-only fallback
  //   unconfirmed → fetchedStartsAt → earliest time-poll slot (with exact time if proposedTime set)
  //               → approximateDate + block label → null
  const approxDateStr = payload.approximateDate ?? fetchedApproxDate;
  const dateOnlyFallback = approxDateStr ? fmtDate(approxDateStr) : null;

  let pendingWhen: string | null = null;
  if (fetchedStartsAt) {
    pendingWhen = fmtDateTime(fetchedStartsAt);
  } else if (fetchedTimeOptions.length > 0) {
    const sorted = [...fetchedTimeOptions].sort((a, b) =>
      (a.proposedDate + (a.proposedTime ?? '')).localeCompare(b.proposedDate + (b.proposedTime ?? ''))
    );
    const firstLabel = fmtTimeOption(sorted[0]);
    pendingWhen = sorted.length > 1 ? `${firstLabel} +${sorted.length - 1} more` : firstLabel;
  } else if (approxDateStr) {
    pendingWhen = `${fmtDate(approxDateStr)}${payload.timeBlock ? ` · ${BLOCK_SHORT[payload.timeBlock] ?? payload.timeBlock}` : ''}`;
  }

  const when = isConfirmed
    ? (payload.confirmedTime
        ? fmtDateTime(payload.confirmedTime)
        : fetchedStartsAt
          ? fmtDateTime(fetchedStartsAt)
          : dateOnlyFallback)
    : pendingWhen;
  const showRsvpButtons = isAuthed && !isCancelled;

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
        <Pressable
          style={mc.creatorRow}
          onPress={() => { if (creator?.handle) router.push(`/u/${creator.handle}` as any); }}
          disabled={!creator?.handle}
        >
          <CreatorAvatar creator={creator} />
          <Text style={mc.creatorText} numberOfLines={1}>
            {creator?.displayName ?? 'Someone'} planned a meetup
          </Text>
        </Pressable>
      ) : null}

      <Text style={[mc.title, mine && mc.titleMine]} numberOfLines={2}>{payload.title}</Text>
      {goingAttendees.length > 0 && (
        <AvatarStack attendees={goingAttendees} totalGoing={counts?.going ?? totalGoing} />
      )}
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
      {counts ? (
        <RsvpBar
          style={mc.rsvpBar}
          going={counts.going}
          maybe={counts.maybe}
          pending={counts.pending}
          total={counts.going + counts.maybe + counts.pending}
        />
      ) : null}

      {showRsvpButtons ? (
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
      ) : isConfirmed ? (
        <View style={mc.footer}>
          <Text style={[mc.see, mine && mc.seeMine]}>Tap to view details</Text>
          <ArrowRight size={12} color={mine ? color.onInk + 'AA' : color.success} />
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
  icon: { width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center' },
  iconConfirmed: { backgroundColor: color.success + '22' },
  label: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' },
  labelConfirmed: { color: color.success },
  pendingBadge: { marginLeft: 'auto', backgroundColor: '#FFF3CD', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  pendingBadgeText: { fontSize: 9, fontWeight: '600', color: '#856404', letterSpacing: 0.3 },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  titleMine: { color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  rsvpBar: { marginTop: 2 },
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
  groupStart = true,
  groupEnd = true,
  autoTranslate,
  defaultShowOriginal,
  isGroupThread,
  onLongPress,
  receiptState,
  readerAvatars,
  dismissedAiMsgIds,
  onDismissAiCard,
  deliveryStatus,
  onRetry,
  onRetryTranslation,
  currentUserId,
  isCircleMember,
  onCircleCardPress,
}: {
  item: Message;
  mine: boolean;
  groupStart?: boolean;
  groupEnd?: boolean;
  autoTranslate: boolean;
  defaultShowOriginal: boolean;
  isGroupThread: boolean;
  onLongPress?: () => void;
  receiptState?: 'sent' | 'delivered' | 'read' | null;
  /** Up to 3 avatar URIs of group members who've read past this message. */
  readerAvatars?: string[];
  dismissedAiMsgIds?: Set<string>;
  onDismissAiCard?: (msgId: string) => void;
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null;
  onRetry?: () => void;
  onRetryTranslation?: () => void;
  currentUserId?: string;
  isCircleMember?: boolean | null;
  onCircleCardPress?: () => void;
}) {
  const [pickerPayload, setPickerPayload] = useState<AddToTripPayload | null>(null);
  const [showOriginal, setShowOriginal] = useState(defaultShowOriginal || !autoTranslate);

  // Brief highlight when a pending translation resolves to 'translated'
  const flashAnim = useRef(new Animated.Value(0)).current;
  const prevStatusRef = useRef<string | undefined>(item.translationStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = item.translationStatus;
    if (prev === 'pending' && item.translationStatus === 'translated') {
      flashAnim.setValue(1);
      Animated.timing(flashAnim, {
        toValue: 0,
        duration: 1400,
        useNativeDriver: true,
      }).start();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [item.translationStatus, flashAnim]);

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

  // Meetup card — special rendering (long-press wrapper added)
  const meetupPayload = parseMeetupCard(item.body ?? '', item);
  if (meetupPayload) {
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300}>
        <MeetupCard payload={meetupPayload} mine={mine} />
      </Pressable>
    );
  }

  // Discovery card
  if (item.msgType === 'system' && item.subtype === 'discovery_card') {
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300}>
        <DiscoveryCardMessage body={item.body ?? ''} mine={mine} />
      </Pressable>
    );
  }

  // Shared post card — sent from a post's ShareSheet
  if (item.msgType === 'system' && item.subtype === 'post_card') {
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300}>
        <PostCardMessage body={item.body ?? ''} mine={mine} />
      </Pressable>
    );
  }

  // Compass card — shared from the Ask Compass tray
  if (item.msgType === 'system' && item.subtype === 'compass_card') {
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300}>
        <CompassCardMessage body={item.body ?? ''} mine={mine} />
      </Pressable>
    );
  }

  // Circle status card — check-in or meeting-point update from the Circle feature
  if (item.msgType === 'circle_status_card') {
    const payload = (() => { try { return JSON.parse(item.body ?? ''); } catch { return null; } })();
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300} onPress={onCircleCardPress} disabled={isCircleMember === null}>
        <CircleStatusCardMessage
          subtype={payload?.subtype ?? item.subtype ?? null}
          venueLabel={payload?.venueLabel ?? null}
          approxArea={payload?.approxArea ?? null}
          senderName={item.senderName}
          mine={mine}
          isCircleMember={isCircleMember}
          onPress={onCircleCardPress}
        />
      </Pressable>
    );
  }

  // AI recommendation card — body is JSON with TelegraphActivityRecommendation shape
  if (item.msgType === 'ai_recommendation') {
    if (dismissedAiMsgIds?.has(item.id)) return null;
    const recPayload = (() => { try { return JSON.parse(item.body ?? ''); } catch { return null; } })();
    if (recPayload?.title) {
      return (
        <>
          <Pressable onLongPress={onLongPress} delayLongPress={300}>
            <TelegraphRecommendationCard
              rec={recPayload}
              onAddToTrip={() => setPickerPayload({
                  id:       recPayload.id ?? recPayload.title,
                  name:     recPayload.title,
                  category: recPayload.category ?? 'place',
                  type:     recPayload.category ?? null,
                  lat:      null,
                  lng:      null,
                })}
              onSave={() => {
              sendFeedback(recPayload.id ?? '', recPayload.category ?? '', 'save').catch(() => {});
              Alert.alert('Saved', `"${recPayload.title}" saved to your ideas.`);
            }}
            onShare={() => {
              sendFeedback(recPayload.id ?? '', recPayload.category ?? '', 'share').catch(() => {});
              Share.share({ message: `${recPayload.title} — ${recPayload.reason ?? ''}` }).catch(() => {});
            }}
            onNotInterested={() => {
              sendFeedback(recPayload.id ?? '', recPayload.category ?? '', 'not_for_me').catch(() => {});
              onDismissAiCard?.(item.id);
            }}
          />
          </Pressable>
          <TripWishlistPicker
            place={pickerPayload}
            visible={pickerPayload !== null}
            onClose={() => setPickerPayload(null)}
          />
        </>
      );
    }
  }

  let bodyToShow: string;
  if (mine || !autoTranslate || showOriginal) {
    bodyToShow = item.originalBody ?? item.body ?? '';
  } else {
    bodyToShow = item.displayBody ?? item.body ?? '';
  }

  const isTranslated = item.translated && autoTranslate && !showOriginal;
  const isPending = item.translationStatus === 'pending';
  const showLabel = !mine && (
    isPending ||
    (isTranslated && !!item.translationLabel) ||
    !!item.canShowOriginal
  );

  return (
    <View>
      {isGroupThread && !mine && item.senderName && groupStart && (
        <Text style={styles.senderLabel}>
          {item.senderName}
          {item.senderHandle ? ` @${item.senderHandle}` : ''}
        </Text>
      )}
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={300}
        style={[
          styles.bubble,
          mine ? styles.bubbleMine : styles.bubbleOther,
          !groupEnd && (mine ? styles.bubbleMineMid : styles.bubbleOtherMid),
        ]}
      >
        <Animated.View
          style={[styles.translationFlash, StyleSheet.absoluteFillObject, { opacity: flashAnim }]}
          pointerEvents="none"
        />
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
        <RichText
          content={bodyToShow}
          // Span positions are computed from the original body server-side.
          // When showing a translation (isTranslated), the translated text has
          // different character offsets, so we suppress spans to avoid
          // misaligned or missing interactive links.
          tags={isTranslated ? undefined : item.tags}
          hashtagUsages={isTranslated ? undefined : item.hashtagUsages}
          currentUserId={currentUserId}
          style={[styles.bubbleText, mine && styles.bubbleTextMine]}
          mentionColor={mine ? 'rgba(255,255,255,0.90)' : undefined}
          hashtagColor={mine ? 'rgba(255,255,255,0.80)' : undefined}
        />

        {(groupEnd || item.editedAt) ? (
          <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
            {formatTime(item.createdAt)}
            {item.editedAt ? '  ·  edited' : ''}
          </Text>
        ) : null}

        {showLabel && (
          <View style={styles.translationRow}>
            {isPending ? (
              <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                Translating…
              </Text>
            ) : isTranslated ? (
              <View style={[styles.transPill, mine && styles.transPillMine]}>
                <Languages size={9} color={mine ? color.onInk : color.mute} />
                <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
                  {item.translationLabel ?? 'Translated'}
                </Text>
              </View>
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

        {/* Translation unavailable — shown when translation was attempted but failed */}
        {!mine && item.translationStatus === 'failed' && autoTranslate && (
          <View style={styles.transRetryRow}>
            <Text style={styles.transUnavailable}>Translation unavailable.</Text>
            {onRetryTranslation && (
              <Pressable onPress={onRetryTranslation} hitSlop={8}>
                <Text style={styles.transRetry}>Retry</Text>
              </Pressable>
            )}
          </View>
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
            <Avatar key={i} uri={uri} size={14} />
          ))}
        </View>
      )}
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
  const plainInsetForSheets = usePlainBottomInset();
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
      <View style={[sheetStyles.sheet, { paddingBottom: plainInsetForSheets }]}>
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
  const { messages, loading, error, sending, send, reload, typingUserIds, notifyTyping, retrySend } = useThreadMessages(id ?? null);
  const { data: langSettings } = useLanguageSettings();
  const [input, setInput] = useState('');
  const [lastSentMessage, setLastSentMessage] = useState<string | undefined>(undefined);
  const [sendFailed, setSendFailed] = useState(false);
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [addToPlanSuggestion, setAddToPlanSuggestion] = useState<TelegraphSuggestion | null>(null);
  const [meetupSheetCtx, setMeetupSheetCtx] = useState<MeetupSheetCtx | null>(null);
  const isDirect = threadType === 'direct' || threadType === 'rent_buddy_booking';
  const [isAcceptedMember, setIsAcceptedMember] = useState(isDirect);
  const [isCircleMember, setIsCircleMember] = useState<boolean | null>(null);
  const [plannedByName, setPlannedByName] = useState<string | undefined>(undefined);
  const [blockingUser, setBlockingUser] = useState(false);
  const [showSafetySheet, setShowSafetySheet] = useState(false);
  const [hideAiSuggestions, setHideAiSuggestions] = useState(false);
  const [threadIsMuted, setThreadIsMuted] = useState(false);
  // E-2: whether the thread uses end-to-end encryption
  const [isE2ee, setIsE2ee] = useState(false);
  const [showCompassTray, setShowCompassTray] = useState(false);
  const [compassTelegraphEnabled, setCompassTelegraphEnabled] = useState<null | boolean>(null);
  const [dismissedAiMsgIds, setDismissedAiMsgIds] = useState<Set<string>>(new Set());
  // Long-press action sheet state
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [actionMsgMine, setActionMsgMine] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // Per-thread translation overrides (null = fall back to global langSettings)
  const [threadAutoTranslate, setThreadAutoTranslate] = useState<boolean | null>(null);
  const [threadShowOriginal, setThreadShowOriginal] = useState<boolean | null>(null);
  // Fetch trip end date so TelegraphSuggestionTray can expire cached suggestions
  const { data: tripData } = useTrip(threadType === 'trip' ? contextId : undefined);
  const [showTranslationSheet, setShowTranslationSheet] = useState(false);
  // DM profile for richer header
  const [dmProfile, setDmProfile] = useState<{ name: string | null; avatarUrl: string | null; handle: string | null; city: string | null } | null>(null);
  // Other party's last_read_at for DM read receipts
  const [dmOtherLastRead, setDmOtherLastRead] = useState<string | null>(null);
  // Member count for trip/circle threads
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const listRef = useRef<FlatList>(null);
  const shouldAnimateMessage = useMessageEntranceGate();
  const mediaPicker = useMessageMediaPicker();
  const [showMediaPickerSheet, setShowMediaPickerSheet] = useState(false);

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

  // Load per-thread translation prefs from AsyncStorage
  useEffect(() => {
    if (!id) return;
    AsyncStorage.getItem(`thread_translation:${id}`)
      .then((raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as { autoTranslate?: boolean; showOriginal?: boolean };
          if (typeof parsed.autoTranslate === 'boolean') setThreadAutoTranslate(parsed.autoTranslate);
          if (typeof parsed.showOriginal === 'boolean') setThreadShowOriginal(parsed.showOriginal);
        } catch { /* ignore corrupt entries */ }
      })
      .catch(() => {});
  }, [id]);

  async function saveThreadTranslationPrefs(at: boolean, so: boolean) {
    if (!id) return;
    await AsyncStorage.setItem(`thread_translation:${id}`, JSON.stringify({ autoTranslate: at, showOriginal: so }));
  }

  // Load per-thread hide-AI-suggestions pref from AsyncStorage
  useEffect(() => {
    if (!id) return;
    AsyncStorage.getItem(`thread_ai_hidden:${id}`)
      .then((v) => { if (v === '1') setHideAiSuggestions(true); })
      .catch(() => {});
  }, [id]);

  // Feature-flag gate: check if COMPASS_TELEGRAPH is enabled for this thread.
  // Chip is hidden until the check resolves (null → false → true).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    checkCompassTelegraphAvailable(id)
      .then((enabled) => { if (!cancelled) setCompassTelegraphEnabled(enabled); })
      .catch(() => { if (!cancelled) setCompassTelegraphEnabled(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Circle membership — determines whether circle_status_card messages show
  // their full content or a privacy-safe placeholder.  Relevant for trip and
  // event threads; direct threads never contain circle cards.
  // Fail-closed: isCircleMember stays null (→ placeholder) until confirmed true.
  useEffect(() => {
    const ctxType = threadType === 'trip' ? 'trip' : threadType === 'event' ? 'event' : null;
    if (!ctxType || !contextId) return;
    // Reset immediately so stale membership from a prior context never bleeds through.
    setIsCircleMember(null);
    let cancelled = false;
    checkCircleMembership(ctxType, contextId)
      .then((member) => { if (!cancelled) setIsCircleMember(member); })
      .catch(() => { if (!cancelled) setIsCircleMember(false); });
    return () => { cancelled = true; };
  }, [threadType, contextId]);

  // Navigate to the Circle presence screen when a circle_status_card is tapped.
  // Circle threads → opens /circle (matching the "View Circle" quick action).
  // Trip/event threads where the viewer is a member → opens /circle-presence.
  // Trip/event threads where membership is unknown/false → informational Alert (fail-closed).
  // No-op when the thread has no Circle context (direct threads, etc.).
  const onCircleCardPress = useCallback(() => {
    const nav = resolveCircleCardNav(
      threadType,
      contextId,
      isCircleMember,
      (tripData as any)?.destinationCity ?? title ?? null,
    );
    if (nav.action === 'push-circle') {
      router.push('/circle' as any);
    } else if (nav.action === 'push-presence') {
      router.push({
        pathname: '/circle-presence',
        params: {
          contextType: nav.contextType,
          contextId: nav.contextId,
          contextLabel: nav.contextLabel,
        },
      } as any);
    } else if (nav.action === 'alert') {
      Alert.alert(nav.title, nav.message);
    }
    // 'loading' and 'noop': do nothing
  }, [threadType, contextId, isCircleMember, tripData, title]);

  async function toggleHideAiSuggestions() {
    if (!id) return;
    const next = !hideAiSuggestions;
    setHideAiSuggestions(next);
    await AsyncStorage.setItem(`thread_ai_hidden:${id}`, next ? '1' : '0').catch(() => {});
  }

  // Resolve display name once (for the planned-by label in meetup cards)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const meta = data?.user?.user_metadata as Record<string, unknown> | undefined;
      const name = (meta?.full_name ?? meta?.name ?? data?.user?.email) as string | undefined;
      if (name) setPlannedByName(name);
    });
  }, []);

  // Fetch DM partner's profile for the rich Direct header
  useEffect(() => {
    if ((threadType !== 'direct' && threadType !== 'rent_buddy_booking') || !otherUserId) return;
    supabase
      .from('profiles')
      .select('name, handle, avatar_url, city')
      .eq('id', otherUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDmProfile({
            name: (data as any).name ?? null,
            handle: (data as any).handle ?? null,
            avatarUrl: (data as any).avatar_url ?? null,
            city: (data as any).city ?? null,
          });
        }
      });
  }, [threadType, otherUserId]);

  // Fetch other party's last_read_at for DM read receipts
  useEffect(() => {
    if ((threadType !== 'direct' && threadType !== 'rent_buddy_booking') || !id || !otherUserId) return;
    supabase
      .from('message_thread_members')
      .select('last_read_at')
      .eq('thread_id', id)
      .eq('user_id', otherUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setDmOtherLastRead((data as any).last_read_at ?? null);
      });
  }, [threadType, id, otherUserId]);

  // Fetch member count for trip / circle threads
  useEffect(() => {
    if (isDirect || !id) return;
    supabase
      .from('message_thread_members')
      .select('*', { count: 'exact', head: true })
      .eq('thread_id', id)
      .is('left_at', null)
      .then(({ count }) => { if (count !== null) setMemberCount(count); });
  }, [id, threadType]);

  // Permission gate: accepted thread members only (DMs always pass; trip/circle
  // check message_thread_members — only accepted members are in the thread).
  useEffect(() => {
    if (isDirect) { setIsAcceptedMember(true); return; }
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

  // E-2: fetch is_e2ee flag once per thread open.
  useEffect(() => {
    if (!id) return;
    supabase
      .from('message_threads')
      .select('is_e2ee')
      .eq('id', id)
      .maybeSingle()
      .then(({ data }) => { if ((data as any)?.is_e2ee) setIsE2ee(true); });
  }, [id]);

  // Merge: per-thread override takes precedence over global langSettings
  const autoTranslate = threadAutoTranslate ?? langSettings?.auto_translate_messages ?? true;
  const defaultShowOriginal = threadShowOriginal ?? langSettings?.show_original_messages ?? false;
  const isGroupThread = threadType === 'trip' || threadType === 'circle';

  // Sender-side rate-limit: "Waiting for reply" = the current user has a
  // PENDING outgoing message request to this person. We check the server so
  // that normal friends/followers who simply haven't replied yet are never
  // blocked. The status clears automatically once the recipient accepts.
  const { pending: hasOutgoingRequest } = useOutgoingRequestStatus(
    isDirect ? (otherUserId ?? null) : null,
  );
  const isWaitingForReply = isDirect && hasOutgoingRequest === true;

  const headerTitle = title && title.trim() ? title : 'Chat';

  // ── Calling (Phases 2–3) — Telegraph DM + Rent a Buddy entry points ────────
  // Buttons appear on eligible DMs and call-eligible RAB booking threads;
  // hiding them is UX — the server remains the authorization for every call.
  const callState = useCallState();
  const callActions = useCallActions();
  // RAB booking status drives entry-point gating (and Call back eligibility).
  const [rabBookingStatus, setRabBookingStatus] = useState<string | null>(null);
  const [rabStayConnected, setRabStayConnected] = useState<{ traveler: boolean; buddy: boolean }>({ traveler: false, buddy: false });
  useEffect(() => {
    if (threadType !== 'rent_buddy_booking' || !contextId) return;
    let alive = true;
    getBooking(contextId).then((res) => {
      if (alive && res.ok && res.data?.booking) {
        setRabBookingStatus(res.data.booking.status);
        setRabStayConnected({
          traveler: !!res.data.booking.stayConnectedTraveler,
          buddy: !!res.data.booking.stayConnectedBuddy,
        });
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [threadType, contextId]);
  const callContextType = threadCallContextType(threadType);
  const canShowCallButtons = canShowThreadCallButtons({
    threadType, otherUserId, isWaitingForReply, rabBookingStatus,
    rabStayConnectedTraveler: rabStayConnected.traveler,
    rabStayConnectedBuddy: rabStayConnected.buddy,
  });

  const startThreadCall = useCallback(async (requested: 'voice' | 'video') => {
    if (!id || !otherUserId) return;
    // Multiple-call prevention (§23) — never silently terminate a call.
    if (callState.phase !== 'idle') {
      Alert.alert(
        "You're already in a call.",
        'What would you like to do?',
        [
          { text: 'Return to current call', onPress: () => callActions.setMinimized(false) },
          {
            text: 'Leave and join new call',
            style: 'destructive',
            onPress: async () => {
              await callActions.hangUp();
              const allowed = await ensureCallMediaPermissions(requested);
              if (allowed === null) return;
              await callActions.startDirectCall({
                threadId: id, calleeId: otherUserId, contextType: callContextType, callType: allowed,
                peer: { id: otherUserId, name: dmProfile?.name ?? headerTitle, handle: dmProfile?.handle ?? null, avatarUrl: dmProfile?.avatarUrl ?? null },
              });
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
      return;
    }
    const allowed = await ensureCallMediaPermissions(requested);
    if (allowed === null) return; // mic denied — explained by the permission alert
    await callActions.startDirectCall({
      threadId: id, calleeId: otherUserId, contextType: callContextType, callType: allowed,
      peer: { id: otherUserId, name: dmProfile?.name ?? headerTitle, handle: dmProfile?.handle ?? null, avatarUrl: dmProfile?.avatarUrl ?? null },
    });
  }, [id, otherUserId, callState.phase, callActions, callContextType, dmProfile?.name, dmProfile?.handle, dmProfile?.avatarUrl, headerTitle]);

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  // Build list items with day separators interspersed. Consecutive messages
  // from the same sender (within the same day) are visually grouped:
  // groupStart shows the sender label, groupEnd shows the timestamp/tail.
  type ListItem =
    | { _t: 'msg'; data: Message; groupStart: boolean; groupEnd: boolean }
    | { _t: 'day'; label: string; key: string };

  const listItems = useMemo<ListItem[]>(() => {
    const items: ListItem[] = [];
    let lastDay = '';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const day = localDateKey(m.createdAt);
      const dayBreak = day !== lastDay;
      if (dayBreak) {
        lastDay = day;
        items.push({ _t: 'day', label: formatDayLabel(day), key: `day-${day}` });
      }
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const sameSenderPrev = !dayBreak && prev && prev.senderId === m.senderId && prev.msgType === m.msgType && m.msgType === 'text';
      const sameSenderNext = next && next.senderId === m.senderId && next.createdAt.slice(0, 10) === day && next.msgType === m.msgType && m.msgType === 'text';
      items.push({ _t: 'msg', data: m, groupStart: !sameSenderPrev, groupEnd: !sameSenderNext });
    }
    return items;
  }, [messages]);

  // Scroll-to-bottom FAB — shown when the user has scrolled away from newest
  const [showJumpFab, setShowJumpFab] = useState(false);

  // Send button springs in/out with input content
  const hasInput = input.trim().length > 0 || mediaPicker.media !== null;
  const sendAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(sendAnim, {
      toValue: hasInput ? 1 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 120,
    }).start();
  }, [hasInput, sendAnim]);

  // Per-message receipt state.
  // DM: cross-checks the other party's last_read_at — 'read' > 'delivered' > 'sent'.
  // Group: always 'delivered' for confirmed messages; readerAvatarsForMsg shows WHO read.
  const receiptForMsg = useCallback((msg: Message): 'sent' | 'delivered' | 'read' | null => {
    if (isDirect && dmOtherLastRead) {
      return new Date(dmOtherLastRead) >= new Date(msg.createdAt) ? 'read' : 'delivered';
    }
    const ageSecs = (Date.now() - new Date(msg.createdAt).getTime()) / 1000;
    return ageSecs > 3 ? 'delivered' : 'sent';
  }, [isDirect, dmOtherLastRead]);

  // Group-thread member reads — fetched once per thread to drive reader avatar chips.
  const [groupMemberReads, setGroupMemberReads] = useState<
    { userId: string; lastReadAt: string | null; avatarUrl: string | null }[]
  >([]);

  useEffect(() => {
    if (isDirect || !id) { setGroupMemberReads([]); return; }
    let active = true;
    (async () => {
      const { data: members } = await supabase
        .from('message_thread_members')
        .select('user_id, last_read_at')
        .eq('thread_id', id)
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
  }, [id, isDirect, userId]);

  // Derive up to 3 reader avatar URIs for a given message (group threads only).
  const readerAvatarsForMsg = useCallback((msg: Message): string[] => {
    if (isDirect || !msg.createdAt) return [];
    return groupMemberReads
      .filter((m) => m.lastReadAt !== null && new Date(m.lastReadAt) >= new Date(msg.createdAt))
      .slice(0, 3)
      .map((m) => m.avatarUrl)
      .filter((u): u is string => !!u);
  }, [isDirect, groupMemberReads]);

  // Handle delete for me from the action sheet
  const handleDeleteForMe = useCallback(async (msgId: string) => {
    await deleteMessage(msgId);
    reload();
  }, [reload]);

  async function handleSend() {
    const text = input.trim();

    // ── Media send path ───────────────────────────────────────────────────
    if (mediaPicker.media !== null && id) {
      notifyTyping(false);
      setSendFailed(false);
      let uploadRes = mediaPicker.uploadResult;
      if (!uploadRes) {
        uploadRes = await mediaPicker.upload();
      }
      if (!uploadRes) {
        // upload was cancelled or failed — mediaPicker already set state to 'failed'
        return;
      }
      const res = await sendMediaMessage(id, {
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
    setLastSentMessage(text);
    setSendFailed(false);
    const currentReply = replyingTo;
    setReplyingTo(null);
    const res = await send(text, currentReply ? {
      replyToId: currentReply.id,
      replyToBody: currentReply.displayBody ?? currentReply.body ?? null,
      replyToSenderName: currentReply.senderName ?? null,
    } : undefined);
    if (!res?.ok) setSendFailed(true);
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
    // Suggestions carry no place id, so show the detail and offer a real
    // next step into Discovery instead of a dead-end OK.
    Alert.alert(
      suggestion.title,
      suggestion.reason + (suggestion.location_context ? `\n\n📍 ${suggestion.location_context}` : ''),
      [
        { text: 'Explore in Discovery', onPress: () => router.push('/(tabs)/discovery' as any) },
        { text: 'OK', style: 'cancel' },
      ],
    );
  }, []);

  // Shared back + title header element (used in loading/error states too)
  function ThreadHeader({ compact }: { compact?: boolean }) {
    const { blockedIds: dmBlockedIds, blockerIds: dmBlockerIds } = useBlockedIds();
    const isDmBlocked = isDirect && !!otherUserId && (dmBlockedIds.has(otherUserId) || dmBlockerIds.has(otherUserId));
    const displayName = isDirect
      ? (dmProfile?.name ?? headerTitle)
      : headerTitle;
    // Direct: show "City · Last active" subtitle
    const directSubtitle = dmProfile?.city ? `${dmProfile.city} · Active recently` : 'Active recently';
    const subtitle = threadType === 'trip'
      ? (memberCount !== null ? `${memberCount} members` : 'Trip Chat')
      : threadType === 'circle'
        ? (memberCount !== null ? `${memberCount} members` : 'Trusted Circle')
        : directSubtitle;

    return (
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>

        {/* Direct: small avatar — tappable to open the other person's profile */}
        {isDirect && (
          <Pressable
            style={styles.dmAvatarWrap}
            onPress={() => {
              if (!dmProfile?.handle || isDmBlocked) return;
              router.push(`/u/${dmProfile.handle}` as any);
            }}
            disabled={!dmProfile?.handle || isDmBlocked}
            hitSlop={4}
          >
            <Avatar uri={dmProfile?.avatarUrl} name={displayName} size={36} />
          </Pressable>
        )}

        {/* Trip / Circle: coloured badge */}
        {threadType === 'trip' && (
          <View style={styles.headerIconBadge}>
            <Globe size={14} color={color.onInk} />
          </View>
        )}
        {threadType === 'circle' && (
          <View style={[styles.headerIconBadge, { backgroundColor: color.ink }]}>
            <Users size={14} color={color.onInk} />
          </View>
        )}

        <Pressable
          style={styles.headerMeta}
          onPress={isDirect && dmProfile?.handle && !isDmBlocked ? () => router.push(`/u/${dmProfile!.handle}` as any) : undefined}
          disabled={!isDirect || !dmProfile?.handle || isDmBlocked}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.headerName} numberOfLines={1}>{displayName}</Text>
            {isDirect && dmProfile?.name && (
              <CheckCircle size={13} color={color.signal} />
            )}
            {/* E-2: lock badge.
                Suppressed entirely while E2EE_CLAIM_UI_ENABLED is false — the
                padlock and its "End-to-end encrypted" label ARE the claim, and
                the app must not assert verified E2EE until FFI bar 2 is proven
                AND the client attachment-control gap is closed. See
                lib/e2ee/verificationGate.ts for both conditions.

                This is not about finding 14: that server-side plaintext-media
                bypass is fixed (9b1f49bdc) and its status stands.

                When the claim gate is reopened, the badge is still
                non-interactive until E2EE_VERIFICATION_UI_ENABLED — tapping
                through to a safety number the FFI has never produced would
                invite exactly the trust the previous (theatre) implementation
                invited. */}
            {E2EE_CLAIM_UI_ENABLED && isE2ee && (
              E2EE_VERIFICATION_UI_ENABLED ? (
                <Pressable
                  hitSlop={8}
                  accessibilityLabel="End-to-end encrypted. Tap to verify safety number."
                  onPress={() => {
                    router.push({
                      pathname: '/safety-number',
                      params: { peerName: displayName, threadId: String(id ?? '') },
                    });
                  }}
                >
                  <Lock size={13} color={color.signal} />
                </Pressable>
              ) : (
                <Lock size={13} color={color.signal} accessibilityLabel="End-to-end encrypted" />
              )
            )}
          </View>
          <View style={styles.headerTagRow}>
            {compact ? (
              <>
                <Zap size={9} color={color.signal} fill={color.signal} />
                <Text style={styles.headerTag}>Telegraph</Text>
              </>
            ) : (
              <Text style={styles.headerTag} numberOfLines={1}>{subtitle}</Text>
            )}
          </View>
        </Pressable>

        {/* Right-side action icons */}
        {!compact && (
          <View style={styles.headerActions}>
            {/* Thread info + message search hidden until built (beta-audit).
                Safety/overflow controls live in ThreadSafetySheet. */}
            {false ? <Pressable hitSlop={8} style={styles.headerIconBtn} onPress={() => Alert.alert('Thread info', 'Members, shared media, and settings — coming soon.')}>
              <Info size={18} color={color.mute} />
            </Pressable> : null}
            {canShowCallButtons && (
              <>
                <Pressable
                  hitSlop={8}
                  style={styles.headerIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Start voice call"
                  onPress={() => { void startThreadCall('voice'); }}
                >
                  <Phone size={18} color={color.signal} />
                </Pressable>
                <Pressable
                  hitSlop={8}
                  style={styles.headerIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Start video call"
                  onPress={() => { void startThreadCall('video'); }}
                >
                  <Video size={18} color={color.signal} />
                </Pressable>
              </>
            )}
            <Pressable hitSlop={8} style={styles.headerIconBtn} onPress={() => setShowTranslationSheet(true)}>
              <Languages size={18} color={autoTranslate ? color.signal : color.mute} />
            </Pressable>
            <Pressable
              hitSlop={8}
              style={styles.headerIconBtn}
              accessibilityLabel={threadIsMuted ? 'Unmute thread' : 'Mute thread'}
              onPress={async () => {
                const next = !threadIsMuted;
                await muteThread(id ?? '', next);
                setThreadIsMuted(next);
              }}
            >
              <VolumeX size={18} color={threadIsMuted ? color.signal : color.mute} />
            </Pressable>
            <Pressable style={styles.headerIconBtn} onPress={() => setShowSafetySheet(true)} hitSlop={8}>
              <MoreVertical size={18} color={color.mute} />
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  // Quick-action bar shown below the header for trip / circle threads
  function QuickActionBar() {
    if (threadType === 'trip' && contextId) {
      return (
        <View style={styles.quickBar}>
          <Pressable style={styles.quickBtn} onPress={() => router.push(`/trip/${contextId}` as any)}>
            <Globe size={12} color={color.signal} />
            <Text style={styles.quickBtnText}>View Trip</Text>
          </Pressable>
          <Pressable style={styles.quickBtn} onPress={handlePlanMeetupButton}>
            <CalendarClock size={12} color={color.signal} />
            <Text style={styles.quickBtnText}>Add Plan</Text>
          </Pressable>
        </View>
      );
    }
    if (threadType === 'circle' && contextId) {
      return (
        <View style={styles.quickBar}>
          {/* /circle/<id> is not a route — the circle screen is /circle (beta-audit fix) */}
          <Pressable style={styles.quickBtn} onPress={() => router.push('/circle' as any)}>
            <Users size={12} color={color.signal} />
            <Text style={styles.quickBtnText}>View Circle</Text>
          </Pressable>
          {/* Share Discovery hidden until the picker flow is built (beta-audit) */}
        </View>
      );
    }
    return null;
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ThreadHeader compact />
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ThreadHeader compact />
        <View style={styles.center}>
          <Text style={styles.errText}>{error}</Text>
          <Pressable
            style={{
              marginTop: space.md, paddingHorizontal: space.xl, paddingVertical: space.sm,
              borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal,
            }}
            onPress={reload}
            accessibilityRole="button"
            accessibilityLabel="Retry loading messages"
          >
            <Text style={{ ...t.bodyStrong, color: color.signal }}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={styles.screen}>
      <ThreadHeader />
      {threadType === 'rent_buddy_booking' && contextId && (
        <RentABuddyThreadHeader
          bookingId={contextId}
          autoTranslate={autoTranslate}
          onTranslateToggle={(v) => {
            setThreadAutoTranslate(v);
            saveThreadTranslationPrefs(v, threadShowOriginal ?? langSettings?.show_original_messages ?? false);
          }}
        />
      )}
      <QuickActionBar />

      <FlatList
        windowSize={9}
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        ref={listRef}
        data={listItems}
        keyExtractor={(item) => item._t === 'day' ? item.key : item.data.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
          </View>
        }
        onScroll={(e) => {
          const { contentSize, layoutMeasurement, contentOffset } = e.nativeEvent;
          const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
          setShowJumpFab(distanceFromBottom > 320);
        }}
        scrollEventThrottle={120}
        renderItem={({ item }) => {
          if (item._t === 'day') {
            return <DayDivider label={item.label} />;
          }
          const m = item.data;
          const mine = m.senderId === userId;
          // Call history lines (missed / declined / canceled / duration)
          if (m.msgType === 'system' && m.subtype?.startsWith('call_')) {
            return (
              <MessageEntrance animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}>
                <CallHistoryMessage
                  subtype={m.subtype}
                  body={m.body ?? null}
                  mine={mine}
                  onCallBack={
                    m.subtype === 'call_missed' && !mine && canShowCallButtons
                      ? (kind) => { void startThreadCall(kind); }
                      : undefined
                  }
                />
              </MessageEntrance>
            );
          }
          // Rent a Buddy milestone banners
          if (m.msgType === 'system' && m.subtype?.startsWith('rent_buddy_')) {
            return (
              <MessageEntrance animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}>
                <BookingMilestoneMessage subtype={m.subtype} body={m.body ?? undefined} />
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
                  senderName={!mine && isGroupThread ? m.senderName : null}
                  createdAt={m.createdAt}
                  uploadState={m.uploadState ?? null}
                  uploadProgress={m.uploadProgress ?? 0}
                  onCancel={m.uploadState === 'uploading' ? () => mediaPicker.cancel() : undefined}
                  onRetry={m.uploadState === 'failed' ? () => mediaPicker.retry() : undefined}
                />
              </MessageEntrance>
            );
          }
          // System event messages (non-meetup, non-rich-card) render as centred pill labels
          if (m.msgType === 'system' && m.subtype !== 'discovery_card' && m.subtype !== 'compass_card' && m.subtype !== 'post_card' && !parseMeetupCard(m.body ?? '', m)) {
            return (
              <MessageEntrance animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}>
                <TelegraphSystemNotice text={m.body ?? ''} />
              </MessageEntrance>
            );
          }
          return (
            <MessageEntrance
              animate={shouldAnimateMessage(m.clientId ?? m.id, m.createdAt)}
              style={[
                styles.bubbleRow,
                mine && styles.bubbleRowMine,
                { marginTop: item.groupStart ? TG_SPACING.groupGap : TG_SPACING.intraGap },
              ]}
            >
              <MessageBubble
                item={m}
                mine={mine}
                groupStart={item.groupStart}
                groupEnd={item.groupEnd}
                autoTranslate={autoTranslate}
                defaultShowOriginal={defaultShowOriginal}
                isGroupThread={isGroupThread}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  setActionMsg(m);
                  setActionMsgMine(mine);
                }}
                receiptState={mine ? receiptForMsg(m) : null}
                readerAvatars={mine ? readerAvatarsForMsg(m) : undefined}
                dismissedAiMsgIds={dismissedAiMsgIds}
                onDismissAiCard={(msgId) => setDismissedAiMsgIds((prev) => new Set([...prev, msgId]))}
                deliveryStatus={mine ? (m.deliveryStatus ?? null) : null}
                onRetry={mine && m.clientId ? () => retrySend(m.clientId!) : undefined}
                onRetryTranslation={!mine && m.id ? () => { retryTranslation(m.id).catch(() => {}); } : undefined}
                currentUserId={userId ?? undefined}
                isCircleMember={isCircleMember}
                onCircleCardPress={m.msgType === 'circle_status_card' ? onCircleCardPress : undefined}
              />
            </MessageEntrance>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {/* Scroll-to-bottom FAB */}
      {showJumpFab && (
        <Pressable
          style={styles.jumpFab}
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          hitSlop={8}
        >
          <ChevronDown size={18} color={color.ink} />
        </Pressable>
      )}

      {/* Typing indicator */}
      {typingUserIds.length > 0 && (
        <View style={styles.typingRow}>
          <Text style={styles.typingText}>
            {typingUserIds.length === 1 && dmProfile?.name
              ? `${dmProfile.name} is typing…`
              : 'Someone is typing…'}
          </Text>
        </View>
      )}

      {/* Waiting-for-reply banner — shown when the user's first message is pending acceptance */}
      {isWaitingForReply && (
        <View style={styles.waitingBanner}>
          <Clock size={14} color="#92400E" />
          <Text style={styles.waitingBannerText}>
            Waiting for reply — your message is in their requests.
          </Text>
        </View>
      )}

      {/* Failed-send banner — sits above the composer, offers retry */}
      {sendFailed && lastSentMessage && (
        <View style={styles.failedBanner}>
          <AlertCircle size={14} color="#EF4444" />
          <Text style={styles.failedBannerText} numberOfLines={1}>
            Failed to send: "{lastSentMessage}"
          </Text>
          <Pressable
            style={styles.failedRetryBtn}
            onPress={() => {
              const text = lastSentMessage;
              setSendFailed(false);
              setInput(text);
            }}
          >
            <RefreshCw size={12} color="#EF4444" />
            <Text style={styles.failedRetryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {/* Telegraph suggestion tray — above the composer */}
      {id && !hideAiSuggestions && (
        <TelegraphSuggestionTray
          threadId={id}
          lastSentMessage={lastSentMessage}
          tripEndDate={tripData?.endDate}
          onAddToPlan={handleAddToPlan}
          onCreateMeetup={handleCreateMeetup}
          onViewPlace={handleViewPlace}
        />
      )}

      {/* Mention suggestions — above compose bar */}
      <MentionSuggestionList
        suggestions={mentionSuggestions}
        loading={mentionLoading}
        visible={mentionVisible}
        onSelect={(s) => mentionRef.current?.insertTag(s)}
      />

      {/* Media attachment preview chip — shown above compose when media is pending */}
      {mediaPicker.media && (
        <View style={styles.attachPreviewBar}>
          <View style={styles.attachPreviewChip}>
            {mediaPicker.media.mediaType === 'video' ? (
              <Text style={styles.attachPreviewIcon}>🎬</Text>
            ) : (
              <Text style={styles.attachPreviewIcon}>🖼️</Text>
            )}
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
              {replyingTo.displayBody ?? replyingTo.body ?? ''}
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
        {/* Media attachment button */}
        <Pressable style={styles.composeIconBtn} onPress={() => setShowMediaPickerSheet(true)} hitSlop={6}>
          <Paperclip size={18} color={mediaPicker.media ? color.signal : color.mute} />
        </Pressable>

        {/* Plan meetup button */}
        {isAcceptedMember && (
          <Pressable style={styles.composeIconBtn} onPress={handlePlanMeetupButton} hitSlop={6}>
            <CalendarClock size={18} color={color.signal} />
          </Pressable>
        )}

        {/* Discovery card stub */}
        {false ? <Pressable style={styles.composeIconBtn} hitSlop={6}>
          <Compass size={18} color={color.mute} />
          </Pressable> : null}

        {/* Ask Compass chip — gated by COMPASS_TELEGRAPH feature flag */}
        {compassTelegraphEnabled === true && (
          <Pressable
            style={styles.composeIconBtn}
            onPress={() => setShowCompassTray(true)}
            hitSlop={6}
            accessibilityLabel="Ask Compass for recommendations"
          >
            <Bot size={18} color={color.signal} />
          </Pressable>
        )}

        <MentionInput
          ref={mentionRef}
          style={[styles.inputField, isWaitingForReply && { opacity: 0.45 }]}
          placeholder={isWaitingForReply ? 'Waiting for reply…' : 'Write a Telegraph…'}
          placeholderTextColor={color.faint}
          value={input}
          onChangeText={(text) => { setInput(text); notifyTyping(text.trim().length > 0); }}
          onBlur={() => notifyTyping(false)}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!sending && !isWaitingForReply}
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
            style={[styles.sendBtn, (hasInput && !sending && !isWaitingForReply) ? styles.sendBtnActive : styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!hasInput || sending || isWaitingForReply}
          >
            {sending ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <Send size={16} color={hasInput ? '#FFFFFF' : color.faint} />
            )}
          </Pressable>
        </Animated.View>
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
              reload();
            } else {
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

      {/* Thread safety / overflow controls */}
      <ThreadSafetySheet
        visible={showSafetySheet}
        onClose={() => setShowSafetySheet(false)}
        threadType={(threadType as 'direct' | 'trip' | 'circle') ?? 'direct'}
        otherUserId={otherUserId}
        isMuted={threadIsMuted}
        onToggleMute={async () => {
          const next = !threadIsMuted;
          await muteThread(id ?? '', next);
          setThreadIsMuted(next);
        }}
        hideAiSuggestions={hideAiSuggestions}
        onToggleHideAi={toggleHideAiSuggestions}
        onBlock={isDirect && otherUserId ? async () => {
          setShowSafetySheet(false);
          setBlockingUser(true);
          await blockUser(otherUserId);
          setBlockingUser(false);
          router.replace('/messages');
        } : undefined}
        onLeave={!isDirect ? async () => {
          await clearTelegraphSuggestionsCache(id ?? '');
          await leaveThread(id ?? '');
          router.replace('/messages');
        } : undefined}
        onDeleteForMe={isDirect ? async () => {
          // Direct threads only: leaving a DM removes it from your inbox
          // without affecting the other person. Group threads already have
          // "Leave group" — a second identical destructive item was misleading.
          await clearTelegraphSuggestionsCache(id ?? '');
          await leaveThread(id ?? '');
          router.replace('/messages');
        } : undefined}
        onReport={async (reason: string) => {
          await reportThread(id ?? '', reason);
        }}
      />

      {/* Long-press action sheet */}
      <LongPressActionSheet
        message={actionMsg}
        mine={actionMsgMine}
        threadId={id ?? undefined}
        onClose={() => setActionMsg(null)}
        onDeleteForMe={handleDeleteForMe}
        onReply={(msg) => { setReplyingTo(msg); setActionMsg(null); }}
        onSave={(msg) => {
          if (!id) return;
          saveMessage(id, msg.id).then((r) => {
            if (r.ok) Alert.alert('Saved', 'Message saved to your collection.');
            else Alert.alert('Error', r.message ?? 'Could not save message.');
          });
        }}
      />

      {/* Per-thread translation settings */}
      <TranslationSettingsSheet
        visible={showTranslationSheet}
        autoTranslate={autoTranslate}
        showOriginalFirst={defaultShowOriginal}
        onChangeAutoTranslate={(v) => {
          setThreadAutoTranslate(v);
          saveThreadTranslationPrefs(v, threadShowOriginal ?? langSettings?.show_original_messages ?? false);
        }}
        onChangeShowOriginalFirst={(v) => {
          setThreadShowOriginal(v);
          saveThreadTranslationPrefs(threadAutoTranslate ?? langSettings?.auto_translate_messages ?? true, v);
        }}
        onClose={() => setShowTranslationSheet(false)}
      />

      {/* Ask Compass recommendation tray */}
      {id && (
        <CompassTelegraphTray
          visible={showCompassTray}
          threadId={id}
          onDismiss={() => setShowCompassTray(false)}
          onShareCard={async (card: CompassTelegraphCard) => {
            setShowCompassTray(false);
            if (!id) return;
            const payload = JSON.stringify({
              type:        'compass_card',
              id:          card.id,
              cardType:    card.type,
              title:       card.title,
              city:        card.city,
              category:    card.category,
              description: card.description,
              imageUrl:    card.imageUrl,
            });
            await sendMessage(id, payload, { msgType: 'system', subtype: 'compass_card' });
            reload();
          }}
        />
      )}
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: TG.surface },
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

  bubble: { borderRadius: TG_SPACING.bubbleRadius, paddingHorizontal: 13, paddingTop: 8, paddingBottom: 6 },
  bubbleOther: {
    backgroundColor: TG.recvBubble,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderBottomLeftRadius: TG_SPACING.bubbleTail,
  },
  bubbleMine: { backgroundColor: TG.sentBubble, borderBottomRightRadius: TG_SPACING.bubbleTail },
  // Middle-of-group bubbles keep fully rounded corners (no tail)
  bubbleOtherMid: { borderBottomLeftRadius: TG_SPACING.bubbleRadius },
  bubbleMineMid: { borderBottomRightRadius: TG_SPACING.bubbleRadius },

  bubbleText: { ...t.body, color: TG.recvText, lineHeight: 21, flexShrink: 1, flexWrap: 'wrap' },
  bubbleTextMine: { color: TG.sentText },

  bubbleTime: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.faint,
    fontSize: 10,
    marginTop: 2,
    textAlign: 'right',
  },
  bubbleTimeMine: { color: TG.sentTextMute },

  transPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: TG.chipFill,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  transPillMine: { backgroundColor: 'rgba(255,255,255,0.14)' },

  jumpFab: {
    position: 'absolute',
    right: space.lg,
    bottom: 130,
    width: avatar.s40, height: avatar.s40,
    borderRadius: avatar.s40 / 2,
    backgroundColor: TG.surfaceRaised,
    borderWidth: 1,
    borderColor: TG.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#11110F',
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },

  translationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },

  translationFlash: {
    borderRadius: radius.lg,
    backgroundColor: color.signal + '28',
  },

  transLabel: {
    fontSize: 10,
    color: color.mute,
    fontFamily: 'Courier',
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  transLabelMine: { color: 'rgba(255,255,255,0.75)' },

  transToggle: {
    fontSize: 10,
    color: color.signal,
    fontFamily: 'Courier',
    textDecorationLine: 'underline',
  },
  transToggleMine: { color: color.onInk + 'CC' },
  transRetryRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  transRetry: { fontSize: 11, color: color.signal, textDecorationLine: 'underline' },

  transUnavailable: {
    fontSize: 10,
    color: color.mute,
    fontFamily: 'Courier',
    fontStyle: 'italic',
    letterSpacing: 0.2,
    marginTop: 4,
  },

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
  // DM avatar in header
  dmAvatarWrap: { flexShrink: 0 },

  // Header right-side action row
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
  headerIconBtn: { padding: 5 },

  // Quick-action bar (trip/circle)
  quickBar: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze, backgroundColor: color.paperRaised },
  quickBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal + '55', backgroundColor: color.signal + '0A' },
  quickBtnText: { ...t.small, color: color.signal, fontSize: 11, fontWeight: '600' },

  // Read receipt
  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  readerAvatarRow: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  receiptSent: { fontSize: 10, color: color.signal, fontFamily: 'Courier' },
  receiptFailRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  receiptFail: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier' },

  deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  deliverySending: { fontSize: 10, color: color.mute, fontFamily: 'Courier' },
  deliverySent: { fontSize: 10, color: color.signal, fontFamily: 'Courier' },
  deliveryFailed: { fontSize: 10, color: '#EF4444', fontFamily: 'Courier', fontWeight: '600' },

  typingRow: {
    paddingHorizontal: space.lg,
    paddingVertical: 5,
    backgroundColor: color.paper,
  },
  typingText: { ...t.small, color: color.mute, fontSize: 11, fontStyle: 'italic' },

  // Composer icon buttons (attach, meetup, discovery, ai)
  composeIconBtn: { width: 32, height: 38, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

  // Waiting-for-reply banner above the composer
  waitingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    backgroundColor: '#FFFBEB',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#FDE68A',
  },
  waitingBannerText: { ...t.small, color: '#92400E', flex: 1, fontSize: 11 },

  // Failed-send banner above the composer
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
  failedRetryBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: '#FECACA' },
  failedRetryText: { ...t.stamp, color: '#EF4444', fontSize: 10, fontWeight: '600' },

  sendBtn: { width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2, alignItems: 'center', justifyContent: 'center' },
  sendBtnActive: { backgroundColor: TG.sentBubble },
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
    width: icon.s22, height: icon.s22,
    borderRadius: icon.s22 / 2,
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
