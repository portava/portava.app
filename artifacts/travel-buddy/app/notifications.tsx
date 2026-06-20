/**
 * Request Inbox — unified view of all social requests:
 * incoming (friend requests, circle invites, trip invites, message requests)
 * and outgoing (friend requests, circle invites you sent).
 *
 * - Skeleton placeholders on initial load
 * - Error state with Retry
 * - Two-tab layout: Incoming / Outgoing
 * - Accept / Decline / Cancel actions per item type
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ScrollView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, UserPlus, Users, Plane, MessageCircle } from 'lucide-react-native';
import { useRequests } from '../src/hooks/useRequests';
import { useIncomingMessageRequests } from '../src/hooks/useMessaging';
import {
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  acceptCircleInvite,
  declineCircleInvite,
  acceptTripInvite,
  declineTripInvite,
} from '../src/services/friends';
import { color, space, type as t } from '../src/theme/tokens';
import type { InboxItem } from '../src/services/requests';

type TabKind = 'incoming' | 'outgoing';

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <View style={[styles.row, { opacity: 0.4 }]}>
      <View style={[styles.iconBadge, { backgroundColor: color.haze }]} />
      <View style={[styles.avatar, { backgroundColor: color.haze }]} />
      <View style={{ flex: 1, gap: 7 }}>
        <View style={{ height: 13, backgroundColor: color.haze, borderRadius: 4, width: '72%' }} />
        <View style={{ height: 11, backgroundColor: color.haze, borderRadius: 4, width: '48%' }} />
        <View style={{ height: 30, backgroundColor: color.haze, borderRadius: 999, width: '52%', marginTop: 2 }} />
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
  if (type === 'circle_invite') return <Users size={18} color={color.signal} />;
  if (type === 'trip_invite') return <Plane size={18} color={color.signal} />;
  return <MessageCircle size={18} color={color.signal} />;
}

// ── Item description text ─────────────────────────────────────────────────────

function describeItem(item: InboxItem, direction: 'incoming' | 'outgoing'): string {
  const who = item.actor?.name ?? item.actor?.handle ?? 'Someone';
  if (direction === 'incoming') {
    if (item.type === 'friend_request') return `${who} sent you a friend request`;
    if (item.type === 'circle_invite') return `${who} invited you to their Travel Circle`;
    if (item.type === 'trip_invite') return `${who} invited you to join${item.targetName ? ` "${item.targetName}"` : ' a trip'}`;
  } else {
    if (item.type === 'friend_request') return `Friend request sent to ${who}`;
    if (item.type === 'circle_invite') return `Circle invite sent to ${who}`;
    if (item.type === 'trip_invite') return `Trip invite sent to ${who}`;
  }
  return '';
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

  // After any social action, reload the unified list
  async function doAction(id: string, fn: () => Promise<any>) {
    setActioning(id);
    try {
      await fn();
      requests.reload();
    } finally {
      setActioning(null);
    }
  }

  // ── Incoming items ──────────────────────────────────────────────────────────

  function renderIncoming() {
    const msgItems = msgReqs.data.map((m: any) => ({ id: m.requestId as string, type: 'message_request' as const, item: m }));
    const socialItems = requests.incoming.map((r) => ({ id: r.id, type: r.type as string, item: r as InboxItem }));
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
      return (
        <View key={id} style={styles.row}>
          <View style={styles.iconBadge}><TypeIcon type={type} /></View>
          <Avatar url={actor?.avatarUrl} name={actor?.name} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.rowText}>
              {type === 'message_request'
                ? <><Text style={{ fontWeight: '700' }}>{actor?.name ?? 'Someone'}</Text>{' wants to message you'}</>
                : describeItem(item as InboxItem, 'incoming')}
            </Text>
            {type === 'message_request' && (item as any).previewText ? (
              <Text style={styles.preview} numberOfLines={2}>"{(item as any).previewText}"</Text>
            ) : null}
            <View style={styles.actionsRow}>
              <Pressable
                style={[styles.acceptBtn, busy && styles.btnDim]}
                disabled={busy}
                onPress={() => {
                  if (type === 'message_request') doAction(id, () => msgReqs.accept(id));
                  else if (type === 'friend_request') doAction(id, () => acceptFriendRequest(id));
                  else if (type === 'circle_invite') doAction(id, () => acceptCircleInvite(id));
                  else if (type === 'trip_invite') doAction(id, () => acceptTripInvite(id));
                }}
              >
                <Text style={styles.acceptBtnText}>Accept</Text>
              </Pressable>
              <Pressable
                style={[styles.declineBtn, busy && styles.btnDim]}
                disabled={busy}
                onPress={() => {
                  if (type === 'message_request') doAction(id, () => msgReqs.decline(id));
                  else if (type === 'friend_request') doAction(id, () => declineFriendRequest(id));
                  else if (type === 'circle_invite') doAction(id, () => declineCircleInvite(id));
                  else if (type === 'trip_invite') doAction(id, () => declineTripInvite(id));
                }}
              >
                <Text style={styles.declineBtnText}>Decline</Text>
              </Pressable>
            </View>
          </View>
        </View>
      );
    });
  }

  // ── Outgoing items ──────────────────────────────────────────────────────────

  function renderOutgoing() {
    if (requests.outgoing.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No pending outgoing requests.</Text>
        </View>
      );
    }

    return requests.outgoing.map((item) => {
      const busy = actioning === item.id;
      return (
        <View key={item.id} style={styles.row}>
          <View style={styles.iconBadge}><TypeIcon type={item.type} /></View>
          <Avatar url={item.actor?.avatarUrl} name={item.actor?.name} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.rowText}>{describeItem(item, 'outgoing')}</Text>
            <Text style={styles.pendingLabel}>Pending</Text>
            {item.type === 'friend_request' && (
              <View style={styles.actionsRow}>
                <Pressable
                  style={[styles.declineBtn, busy && styles.btnDim]}
                  disabled={busy}
                  onPress={() => doAction(item.id, () => cancelFriendRequest(item.id))}
                >
                  <Text style={styles.declineBtnText}>Cancel request</Text>
                </Pressable>
              </View>
            )}
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
          <Pressable
            style={styles.retryBtn}
            onPress={() => { requests.reload(); msgReqs.reload(); }}
          >
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
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
  },
  avatarInitial: { ...t.bodyStrong, color: color.ink },
  rowText: { ...t.body, color: color.ink, flex: 1 },
  preview: { ...t.small, color: color.mute, fontStyle: 'italic' },
  pendingLabel: { ...t.small, color: color.mute },
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
});
