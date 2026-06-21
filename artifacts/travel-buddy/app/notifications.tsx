/**
 * Request Inbox — unified view of all social requests + meetup invites.
 *
 * Incoming tab:
 *   - friend requests, circle invites, trip invites, message requests (social)
 *   - meetup invites (RSVP Going / Maybe / Can't go)
 * Outgoing tab: requests you sent with status history and Cancel
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, UserPlus, Users, Plane, MessageCircle, CalendarClock } from 'lucide-react-native';
import { useRequests } from '../src/hooks/useRequests';
import { useIncomingMessageRequests, useUnreadCounts } from '../src/hooks/useMessaging';
import { acceptRequest, declineRequest, cancelRequest, type InboxItem } from '../src/services/requests';
import { markNotificationsRead } from '../src/services/messaging';
import { getMyMeetupInvites, rsvpMeetup, type MeetupInvite } from '../src/services/meetups';
import { getAvailabilityNudges, type AvailabilityNudge } from '../src/services/availability';
import { color, space, type as t } from '../src/theme/tokens';

type TabKind = 'incoming' | 'outgoing';

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

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending:   { bg: color.haze,        text: color.mute },
  invited:   { bg: color.haze,        text: color.mute },
  accepted:  { bg: '#DCFCE7',         text: '#16A34A' },
  friends:   { bg: '#DCFCE7',         text: '#16A34A' },
  member:    { bg: '#DCFCE7',         text: '#16A34A' },
  going:     { bg: '#DCFCE7',         text: '#16A34A' },
  maybe:     { bg: '#FEF9C3',         text: '#A16207' },
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

function Avatar({ url, name }: { url?: string | null; name?: string | null }) {
  if (url) return <Image source={{ uri: url }} style={styles.avatar} />;
  return (
    <View style={[styles.avatar, styles.avatarFallback]}>
      <Text style={styles.avatarInitial}>{((name ?? '?')[0]).toUpperCase()}</Text>
    </View>
  );
}

function TypeIcon({ type }: { type: string }) {
  if (type === 'friend_request') return <UserPlus size={18} color={color.deep} />;
  if (type === 'circle_invite')  return <Users size={18} color={color.signal} />;
  if (type === 'trip_invite')    return <Plane size={18} color={color.signal} />;
  if (type === 'meetup_invite')  return <CalendarClock size={18} color={color.signal} />;
  return <MessageCircle size={18} color={color.signal} />;
}

function fmtNudgeDate(dateStr: string): string {
  // dateStr is YYYY-MM-DD (date only, interpret as UTC noon to avoid off-by-one)
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function NudgeRow({ nudge }: { nudge: AvailabilityNudge }) {
  const name = nudge.senderName ?? nudge.senderHandle ?? 'Someone';
  const dateLabel = fmtNudgeDate(nudge.nudgeDate);
  const subtitle = nudge.tripTitle
    ? `${nudge.tripTitle}${nudge.destinationCity ? ` · ${nudge.destinationCity}` : ''}`
    : (nudge.destinationCity ?? 'a shared trip');

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push({ pathname: '/trip/[id]', params: { id: nudge.tripId } } as any)}
    >
      <View style={[styles.iconBadge, { backgroundColor: '#EEF6FF' }]}>
        <CalendarClock size={18} color="#2563EB" />
      </View>
      {nudge.senderAvatarUrl ? (
        <Image source={{ uri: nudge.senderAvatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>{name[0].toUpperCase()}</Text>
        </View>
      )}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.rowText}>
          <Text style={{ fontWeight: '700' }}>{name}</Text>
          {` is free ${dateLabel} — are you?`}
        </Text>
        <Text style={styles.meta}>{subtitle}</Text>
        <Text style={[styles.meta, { color: '#2563EB' }]}>Tap to view availability ›</Text>
        <Text style={styles.meta}>{relativeTime(nudge.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

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

function ActorMeta({ handle, createdAt }: { handle?: string | null; createdAt: string }) {
  return (
    <Text style={styles.meta}>
      {handle ? `@${handle} · ` : ''}{relativeTime(createdAt)}
    </Text>
  );
}

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

// ── Meetup RSVP row ───────────────────────────────────────────────────────────

function MeetupInviteRow({
  invite,
  busy,
  onRsvp,
}: {
  invite: MeetupInvite;
  busy: boolean;
  onRsvp: (status: 'going' | 'maybe' | 'declined') => void;
}) {
  const m = invite.meetup;
  const creator = invite.creator;
  const isConfirmation = invite.kind === 'confirmation';
  const isPending = invite.status === 'pending';

  if (isConfirmation) {
    return (
      <View style={styles.row}>
        <View style={[styles.iconBadge, { backgroundColor: '#DCFCE7' }]}>
          <CalendarClock size={18} color="#16A34A" />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.rowText}>
            {'✅ Time confirmed'}
          </Text>
          {m ? (
            <Pressable onPress={() => router.push(`/meetup/${m.id}` as any)}>
              <Text style={styles.meetupTitle} numberOfLines={1}>{m.title}</Text>
              {m.startsAt && (
                <Text style={styles.meetupMeta}>
                  🗓 {new Date(m.startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  {m.timeBlock ? ` · ${m.timeBlock}` : ''}
                </Text>
              )}
              {m.locationName && <Text style={styles.meetupMeta}>📍 {m.locationName}</Text>}
              <Text style={[styles.meta, { color: '#16A34A', marginTop: 2 }]}>Tap to view details ›</Text>
            </Pressable>
          ) : null}
          <Text style={styles.meta}>{relativeTime(invite.invitedAt)}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.iconBadge}><TypeIcon type="meetup_invite" /></View>
      <View style={[styles.avatar, styles.avatarFallback]}>
        <Text style={styles.avatarInitial}>{((creator?.name ?? creator?.handle ?? '?')[0]).toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.rowText}>
          <Text style={{ fontWeight: '700' }}>{creator?.name ?? 'Someone'}</Text>
          {' invited you to a meetup'}
        </Text>
        {m ? (
          <Pressable onPress={() => router.push(`/meetup/${m.id}` as any)}>
            <Text style={styles.meetupTitle} numberOfLines={1}>{m.title}</Text>
            {m.locationName && <Text style={styles.meetupMeta}>📍 {m.locationName}</Text>}
            {m.approximateDate && <Text style={styles.meetupMeta}>🗓 {m.approximateDate}{m.timeBlock ? ` · ${m.timeBlock}` : ''}</Text>}
          </Pressable>
        ) : null}
        <Text style={styles.meta}>{relativeTime(invite.invitedAt)}</Text>
        {isPending ? (
          <ActionRow>
            <Pressable style={[styles.acceptBtn, busy && styles.btnDim]} disabled={busy} onPress={() => onRsvp('going')}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : null}
              <Text style={styles.acceptBtnText}>✅ Going</Text>
            </Pressable>
            <Pressable style={[styles.maybeBtn, busy && styles.btnDim]} disabled={busy} onPress={() => onRsvp('maybe')}>
              <Text style={styles.maybeBtnText}>🤔 Maybe</Text>
            </Pressable>
            <Pressable style={[styles.declineBtn, busy && styles.btnDim]} disabled={busy} onPress={() => onRsvp('declined')}>
              <Text style={styles.declineBtnText}>Can't go</Text>
            </Pressable>
          </ActionRow>
        ) : (
          <View style={{ marginTop: 2 }}>
            <StatusChip status={invite.status} />
          </View>
        )}
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Notifications() {
  const insets = useSafeAreaInsets();
  const requests = useRequests();
  const msgReqs = useIncomingMessageRequests();
  const { refresh: refreshUnreadCounts } = useUnreadCounts();
  const [activeTab, setActiveTab] = useState<TabKind>('incoming');
  const [actioning, setActioning] = useState<string | null>(null);
  const everLoaded = useRef(false);

  const [meetupInvites, setMeetupInvites] = useState<MeetupInvite[]>([]);
  const [availabilityNudges, setAvailabilityNudges] = useState<AvailabilityNudge[]>([]);

  const loadMeetupInvites = useCallback(async () => {
    const res = await getMyMeetupInvites();
    if (res.ok && res.data) setMeetupInvites(res.data.invites);
  }, []);

  const loadAvailabilityNudges = useCallback(async () => {
    const res = await getAvailabilityNudges();
    if (res.ok && res.data) setAvailabilityNudges(res.data.nudges);
  }, []);

  useFocusEffect(useCallback(() => {
    requests.reload();
    msgReqs.reload();
    loadMeetupInvites();
    loadAvailabilityNudges();
    markNotificationsRead().then(() => refreshUnreadCounts());
  }, [requests.reload, msgReqs.reload, loadMeetupInvites, loadAvailabilityNudges, refreshUnreadCounts]));

  const loading = requests.loading || msgReqs.loading;
  const error = requests.error || msgReqs.error;
  if (!loading) everLoaded.current = true;
  const showSkeleton = loading && !everLoaded.current;

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

  async function handleMeetupRsvp(invite: MeetupInvite, status: 'going' | 'maybe' | 'declined') {
    const key = `meetup_${invite.meetupId}_${status}`;
    setActioning(key);
    const res = await rsvpMeetup(invite.meetupId, status);
    if (res.ok) {
      setMeetupInvites((prev) =>
        prev.map((i) => i.meetupId === invite.meetupId ? { ...i, status } : i)
      );
    }
    setActioning(null);
  }

  function renderIncoming() {
    const msgItems = msgReqs.data
      .map((m: any) => ({ id: m.requestId as string, type: 'message_request', item: m }));

    const socialItems = requests.incoming
      .map((r) => ({ id: r.id, type: r.type as string, item: r as InboxItem }));

    const all = [...msgItems, ...socialItems];

    const nudgeSection = availabilityNudges.length > 0 ? (
      <View key="nudge_section">
        <View style={styles.sectionLabel}>
          <CalendarClock size={12} color={color.mute} />
          <Text style={styles.sectionLabelText}>Availability Nudges</Text>
        </View>
        {availabilityNudges.map((n) => (
          <NudgeRow key={n.id} nudge={n} />
        ))}
      </View>
    ) : null;

    const meetupSection = meetupInvites.length > 0 ? (
      <View key="meetup_section">
        <View style={styles.sectionLabel}>
          <CalendarClock size={12} color={color.mute} />
          <Text style={styles.sectionLabelText}>Meetup Invites</Text>
        </View>
        {meetupInvites.map((inv) => (
          <MeetupInviteRow
            key={inv.inviteId}
            invite={inv}
            busy={actioning?.startsWith(`meetup_${inv.meetupId}`) ?? false}
            onRsvp={(status) => handleMeetupRsvp(inv, status)}
          />
        ))}
      </View>
    ) : null;

    if (all.length === 0 && !meetupSection && !nudgeSection) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>All caught up! No pending requests.</Text>
        </View>
      );
    }

    return (
      <>
        {nudgeSection}
        {meetupSection}
        {all.length > 0 && (nudgeSection || meetupSection) && (
          <View style={styles.sectionLabel}>
            <Text style={styles.sectionLabelText}>Social Requests</Text>
          </View>
        )}
        {all.map(({ id, type, item }) => {
          const actor = type === 'message_request' ? (item as any).sender : (item as InboxItem).actor;
          const status = type === 'message_request' ? (item as any).status : (item as InboxItem).status;
          const isPending = status === 'pending' || status === 'invited';
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
                {isPending ? (
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
                ) : (
                  <View style={{ marginTop: 2 }}>
                    <StatusChip status={status} />
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </>
    );
  }

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
              {isPending && item.type === 'friend_request' && (
                <DeclineBtn label="Cancel" busy={busy} onPress={() =>
                  doAction(item.id, () => cancelRequest('friend_request', item.id))
                } />
              )}
              {isPending && item.type === 'circle_invite' && (
                <DeclineBtn label="Cancel" busy={busy} onPress={() =>
                  doAction(item.id, () => cancelRequest('circle_invite', item.id))
                } />
              )}
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
      <View style={[styles.head, { paddingTop: insets.top + space.md }]}>
        <Text style={styles.title}>Inbox</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <X size={24} color={color.ink} />
        </Pressable>
      </View>

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

      {showSkeleton ? (
        <ScrollView contentContainerStyle={styles.list}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </ScrollView>
      ) : error && !everLoaded.current ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn't load requests.</Text>
          <Pressable style={styles.retryBtn} onPress={() => { requests.reload(); msgReqs.reload(); loadMeetupInvites(); }}>
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
  sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: space.sm },
  sectionLabelText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' },
  meetupTitle: { ...t.bodyStrong, color: color.signal, fontWeight: '700', fontSize: 13, marginTop: 2 },
  meetupMeta: { ...t.small, color: color.mute, fontSize: 11 },
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
  actionsRow: { flexDirection: 'row', gap: space.sm, marginTop: 4, flexWrap: 'wrap' },
  acceptBtn: {
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    backgroundColor: color.signal,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  acceptBtnText: { ...t.stamp, color: '#fff' },
  maybeBtn: {
    paddingVertical: 7,
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: '#A16207',
    borderRadius: 999,
    backgroundColor: '#FEF9C3',
  },
  maybeBtnText: { ...t.stamp, color: '#A16207' },
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
