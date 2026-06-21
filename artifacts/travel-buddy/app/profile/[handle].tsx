import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { Users, CheckCircle, UserPlus, Clock, UserCheck, MessageCircle, X } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { getProfileByHandle } from '../../src/services/friends';
import { useSession } from '../../src/context/SessionContext';
import { useFriendStatus } from '../../src/hooks/useFriends';
import { useMessagePermission } from '../../src/hooks/useMessaging';
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
  spokenLanguages: string[];
  defaultLanguage: string | null;
  travelStyles: string[];
  travelPace: string | null;
  budgetStyle: string | null;
  travelGroupStyle: string[];
  lookingFor: string[];
  comfortLevel: string | null;
  availabilityTags: string[];
  planningStyle: string | null;
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
    return <View style={s.actionBtn}><ActivityIndicator size="small" color={color.mute} /></View>;
  }

  if (status === 'friends') {
    return (
      <View style={[s.actionBtn, s.friendsBtnStyle]}>
        <UserCheck size={15} color={color.signal} />
        <Text style={[s.btnText, { color: color.signal }]}>Friends</Text>
      </View>
    );
  }

  if (status === 'outgoing_pending') {
    return (
      <Pressable style={[s.actionBtn, s.pendingBtnStyle]} onPress={() => run(cancel)} disabled={busy}>
        <Clock size={15} color={color.mute} />
        <Text style={[s.btnText, { color: color.mute }]}>{busy ? 'Cancelling…' : 'Request Sent'}</Text>
      </Pressable>
    );
  }

  if (status === 'incoming_pending') {
    return (
      <View style={s.incomingRow}>
        <Pressable style={[s.actionBtn, s.acceptBtnStyle, { flex: 1 }]} onPress={() => run(accept)} disabled={busy}>
          <Text style={[s.btnText, { color: '#fff' }]}>{busy ? '…' : 'Accept'}</Text>
        </Pressable>
        <Pressable style={[s.actionBtn, s.declineBtnStyle, { flex: 1 }]} onPress={() => run(decline)} disabled={busy}>
          <Text style={[s.btnText, { color: color.ink }]}>{busy ? '…' : 'Decline'}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable style={[s.actionBtn, s.addFriendBtnStyle]} onPress={() => run(send)} disabled={busy}>
      <UserPlus size={15} color="#fff" />
      <Text style={[s.btnText, { color: '#fff' }]}>{busy ? 'Sending…' : 'Add Friend'}</Text>
    </Pressable>
  );
}

function MessageButton({ userId, isOwn }: { userId: string; isOwn: boolean }) {
  const { verdict, loading, send } = useMessagePermission(isOwn ? null : userId);
  const [showComposer, setShowComposer] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  if (isOwn || !userId) return null;
  if (loading) return null;

  if (verdict === 'denied') {
    return (
      <View style={[s.actionBtn, s.disabledBtnStyle]}>
        <MessageCircle size={15} color={color.faint} />
        <Text style={[s.btnText, { color: color.faint }]}>Not accepting messages</Text>
      </View>
    );
  }

  if (verdict === 'allowed') {
    return (
      <Pressable
        style={[s.actionBtn, s.msgBtnStyle]}
        onPress={() => router.push('/messages')}
      >
        <MessageCircle size={15} color={color.ink} />
        <Text style={[s.btnText, { color: color.ink }]}>Message</Text>
      </Pressable>
    );
  }

  if (verdict === 'requires_request') {
    if (sent) {
      return (
        <View style={[s.actionBtn, s.pendingBtnStyle]}>
          <MessageCircle size={15} color={color.mute} />
          <Text style={[s.btnText, { color: color.mute }]}>Request sent</Text>
        </View>
      );
    }

    return (
      <>
        <Pressable
          style={[s.actionBtn, s.msgBtnStyle]}
          onPress={() => setShowComposer(true)}
        >
          <MessageCircle size={15} color={color.ink} />
          <Text style={[s.btnText, { color: color.ink }]}>Message</Text>
        </Pressable>

        <Modal visible={showComposer} transparent animationType="slide">
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>Send a message request</Text>
                <Pressable onPress={() => setShowComposer(false)} hitSlop={8}>
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <TextInput
                style={s.composerInput}
                placeholder="Introduce yourself… (optional)"
                placeholderTextColor={color.faint}
                value={previewText}
                onChangeText={setPreviewText}
                maxLength={280}
                multiline
                numberOfLines={3}
              />
              <Pressable
                style={[s.actionBtn, s.addFriendBtnStyle, { marginTop: space.sm }]}
                disabled={busy}
                onPress={async () => {
                  setBusy(true);
                  const res = await send(previewText.trim() || undefined);
                  setBusy(false);
                  if (res.ok) {
                    setSent(true);
                    setShowComposer(false);
                  } else {
                    Alert.alert('Error', res.message ?? 'Could not send request');
                  }
                }}
              >
                <Text style={[s.btnText, { color: '#fff' }]}>
                  {busy ? 'Sending…' : 'Send Request'}
                </Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </>
    );
  }

  return null;
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

        <View style={s.heroRow}>
          {profile.avatarUrl
            ? <Image source={{ uri: profile.avatarUrl }} style={s.avatar} />
            : <View style={[s.avatar, s.avatarPlaceholder]}>
                <Text style={s.avatarInitial}>{(profile.name?.[0] ?? '?').toUpperCase()}</Text>
              </View>
          }
          <View style={{ flex: 1, gap: 4 }}>
            <View style={s.nameRow}>
              <Text style={s.name} numberOfLines={1}>{profile.name}</Text>
              {profile.verified && <CheckCircle size={16} color={color.signal} />}
            </View>
            <Text style={s.handle}>@{profile.handle}</Text>
            {locationParts.length > 0 && <Text style={s.meta}>{locationParts.join(' · ')}</Text>}
          </View>
        </View>

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

        <View style={s.stampRow}>
          {profile.openToMeet && <Stamp label="open to meet" tone="signal" />}
          {profile.travelStyle ? <Stamp label={profile.travelStyle} tone="deep" rotate={2} /> : null}
          {(profile.interests ?? []).slice(0, 3).map((i) => <Stamp key={i} label={i} rotate={-2} />)}
        </View>

        {((profile.travelStyles?.length ?? 0) > 0 || profile.travelPace || profile.budgetStyle) && (
          <AboutRow label="TRAVEL STYLE">
            {(profile.travelStyles ?? []).map((ts) => <InfoChip key={ts} label={ts} />)}
            {profile.travelPace && <InfoChip label={`${profile.travelPace} pace`} accent />}
            {profile.budgetStyle && <InfoChip label={profile.budgetStyle} />}
          </AboutRow>
        )}

        {(profile.spokenLanguages?.length ?? 0) > 0 && (
          <AboutRow label="SPEAKS">
            {(profile.spokenLanguages ?? []).map((lang) => <InfoChip key={lang} label={lang} />)}
          </AboutRow>
        )}

        {(profile.lookingFor?.length ?? 0) > 0 && (
          <AboutRow label="LOOKING FOR">
            {(profile.lookingFor ?? []).map((lf) => <InfoChip key={lf} label={lf} />)}
          </AboutRow>
        )}

        {((profile.availabilityTags?.length ?? 0) > 0 || profile.planningStyle) && (
          <AboutRow label="AVAILABILITY">
            {(profile.availabilityTags ?? []).map((tag) => <InfoChip key={tag} label={tag} />)}
            {profile.planningStyle && <InfoChip label={profile.planningStyle.replace(/_/g, ' ')} accent />}
          </AboutRow>
        )}

        {!isOwn && (
          <View style={s.actions}>
            <FriendButton userId={profile.id} isOwn={isOwn} />
            <MessageButton userId={profile.id} isOwn={isOwn} />
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

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.aboutRow}>
      <Text style={s.aboutLabel}>{label}</Text>
      <View style={s.aboutChips}>{children}</View>
    </View>
  );
}

function InfoChip({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <View style={[s.infoChip, accent && s.infoChipAccent]}>
      <Text style={[s.infoChipText, accent && s.infoChipTextAccent]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errText: { ...t.body, color: color.mute },
  heroRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: color.haze, flexShrink: 0 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.title, color: color.ink, fontSize: 28 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  name: { ...t.title, color: color.ink, fontSize: 20, flexShrink: 1 },
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
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  btnText: { ...t.small, fontWeight: '700', fontSize: 14 },
  addFriendBtnStyle: { backgroundColor: color.ink },
  pendingBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  friendsBtnStyle: { borderWidth: 1, borderColor: color.signal, backgroundColor: color.paperRaised },
  acceptBtnStyle: { backgroundColor: color.signal },
  declineBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  msgBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  disabledBtnStyle: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  privateNote: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: 10, backgroundColor: color.paperRaised },
  privateText: { ...t.small, color: color.mute, flex: 1 },
  aboutRow: { gap: 6 },
  aboutLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8 },
  aboutChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  infoChip: { borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: color.paperRaised },
  infoChipAccent: { backgroundColor: color.deep, borderColor: color.deep },
  infoChipText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },
  infoChipTextAccent: { color: color.onInk },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(17,17,15,0.5)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.xl, gap: space.md },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { ...t.heading, color: color.ink },
  composerInput: { ...t.body, color: color.ink, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, minHeight: 80, textAlignVertical: 'top' },
});
