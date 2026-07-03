import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Image, Pressable, StyleSheet,
  ScrollView, TextInput, ActivityIndicator, Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Zap, Users, Globe, BellOff, Search, MessageCirclePlus, Compass, Bot, ShieldOff, Flag, UserCheck, UserMinus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMyThreads, useIncomingMessageRequests } from '../hooks/useMessaging';
import { useSession } from '../context/SessionContext';
import { blockUser, getBlockList } from '../services/blocks';
import { useBlockedIds } from '../context/BlockedIdsContext';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { useHighlightRingState } from '../hooks/useHighlightRingState';
import { color, space, radius, type as t } from '../theme/tokens';
import type { ThreadSummary, MessageRequest } from '../services/messaging';

type FilterKey = 'all' | 'direct' | 'trips' | 'circles' | 'unread' | 'requests';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'direct', label: 'Direct' },
  { key: 'trips', label: 'Trips' },
  { key: 'circles', label: 'Circles' },
  { key: 'unread', label: 'Unread' },
  { key: 'requests', label: 'Requests' },
];

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
  const title = item.threadType === 'direct' || isRentBuddy
    ? (item.otherMembers[0]?.name ?? (isRentBuddy ? 'Buddy Booking' : ''))
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
      <View style={[s.avatar, { backgroundColor: color.haze }]} />
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

  const inner = other?.avatarUrl
    ? <Image source={{ uri: other.avatarUrl }} style={s.avatar} />
    : (
      <View style={[s.avatar, s.avatarPlaceholder]}>
        <Text style={s.avatarInitial}>{(other?.name?.[0] ?? '?').toUpperCase()}</Text>
      </View>
    );

  if (!ringState?.hasActive) return inner;

  return (
    <>
      <HighlightRing size={50} hasActive allViewed={ringState.allViewed} onPress={() => setViewerOpen(true)}>
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
  if (item.threadType === 'trip') {
    return (
      <View style={[s.avatar, s.groupAvatar, { backgroundColor: '#E0EFEC' }]}>
        <Globe size={22} color={color.deep} />
      </View>
    );
  }
  if (item.threadType === 'circle') {
    return (
      <View style={[s.avatar, s.groupAvatar, { backgroundColor: '#F2EBE0' }]}>
        <Users size={22} color="#7A4C20" />
      </View>
    );
  }
  return <DmThreadAvatar item={item} currentUserId={currentUserId} />;
}

function ThreadRow({ item, userId }: { item: ThreadSummary; userId: string | null }) {
  const isGroup = item.threadType !== 'direct';
  const displayName = isGroup
    ? (item.title ?? (item.threadType === 'trip' ? 'Trip Chat' : 'Circle Chat'))
    : (item.otherMembers[0]?.name ?? 'Unknown');

  const lmp = item.lastMessagePreview;
  const isMine = lmp?.senderId === userId;
  const previewText = lmp ? (isMine ? lmp.body : (lmp.displayBody ?? lmp.body)) : '';
  const lastAt = lmp?.createdAt;
  const isMuted = !!item.mutedAt;
  const unread = item.unreadCount ?? 0;
  const isAi = item.isAiLastMessage ?? (lmp?.msgType === 'ai_recommendation');

  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
      onPress={() => navigateToThread(item)}
    >
      <ThreadAvatarIcon item={item} currentUserId={userId} />

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
    </Pressable>
  );
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
  const { isAuthed, userId } = useSession();
  const { data: threads, loading, error, reload } = useMyThreads();
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
        : (th.otherMembers[0]?.name ?? '').toLowerCase();
      const body = (th.lastMessagePreview?.body ?? '').toLowerCase();
      const displayBody = (th.lastMessagePreview?.displayBody ?? '').toLowerCase();
      if (!name.includes(q) && !body.includes(q) && !displayBody.includes(q)) return false;
    }
    return true;
  });

  const pt = Math.max(insets.top, topInset);

  return (
    <View style={[s.screen, { paddingTop: pt }]}>
      <View style={s.header}>
        <View style={s.brandRow}>
          <View style={s.brandIcon}>
            <Zap size={14} color={color.onInk} fill={color.onInk} />
          </View>
          <Text style={s.brandName}>Telegraph</Text>
        </View>
      </View>

      {!isAuthed ? (
        <View style={s.center}>
          <Text style={s.emptyBody}>Sign in to view your messages.</Text>
        </View>
      ) : (
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

          {error ? (
            <View style={s.center}><Text style={[s.emptyBody, { color: '#B33' }]}>{error}</Text></View>
          ) : loading ? (
            <View style={{ paddingTop: space.sm }}>
              {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
            </View>
          ) : filter === 'requests' ? (
            <RequestsPane
              requests={filteredRequests}
              loading={reqLoading}
              onAccept={acceptRequest}
              onDecline={declineRequest}
            />
          ) : filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingBottom: space.xxxl }}
              renderItem={({ item }) => <ThreadRow item={item} userId={userId} />}
              ItemSeparatorComponent={() => <View style={s.sep} />}
            />
          )}
        </>
      )}
    </View>
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
      `${request.sender.name ?? 'This person'} won't be able to message you or see your profile.`,
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

  function handleReport() {
    Alert.alert('Report', 'Thank you — our team will review this request.');
  }

  const { sender, previewText, createdAt } = request;
  const initial = (sender?.name?.[0] ?? '?').toUpperCase();

  return (
    <View style={rc.card}>
      {/* Header: avatar + name + time */}
      <View style={rc.headerRow}>
        {sender?.avatarUrl ? (
          <Image source={{ uri: sender.avatarUrl }} style={rc.avatar} />
        ) : (
          <View style={[rc.avatar, rc.avatarFallback]}>
            <Text style={rc.avatarInitial}>{initial}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={rc.name} numberOfLines={1}>{sender?.name ?? 'Unknown'}</Text>
          {sender?.handle ? (
            <Text style={rc.handle}>@{sender.handle}</Text>
          ) : null}
        </View>
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
    </View>
  );
}

const rc = StyleSheet.create({
  card: {
    marginHorizontal: space.xl,
    marginTop: space.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.haze, flexShrink: 0 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E5DE' },
  avatarInitial: { ...t.bodyStrong, color: color.ink, fontSize: 18 },
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
}: {
  requests: MessageRequest[];
  loading: boolean;
  onAccept: (requestId: string) => Promise<{ ok: boolean; data: { status: string; threadId: string } | null }>;
  onDecline: (requestId: string) => Promise<{ ok: boolean; data: { status: string } | null }>;
}) {
  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (requests.length === 0) {
    return (
      <View style={s.center}>
        <Text style={s.emptyTitle}>No pending requests</Text>
        <Text style={s.emptyBody}>
          Message requests from people you don't know yet will appear here.
        </Text>
      </View>
    );
  }

  // Dedup by requestId in case the API returns duplicates
  const seen = new Set<string>();
  const uniqueRequests = requests.filter((r) => {
    if (seen.has(r.requestId)) return false;
    seen.add(r.requestId);
    return true;
  });

  return (
    <FlatList
      data={uniqueRequests}
      keyExtractor={(item) => item.requestId}
      contentContainerStyle={{ paddingBottom: space.xxxl }}
      renderItem={({ item }) => (
        <RequestCard
          request={item}
          onAccept={async () => {
            const res = await onAccept(item.requestId);
            if (res.ok && res.data?.threadId) {
              const name = item.sender?.name ?? 'Chat';
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
  screen: { flex: 1, backgroundColor: color.paper },
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
    backgroundColor: color.haze,
    borderRadius: 12,
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

  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: color.haze, flexShrink: 0 },
  groupAvatar: { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E5DE' },
  avatarInitial: { ...t.bodyStrong, color: color.ink },

  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  nameLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 5, flexShrink: 1 },
  nameMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  name: { ...t.body, color: color.ink, flexShrink: 1 },
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
