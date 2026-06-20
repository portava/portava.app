import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Users, CheckCircle, UserPlus, Clock, UserCheck } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { getProfileByHandle } from '../../src/services/friends';
import { useSession } from '../../src/context/SessionContext';
import { useFriendStatus } from '../../src/hooks/useFriends';
import { color, space, radius, type as t } from '../../src/theme/tokens';

interface PublicProfile {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  currentCity: string | null;
  travelStyle: string | null;
  interests: string[];
  verified: boolean;
  openToMeet: boolean;
  isPrivate: boolean;
  followersCount: number;
  followingCount: number;
  isFollowing: boolean;
  isOwnProfile: boolean;
}

function FriendButton({ userId, isOwn }: { userId: string; isOwn: boolean }) {
  const { status, loading, send, accept, decline, cancel } = useFriendStatus(isOwn ? null : userId);
  const [busy, setBusy] = useState(false);

  if (isOwn || !userId) return null;

  async function run(action: () => Promise<any>) {
    setBusy(true);
    await action();
    setBusy(false);
  }

  if (loading) {
    return <View style={s.friendBtn}><ActivityIndicator size="small" color={color.mute} /></View>;
  }

  if (status === 'friends') {
    return (
      <View style={[s.friendBtn, s.friendsBtnStyle]}>
        <UserCheck size={15} color={color.signal} />
        <Text style={[s.friendBtnText, { color: color.signal }]}>Friends</Text>
      </View>
    );
  }

  if (status === 'outgoing_pending') {
    return (
      <Pressable style={[s.friendBtn, s.pendingBtnStyle]} onPress={() => run(cancel)} disabled={busy}>
        <Clock size={15} color={color.mute} />
        <Text style={[s.friendBtnText, { color: color.mute }]}>{busy ? 'Cancelling…' : 'Request Sent'}</Text>
      </Pressable>
    );
  }

  if (status === 'incoming_pending') {
    return (
      <View style={s.incomingRow}>
        <Pressable style={[s.friendBtn, s.acceptBtnStyle, { flex: 1 }]} onPress={() => run(accept)} disabled={busy}>
          <Text style={[s.friendBtnText, { color: '#fff' }]}>{busy ? '…' : 'Accept'}</Text>
        </Pressable>
        <Pressable style={[s.friendBtn, s.declineBtnStyle, { flex: 1 }]} onPress={() => run(decline)} disabled={busy}>
          <Text style={[s.friendBtnText, { color: color.ink }]}>{busy ? '…' : 'Decline'}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable style={[s.friendBtn, s.addFriendBtnStyle]} onPress={() => run(send)} disabled={busy}>
      <UserPlus size={15} color="#fff" />
      <Text style={[s.friendBtnText, { color: '#fff' }]}>{busy ? 'Sending…' : 'Add Friend'}</Text>
    </Pressable>
  );
}

export default function Profile() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const { userId: currentUserId } = useSession();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    if (!handle) return;
    setLoading(true);
    setLoadError(null);
    const res = await getProfileByHandle(handle as string);
    if (res.ok && res.data) setProfile(res.data as PublicProfile);
    else setLoadError('Could not load this profile.');
    setLoading(false);
  }, [handle]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  useFocusEffect(useCallback(() => { loadProfile(); }, [loadProfile]));

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title={handle ? `@${handle}` : 'Profile'} back />
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (loadError || !profile) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Profile" back />
        <View style={s.center}><Text style={s.errText}>{loadError ?? 'Profile not found.'}</Text></View>
      </View>
    );
  }

  const isOwn = profile.id === currentUserId;
  const locationParts = [
    profile.currentCity ? `Now in ${profile.currentCity}` : null,
    profile.homeCity,
    profile.homeCountry,
  ].filter(Boolean);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title={`@${profile.handle}`} back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>

        {/* Avatar + name */}
        <View style={s.heroRow}>
          {profile.avatarUrl
            ? <Image source={{ uri: profile.avatarUrl }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarPlaceholder]}>
                <Text style={s.avatarInitial}>{(profile.name?.[0] ?? '?').toUpperCase()}</Text>
              </View>
          }
          <View style={{ flex: 1, gap: 4 }}>
            <View style={s.nameRow}>
              <Text style={s.name}>{profile.name}</Text>
              {profile.verified && <CheckCircle size={16} color={color.signal} />}
            </View>
            <Text style={s.handle}>@{profile.handle}</Text>
            {locationParts.length > 0 && <Text style={s.meta}>{locationParts.join(' · ')}</Text>}
          </View>
        </View>

        {/* Follow / follower counts */}
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statNum}>{profile.followersCount}</Text>
            <Text style={s.statLabel}>Followers</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statNum}>{profile.followingCount}</Text>
            <Text style={s.statLabel}>Following</Text>
          </View>
        </View>

        {profile.bio ? <Text style={s.bio}>{profile.bio}</Text> : null}

        {/* Stamps / traits */}
        <View style={s.stampRow}>
          {profile.openToMeet && <Stamp label="open to meet" tone="signal" />}
          {profile.travelStyle ? <Stamp label={profile.travelStyle} tone="deep" rotate={2} /> : null}
          {(profile.interests ?? []).slice(0, 3).map((i) => <Stamp key={i} label={i} rotate={-2} />)}
        </View>

        {/* Action buttons (not shown on own profile) */}
        {!isOwn && (
          <View style={s.actions}>
            <FriendButton userId={profile.id} isOwn={isOwn} />
            <Pressable style={s.msgBtn}>
              <Text style={s.msgText}>Message</Text>
            </Pressable>
          </View>
        )}

        {profile.isPrivate && !isOwn && (
          <View style={s.privateNote}>
            <Users size={14} color={color.mute} />
            <Text style={s.privateText}>This profile is private. Add as a friend to see more.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errText: { ...t.body, color: color.mute },
  heroRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: color.haze },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.title, color: color.ink, fontSize: 28 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { ...t.title, color: color.ink, fontSize: 20 },
  handle: { ...t.small, color: color.mute },
  meta: { ...t.small, color: color.deep },
  statsRow: { flexDirection: 'row', gap: space.xl },
  stat: { alignItems: 'center' },
  statNum: { ...t.title, color: color.ink, fontSize: 18 },
  statLabel: { ...t.small, color: color.mute },
  bio: { ...t.body, color: color.ink },
  stampRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  actions: { gap: space.sm, marginTop: space.sm },
  incomingRow: { flexDirection: 'row', gap: space.sm },
  friendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  friendBtnText: { ...t.small, fontWeight: '700', fontSize: 14 },
  addFriendBtnStyle: { backgroundColor: color.ink },
  pendingBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  friendsBtnStyle: { borderWidth: 1, borderColor: color.signal, backgroundColor: color.paperRaised },
  acceptBtnStyle: { backgroundColor: color.signal },
  declineBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  msgBtn: { borderWidth: 1, borderColor: color.haze, paddingVertical: 11, borderRadius: radius.pill, alignItems: 'center' },
  msgText: { ...t.small, fontWeight: '700', color: color.ink },
  privateNote: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: 10, backgroundColor: color.paperRaised },
  privateText: { ...t.small, color: color.mute, flex: 1 },
});
