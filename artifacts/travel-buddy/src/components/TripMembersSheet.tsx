/**
 * TripMembersSheet — bottom sheet listing the members of a trip or circle chat.
 *
 * - Lists current members (owner gets an "Owner" badge).
 * - Trip owners get an "Invite a friend" action that opens an inline picker
 *   pre-filtered to friends not already in the trip (otherFollowers from
 *   getTripInvitableUsers). Tapping a friend sends a trip invite immediately.
 * - Freshly invited friends move into an "Invited" section with a "Pending"
 *   badge until they accept.
 * - Circle chats reuse the same member list but never show the invite action
 *   (circles have their own membership flow).
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Image, Modal,
  TextInput, ScrollView,
} from 'react-native';
import { UserPlus, X, Search, Check, Crown } from 'lucide-react-native';
import { useSession } from '../context/SessionContext';
import {
  getTripMembers, getCircleMembers, getTripInvitableUsers, sendTripInvite,
  type FriendUser,
} from '../services/friends';
import { getTrip } from '../services/trips';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  type: 'trip' | 'circle';
  id: string;
  title?: string;
  onDismiss: () => void;
}

function PersonAvatar({ user, size = 36 }: { user: FriendUser; size?: number }) {
  if (user.avatarUrl) {
    return <Image source={{ uri: user.avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2 }, s.avatarFallback]}>
      <Text style={s.avatarInitial}>
        {(user.name?.[0] ?? user.handle?.[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

function MemberRow({
  user, badge, badgeKind,
}: { user: FriendUser; badge?: string; badgeKind?: 'owner' | 'pending' }) {
  return (
    <View style={s.row}>
      <PersonAvatar user={user} />
      <View style={s.rowMeta}>
        <Text style={s.rowName} numberOfLines={1}>{user.name || user.handle}</Text>
        {user.handle ? <Text style={s.rowHandle} numberOfLines={1}>@{user.handle}</Text> : null}
      </View>
      {badge ? (
        <View style={[
          s.badge,
          badgeKind === 'owner' && s.badgeOwner,
          badgeKind === 'pending' && s.badgePending,
        ]}>
          {badgeKind === 'owner' && <Crown size={10} color={color.signal} />}
          <Text style={[
            s.badgeText,
            badgeKind === 'owner' && s.badgeTextOwner,
            badgeKind === 'pending' && s.badgeTextPending,
          ]}>{badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function TripMembersSheet({ type, id, title, onDismiss }: Props) {
  const { userId } = useSession();

  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<FriendUser[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [canInvite, setCanInvite] = useState(false);

  // Invite picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<FriendUser[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [invited, setInvited] = useState<FriendUser[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // ── Load members (+ ownership for trips) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Reset all context-sensitive state so a circle context can never
      // inherit a stale trip's members, pending invites, or permissions.
      setLoading(true);
      setMembers([]);
      setInvited([]);
      setOwnerId(null);
      setCanInvite(false);
      setPickerOpen(false);
      setCandidates([]);
      setCandidatesLoaded(false);
      setInviteError(null);
      setSearch('');
      setInvitingId(null);
      setCandidatesLoading(false);

      if (type === 'trip') {
        const res = await getTripMembers(id);
        if (cancelled) return;
        if (res.ok && res.data) {
          setMembers(res.data.members);
          setInvited(res.data.invited ?? []);
        }
        const trip = await getTrip(id);
        if (cancelled) return;
        if (trip) {
          setOwnerId(trip.ownerId);
          setCanInvite(!!userId && trip.ownerId === userId);
        }
      } else {
        const res = await getCircleMembers(id);
        if (cancelled) return;
        if (res.ok && res.data) setMembers(res.data.members);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [type, id, userId]);

  // ── Load invite candidates (trip owners only) ──
  const loadCandidates = useCallback(async () => {
    if (candidatesLoaded || candidatesLoading) return;
    setCandidatesLoading(true);
    const res = await getTripInvitableUsers(id);
    if (res.ok && res.data) setCandidates(res.data.otherFollowers);
    setCandidatesLoading(false);
    setCandidatesLoaded(true);
  }, [candidatesLoaded, candidatesLoading, id]);

  useEffect(() => {
    if (pickerOpen) loadCandidates();
  }, [pickerOpen, loadCandidates]);

  async function handleInvite(user: FriendUser) {
    if (invitingId) return;
    setInvitingId(user.id);
    setInviteError(null);
    const res = await sendTripInvite(id, user.id);
    setInvitingId(null);
    if (!res.ok) {
      setInviteError(res.message ?? 'Could not send invite. Try again.');
      return;
    }
    // Move from picker into the Invited section
    setCandidates((prev) => prev.filter((c) => c.id !== user.id));
    setInvited((prev) => (prev.some((u) => u.id === user.id) ? prev : [...prev, user]));
  }

  const q = search.trim().toLowerCase();
  const filteredCandidates = q
    ? candidates.filter((c) =>
        (c.name?.toLowerCase().includes(q) || c.handle?.toLowerCase().includes(q)) ?? false)
    : candidates;

  const sheetTitle = title ?? (type === 'trip' ? 'Trip members' : 'Circle members');
  // Backend excludes the caller from `members`, so add 1 for the current user.
  const totalCount = members.length + 1;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onDismiss}>
      <Pressable style={s.overlay} onPress={onDismiss} />
      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.head}>
          <Text style={s.title}>{sheetTitle}</Text>
          {!loading && (
            <Text style={s.count}>{totalCount} {totalCount === 1 ? 'member' : 'members'}</Text>
          )}
          <View style={{ flex: 1 }} />
          <Pressable onPress={onDismiss} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={color.signal} /></View>
        ) : (
          <ScrollView style={s.scroll} contentContainerStyle={s.scrollBody} keyboardShouldPersistTaps="handled">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                user={m}
                badge={ownerId && m.id === ownerId ? 'Owner' : undefined}
                badgeKind="owner"
              />
            ))}

            {type === 'trip' && invited.length > 0 && (
              <>
                <Text style={s.sectionLabel}>Invited</Text>
                {invited.map((u) => (
                  <MemberRow key={u.id} user={u} badge="Pending" badgeKind="pending" />
                ))}
              </>
            )}

            {members.length === 0 && invited.length === 0 && (
              <Text style={s.emptyNote}>No members yet.</Text>
            )}

            {/* ── Invite action (trip owners only) ── */}
            {canInvite && !pickerOpen && (
              <Pressable style={s.inviteBtn} onPress={() => setPickerOpen(true)}>
                <UserPlus size={16} color={color.onInk} />
                <Text style={s.inviteBtnText}>Invite a friend</Text>
              </Pressable>
            )}

            {canInvite && pickerOpen && (
              <View style={s.picker}>
                <View style={s.searchRow}>
                  <Search size={14} color={color.mute} />
                  <TextInput
                    style={s.searchInput}
                    placeholder="Search friends"
                    placeholderTextColor={color.faint}
                    value={search}
                    onChangeText={setSearch}
                    autoCorrect={false}
                  />
                  <Pressable onPress={() => { setPickerOpen(false); setSearch(''); }} hitSlop={8}>
                    <X size={16} color={color.mute} />
                  </Pressable>
                </View>

                {inviteError ? <Text style={s.errorText}>{inviteError}</Text> : null}

                {candidatesLoading ? (
                  <View style={s.center}><ActivityIndicator color={color.signal} /></View>
                ) : filteredCandidates.length === 0 ? (
                  <Text style={s.emptyNote}>
                    {candidatesLoaded
                      ? (q ? 'No friends match your search.' : 'No friends left to invite.')
                      : ''}
                  </Text>
                ) : (
                  filteredCandidates.map((c) => (
                    <Pressable
                      key={c.id}
                      style={s.candidateRow}
                      onPress={() => handleInvite(c)}
                      disabled={!!invitingId}
                    >
                      <PersonAvatar user={c} size={32} />
                      <View style={s.rowMeta}>
                        <Text style={s.rowName} numberOfLines={1}>{c.name || c.handle}</Text>
                        {c.handle ? <Text style={s.rowHandle} numberOfLines={1}>@{c.handle}</Text> : null}
                      </View>
                      {invitingId === c.id ? (
                        <ActivityIndicator size="small" color={color.signal} />
                      ) : (
                        <View style={s.candidateAdd}>
                          <UserPlus size={14} color={color.signal} />
                        </View>
                      )}
                    </Pressable>
                  ))
                )}
              </View>
            )}
          </ScrollView>
        )}
      </View>
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
    paddingBottom: 34,
    paddingTop: space.sm,
    maxHeight: '80%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  count: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 11 },
  center: { paddingVertical: space.xl, alignItems: 'center' },
  scroll: { flexGrow: 0 },
  scrollBody: { paddingBottom: space.md },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10 },
  rowMeta: { flex: 1, minWidth: 0 },
  rowName: { ...t.body, color: color.ink, fontWeight: '600' },
  rowHandle: { ...t.small, color: color.mute, fontSize: 12 },

  avatarFallback: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 14 },

  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  badgeOwner: { borderColor: color.signal, backgroundColor: color.paper },
  badgePending: { borderColor: color.haze, backgroundColor: color.paper },
  badgeText: { ...t.small, fontWeight: '700', fontSize: 10 },
  badgeTextOwner: { color: color.signal },
  badgeTextPending: { color: color.mute },

  sectionLabel: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 11, letterSpacing: 0.5, marginTop: space.md, marginBottom: 2, textTransform: 'uppercase' },
  emptyNote: { ...t.small, color: color.mute, fontStyle: 'italic', paddingVertical: space.md },

  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 12, marginTop: space.md,
  },
  inviteBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },

  picker: { marginTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, paddingTop: space.md },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: 8, marginBottom: space.sm,
  },
  searchInput: { flex: 1, ...t.body, color: color.ink, padding: 0 },
  errorText: { ...t.small, color: '#DC2626', marginBottom: space.sm },
  candidateRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 8 },
  candidateAdd: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
});
