import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, Image, ActivityIndicator,
  StyleSheet, Alert, TextInput, Share, Platform,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, UserPlus, UserMinus, Link2, Link2Off, UserCircle, Crown, Users, Check, X, Search } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { useTripMembers } from '../../src/hooks/useBackend';
import { useTrip } from '../../src/hooks/useBackend';
import {
  listInvitableUsers, inviteMember, removeMember,
  generateInviteLink, revokeInviteLink,
  type TripMember, type InvitableUser, type InviteLink,
} from '../../src/services/trips';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

export default function TripCrew() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;

  const { data: trip, loading: tripLoading } = useTrip(live ? tripId : undefined);
  const { members, invited, loading: membersLoading, reload: reloadMembers } = useTripMembers(live ? tripId : undefined);
  const isOwner = trip?.ownerId === userId;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<InviteLink | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleGenerateLink() {
    if (!tripId || linkLoading) return;
    setLinkLoading(true);
    try {
      const link = await generateInviteLink(tripId);
      setInviteLink(link);
    } catch {
      Alert.alert('Error', 'Could not generate invite link.');
    } finally {
      setLinkLoading(false);
    }
  }

  async function handleRevokeLink() {
    if (!tripId || !inviteLink) return;
    setLinkLoading(true);
    try {
      await revokeInviteLink(tripId, inviteLink.id);
      setInviteLink(null);
    } catch {
      Alert.alert('Error', 'Could not revoke link.');
    } finally {
      setLinkLoading(false);
    }
  }

  async function handleShareLink() {
    if (!inviteLink) return;
    try {
      await Share.share({ message: `Join my trip! ${inviteLink.url}` });
    } catch {}
  }

  async function handleRemoveMember(member: TripMember) {
    if (!tripId) return;
    Alert.alert(
      'Remove member',
      `Remove ${member.name || member.handle} from this trip?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingId(member.id);
            await removeMember(tripId, member.id);
            await reloadMembers();
            setRemovingId(null);
          },
        },
      ],
    );
  }

  if (!live) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Trip Crew" back />
        <View style={styles.empty}>
          <Text style={styles.emptyTxt}>Sign in to manage trip crew.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title="Trip Crew"
        back={false}
        left={
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
            <ChevronLeft size={20} color={color.ink} />
          </Pressable>
        }
        right={
          isOwner ? (
            <Pressable style={styles.inviteBtn} onPress={() => setInviteOpen(true)}>
              <UserPlus size={15} color={color.onInk} />
              <Text style={styles.inviteBtnTxt}>Invite</Text>
            </Pressable>
          ) : undefined
        }
      />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Members */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Members {members.length > 0 ? `(${members.length})` : ''}</Text>
          {membersLoading
            ? <ActivityIndicator color={color.signal} style={{ marginTop: space.md }} />
            : members.length === 0
            ? <Text style={styles.emptySection}>No members yet other than you.</Text>
            : members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isOwner={isOwner}
                isYou={m.id === userId}
                removing={removingId === m.id}
                onRemove={() => handleRemoveMember(m)}
              />
            ))}
        </View>

        {/* Invited */}
        {invited.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Invited ({invited.length})</Text>
            {invited.map((m) => (
              <MemberRow
                key={m.id}
                member={{ ...m, role: 'invited' }}
                isOwner={isOwner}
                isYou={false}
                removing={removingId === m.id}
                onRemove={isOwner ? () => handleRemoveMember(m) : undefined}
                pending
              />
            ))}
          </View>
        )}

        {/* Invite link */}
        {isOwner && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Invite Link</Text>
            {inviteLink ? (
              <View style={styles.linkCard}>
                <View style={styles.linkRow}>
                  <Link2 size={14} color={color.signal} />
                  <Text style={styles.linkUrl} numberOfLines={1} selectable>{inviteLink.url}</Text>
                </View>
                <View style={styles.linkBtns}>
                  <Pressable style={styles.linkBtn} onPress={handleShareLink}>
                    <Text style={styles.linkBtnTxt}>Share</Text>
                  </Pressable>
                  <Pressable style={[styles.linkBtn, styles.linkBtnDanger]} onPress={handleRevokeLink} disabled={linkLoading}>
                    {linkLoading
                      ? <ActivityIndicator size="small" color={color.signal} />
                      : <><Link2Off size={13} color={color.signal} /><Text style={[styles.linkBtnTxt, { color: color.signal }]}>Revoke</Text></>}
                  </Pressable>
                </View>
                {inviteLink.expiresAt && <Text style={styles.linkExpiry}>Expires {new Date(inviteLink.expiresAt).toLocaleDateString()}</Text>}
              </View>
            ) : (
              <Pressable style={styles.genLinkBtn} onPress={handleGenerateLink} disabled={linkLoading}>
                {linkLoading
                  ? <ActivityIndicator color={color.onInk} />
                  : <><Link2 size={15} color={color.onInk} /><Text style={styles.genLinkTxt}>Generate invite link</Text></>}
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>

      {/* Invite picker sheet */}
      {inviteOpen && tripId && (
        <InviteSheet
          tripId={tripId}
          onClose={() => setInviteOpen(false)}
          onInvited={reloadMembers}
        />
      )}
    </View>
  );
}

/* ─── Member row ─────────────────────────────────────────────────────────────── */

function MemberRow({
  member, isOwner, isYou, removing, onRemove, pending = false,
}: {
  member: TripMember;
  isOwner: boolean;
  isYou: boolean;
  removing: boolean;
  onRemove?: () => void;
  pending?: boolean;
}) {
  const roleLabel = pending ? 'Invited'
    : member.role === 'owner' ? 'Owner'
    : member.role === 'co_host' ? 'Co-host'
    : member.role === 'viewer' ? 'Viewer'
    : 'Member';

  const rolePillBg = member.role === 'owner' ? color.deep + '20'
    : pending ? color.signal + '15'
    : color.haze;

  const rolePillColor = member.role === 'owner' ? color.deep
    : pending ? color.signal
    : color.mute;

  return (
    <View style={styles.memberRow}>
      {member.avatarUrl
        ? <Image source={{ uri: member.avatarUrl }} style={styles.memberAv} />
        : <View style={styles.memberAvPH}><UserCircle size={22} color={color.mute} /></View>}
      <View style={{ flex: 1 }}>
        <Text style={styles.memberName} numberOfLines={1}>
          {member.name || member.handle}{isYou ? ' (you)' : ''}
        </Text>
        <Text style={styles.memberHandle} numberOfLines={1}>@{member.handle}</Text>
      </View>
      <View style={[styles.rolePill, { backgroundColor: rolePillBg }]}>
        {member.role === 'owner' && <Crown size={10} color={rolePillColor} />}
        <Text style={[styles.roleTxt, { color: rolePillColor }]}>{roleLabel}</Text>
      </View>
      {isOwner && !isYou && onRemove && (
        <Pressable style={styles.removeBtn} onPress={onRemove} hitSlop={8} disabled={removing}>
          {removing
            ? <ActivityIndicator size="small" color={color.signal} />
            : <UserMinus size={16} color={color.signal} />}
        </Pressable>
      )}
    </View>
  );
}

/* ─── Invite sheet ───────────────────────────────────────────────────────────── */

function InviteSheet({ tripId, onClose, onInvited }: { tripId: string; onClose: () => void; onInvited: () => void }) {
  const [users, setUsers] = useState<InvitableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  React.useEffect(() => {
    let active = true;
    listInvitableUsers(tripId).then((list) => { if (active) { setUsers(list); setLoading(false); } }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tripId]);

  const filtered = query
    ? users.filter((u) =>
        u.name.toLowerCase().includes(query.toLowerCase()) ||
        u.handle.toLowerCase().includes(query.toLowerCase()))
    : users;

  async function handleInvite(u: InvitableUser) {
    if (inviting) return;
    setInviting(u.id);
    try {
      await inviteMember(tripId, u.id);
      setInvited((s) => new Set([...s, u.id]));
      onInvited();
    } catch {}
    setInviting(null);
  }

  return (
    <View style={sheet.overlay}>
      <Pressable style={sheet.backdrop} onPress={onClose} />
      <View style={sheet.panel}>
        <View style={sheet.header}>
          <Text style={sheet.title}>Invite to trip</Text>
          <Pressable onPress={onClose} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
        </View>
        <View style={sheet.searchRow}>
          <Search size={15} color={color.mute} />
          <TextInput
            style={sheet.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or handle…"
            placeholderTextColor={color.faint}
            autoFocus
          />
        </View>
        {loading
          ? <ActivityIndicator style={{ margin: space.xl }} color={color.signal} />
          : filtered.length === 0
          ? <Text style={sheet.empty}>{query ? 'No matches found.' : 'No one to invite yet.'}</Text>
          : (
            <ScrollView style={{ maxHeight: 400 }} keyboardShouldPersistTaps="handled">
              {filtered.map((u) => {
                const isInvited = invited.has(u.id);
                return (
                  <View key={u.id} style={sheet.row}>
                    {u.avatarUrl
                      ? <Image source={{ uri: u.avatarUrl }} style={sheet.av} />
                      : <View style={sheet.avPH}><UserCircle size={20} color={color.mute} /></View>}
                    <View style={{ flex: 1 }}>
                      <Text style={sheet.name} numberOfLines={1}>{u.name}</Text>
                      <Text style={sheet.handle} numberOfLines={1}>@{u.handle}</Text>
                    </View>
                    <Pressable
                      style={[sheet.invBtn, isInvited && sheet.invBtnSent]}
                      onPress={() => handleInvite(u)}
                      disabled={isInvited || inviting === u.id}
                    >
                      {inviting === u.id
                        ? <ActivityIndicator size="small" color={color.onInk} />
                        : isInvited
                        ? <><Check size={13} color={color.mute} /><Text style={sheet.invBtnSentTxt}>Invited</Text></>
                        : <Text style={sheet.invBtnTxt}>Invite</Text>}
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          )}
      </View>
    </View>
  );
}

const sheet = StyleSheet.create({
  overlay: { position: 'absolute', inset: 0, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  panel: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  title: { ...t.title, color: color.ink, fontSize: 17 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, margin: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: color.haze },
  searchInput: { flex: 1, ...t.body, color: color.ink },
  empty: { ...t.small, color: color.mute, textAlign: 'center', margin: space.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.haze + '80' },
  av: { width: 40, height: 40, borderRadius: 20 },
  avPH: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  name: { ...t.bodyStrong, color: color.ink, fontWeight: '600' as const },
  handle: { ...t.small, color: color.mute },
  invBtn: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: color.ink, flexDirection: 'row', alignItems: 'center', gap: 4 },
  invBtnSent: { backgroundColor: color.haze },
  invBtnTxt: { ...t.small, color: color.onInk, fontWeight: '700' as const },
  invBtnSentTxt: { ...t.small, color: color.mute },
});

const styles = StyleSheet.create({
  scroll: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  backBtn: { paddingHorizontal: space.sm },
  inviteBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  inviteBtnTxt: { ...t.small, color: color.onInk, fontWeight: '700' as const },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTxt: { ...t.body, color: color.mute, textAlign: 'center' },
  emptySection: { ...t.small, color: color.mute, paddingVertical: space.md },
  section: { gap: space.sm },
  sectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' as const, marginBottom: 2 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, borderWidth: 1, borderColor: color.haze },
  memberAv: { width: 42, height: 42, borderRadius: 21 },
  memberAvPH: { width: 42, height: 42, borderRadius: 21, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  memberName: { ...t.bodyStrong, color: color.ink, fontWeight: '600' as const },
  memberHandle: { ...t.small, color: color.mute },
  rolePill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill },
  roleTxt: { fontSize: 11, fontWeight: '700' as const },
  removeBtn: { padding: 4 },
  linkCard: { backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: color.haze },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkUrl: { flex: 1, ...t.small, color: color.ink, fontFamily: 'Courier' },
  linkBtns: { flexDirection: 'row', gap: space.sm },
  linkBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: color.ink },
  linkBtnDanger: { backgroundColor: color.signal + '15', borderWidth: 1, borderColor: color.signal + '40' },
  linkBtnTxt: { ...t.small, color: color.onInk, fontWeight: '700' as const },
  linkExpiry: { ...t.small, color: color.faint, textAlign: 'center' },
  genLinkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: color.ink, borderRadius: radius.lg, paddingVertical: space.md },
  genLinkTxt: { ...t.body, color: color.onInk, fontWeight: '700' as const },
});
