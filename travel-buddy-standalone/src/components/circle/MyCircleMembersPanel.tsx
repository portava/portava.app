/**
 * MyCircleMembersPanel — the trusted-circle MEMBERSHIP list on the Circle
 * screen, for its owner. TM-social, PLAT-F11.
 *
 * The Circle screen's own list is the people the viewer FOLLOWS. Trusted-circle
 * membership is a different thing: a `circle_memberships` row that only an
 * accepted circle invite creates, and that grants circle-visibility posts,
 * events, meetups and the circle chat. Until this panel an owner could neither
 * see who held that access, nor invite anyone into it, nor take it away —
 * `DELETE /circles/:owner/members/:member` and `POST /circle-invites` had no
 * caller.
 *
 * States are true ones (DV-83): a failed member read is "couldn't load" with a
 * retry, never "no members"; a failed removal is reported, and the row stays.
 * Anyone in a block relation with the viewer is not listed (blocks context),
 * matching every other people list in the app.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { UserMinus, UserPlus, Users, Check } from 'lucide-react-native';
import {
  getCircleMembers, removeCircleMember, getMyFriends, sendCircleInvite,
  type FriendUser, type FriendRow,
} from '../../services/friends.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

function Row({
  user, action,
}: { user: FriendUser; action: React.ReactNode }) {
  const label = primaryIdentityText({ name: user.name, handle: user.handle });
  return (
    <View style={s.row}>
      <Pressable
        style={s.who}
        onPress={() => router.push(`/u/${encodeURIComponent(user.handle || user.id)}` as never)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${label}'s profile`}
      >
        <Avatar uri={user.avatarUrl} name={label.replace(/^@/, '')} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>{label}</Text>
          {user.handle && label !== `@${user.handle}` ? <Text style={s.handle}>@{user.handle}</Text> : null}
        </View>
      </Pressable>
      {action}
    </View>
  );
}

export function MyCircleMembersPanel({ ownerId }: { ownerId: string }) {
  const { blockedIds, blockerIds } = useBlockedIds();
  const [members, setMembers] = useState<Load<FriendUser[]>>({ state: 'loading' });
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [friends, setFriends] = useState<Load<FriendRow[]>>({ state: 'loading' });
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [invitingId, setInvitingId] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setMembers({ state: 'loading' });
    const res = await getCircleMembers(ownerId);
    if (res.ok && res.data && Array.isArray(res.data.members)) {
      setMembers({ state: 'ok', data: res.data.members });
    } else {
      setMembers({ state: 'error', message: res.message ?? "Couldn't load your circle members." });
    }
  }, [ownerId]);

  const loadFriends = useCallback(async () => {
    setFriends({ state: 'loading' });
    const res = await getMyFriends();
    if (res.ok && res.data && Array.isArray(res.data.friends)) {
      setFriends({ state: 'ok', data: res.data.friends });
    } else {
      setFriends({ state: 'error', message: res.message ?? "Couldn't load your friends." });
    }
  }, []);

  useEffect(() => { void loadMembers(); }, [loadMembers]);
  useEffect(() => { if (pickerOpen) void loadFriends(); }, [pickerOpen, loadFriends]);

  const hidden = (id: string) => blockedIds.has(id) || blockerIds.has(id);

  function confirmRemove(user: FriendUser) {
    const label = primaryIdentityText({ name: user.name, handle: user.handle });
    Alert.alert(
      'Remove from circle',
      `Remove ${label} from your trusted circle? They lose access to your circle-only posts, events and the circle chat. They are not notified.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { void doRemove(user); } },
      ],
    );
  }

  async function doRemove(user: FriendUser) {
    if (removingId) return;
    setRemovingId(user.id);
    const res = await removeCircleMember(ownerId, user.id);
    setRemovingId(null);
    if (res.ok && res.data?.status === 'removed') {
      setMembers((prev) => (prev.state === 'ok'
        ? { state: 'ok', data: prev.data.filter((m) => m.id !== user.id) }
        : prev));
      return;
    }
    if (res.errorKind === 'not_found') {
      // The server re-read the membership and it is already gone — the end
      // state the owner asked for. Refresh rather than claim we removed it.
      void loadMembers();
      return;
    }
    Alert.alert('Could not remove', res.message ?? 'They are still in your circle. Please try again.');
  }

  async function invite(user: FriendRow) {
    if (invitingId) return;
    setInvitingId(user.id);
    const res = await sendCircleInvite(user.id);
    setInvitingId(null);
    if (res.ok) {
      setInvited((prev) => new Set(prev).add(user.id));
    } else {
      Alert.alert('Invite not sent', res.message ?? 'Please try again.');
    }
  }

  const memberIds = new Set(members.state === 'ok' ? members.data.map((m) => m.id) : []);

  return (
    <View style={s.card} testID="my-circle-members">
      <View style={s.head}>
        <Users size={14} color={color.deep} />
        <Text style={s.title}>Trusted circle members</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          style={s.inviteBtn}
          onPress={() => setPickerOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={pickerOpen ? 'Close invite list' : 'Invite a friend to your circle'}
          testID="circle-invite-toggle"
        >
          <UserPlus size={13} color={color.onInk} />
          <Text style={s.inviteBtnText}>{pickerOpen ? 'Done' : 'Invite'}</Text>
        </Pressable>
      </View>

      {members.state === 'loading' ? (
        <ActivityIndicator color={color.signal} style={{ marginVertical: space.md }} />
      ) : members.state === 'error' ? (
        <View style={s.stateBox}>
          <Text style={s.stateText}>Couldn't load your circle members.</Text>
          <Pressable onPress={() => { void loadMembers(); }} accessibilityRole="button" testID="circle-members-retry">
            <Text style={s.link}>Try again</Text>
          </Pressable>
        </View>
      ) : members.data.filter((m) => !hidden(m.id)).length === 0 ? (
        <Text style={s.stateText}>No one is in your trusted circle yet. Invite a friend — they join when they accept.</Text>
      ) : (
        members.data.filter((m) => !hidden(m.id)).map((m) => (
          <Row
            key={m.id}
            user={m}
            action={
              <Pressable
                style={s.removeBtn}
                onPress={() => confirmRemove(m)}
                disabled={removingId !== null}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${primaryIdentityText({ name: m.name, handle: m.handle })} from your circle`}
                testID={`circle-remove-${m.id}`}
              >
                {removingId === m.id
                  ? <ActivityIndicator size="small" color={color.signal} />
                  : <UserMinus size={14} color={color.signal} />}
              </Pressable>
            }
          />
        ))
      )}

      {pickerOpen && (
        <View style={s.picker}>
          <Text style={s.pickerLabel}>Invite a friend</Text>
          {friends.state === 'loading' ? (
            <ActivityIndicator color={color.signal} style={{ marginVertical: space.sm }} />
          ) : friends.state === 'error' ? (
            <View style={s.stateBox}>
              <Text style={s.stateText}>Couldn't load your friends.</Text>
              <Pressable onPress={() => { void loadFriends(); }} accessibilityRole="button">
                <Text style={s.link}>Try again</Text>
              </Pressable>
            </View>
          ) : (() => {
            const candidates = friends.data.filter((f) => !memberIds.has(f.id) && !hidden(f.id));
            if (candidates.length === 0) {
              return <Text style={s.stateText}>Every friend you have is already in your circle — or you have no friends on Portava yet.</Text>;
            }
            return candidates.map((f) => (
              <Row
                key={f.id}
                user={f}
                action={invited.has(f.id) ? (
                  <View style={s.invitedPill}>
                    <Check size={12} color={color.deep} />
                    <Text style={s.invitedText}>Invited</Text>
                  </View>
                ) : (
                  <Pressable
                    style={s.inviteSmall}
                    onPress={() => { void invite(f); }}
                    disabled={invitingId !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Invite ${primaryIdentityText({ name: f.name, handle: f.handle })} to your circle`}
                    testID={`circle-invite-${f.id}`}
                  >
                    {invitingId === f.id
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Text style={s.inviteBtnText}>Invite</Text>}
                  </Pressable>
                )}
              />
            ));
          })()}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: space.lg, marginTop: space.md, padding: space.md, gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { ...t.body, color: color.ink, fontWeight: '600' },
  handle: { ...t.small, color: color.mute },
  stateBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  stateText: { ...t.small, color: color.mute },
  link: { ...t.small, color: color.signal, fontWeight: '700' },
  removeBtn: {
    padding: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper,
  },
  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: color.ink,
  },
  inviteSmall: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.ink },
  inviteBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  invitedPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  invitedText: { ...t.small, color: color.deep, fontWeight: '600' },
  picker: { borderTopWidth: 1, borderTopColor: color.haze, paddingTop: space.sm, gap: space.xs },
  pickerLabel: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
});
