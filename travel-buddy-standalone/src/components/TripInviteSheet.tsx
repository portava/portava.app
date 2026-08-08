/**
 * TripInviteSheet
 *
 * Bottom sheet that lets the trip owner invite people from their circle
 * directly from the trip detail screen without navigating away.
 *
 * Shows the user's FULL circle in three labelled sections:
 *   • "On this trip"  — circle members who are accepted trip members
 *   • "Invite sent"   — circle members with a pending invite (server + local)
 *   • "Your circle"   — remaining circle members available to invite
 *
 * Tapping "Invite" calls POST /api/trips/:tripId/invite and fires a toast.
 * The sheet stays open so multiple invites can be sent in sequence.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
  Image, Modal, TextInput, ScrollView,
} from 'react-native';
import { Avatar as SharedAvatar } from './ui/Avatar.tsx';
import { UserPlus, X, Search, Check, Users } from 'lucide-react-native';
import {
  getTripInvitableUsers, getTripMembers, sendTripInvite, type FriendUser,
} from '../services/friends.ts';
import { showNotificationToast } from './NotificationToast.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';

interface Props {
  tripId: string;
  visible: boolean;
  onDismiss: () => void;
  /** Called each time an invite is successfully sent. Parent can use this to refresh the crew section. */
  onInviteSent?: () => void;
}

type InviteStatus = 'on_trip' | 'pending' | 'available';

interface CircleMember extends FriendUser {
  status: InviteStatus;
}

function Avatar({ user, size = 38 }: { user: FriendUser; size?: number }) {
  return <SharedAvatar uri={user.avatarUrl} name={user.name ?? user.handle} size={size} />;
}

export function TripInviteSheet({ tripId, visible, onDismiss, onInviteSent }: Props) {
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0); // increment to force reload

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [invitableRes, membersRes] = await Promise.all([
      getTripInvitableUsers(tripId),
      getTripMembers(tripId),
    ]);
    setLoading(false);
    setLoaded(true);

    if (!invitableRes.ok) {
      setLoadError('Could not load your circle. Tap retry to try again.');
      return;
    }

    const invitedSet = new Set<string>(
      (membersRes.ok && membersRes.data?.invited ? membersRes.data.invited : []).map(
        (u) => u.id,
      ),
    );

    const result: CircleMember[] = [
      ...(invitableRes.data?.groupMembers ?? []).map((u) => ({
        ...u,
        status: 'on_trip' as InviteStatus,
      })),
      ...(invitableRes.data?.otherFollowers ?? []).map((u) => ({
        ...u,
        status: invitedSet.has(u.id) ? ('pending' as InviteStatus) : ('available' as InviteStatus),
      })),
    ];
    setMembers(result);
  }, [tripId]);

  useEffect(() => {
    if (visible) {
      load();
    } else {
      setLoaded(false);
      setMembers([]);
      setSearch('');
      setLoadError(null);
    }
  }, [visible, loadKey, load]);

  async function handleInvite(user: FriendUser) {
    if (invitingId) return;
    setInvitingId(user.id);
    const res = await sendTripInvite(tripId, user.id);
    setInvitingId(null);

    if (res.ok) {
      // Promote row from "available" to "pending" in local state
      setMembers((prev) =>
        prev.map((m) => (m.id === user.id ? { ...m, status: 'pending' } : m)),
      );
      onInviteSent?.();
      showNotificationToast({
        id: `trip-invite-${user.id}-${Date.now()}`,
        userId: '',
        eventType: 'trip_invite_sent',
        title: 'Invite sent ✈️',
        body: `${user.name || user.handle || 'Your friend'} has been invited to your trip`,
        priority: 'normal',
        category: 'trips',
        actionUrl: null,
        imageUrl: null,
        sourceType: null,
        sourceId: null,
        actorId: null,
        metadata: {},
        privacyLevel: 'standard',
        readAt: null,
        dismissedAt: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      });
    } else {
      showNotificationToast({
        id: `trip-invite-err-${user.id}-${Date.now()}`,
        userId: '',
        eventType: 'trip_invite_error',
        title: 'Could not send invite',
        body: res.message ?? 'Something went wrong. Please try again.',
        priority: 'important',
        category: 'trips',
        actionUrl: null,
        imageUrl: null,
        sourceType: null,
        sourceId: null,
        actorId: null,
        metadata: {},
        privacyLevel: 'standard',
        readAt: null,
        dismissedAt: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? members.filter(
        (m) =>
          (m.name?.toLowerCase().includes(q) ||
            m.handle?.toLowerCase().includes(q)) ??
          false,
      )
    : members;

  const onTrip = filtered.filter((m) => m.status === 'on_trip');
  const pending = filtered.filter((m) => m.status === 'pending');
  const available = filtered.filter((m) => m.status === 'available');
  const hasAny = onTrip.length + pending.length + available.length > 0;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={s.sheet}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.head}>
          <Users size={18} color={color.signal} />
          <Text style={s.title}>Invite to Trip</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onDismiss} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <Text style={s.subtitle}>
          Pick people from your circle. The sheet stays open so you can
          invite multiple friends.
        </Text>

        {/* Search */}
        <View style={s.searchRow}>
          <Search size={14} color={color.mute} />
          <TextInput
            style={s.searchInput}
            placeholder="Search by name or handle"
            placeholderTextColor={color.faint}
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <X size={14} color={color.mute} />
            </Pressable>
          )}
        </View>

        {/* Body */}
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
            <Text style={s.loadingText}>Loading your circle…</Text>
          </View>
        ) : loadError ? (
          <View style={s.center}>
            <Text style={s.errorText}>{loadError}</Text>
            <Pressable
              style={s.retryBtn}
              onPress={() => {
                setLoaded(false);
                setLoadKey((k) => k + 1);
              }}
            >
              <Text style={s.retryBtnText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView
            style={s.scroll}
            contentContainerStyle={s.scrollBody}
            keyboardShouldPersistTaps="handled"
          >
            {/* Available to invite */}
            {available.length > 0 && (
              <>
                <Text style={s.sectionLabel}>Your circle</Text>
                {available.map((user) => (
                  <View key={user.id} style={s.row}>
                    <Avatar user={user} />
                    <View style={s.rowMeta}>
                      <Text style={s.rowName} numberOfLines={1}>
                        {user.name || user.handle}
                      </Text>
                      {user.handle ? (
                        <Text style={s.rowHandle} numberOfLines={1}>
                          @{user.handle}
                        </Text>
                      ) : null}
                    </View>
                    <Pressable
                      style={[
                        s.inviteBtn,
                        invitingId === user.id && s.inviteBtnBusy,
                      ]}
                      onPress={() => handleInvite(user)}
                      disabled={!!invitingId}
                      accessibilityLabel={`Invite ${user.name || user.handle}`}
                    >
                      {invitingId === user.id ? (
                        <ActivityIndicator size="small" color={color.onInk} />
                      ) : (
                        <>
                          <UserPlus size={13} color={color.onInk} />
                          <Text style={s.inviteBtnText}>Invite</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                ))}
              </>
            )}

            {/* Pending invites */}
            {pending.length > 0 && (
              <>
                <Text style={s.sectionLabel}>Invite sent</Text>
                {pending.map((user) => (
                  <View key={user.id} style={s.row}>
                    <Avatar user={user} />
                    <View style={s.rowMeta}>
                      <Text style={s.rowName} numberOfLines={1}>
                        {user.name || user.handle}
                      </Text>
                      {user.handle ? (
                        <Text style={s.rowHandle} numberOfLines={1}>
                          @{user.handle}
                        </Text>
                      ) : null}
                    </View>
                    <View style={s.pendingBadge}>
                      <Check size={12} color="#16a34a" />
                      <Text style={s.pendingText}>Pending</Text>
                    </View>
                  </View>
                ))}
              </>
            )}

            {/* Already on the trip */}
            {onTrip.length > 0 && (
              <>
                <Text style={s.sectionLabel}>On this trip</Text>
                {onTrip.map((user) => (
                  <View key={user.id} style={s.row}>
                    <Avatar user={user} />
                    <View style={s.rowMeta}>
                      <Text style={s.rowName} numberOfLines={1}>
                        {user.name || user.handle}
                      </Text>
                      {user.handle ? (
                        <Text style={s.rowHandle} numberOfLines={1}>
                          @{user.handle}
                        </Text>
                      ) : null}
                    </View>
                    <View style={s.onTripBadge}>
                      <Text style={s.onTripText}>On trip</Text>
                    </View>
                  </View>
                ))}
              </>
            )}

            {/* Empty state */}
            {!hasAny && loaded && (
              <View style={s.empty}>
                <Text style={s.emptyTitle}>
                  {q ? 'No matches' : 'No circle members yet'}
                </Text>
                <Text style={s.emptyBody}>
                  {q
                    ? 'Try a different name or handle.'
                    : 'Follow people on Portava to invite them to your trips.'}
                </Text>
              </View>
            )}
          </ScrollView>
        )}
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 36,
    paddingTop: space.sm,
    maxHeight: '82%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: 4,
  },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },
  subtitle: { ...t.small, color: color.mute, marginBottom: space.md, lineHeight: 17 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    marginBottom: space.md,
  },
  searchInput: { flex: 1, ...t.body, color: color.ink, padding: 0 },

  center: { paddingVertical: space.xxl, alignItems: 'center', gap: space.md },
  loadingText: { ...t.small, color: color.mute },
  errorText: { ...t.small, color: '#DC2626', textAlign: 'center' },
  retryBtn: {
    borderWidth: 1,
    borderColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
  },
  retryBtnText: { ...t.small, color: color.signal, fontWeight: '700' },

  scroll: { flexGrow: 0 },
  scrollBody: { paddingBottom: space.md },

  sectionLabel: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.mute,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: space.lg,
    marginBottom: 4,
  },

  empty: { paddingVertical: space.xl, alignItems: 'center', gap: space.sm },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptyBody: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 17 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
  },
  rowMeta: { flex: 1, minWidth: 0 },
  rowName: { ...t.body, color: color.ink, fontWeight: '600' },
  rowHandle: { ...t.small, color: color.mute, fontSize: 12 },


  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    minWidth: 72,
    justifyContent: 'center',
  },
  inviteBtnBusy: { opacity: 0.6 },
  inviteBtnText: { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 12 },

  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f0fdf4',
  },
  pendingText: { fontSize: 12, fontWeight: '700', color: '#16a34a' },

  onTripBadge: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: color.paper,
  },
  onTripText: { fontSize: 12, fontWeight: '600', color: color.mute },
});
