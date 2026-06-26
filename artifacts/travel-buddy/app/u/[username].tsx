import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet,
  Alert, Modal, TextInput,
} from 'react-native';
import { useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Users, UserCheck, UserPlus, Clock,
  MessageCircle, X, MoreVertical, ShieldAlert,
} from 'lucide-react-native';
import { usePublicPassport } from '../../src/hooks/usePublicPassport';
import { useFollow } from '../../src/hooks/useFollow';
import { useHighlightRingState, viewedHighlightIds } from '../../src/hooks/useHighlightRingState';
import { useFriendStatus } from '../../src/hooks/useFriends';
import { useMessagePermission } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { PassportHero } from '../../src/components/PassportHero';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { AboutTab } from '../../src/components/AboutTab';
import { MapTab } from '../../src/components/MapTab';
import { getProfileByHandle, getProfileById } from '../../src/services/friends';
import { blockUser, getBlockStatus } from '../../src/services/blocks';
import type { PublicProfile } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';

type Tab = 'postcards' | 'stamps' | 'map' | 'about';
const TABS: { key: Tab; label: string }[] = [
  { key: 'postcards', label: 'Postcards' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'map', label: 'Map' },
  { key: 'about', label: 'About' },
];

interface SocialProfile {
  id: string;
  handle: string | null;
  name: string | null;
  openToMeet: boolean;
  isPrivate: boolean;
  isOwnProfile: boolean;
  spokenLanguages: string[];
  travelStyles: string[];
  travelPace: string | null;
  budgetStyle: string | null;
  travelGroupStyle: string[];
  lookingFor: string[];
  availabilityTags: string[];
  planningStyle: string | null;
  comfortLevel: string | null;
}

// ── Friend action button ─────────────────────────────────────────────────────

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
    return <View style={st.actionBtn}><ActivityIndicator size="small" color={color.mute} /></View>;
  }

  if (status === 'friends') {
    return (
      <View style={[st.actionBtn, st.friendsBtnStyle]}>
        <UserCheck size={15} color={color.signal} />
        <Text style={[st.btnText, { color: color.signal }]}>Friends</Text>
      </View>
    );
  }

  if (status === 'outgoing_pending') {
    return (
      <Pressable style={[st.actionBtn, st.pendingBtnStyle]} onPress={() => run(cancel)} disabled={busy}>
        <Clock size={15} color={color.mute} />
        <Text style={[st.btnText, { color: color.mute }]}>{busy ? 'Cancelling…' : 'Request Sent'}</Text>
      </Pressable>
    );
  }

  if (status === 'incoming_pending') {
    return (
      <View style={st.incomingRow}>
        <Pressable style={[st.actionBtn, st.acceptBtnStyle, { flex: 1 }]} onPress={() => run(accept)} disabled={busy}>
          <Text style={[st.btnText, { color: '#fff' }]}>{busy ? '…' : 'Accept'}</Text>
        </Pressable>
        <Pressable style={[st.actionBtn, st.declineBtnStyle, { flex: 1 }]} onPress={() => run(decline)} disabled={busy}>
          <Text style={[st.btnText, { color: color.ink }]}>{busy ? '…' : 'Decline'}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable style={[st.actionBtn, st.addFriendBtnStyle]} onPress={() => run(send)} disabled={busy}>
      <UserPlus size={15} color="#fff" />
      <Text style={[st.btnText, { color: '#fff' }]}>{busy ? 'Sending…' : 'Add Friend'}</Text>
    </Pressable>
  );
}

// ── Message button ───────────────────────────────────────────────────────────

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
      <View style={[st.actionBtn, st.disabledBtnStyle]}>
        <MessageCircle size={15} color={color.faint} />
        <Text style={[st.btnText, { color: color.faint }]}>Not accepting messages</Text>
      </View>
    );
  }

  if (verdict === 'allowed') {
    return (
      <Pressable style={[st.actionBtn, st.msgBtnStyle]} onPress={() => router.push('/messages')}>
        <MessageCircle size={15} color={color.ink} />
        <Text style={[st.btnText, { color: color.ink }]}>Message</Text>
      </Pressable>
    );
  }

  if (verdict === 'requires_request') {
    if (sent) {
      return (
        <View style={[st.actionBtn, st.pendingBtnStyle]}>
          <MessageCircle size={15} color={color.mute} />
          <Text style={[st.btnText, { color: color.mute }]}>Request sent</Text>
        </View>
      );
    }

    return (
      <>
        <Pressable style={[st.actionBtn, st.msgBtnStyle]} onPress={() => setShowComposer(true)}>
          <MessageCircle size={15} color={color.ink} />
          <Text style={[st.btnText, { color: color.ink }]}>Message</Text>
        </Pressable>

        <Modal visible={showComposer} transparent animationType="slide">
          <View style={st.modalOverlay}>
            <View style={st.modalCard}>
              <View style={st.modalHeader}>
                <Text style={st.modalTitle}>Send a message request</Text>
                <Pressable onPress={() => setShowComposer(false)} hitSlop={8}>
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <TextInput
                style={st.composerInput}
                placeholder="Introduce yourself… (optional)"
                placeholderTextColor={color.faint}
                value={previewText}
                onChangeText={setPreviewText}
                maxLength={280}
                multiline
                numberOfLines={3}
              />
              <Pressable
                style={[st.actionBtn, st.addFriendBtnStyle, { marginTop: space.sm }]}
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
                <Text style={[st.btnText, { color: '#fff' }]}>
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

// ── Kebab / block menu ───────────────────────────────────────────────────────

function KebabMenu({
  userId, name, handle, onBlocked,
}: { userId: string; name: string | null; handle: string | null; onBlocked: () => void }) {
  const [open, setOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);

  function handleBlock() {
    setOpen(false);
    Alert.alert(
      'Block user',
      `Block ${name ?? `@${handle}`}? They won't be able to message you, follow you, or see your profile. You can unblock them any time in Settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            setBlocking(true);
            const res = await blockUser(userId);
            setBlocking(false);
            if (res.ok) {
              onBlocked();
            } else {
              Alert.alert('Error', res.error ?? 'Could not block user');
            }
          },
        },
      ],
    );
  }

  return (
    <>
      <Pressable hitSlop={12} onPress={() => setOpen(true)} style={{ padding: 4 }} disabled={blocking}>
        {blocking
          ? <ActivityIndicator size="small" color={color.mute} />
          : <MoreVertical size={20} color={color.mute} />}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={st.menuOverlay} onPress={() => setOpen(false)}>
          <View style={st.menuCard}>
            <Pressable style={st.menuItem} onPress={handleBlock}>
              <ShieldAlert size={16} color={color.signal} />
              <Text style={[st.menuItemText, { color: color.signal }]}>Block user</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ── About section rows ───────────────────────────────────────────────────────

function AboutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={st.aboutRow}>
      <Text style={st.aboutLabel}>{label}</Text>
      <View style={st.aboutChips}>{children}</View>
    </View>
  );
}

function InfoChip({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <View style={[st.infoChip, accent && st.infoChipAccent]}>
      <Text style={[st.infoChipText, accent && st.infoChipTextAccent]}>{label}</Text>
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function PublicPassportScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { userId: currentUserId } = useSession();

  const { profile, postcards, loading, error, isPrivate, notFound } = usePublicPassport(username ?? '');
  const follow = useFollow(profile?.id ?? null);
  const ringState = useHighlightRingState(profile?.id ?? null);

  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [sessionAllViewed, setSessionAllViewed] = useState(false);
  const [tab, setTab] = useState<Tab>('postcards');

  // Social profile (friend/block/about data) loaded via the friends service
  const [social, setSocial] = useState<SocialProfile | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [isBlockedRelation, setIsBlockedRelation] = useState(false);

  const loadSocial = useCallback(async (userId: string) => {
    if (!userId) return;
    setSocialLoading(true);

    // Try handle first, fall back to userId
    const res = username
      ? await getProfileByHandle(username).catch(() => ({ ok: false, data: null }))
      : { ok: false, data: null };

    const data: any = res.ok && res.data ? res.data : null;

    if (data) {
      setSocial({
        id: data.id,
        handle: data.handle ?? null,
        name: data.name ?? null,
        openToMeet: data.openToMeet ?? false,
        isPrivate: data.isPrivate ?? false,
        isOwnProfile: data.isOwnProfile ?? (data.id === currentUserId),
        spokenLanguages: data.spokenLanguages ?? [],
        travelStyles: data.travelStyles ?? [],
        travelPace: data.travelPace ?? null,
        budgetStyle: data.budgetStyle ?? null,
        travelGroupStyle: data.travelGroupStyle ?? [],
        lookingFor: data.lookingFor ?? [],
        availabilityTags: data.availabilityTags ?? [],
        planningStyle: data.planningStyle ?? null,
        comfortLevel: data.comfortLevel ?? null,
      });
    }

    if (userId !== currentUserId) {
      const blockRes = await getBlockStatus(userId).catch(() => ({ ok: false, data: null }));
      if (blockRes.ok && blockRes.data) {
        const bd = blockRes.data as any;
        setIsBlockedRelation(bd.iBlocked || bd.theyBlockedMe);
      }
    }

    setSocialLoading(false);
  }, [username, currentUserId]);

  // Load social data whenever the passport profile resolves
  useEffect(() => {
    if (profile?.id) {
      loadSocial(profile.id);
    }
  }, [profile?.id, loadSocial]);

  // Reload social data on focus (friend/block state may have changed)
  useFocusEffect(useCallback(() => {
    if (profile?.id) {
      loadSocial(profile.id);
    }
  }, [profile?.id, loadSocial]));

  // Reset session-viewed flag when navigating to a different user's profile
  useEffect(() => {
    setSessionAllViewed(false);
    setSocial(null);
    setIsBlockedRelation(false);
  }, [profile?.id]);

  function handleViewerClose() {
    setHighlightViewerOpen(false);
    const highlights = ringState?.highlights ?? [];
    if (highlights.length > 0 && highlights.every((h) => viewedHighlightIds.has(h.id))) {
      setSessionAllViewed(true);
    }
  }

  const insets = useSafeAreaInsets();

  const isOwn = social?.isOwnProfile ?? profile?.isOwnProfile ?? (profile?.id === currentUserId);
  const displayHandle = social?.handle ?? username ?? '';
  const displayName = social?.name ?? (profile && ('displayName' in profile ? profile.displayName : null)) ?? username ?? '';

  const renderContent = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      );
    }

    if (notFound) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔍</Text>
          <Text style={styles.stateTitle}>No one here</Text>
          <Text style={styles.stateSub}>@{username} doesn't exist.</Text>
        </View>
      );
    }

    if (isBlockedRelation) {
      return (
        <View style={styles.center}>
          <ShieldAlert size={40} color={color.haze} />
          <Text style={styles.stateTitle}>This user is unavailable</Text>
          <Text style={styles.stateSub}>You can't view this profile.</Text>
        </View>
      );
    }

    if (isPrivate) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔒</Text>
          <Text style={styles.stateTitle}>This Passport is private</Text>
          <Text style={styles.stateSub}>Only the owner can see this Passport.</Text>
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateTitle}>Couldn't load Passport</Text>
          <Text style={styles.stateSub}>{error}</Text>
        </View>
      );
    }

    if (!profile) return null;

    const countries = new Set(postcards.map((c) => c.locationCountry).filter(Boolean)).size;
    const cities = new Set(postcards.map((c) => c.locationCity).filter(Boolean)).size;

    const followContext = !isOwn && !follow.loading
      ? (follow.isFollowing && follow.followsYou)
        ? 'Mutual'
        : follow.followsYou
        ? 'Follows you'
        : follow.isFollowing
        ? 'You follow'
        : undefined
      : undefined;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingTop: 0, paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        <PassportHero
          profile={profile}
          isOwner={isOwn}
          isFollowing={follow.isFollowing}
          followLoading={follow.loading || follow.toggling}
          followContext={followContext}
          onFollowPress={!isOwn ? follow.toggle : undefined}
          hasHighlights={ringState?.hasActive}
          allHighlightsViewed={(ringState?.allViewed ?? false) || sessionAllViewed}
          onHighlightRingPress={ringState?.hasActive ? () => setHighlightViewerOpen(true) : undefined}
        />

        {/* Stats row */}
        <View style={styles.statsRow}>
          {[
            { n: postcards.length, label: 'Postcards' },
            { n: countries, label: 'Countries' },
            { n: cities, label: 'Cities' },
            { n: follow.followersCount, label: 'Followers' },
          ].map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && <View style={styles.statsDivider} />}
              <View style={styles.statsCell}>
                <Text style={styles.statsN}>
                  {follow.loading && item.label === 'Followers' ? '—' : item.n}
                </Text>
                <Text style={styles.statsL}>{item.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </View>

        {/* Following pill */}
        {follow.followingCount > 0 && (
          <View style={styles.followingPill}>
            <Users size={12} color={color.mute} />
            <Text style={styles.followingText}>
              Following {follow.followingCount} {follow.followingCount === 1 ? 'traveler' : 'travelers'}
            </Text>
          </View>
        )}

        {/* Social actions: friend + message (only for other users) */}
        {!isOwn && profile.id && (
          <View style={styles.actions}>
            <FriendButton userId={profile.id} isOwn={isOwn} />
            <MessageButton userId={profile.id} isOwn={isOwn} />
          </View>
        )}

        {/* Private profile note */}
        {social?.isPrivate && !isOwn && (
          <View style={styles.privateNote}>
            <Users size={14} color={color.mute} />
            <Text style={styles.privateText}>This profile is private. Add as a friend to see more.</Text>
          </View>
        )}

        {/* Tab bar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBarWrap}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tb) => (
            <Pressable
              key={tb.key}
              style={[styles.tab, tab === tb.key && styles.tabActive]}
              onPress={() => setTab(tb.key)}
            >
              <Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>
                {tb.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={{ marginTop: space.md }}>
          {tab === 'postcards' && <PostcardsTab postcards={postcards} isOwner={isOwn} />}
          {tab === 'stamps' && <StampsTab stamps={[]} />}
          {tab === 'map' && <MapTab postcards={postcards} />}
          {tab === 'about' && (
            <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
              {/* Passport about tab for standard fields */}
              <AboutTab profile={profile} isOwner={isOwn} />

              {/* Extra social about rows from the social profile */}
              {social && (
                <View style={{ gap: space.md, marginTop: space.sm }}>
                  {((social.travelStyles?.length ?? 0) > 0 || social.travelPace || social.budgetStyle) && (
                    <AboutRow label="TRAVEL STYLE">
                      {(social.travelStyles ?? []).map((ts) => <InfoChip key={ts} label={ts} />)}
                      {social.travelPace && <InfoChip label={`${social.travelPace} pace`} accent />}
                      {social.budgetStyle && <InfoChip label={social.budgetStyle} />}
                    </AboutRow>
                  )}
                  {(social.spokenLanguages?.length ?? 0) > 0 && (
                    <AboutRow label="SPEAKS">
                      {(social.spokenLanguages ?? []).map((lang) => <InfoChip key={lang} label={lang} />)}
                    </AboutRow>
                  )}
                  {(social.lookingFor?.length ?? 0) > 0 && (
                    <AboutRow label="LOOKING FOR">
                      {(social.lookingFor ?? []).map((lf) => <InfoChip key={lf} label={lf} />)}
                    </AboutRow>
                  )}
                  {((social.availabilityTags?.length ?? 0) > 0 || social.planningStyle) && (
                    <AboutRow label="AVAILABILITY">
                      {(social.availabilityTags ?? []).map((tag) => <InfoChip key={tag} label={tag} />)}
                      {social.planningStyle && (
                        <InfoChip label={social.planningStyle.replace(/_/g, ' ')} accent />
                      )}
                    </AboutRow>
                  )}
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Nav header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {displayHandle ? `@${displayHandle}` : (displayName || username || '')}
        </Text>
        {!isOwn && profile?.id && social ? (
          <KebabMenu
            userId={profile.id}
            name={social.name}
            handle={social.handle}
            onBlocked={() => router.back()}
          />
        ) : (
          <View style={{ width: 38 }} />
        )}
      </View>

      {renderContent()}

      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ringState?.highlights ?? []}
        onClose={handleViewerClose}
      />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  backBtn: { padding: 6 },
  headerTitle: { ...t.heading, color: color.ink, flex: 1, textAlign: 'center' },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md, minHeight: 300,
  },
  stateIcon: { fontSize: 56 },
  stateTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  stateSub: { ...t.body, color: color.mute, textAlign: 'center' },

  statsRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 10,
  },
  statsCell: { flex: 1, alignItems: 'center' },
  statsDivider: { width: 1, height: 28, backgroundColor: color.haze },
  statsN: { ...t.heading, color: color.ink, fontSize: 18 },
  statsL: { fontFamily: 'Courier', fontSize: 9, color: color.mute, fontWeight: '700' },

  followingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 6, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, alignSelf: 'flex-start',
  },
  followingText: { ...t.small, color: color.mute, fontSize: 12 },

  actions: { gap: space.sm, marginHorizontal: space.lg, marginTop: space.md },
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

  privateNote: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.sm,
    padding: space.md, borderRadius: 10, backgroundColor: color.paperRaised,
  },
  privateText: { ...t.small, color: color.mute, flex: 1 },

  tabBarWrap: { marginTop: space.md },
  tabBarContent: { paddingHorizontal: space.lg, gap: space.xs },
  tab: {
    paddingHorizontal: space.md, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 13 },
  tabTextActive: { color: color.onInk },

  aboutRow: { gap: 6 },
  aboutLabel: {
    fontFamily: 'Courier', fontSize: 10, fontWeight: '700',
    color: color.mute, letterSpacing: 0.8,
  },
  aboutChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  infoChip: {
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: 10, paddingVertical: 4, backgroundColor: color.paperRaised,
  },
  infoChipAccent: { backgroundColor: color.deep, borderColor: color.deep },
  infoChipText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },
  infoChipTextAccent: { color: color.onInk },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(17,17,15,0.5)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: space.xl, gap: space.md,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { ...t.heading, color: color.ink },
  composerInput: {
    ...t.body, color: color.ink, backgroundColor: color.paper,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, minHeight: 80, textAlignVertical: 'top',
  },
  menuOverlay: {
    flex: 1, backgroundColor: 'rgba(17,17,15,0.3)',
    alignItems: 'flex-end', paddingTop: 60, paddingRight: space.lg,
  },
  menuCard: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, minWidth: 160, overflow: 'hidden',
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  menuItemText: { ...t.body, fontSize: 14, fontWeight: '600' },
});

// Alias so st.* works in sub-components above
const st = styles;
