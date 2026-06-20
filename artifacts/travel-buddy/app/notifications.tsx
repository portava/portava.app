/**
 * Request Inbox — unified view of all social requests:
 *
 * Incoming tab: friend requests, circle invites, trip invites, message requests (pending only)
 * Outgoing tab: requests you sent with status history and Cancel where applicable
 *
 * Features:
 * - Skeleton placeholders on initial load
 * - Error state with Retry
 * - Two-tab layout: Incoming / Outgoing
 * - Status chip (pending, accepted, declined, cancelled)
 * - Relative timestamp + @username for each item
 * - All actions routed through the unified /api/me/requests service
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, UserPlus, Users, Plane, MessageCircle } from 'lucide-react-native';
import { useRequests } from '../src/hooks/useRequests';
import { useIncomingMessageRequests } from '../src/hooks/useMessaging';
import { acceptRequest, declineRequest, cancelRequest, type InboxItem } from '../src/services/requests';
import { color, space, type as t } from '../src/theme/tokens';

type TabKind = 'incoming' | 'outgoing';

// ── Time helper ───────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${mins}m ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Status chip ───────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending:   { bg: color.haze,      text: color.mute },
  invited:   { bg: color.haze,      text: color.mute },
  accepted:  { bg: '#DCFCE7',       text: '#16A34A' },
  friends:   { bg: '#DCFCE7',       text: '#16A34A' },
  member:    { bg: '#DCFCE7',       text: '#16A34A' },
  declined:  { bg: color.paperRaised, text: color.mute },
  cancelled: { bg: color.paperRaised, text: color.mute },
};

function StatusChip({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.pending;
  return (
    <View style={[styles.statusChip, { backgroundColor: c.bg }]}>
      <Text style={[styles.statusChipText, { color: c.text }]}>{status}</Text>
    </View>
  );
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <View style={[styles.row, { opacity: 0.4 }]}>
      <View style={[styles.iconBadge, { backgroundColor: color.haze }]} />
      <View style={[styles.avatar, { backgroundColor: color.haze }]} />
      <View style={{ flex: 1, gap: 7 }}>
        <View style={{ height: 13, backgroundColor: color.haze, borderRadius: 4, width: '70%' }} />
        <View style={{ height: 11, backgroundColor: color.haze, borderRadius: 4, width: '45%' }} />
        <View style={{ height: 30, backgroundColor: color.haze, borderRadius: 999, width: '50%', marginTop: 2 }} />
      </View>
    </View>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ url, name }: { url?: string | null; name?: string | null }) {
  if (url) return <Image source={{ uri: url }} style={styles.avatar} />;
  return (
    <View style={[styles.avatar, styles.avatarFallback]}>
      <Text style={styles.avatarInitial}>{((name ?? '?')[0]).toUpperCase()}</Text>
    </View>
  );
}

// ── Type icon ─────────────────────────────────────────────────────────────────

function TypeIcon({ type }: { type: string }) {
  if (type === 'friend_request') return <UserPlus size={18} color={color.deep} />;
  if (type === 'circle_invite')  return <Users size={18} color={color.signal} />;
  if (type === 'trip_invite')    return <Plane size={18} color={color.signal} />;
  return <MessageCircle size={18} color={color.signal} />;
}

// ── Description ───────────────────────────────────────────────────────────────

function describeItem(item: InboxItem, direction: 'incoming' | 'outgoing'): string {
  const who = item.actor?.name ?? item.actor?.handle ?? 'Someone';
  if (direction === 'incoming') {
    if (item.type === 'friend_request') return `${who} sent you a friend request`;
    if (item.type === 'circle_invite')  return `${who} invited you to their Travel Circle`;
    if (item.type === 'trip_invite')    return `${who} invited you to join${item.targetName ? ` "${item.targetName}"` : ' a trip'}`;
  } else {
    if (item.type === 'friend_request') return `Friend request sent to ${who}`;
    if (item.type === 'circle_invite')  return `Circle invite sent to ${who}`;
    if (item.type === 'trip_invite')    return `Trip invite sent to ${who}${item.targetName ? ` for "${item.targetName}"` : ''}`;
  }
  return '';
}

// ── Actor meta row ────────────────────────────────────────────────────────────

function ActorMeta({ handle, createdAt }: { handle?: string | null; createdAt: string }) {
  return (
    <Text style={styles.meta}>
      {handle ? `@${handle} · ` : ''}{relativeTime(createdAt)}
    </Text>
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────

function ActionRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.actionsRow}>{children}</View>;
}

function AcceptBtn({ onPress, busy }: { onPress: () => void; busy: boolean }) {
  return (
    <Pressable style={[styles.acceptBtn, busy && styles.btnDim]} disabled={busy} onPress={onPress}>
      <Text style={styles.acceptBtnText}>Accept</Text>
    </Pressable>
  );
}

function DeclineBtn({ label = 'Decline', onPress, busy }: { label?: string; onPress: () => void; busy: boolean }) {
  return (
    <Pressable style={[styles.declineBtn, busy && styles.btnDim]} disabled={busy} onPress={onPress}>
      <Text style={styles.declineBtnText}>{label}</Text>
    </Pressable>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Notifications() {
  const insets = useSafeAreaInsets();
  const requests = useRequests();
  const msgReqs = useIncomingMessageRequests();
  const [activeTab, setActiveTab] = useState<TabKind>('incoming');
  const [actioning, setActioning] = useState<string | null>(null);
  const everLoaded = useRef(false);

  useFocusEffect(useCallback(() => {
    requests.reload();
    msgReqs.reload();
  }, [requests.reload, msgReqs.reload]));

  const loading = requests.loading || msgReqs.loading;
  const error = requests.error || msgReqs.error;
  if (!loading) everLoaded.current = true;
  const showSkeleton = loading && !everLoaded.current;

  // Perform an action then silently reload
  async function doAction(id: string, fn: () => Promise<any>, reloadMsgs = false) {
    setActioning(id);
    try {
      await fn();
      requests.reload();
      if (reloadMsgs) msgReqs.reload();
    } finally {
      setActioning(null);
    }
  }

  // ── Incoming tab ────────────────────────────────────────────────────────────

  function renderIncoming() {
    const msgItems = msgReqs.data
      .filter((m: any) => m.status === 'pending')
      .map((m: any) => ({ id: m.requestId as string, type: 'message_request', item: m }));

    const socialItems = requests.incoming
      .filter((r) => r.status === 'pending' || r.status === 'invited')
      .map((r) => ({ id: r.id, type: r.type as string, item: r as InboxItem }));

    const all = [...msgItems, ...socialItems];

    if (all.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>All caught up! No pending requests.</Text>
        </View>
      );
    }

    return all.map(({ id, type, item }) => {
      const actor = type === 'message_request' ? (item as any).sender : (item as InboxItem).actor;
      const busy = actioning === id;
      const createdAt = (item as any).createdAt ?? '';

      return (
        <View key={id} style={styles.row}>
          <View style={styles.iconBadge}><TypeIcon type={type} /></View>
          <Avatar url={actor?.avatarUrl} name={actor?.name} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.rowText}>
              {type === 'message_request'
                ? <><Text style={{ fontWeight: '700' }}>{actor?.name ?? 'Someone'}</Text>{' wants to message you'}</>
                : describeItem(item as InboxItem, 'incoming')}
            </Text>
            <ActorMeta handle={actor?.handle} createdAt={createdAt} />
            {type === 'message_request' && (item as any).previewText ? (
              <Text style={styles.preview} numberOfLines={2}>"{(item as any).previewText}"</Text>
            ) : null}
            <ActionRow>
              <AcceptBtn busy={busy} onPress={() => {
                if (type === 'message_request') doAction(id, () => msgReqs.accept(id), true);
                else doAction(id, () => acceptRequest((item as InboxItem).type, id));
              }} />
              <DeclineBtn busy={busy} onPress={() => {
                if (type === 'message_request') doAction(id, () => msgReqs.decline(id), true);
                else doAction(id, () => declineRequest((item as InboxItem).type, id));
              }} />
            </ActionRow>
          </View>
        </View>
      );
    });
  }

  // ── Outgoing tab ────────────────────────────────────────────────────────────

  function renderOutgoing() {
    if (requests.outgoing.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No outgoing requests.</Text>
        </View>
      );
    }

    return requests.outgoing.map((item) => {
      const busy = actioning === item.id;
      const isPending = item.status === 'pending' || item.status === 'invited';
      return (
        <View key={item.id} style={styles.row}>
          <View style={styles.iconBadge}><TypeIcon type={item.type} /></View>
          <Avatar url={item.actor?.avatarUrl} name={item.actor?.name} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.rowText}>{describeItem(item, 'outgoing')}</Text>
            <ActorMeta handle={item.actor?.handle} createdAt={item.createdAt} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 }}>
              <StatusChip status={item.status} />
              {/* Cancel only available for pending friend requests */}
              {isPending && item.type === 'friend_request' && (
                <DeclineBtn label="Cancel" busy={busy} onPress={() =>
                  doAction(item.id, () => cancelRequest('friend_request', item.id))
                } />
              )}
              {/* Owner cancels a trip invite: compound id = tripId|inviteeId */}
              {isPending && item.type === 'trip_invite' && item.id.includes('|') && (
                <DeclineBtn label="Cancel invite" busy={busy} onPress={() => {
                  const [tripId, inviteeId] = item.id.split('|');
                  doAction(item.id, () => cancelRequest('trip_invite', tripId, { inviteeId }));
                }} />
              )}
            </View>
          </View>
        </View>
      );
    });
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>

      {/* ── Header ── */}
      <View style={[styles.head, { paddingTop: insets.top + space.md }]}>
        <Text style={styles.title}>Inbox</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <X size={24} color={color.ink} />
        </Pressable>
      </View>

      {/* ── Tab switcher ── */}
      <View style={styles.tabs}>
        {(['incoming', 'outgoing'] as TabKind[]).map((tab) => (
          <Pressable
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'incoming' ? 'Incoming' : 'Outgoing'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Content ── */}
      {showSkeleton ? (
        <ScrollView contentContainerStyle={styles.list}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </ScrollView>
      ) : error && !everLoaded.current ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn't load requests.</Text>
          <Pressable style={styles.retryBtn} onPress={() => { requests.reload(); msgReqs.reload(); }}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {activeTab === 'incoming' ? renderIncoming() : renderOutgoing()}
        </ScrollView>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: { ...t.title, color: color.ink },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tab: {
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { ...t.stamp, color: color.mute },
  tabTextActive: { color: color.onInk },
  list: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyWrap: { paddingVertical: space.xxl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  errorText: { ...t.body, color: color.mute, textAlign: 'center', marginBottom: space.md },
  retryBtn: {
    paddingVertical: space.sm,
    paddingHorizontal: space.xl,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.signal,
  },
  retryBtnText: { ...t.stamp, color: color.signal },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  iconBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.haze,
    flexShrink: 0,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.bodyStrong, color: color.ink },
  rowText: { ...t.body, color: color.ink, flex: 1 },
  meta: { ...t.small, color: color.mute },
  preview: { ...t.small, color: color.mute, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', gap: space.sm, marginTop: 4 },
  acceptBtn: {
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    backgroundColor: color.signal,
    borderRadius: 999,
  },
  acceptBtnText: { ...t.stamp, color: '#fff' },
  declineBtn: {
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: 999,
  },
  declineBtnText: { ...t.stamp, color: color.mute },
  btnDim: { opacity: 0.45 },
  statusChip: {
    paddingVertical: 3,
    paddingHorizontal: space.sm,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  statusChipText: { ...t.small, fontWeight: '700', fontSize: 11 },
});
