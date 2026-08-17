import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Image, Pressable, StyleSheet,
  ScrollView, TextInput, ActivityIndicator, Alert, Modal,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { router, useFocusEffect } from 'expo-router';
import { Zap, Users, Globe, BellOff, Search, MessageCirclePlus, Compass, Bot, ShieldOff, Flag, UserCheck, UserMinus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMyThreads, useIncomingMessageRequests } from '../hooks/useMessaging.ts';
import { useSession } from '../context/SessionContext.tsx';
import { blockUser, getBlockList } from '../services/blocks.ts';
import { reportContent, type ReportReason } from '../services/reports.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import { TG, TG_AVATAR } from '../theme/telegraphTokens.ts';
import { TelegraphAvatar, TelegraphRow } from './telegraph/TelegraphPrimitives.tsx';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { useBottomInset } from '../hooks/useBottomInset.ts';
import { useScreenTiming } from '../hooks/useScreenTiming.ts';
import type { ThreadSummary, MessageRequest } from '../services/messaging.ts';
import { circleCardInboxPreview } from './CircleStatusCardMessage.logic';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity.ts';
import { UserIdentityLink } from './interaction/UserIdentityLink.tsx';
import { errorCopy } from '../lib/errorCopy.ts';

type FilterKey = 'all' | 'direct' | 'trips' | 'circles' | 'unread' | 'requests';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'direct', label: 'Direct' },
  { key: 'trips', label: 'Trips' },
  { key: 'circles', label: 'Circles' },
  { key: 'unread', label: 'Unread' },
  { key: 'requests', label: 'Requests' },
];

/** Human-readable labels for system message types whose `body` is raw JSON. */
const SYSTEM_MESSAGE_LABELS: Record<string, string> = {
  post_card: 'Shared a post',
  discovery_card: 'Shared a place',
  compass_card: 'Shared a Compass result',
  meetup: 'Created a meetup',
  meetup_confirmed: 'Meetup confirmed',
  ai_recommendation: 'AI suggestion',
};

/**
 * Resolves the inbox row preview text for a thread's last message. System
 * message types (post_card, discovery_card, compass_card, meetup,
 * meetup_confirmed, ai_recommendation, circle_status_card) carry a
 * structured JSON `body` — showing it raw leaks `{"postId":"..."}` into the
 * conversation list, so each gets a short human-readable label instead.
 */
function systemMessageInboxPreview(
  lmp: NonNullable<ThreadSummary['lastMessagePreview']>,
  isMine: boolean,
): string {
  // Shared cards are stored with msgType 'system' and the real card kind in
  // `subtype` (e.g. post_card, discovery_card, meetup). A few older/simple
  // system messages key off msgType directly (circle_status_card,
  // ai_recommendation), so check subtype first, then fall back to msgType.
  const kind = lmp.subtype ?? lmp.msgType;
  if (kind === 'circle_status_card') {
    return circleCardInboxPreview(lmp.body);
  }
  const label = kind ? SYSTEM_MESSAGE_LABELS[kind] : undefined;
  if (label) {
    return isMine ? `You: ${label}` : label;
  }
  return isMine ? lmp.body : (lmp.displayBody ?? lmp.body);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function navigateToThread(item: ThreadSummary) {
  const isRentBuddy = item.threadType === 'rent_buddy_booking';
  const otherForTitle = item.otherMembers[0];
  const title = item.threadType === 'direct' || isRentBuddy
    ? (otherForTitle
        ? primaryIdentityText({ name: otherForTitle.name, handle: otherForTitle.handle })
        : (isRentBuddy ? 'Buddy Booking' : ''))
    : (item.title ?? '');
  const params = new URLSearchParams({ title, threadType: item.threadType });
  if (item.tripId) params.set('contextId', item.tripId);
  else if (item.circleOwnerId) params.set('contextId', item.circleOwnerId);
  else if (isRentBuddy && (item as any).bookingId) params.set('contextId', (item as any).bookingId);
  if ((item.threadType === 'direct' || isRentBuddy) && item.otherMembers[0]?.id) {
    params.set('otherUserId', item.otherMembers[0].id);
  }
  router.push(`/messages/${item.id}?${params.toString()}`);
}

const TYPE_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  direct:              { bg: '#E6EEF8', text: '#2B5EA7', label: 'Direct' },
  trip:                { bg: '#E0EFEC', text: '#0A3D4A', label: 'Trip' },
  circle:              { bg: '#F2EBE0', text: '#7A4C20', label: 'Circle' },
  rent_buddy_booking:  { bg: '#F0EBF9', text: '#6B21A8', label: 'Buddy' },
};

function TypeBadge({ threadType }: { threadType: string }) {
  const cfg = TYPE_BADGE[threadType];
  if (!cfg) return null;
  return (
    <View style={[s.typeBadge, { backgroundColor: cfg.bg }]}>
      <Text style={[s.typeBadgeText, { color: cfg.text }]}>{cfg.label}</Text>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={s.row}>
      <View style={s.avatarSkeleton} />
      <View style={{ flex: 1, gap: 7 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <View style={{ height: 13, width: '50%', backgroundColor: color.haze, borderRadius: 6 }} />
          <View style={{ height: 13, width: 44, backgroundColor: color.haze, borderRadius: 6 }} />
        </View>
        <View style={{ height: 11, width: '78%', backgroundColor: color.haze, borderRadius: 6 }} />
      </View>
    </View>
  );
}

function DmThreadAvatar({ item, currentUserId }: { item: ThreadSummary; currentUserId: string | null }) {
  const other = item.otherMembers[0];
  const ringState = useHighlightRingState(other?.id ?? null);
  const [viewerOpen, setViewerOpen] = useState(false);

  const inner = (
    <Avatar
      uri={other?.avatarUrl}
      name={primaryIdentityText({ name: other?.name, handle: other?.handle }).replace(/^@/, '')}
      size={48}
      style={s.avatarBox}
    />
  );

  if (!ringState?.hasActive) return inner;

  return (
    <>
      <HighlightRing size={48} hasActive allViewed={ringState.allViewed} onPress={() => setViewerOpen(true)}>
        {inner}
      </HighlightRing>
      <HighlightViewer
        visible={viewerOpen}
        highlights={ringState.highlights}
        currentUserId={currentUserId ?? undefined}
        onClose={() => setViewerOpen(false)}
      />
    </>
  );
}

function ThreadAvatarIcon({ item, currentUserId }: { item: ThreadSummary; currentUserId: string | null }) {
  if (item.threadType === 'trip') return <TelegraphAvatar kind="trip" size={TG_AVATAR.row} />;
  if (item.threadType === 'circle') return <TelegraphAvatar kind="circle" size={TG_AVATAR.row} />;
  return <DmThreadAvatar item={item} currentUserId={currentUserId} />;
}

function ThreadRow({ item, userId }: { item: ThreadSummary; userId: string | null }) {
  const isGroup = item.threadType !== 'direct';
  const otherMember = item.otherMembers[0];
  const displayName = isGroup
    ? (item.title ?? (item.threadType === 'trip' ? 'Trip Chat' : 'Circle Chat'))
    : (otherMember ? primaryIdentityText({ name: otherMember.name, handle: otherMember.handle }) : 'Unknown');

  const lmp = item.lastMessagePreview;
  const isMine = lmp?.senderId === userId;
  const previewText = lmp ? systemMessageInboxPreview(lmp, isMine) : '';
  const lastAt = lmp?.createdAt;
  const isMuted = !!item.mutedAt;
  const unread = item.unreadCount ?? 0;
  const isAi = item.isAiLastMessage ?? (lmp?.msgType === 'ai_recommendation');

  return (
    <TelegraphRow
      avatar={<ThreadAvatarIcon item={item} currentUserId={userId} />}
      onPress={() => navigateToThread(item)}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <View style={s.nameRow}>
          <View style={s.nameLeft}>
            <Text style={[s.name, unread > 0 && s.nameBold]} numberOfLines={1}>{displayName}</Text>
            {isMuted && <BellOff size={12} color={color.faint} style={{ marginLeft: 4 }} />}
            <TypeBadge threadType={item.threadType} />
          </View>
          <View style={s.nameMeta}>
            {unread > 0 && (
              <View style={s.unreadBubble}>
                <Text style={s.unreadText}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            )}
            {lastAt ? <Text style={s.time}>{timeAgo(lastAt)}</Text> : null}
          </View>
        </View>

        {previewText ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {isAi && (
              <View style={s.aiBadge}>
                <Bot size={9} color={color.onInk} />
                <Text style={s.aiBadgeText}>AI</Text>
              </View>
            )}
            <Text
              style={[s.preview, unread > 0 && s.previewBold]}
              numberOfLines={1}
            >
              {previewText}
            </Text>
          </View>
        ) : null}

        {item.tripCity ? (
          <View style={s.cityTag}>
            <Text style={s.cityTagText}>{item.tripCity}</Text>
          </View>
        ) : null}
      </View>
    </TelegraphRow>
  );
}

/** Slim uppercase divider label between inbox sections (DMs / group threads). */
function SectionDivider({ label }: { label: string }) {
  return (
    <View style={s.sectionDivider}>
      <Text style={s.sectionDividerText}>{label}</Text>
      <View style={s.sectionDividerLine} />
    </View>
  );
}

// ── Inbox list assembly (visual sectioning only) ─────────────────────────────

type InboxItem =
  | { _t: 'thread'; thread: ThreadSummary }
  | { _t: 'divider'; key: string; label: string }
  | { _t: 'requests'; key: string; count: number };

/**
 * Splits threads into DMs first, then group threads (trips/circles), with a
 * divider between the sections, and appends a pending-requests row at the
 * bottom. Only applies sectioning in the 'all' filter; other filters keep the
 * original flat ordering.
 */
function buildInboxItems(
  threads: ThreadSummary[],
  filter: FilterKey,
  requestCount: number,
): InboxItem[] {
  if (filter !== 'all') {
    return threads.map((thread) => ({ _t: 'thread', thread }));
  }
  const dms = threads.filter((th) => th.threadType === 'direct' || th.threadType === 'rent_buddy_booking');
  const groups = threads.filter((th) => th.threadType !== 'direct' && th.threadType !== 'rent_buddy_booking');
  const items: InboxItem[] = dms.map((thread) => ({ _t: 'thread', thread }));
  if (groups.length > 0) {
    if (dms.length > 0) items.push({ _t: 'divider', key: 'div-groups', label: 'Trips & Circles' });
    items.push(...groups.map((thread) => ({ _t: 'thread', thread } as InboxItem)));
  }
  if (requestCount > 0) {
    items.push({ _t: 'divider', key: 'div-requests', label: 'Requests' });
    items.push({ _t: 'requests', key: 'requests-row', count: requestCount });
  }
  return items;
}

const FILTER_EMPTY: Record<FilterKey, string> = {
  all:      'Your Telegraph is quiet.',
  direct:   'No direct conversations yet.',
  trips:    'No trip chats yet.',
  circles:  'No circle chats yet.',
  unread:   "You're all caught up.",
  requests: 'No pending requests.',
};

function EmptyState({ filter }: { filter: FilterKey }) {
  return (
    <View style={s.emptyWrap}>
      <View style={s.emptyIcon}>
        <Zap size={28} color={color.signal} />
      </View>
      <Text style={s.emptyTitle}>{FILTER_EMPTY[filter]}</Text>
      <Text style={s.emptyBody}>
        Start a conversation, join a trip, or share a Discovery card.
      </Text>
      <View style={s.emptyActions}>
        <Pressable style={s.emptyBtn} onPress={() => router.push('/discover' as any)}>
          <Compass size={15} color={color.signal} />
          <Text style={s.emptyBtnText}>Find people</Text>
        </Pressable>
        <Pressable style={s.emptyBtn} onPress={() => router.push('/(tabs)/discovery' as any)}>
          <Globe size={15} color={color.signal} />
          <Text style={s.emptyBtnText}>Explore Discovery</Text>
        </Pressable>
        <Pressable style={s.emptyBtn} onPress={() => router.push('/discover' as any)}>
          <MessageCirclePlus size={15} color={color.signal} />
          <Text style={s.emptyBtnText}>Start Telegraph</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface Props {
  topInset?: number;
}

export function TelegraphInboxScreen({ topInset = 0 }: Props) {
  const insets = useSafeAreaInsets();
  const bottomInset = useBottomInset();
  const { isAuthed, userId } = useSession();
  const { data: threads, loading, refreshing, error, reload, refresh } = useMyThreads();
  const { markFirstContent, epoch } = useScreenTiming('Telegraph');
  const {
    data: requests,
    loading: reqLoading,
    reload: reloadRequests,
    accept: acceptRequest,
    decline: declineRequest,
  } = useIncomingMessageRequests();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const { blockerIds } = useBlockedIds();

  const loadBlockList = useCallback(async () => {
    const res = await getBlockList();
    if (res.ok && res.data) {
      setBlockedIds(new Set(res.data.map((u) => u.id)));
    }
  }, []);

  useEffect(() => { void loadBlockList(); }, [loadBlockList]);

  const filteredRequests = requests.filter((r) => {
    const sid = r.sender?.id;
    if (!sid) return true;
    return !blockedIds.has(sid) && !blockerIds.has(sid);
  });
  const requestCount = filteredRequests.length;

  useFocusEffect(useCallback(() => {
    reload();
    reloadRequests();
    void loadBlockList();
  }, [reload, reloadRequests, loadBlockList]));

  // Perf timing: fire on every focus cycle when threads are loaded.
  // epoch increments on each focus so warm opens fire even without data changes.
  useEffect(() => {
    if (threads.length > 0) markFirstContent();
  }, [epoch, threads.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = threads.filter((th) => {
    // Hide direct threads where the other member is blocked (either direction).
    if (th.threadType === 'direct' || th.threadType === 'rent_buddy_booking') {
      const otherId = th.otherMembers[0]?.id;
      if (otherId && (blockedIds.has(otherId) || blockerIds.has(otherId))) return false;
    }
    if (filter === 'direct' && th.threadType !== 'direct' && th.threadType !== 'rent_buddy_booking') return false;
    if (filter === 'trips' && th.threadType !== 'trip') return false;
    if (filter === 'circles' && th.threadType !== 'circle') return false;
    if (filter === 'unread' && !(th.unreadCount && th.unreadCount > 0)) return false;
    if (filter === 'requests') return false;
    if (search) {
      const q = search.toLowerCase();
      const name = th.threadType !== 'direct'
        ? (th.title ?? '').toLowerCase()
        : (th.otherMembers[0]
            ? primaryIdentityText({ name: th.otherMembers[0].name, handle: th.otherMembers[0].handle }).toLowerCase()
            : '');
      const body = (th.lastMessagePreview?.body ?? '').toLowerCase();
      const displayBody = (th.lastMessagePreview?.displayBody ?? '').toLowerCase();
      if (!name.includes(q) && !body.includes(q) && !displayBody.includes(q)) return false;
    }
    return true;
  });

  const pt = Math.max(insets.top, topInset);

  // Header, search bar, and filter chips — used as ListHeaderComponent so they
  // scroll with the list content rather than staying fixed above it.
  const listHeader = (
    <View style={{ paddingTop: pt }}>
      <View style={s.header}>
        <View style={s.brandRow}>
          <View style={s.brandIcon}>
            <Zap size={14} color={color.onInk} fill={color.onInk} />
          </View>
          <Text style={s.brandName}>Telegraph</Text>
        </View>
      </View>

      {isAuthed && (
        <>
          <View style={s.searchWrap}>
            <Search size={16} color={color.faint} style={s.searchIcon} />
            <TextInput
              style={s.searchInput}
              placeholder="Search Telegraph…"
              placeholderTextColor={color.faint}
              value={search}
              onChangeText={setSearch}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.chipsRow}
            style={s.chipsScroll}
          >
            {FILTERS.map((f) => {
              const active = filter === f.key;
              const badge = f.key === 'requests' && requestCount > 0 ? requestCount : 0;
              return (
                <Pressable
                  key={f.key}
                  style={[s.chip, active && s.chipActive]}
                  onPress={() => setFilter(f.key)}
                >
                  <Text style={[s.chipText, active && s.chipTextActive]}>{f.label}</Text>
                  {badge > 0 && (
                    <View style={s.chipBadge}>
                      <Text style={s.chipBadgeText}>{badge > 99 ? '99+' : badge}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}
    </View>
  );

  // Not signed in — single FlatList with header + sign-in message
  if (!isAuthed) {
    return (
      <KeyboardSafeScrollView style={{ backgroundColor: TG.surface }}>
        <FlatList
          data={[]}
          keyExtractor={() => ''}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={s.emptyBody}>Sign in to view your messages.</Text>
            </View>
          }
          contentContainerStyle={{ paddingBottom: bottomInset }}
          renderItem={() => null}
        />
      </KeyboardSafeScrollView>
    );
  }

  // Requests pane — its own FlatList with the shared header
  if (filter === 'requests') {
    return (
      <KeyboardSafeScrollView style={{ backgroundColor: TG.surface }}>
        <RequestsPane
          requests={filteredRequests}
          loading={reqLoading}
          onAccept={acceptRequest}
          onDecline={declineRequest}
          listHeader={listHeader}
          bottomInset={bottomInset}
        />
      </KeyboardSafeScrollView>
    );
  }

  // Loading / error / empty / thread list — single FlatList
  return (
    <KeyboardSafeScrollView style={{ backgroundColor: TG.surface }}>
      <FlatList
        data={
          error || (loading && !refreshing) || filtered.length === 0
            ? []
            : buildInboxItems(filtered, filter, requestCount)
        }
        keyExtractor={(item) => item._t === 'thread' ? item.thread.id : item.key}
        ListHeaderComponent={listHeader}
        onRefresh={refresh}
        refreshing={refreshing}
        ListEmptyComponent={
          error ? (
            <View style={s.center}>
              <Text style={[s.emptyBody, { color: '#B33' }]}>{error}</Text>
            </View>
          ) : loading ? (
            <View style={{ paddingTop: space.sm }}>
              {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
            </View>
          ) : (
            <EmptyState filter={filter} />
          )
        }
        contentContainerStyle={{ paddingBottom: bottomInset }}
        renderItem={({ item }) => {
          if (item._t === 'divider') return <SectionDivider label={item.label} />;
          if (item._t === 'requests') {
            return (
              <TelegraphRow
                avatar={
                  <View style={s.requestsRowIcon}>
                    <UserCheck size={20} color={color.signal} />
                  </View>
                }
                onPress={() => setFilter('requests')}
              >
                <View style={s.nameRow}>
                  <Text style={[s.name, s.nameBold]}>Message requests</Text>
                  <View style={s.unreadBubble}>
                    <Text style={s.unreadText}>{item.count > 99 ? '99+' : item.count}</Text>
                  </View>
                </View>
                <Text style={s.preview} numberOfLines={1}>
                  People you haven't chatted with yet
                </Text>
              </TelegraphRow>
            );
          }
          return <ThreadRow item={item.thread} userId={userId} />;
        }}
      />
    </KeyboardSafeScrollView>
  );
}

// ── Request card ──────────────────────────────────────────────────────────────

function RequestCard({
  request,
  onAccept,
  onDecline,
}: {
  request: MessageRequest;
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [showReportNote, setShowReportNote] = useState(false);
  const [reportNote, setReportNote] = useState('');
  const [reportSending, setReportSending] = useState(false);
  const busy = accepting || declining || blocking;

  async function handleAccept() {
    setAccepting(true);
    await onAccept();
    setAccepting(false);
  }

  async function handleDecline() {
    setDeclining(true);
    await onDecline();
    setDeclining(false);
  }

  async function handleBlock() {
    if (!request.sender?.id) return;
    Alert.alert(
      'Block this person?',
      `${request.sender.name ? primaryIdentityText({ name: request.sender.name, handle: request.sender.handle }) : 'This person'} won't be able to message you or see your profile.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setBlocking(true);
            await blockUser(request.sender!.id);
            await onDecline(); // remove from list after block
            setBlocking(false);
          },
        },
      ],
    );
  }

  async function submitReport(reason: ReportReason, detail?: string) {
    if (!request.sender?.id) return;
    const trimmed = detail?.trim() ?? '';
    setReportSending(true);
    const res = await reportContent({
      target_type: 'user',
      target_id: request.sender.id,
      reason_code: reason,
      ...(trimmed ? { reason_detail: trimmed } : {}),
    }).catch(() => ({ ok: false as const, error: undefined as string | undefined }));
    setReportSending(false);
    if (res.ok) {
      setShowReportNote(false);
      setReportNote('');
      Alert.alert('Report submitted', 'Thank you — our team will review this request.');
    } else {
      Alert.alert('Error', errorCopy(res.error, 'Could not submit report'));
    }
  }

  function handleReport() {
    if (!request.sender?.id) return;
    Alert.alert('Report this person', 'Why are you reporting this request?', [
      { text: 'Spam', onPress: () => void submitReport('spam') },
      { text: 'Harassment', onPress: () => void submitReport('harassment') },
      { text: 'Something else', onPress: () => { setReportNote(''); setShowReportNote(true); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const { sender, previewText, createdAt } = request;
  const senderName = primaryIdentityText({ name: sender?.name, handle: sender?.handle });
  const senderHandleSub = secondaryIdentityText({ name: sender?.name, handle: sender?.handle });
  const initial = (senderName.replace(/^@/, '')[0] ?? '?').toUpperCase();

  return (
    <View style={rc.card}>
      {/* Header: avatar + name + time — sender identity is tappable */}
      <View style={rc.headerRow}>
        <UserIdentityLink
          userId={sender?.id ?? ''}
          handle={sender?.handle ?? null}
          testID={`request-sender-identity-${sender?.id ?? 'unknown'}`}
        >
          <Avatar
            uri={sender?.avatarUrl}
            name={primaryIdentityText({ name: sender?.name, handle: sender?.handle }).replace(/^@/, '')}
            size={52}
            style={rc.avatarBox}
          />
        </UserIdentityLink>
        <UserIdentityLink
          userId={sender?.id ?? ''}
          handle={sender?.handle ?? null}
        >
          <View style={{ flex: 1 }}>
            <Text style={rc.name} numberOfLines={1}>{senderName}</Text>
            {senderHandleSub ? (
              <Text style={rc.handle}>{senderHandleSub}</Text>
            ) : null}
          </View>
        </UserIdentityLink>
        <Text style={rc.time}>{timeAgo(createdAt)}</Text>
      </View>

      {/* City / language metadata */}
      {(sender?.city || sender?.language) ? (
        <View style={rc.metaRow}>
          {sender.city ? <Text style={rc.metaChip}>{sender.city}</Text> : null}
          {sender.language ? <Text style={rc.metaChip}>{sender.language.toUpperCase()}</Text> : null}
        </View>
      ) : null}

      {/* Message preview */}
      {previewText ? (
        <Text style={rc.preview} numberOfLines={3}>{previewText}</Text>
      ) : (
        <Text style={rc.previewEmpty}>No preview available.</Text>
      )}

      {/* Primary actions: Accept + Decline */}
      <View style={rc.primaryRow}>
        <Pressable
          style={[rc.btn, rc.btnAccept, busy && { opacity: 0.55 }]}
          onPress={handleAccept}
          disabled={busy}
        >
          {accepting
            ? <ActivityIndicator size="small" color={color.onInk} style={{ marginRight: 4 }} />
            : <UserCheck size={14} color={color.onInk} />
          }
          <Text style={rc.btnAcceptText}>Accept</Text>
        </Pressable>
        <Pressable
          style={[rc.btn, rc.btnDecline, busy && { opacity: 0.55 }]}
          onPress={handleDecline}
          disabled={busy}
        >
          {declining
            ? <ActivityIndicator size="small" color={color.mute} style={{ marginRight: 4 }} />
            : <UserMinus size={14} color={color.mute} />
          }
          <Text style={rc.btnDeclineText}>Decline</Text>
        </Pressable>
      </View>

      {/* Secondary actions: Block + Report */}
      <View style={rc.secondaryRow}>
        <Pressable style={rc.secondaryBtn} onPress={handleBlock} disabled={busy}>
          <ShieldOff size={13} color={color.faint} />
          <Text style={rc.secondaryBtnText}>Block</Text>
        </Pressable>
        <Text style={rc.secondarySep}>·</Text>
        <Pressable style={rc.secondaryBtn} onPress={handleReport} disabled={busy}>
          <Flag size={13} color={color.faint} />
          <Text style={rc.secondaryBtnText}>Report</Text>
        </Pressable>
      </View>

      {/* Optional note sheet for "Something else" reports */}
      {showReportNote && (
        <Modal visible animationType="slide" transparent onRequestClose={() => setShowReportNote(false)}>
          <Pressable style={rc.reportOverlay} onPress={() => setShowReportNote(false)} />
          <View style={rc.reportSheet}>
            <View style={rc.reportHandle} />
            <Text style={rc.reportTitle}>Report this person</Text>
            <Text style={rc.reportSub}>Add a note so our team has more context.</Text>
            <TextInput
              style={rc.reportDetailInput}
              value={reportNote}
              onChangeText={setReportNote}
              placeholder="Tell us more (optional)"
              placeholderTextColor={color.mute}
              multiline
              maxLength={500}
            />
            <Pressable
              style={[rc.reportBtn, reportSending && rc.reportBtnDisabled]}
              onPress={() => void submitReport('other', reportNote)}
              disabled={reportSending}
            >
              {reportSending
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={rc.reportBtnLabel}>Submit Report</Text>}
            </Pressable>
            <Pressable style={rc.reportBackBtn} onPress={() => setShowReportNote(false)}>
              <Text style={rc.reportBackLabel}>Cancel</Text>
            </Pressable>
          </View>
        </Modal>
      )}
    </View>
  );
}

const rc = StyleSheet.create({
  reportOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  reportSheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 34,
    paddingTop: space.sm,
  },
  reportHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  reportTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15, marginBottom: 2 },
  reportSub: { ...t.small, color: color.mute, marginBottom: space.md },
  reportDetailInput: { ...t.body, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: 10, minHeight: 64, textAlignVertical: 'top', marginTop: 2 },
  reportBtn: { marginTop: space.md, backgroundColor: '#EF4444', borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  reportBtnDisabled: { opacity: 0.45 },
  reportBtnLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  reportBackBtn: { paddingVertical: 10, alignItems: 'center' },
  reportBackLabel: { ...t.body, color: color.mute },
  card: {
    marginHorizontal: space.xl,
    marginTop: space.md,
    padding: space.lg,
    backgroundColor: TG.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // Sizing/shape come from <Avatar size>; this carries layout only.
  avatarBox: { flexShrink: 0 },
  safetyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.xl,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: TG.chipFill,
    borderRadius: radius.md,
  },
  safetyText: { ...t.small, color: color.mute, fontSize: 11, flex: 1, lineHeight: 15 },
  name: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  handle: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  time: { ...t.small, color: color.faint, fontSize: 11 },
  metaRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  metaChip: {
    fontSize: 11,
    fontWeight: '600',
    color: color.deep,
    backgroundColor: '#E0EFEC',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  preview: { ...t.body, color: color.mute, lineHeight: 19, fontSize: 13 },
  previewEmpty: { ...t.small, color: color.faint, fontStyle: 'italic', fontSize: 12 },
  primaryRow: { flexDirection: 'row', gap: space.sm, marginTop: 2 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  btnAccept: { backgroundColor: color.signal, borderColor: color.signal },
  btnAcceptText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700', fontSize: 13 },
  btnDecline: { backgroundColor: color.paper, borderColor: color.haze },
  btnDeclineText: { ...t.body, color: color.mute, fontWeight: '600', fontSize: 13 },
  secondaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondarySep: { color: color.faint, fontSize: 13 },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
  secondaryBtnText: { ...t.small, color: color.faint, fontSize: 12 },
});

// ── Requests pane ─────────────────────────────────────────────────────────────

function RequestsPane({
  requests,
  loading,
  onAccept,
  onDecline,
  listHeader,
  bottomInset,
}: {
  requests: MessageRequest[];
  loading: boolean;
  onAccept: (requestId: string) => Promise<{ ok: boolean; data: { status: string; threadId: string } | null }>;
  onDecline: (requestId: string) => Promise<{ ok: boolean; data: { status: string } | null }>;
  listHeader?: React.ReactElement;
  bottomInset: number;
}) {
  // Dedup by requestId in case the API returns duplicates
  const seen = new Set<string>();
  const uniqueRequests = loading ? [] : requests.filter((r) => {
    if (seen.has(r.requestId)) return false;
    seen.add(r.requestId);
    return true;
  });

  return (
    <FlatList
      data={uniqueRequests}
      keyExtractor={(item) => item.requestId}
      contentContainerStyle={{ paddingBottom: bottomInset }}
      ListHeaderComponent={
        <>
          {listHeader}
          <View style={rc.safetyBar}>
            <ShieldOff size={13} color={color.mute} />
            <Text style={rc.safetyText}>
              These people aren't in your circles yet. They won't know you've seen their request until you accept.
            </Text>
          </View>
        </>
      }
      ListEmptyComponent={
        loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <View style={s.center}>
            <Text style={s.emptyTitle}>No pending requests</Text>
            <Text style={s.emptyBody}>
              Message requests from people you don't know yet will appear here.
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <RequestCard
          request={item}
          onAccept={async () => {
            const res = await onAccept(item.requestId);
            if (res.ok && res.data?.threadId) {
              const name = item.sender ? primaryIdentityText({ name: item.sender.name, handle: item.sender.handle }) : 'Chat';
              const params = new URLSearchParams({
                title: name,
                threadType: 'direct',
              });
              if (item.sender?.id) params.set('otherUserId', item.sender.id);
              router.push(`/messages/${res.data.threadId}?${params.toString()}`);
            }
          }}
          onDecline={async () => { await onDecline(item.requestId); }}
        />
      )}
    />
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },

  header: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  brandIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: { fontSize: 22, fontWeight: '800', color: color.ink, letterSpacing: -0.5 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.xl,
    marginVertical: space.sm,
    backgroundColor: TG.surfaceRaised,
    borderWidth: 1,
    borderColor: TG.hairline,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    height: 40,
  },
  searchIcon: { marginRight: space.sm },
  searchInput: {
    flex: 1,
    height: 40,
    ...t.body,
    color: color.ink,
  },

  chipsScroll: { flexGrow: 0, marginBottom: space.sm },
  chipsRow: { paddingHorizontal: space.xl, gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: color.haze,
  },
  chipActive: { backgroundColor: color.ink },
  chipText: { ...t.small, color: color.mute, fontWeight: '500' },
  chipTextActive: { color: color.onInk },
  chipBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  chipBadgeText: { fontSize: 10, fontWeight: '700', color: color.onInk },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  rowPressed: { opacity: 0.6 },

  // Sizing/shape come from <Avatar size>; this carries layout only.
  avatarBox: { flexShrink: 0 },
  // The loading skeleton has no Avatar to size it, so it keeps its own.
  avatarSkeleton: { width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2, backgroundColor: color.haze, flexShrink: 0 },
  groupAvatar: { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },

  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  nameLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 5, flexShrink: 1 },
  nameMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  name: { ...t.bodyStrong, color: color.ink, flexShrink: 1, fontWeight: '600' },
  nameBold: { fontWeight: '700' },
  time: { ...t.small, color: color.faint, fontSize: 11 },

  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  typeBadgeText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2 },

  unreadBubble: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  unreadText: { fontSize: 10, fontWeight: '700', color: color.onInk },

  preview: { ...t.small, color: color.mute, flex: 1 },
  previewBold: { color: color.ink, fontWeight: '600' },

  aiBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: color.signal,
  },
  aiBadgeText: { fontSize: 9, fontWeight: '700', color: color.onInk, letterSpacing: 0.3 },

  cityTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#E0EFEC',
    marginTop: 1,
  },
  cityTagText: { fontSize: 10, color: color.deep, fontWeight: '500' },

  sep: { height: 1, backgroundColor: color.haze, marginHorizontal: space.xl, opacity: 0.5 },

  sectionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: 4,
  },
  sectionDividerText: {
    fontSize: 10,
    fontFamily: 'Courier',
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: color.faint,
  },
  sectionDividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: TG.hairline },

  requestsRowIcon: {
    width: avatar.s48, height: avatar.s48,
    borderRadius: avatar.s48 / 2,
    backgroundColor: color.signal + '14',
    alignItems: 'center',
    justifyContent: 'center',
  },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#FEF0ED',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyBody: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },
  emptyActions: { gap: space.sm, marginTop: space.sm, width: '100%' },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  emptyBtnText: { ...t.body, color: color.ink },
});
