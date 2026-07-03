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
  Image as ImageIcon, Tag, Map as MapIcon, Info,
  Bookmark, BookmarkCheck, BellOff, Bell, Flag,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
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
import { blockUser, getBlockStatus, unblockUser } from '../../src/services/blocks';
import { muteUser, unmuteUser, getMuteStatus } from '../../src/services/mutes';
import { saveProfile, unsaveProfile, getSaveStatus } from '../../src/services/saves';
import { submitReport, type ReportReason } from '../../src/services/reports';
import { getUserReviews, type Review } from '../../src/services/reviews';
import { getBuddyProfileByUserId, type BuddyProfile } from '../../src/services/rentABuddy';
import type { PublicProfile } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { PROFILE_NOT_FOUND_TITLE, PROFILE_NOT_FOUND_SUB } from '../../src/constants/profileScreenCopy';

type Tab = 'postcards' | 'stamps' | 'map' | 'about';
const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: 'postcards', label: 'Postcards', Icon: ImageIcon },
  { key: 'stamps',    label: 'Stamps',    Icon: Tag },
  { key: 'map',       label: 'Map',       Icon: MapIcon },
  { key: 'about',     label: 'About',     Icon: Info },
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
  reason: string | null;
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

// ── Kebab / action menu ───────────────────────────────────────────────────────

const REPORT_REASONS: { code: ReportReason; label: string }[] = [
  { code: 'harassment',     label: 'Harassment or bullying' },
  { code: 'spam',           label: 'Spam' },
  { code: 'hate_speech',    label: 'Hate speech' },
  { code: 'violence',       label: 'Violence or dangerous content' },
  { code: 'impersonation',  label: 'Impersonation' },
  { code: 'nudity',         label: 'Nudity or explicit content' },
  { code: 'misinformation', label: 'Misinformation' },
  { code: 'other',          label: 'Other' },
];

function KebabMenu({
  userId, name, handle, onBlocked,
}: { userId: string; name: string | null; handle: string | null; onBlocked: () => void }) {
  const [open, setOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason | null>(null);
  const [reportDetail, setReportDetail] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatusLoading(true);
    Promise.all([getMuteStatus(userId), getSaveStatus(userId)])
      .then(([muteRes, saveRes]) => {
        if (muteRes.ok && muteRes.data) setIsMuted(muteRes.data.isMuted);
        if (saveRes.ok && saveRes.data) setIsSaved(saveRes.data.isSaved);
      })
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, [open, userId]);

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

  async function handleMuteToggle() {
    setOpen(false);
    setBusy('mute');
    const wasMuted = isMuted;
    setIsMuted(!wasMuted);
    const res = wasMuted ? await unmuteUser(userId) : await muteUser(userId);
    setBusy(null);
    if (!res.ok) {
      setIsMuted(wasMuted);
      Alert.alert('Error', res.error ?? `Could not ${wasMuted ? 'unmute' : 'mute'} user`);
    }
  }

  async function handleSaveToggle() {
    setOpen(false);
    setBusy('save');
    const wasSaved = isSaved;
    setIsSaved(!wasSaved);
    const res = wasSaved ? await unsaveProfile(userId) : await saveProfile(userId);
    setBusy(null);
    if (!res.ok) {
      setIsSaved(wasSaved);
      Alert.alert('Error', res.error ?? `Could not ${wasSaved ? 'unsave' : 'save'} profile`);
    }
  }

  function handleReport() {
    setOpen(false);
    setReportReason(null);
    setReportDetail('');
    setReportDone(false);
    setReportOpen(true);
  }

  async function handleSubmitReport() {
    if (!reportReason) return;
    setReportSubmitting(true);
    const res = await submitReport({
      targetUserId: userId,
      reason: reportReason,
      details: reportDetail.trim() || undefined,
    });
    setReportSubmitting(false);
    if (res.ok) {
      setReportDone(true);
      setTimeout(() => setReportOpen(false), 2500);
    } else {
      Alert.alert('Error', res.error ?? 'Could not submit report');
    }
  }

  const displayName = name ?? `@${handle}`;

  return (
    <>
      <Pressable hitSlop={12} onPress={() => setOpen(true)} style={{ padding: 4 }} disabled={blocking}>
        {blocking
          ? <ActivityIndicator size="small" color={color.mute} />
          : <MoreVertical size={20} color={color.mute} />}
      </Pressable>

      {/* Dropdown menu */}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={st.menuOverlay} onPress={() => setOpen(false)}>
          <View style={st.menuCard}>
            <Pressable
              style={st.menuItem}
              onPress={handleSaveToggle}
              disabled={statusLoading || busy === 'save'}
            >
              {isSaved
                ? <BookmarkCheck size={16} color={color.signal} />
                : <Bookmark size={16} color={color.mute} />}
              <Text style={[st.menuItemText, isSaved && { color: color.signal }]}>
                {isSaved ? 'Saved' : 'Save profile'}
              </Text>
            </Pressable>
            <Pressable
              style={[st.menuItem, st.menuItemBorder]}
              onPress={handleMuteToggle}
              disabled={statusLoading || busy === 'mute'}
            >
              {isMuted
                ? <Bell size={16} color={color.mute} />
                : <BellOff size={16} color={color.mute} />}
              <Text style={st.menuItemText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
            </Pressable>
            <Pressable style={[st.menuItem, st.menuItemBorder]} onPress={handleReport}>
              <Flag size={16} color={color.warn} />
              <Text style={[st.menuItemText, { color: color.warn }]}>Report</Text>
            </Pressable>
            <Pressable style={[st.menuItem, st.menuItemBorder]} onPress={handleBlock}>
              <ShieldAlert size={16} color={color.signal} />
              <Text style={[st.menuItemText, { color: color.signal }]}>Block user</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Report sub-modal */}
      <Modal visible={reportOpen} transparent animationType="slide" onRequestClose={() => setReportOpen(false)}>
        <View style={st.modalOverlay}>
          <View style={[st.modalCard, { maxHeight: '80%' }]}>
            <View style={st.modalHeader}>
              <Text style={st.modalTitle}>Report {displayName}</Text>
              <Pressable onPress={() => setReportOpen(false)} hitSlop={8}>
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            {reportDone ? (
              <View style={st.reportDoneWrap}>
                <Text style={st.reportDoneIcon}>✓</Text>
                <Text style={st.reportDoneTitle}>Report submitted</Text>
                <Text style={st.reportDoneSub}>
                  Thank you — our team will review this shortly.
                </Text>
              </View>
            ) : (
              <>
                <Text style={st.reportSubLabel}>Why are you reporting this account?</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {REPORT_REASONS.map((r) => (
                    <Pressable
                      key={r.code}
                      style={[
                        st.reasonRow,
                        reportReason === r.code && { backgroundColor: `${color.signal}08` },
                      ]}
                      onPress={() => setReportReason(r.code)}
                    >
                      <View style={[st.reasonRadio, reportReason === r.code && st.reasonRadioSelected]} />
                      <Text style={st.reasonLabel}>{r.label}</Text>
                    </Pressable>
                  ))}
                  <TextInput
                    style={[st.composerInput, { marginTop: space.md }]}
                    placeholder="Additional details (optional)"
                    placeholderTextColor={color.faint}
                    value={reportDetail}
                    onChangeText={setReportDetail}
                    maxLength={500}
                    multiline
                    numberOfLines={3}
                  />
                </ScrollView>
                <Pressable
                  style={[
                    st.actionBtn, st.addFriendBtnStyle,
                    { marginTop: space.md, opacity: reportReason ? 1 : 0.45 },
                  ]}
                  disabled={!reportReason || reportSubmitting}
                  onPress={handleSubmitReport}
                >
                  <Text style={[st.btnText, { color: '#fff' }]}>
                    {reportSubmitting ? 'Submitting…' : 'Submit Report'}
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
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

// ── Host reviews summary ─────────────────────────────────────────────────────

function StarLine({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Text key={s} style={{ fontSize: 11, color: s <= full ? '#F59E0B' : '#D1D5DB' }}>★</Text>
      ))}
    </View>
  );
}

function BuddySection({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(false);
  const [buddy, setBuddy] = useState<BuddyProfile | null>(null);

  useEffect(() => {
    setLoading(true);
    getBuddyProfileByUserId(userId)
      .then((res) => {
        setLoading(false);
        if (res.ok && res.data?.buddy) setBuddy(res.data.buddy);
      })
      .catch(() => setLoading(false));
  }, [userId]);

  if (loading) return <ActivityIndicator size="small" color={color.mute} style={{ marginVertical: space.md }} />;
  if (!buddy) return null;

  return (
    <View style={buddyCardStyles.card}>
      <View style={buddyCardStyles.headerRow}>
        <View style={buddyCardStyles.badge}>
          <Text style={buddyCardStyles.badgeText}>Rent-a-Buddy</Text>
        </View>
        {buddy.averageRating != null && (
          <Text style={buddyCardStyles.rating}>★ {buddy.averageRating.toFixed(1)}</Text>
        )}
      </View>
      <Text style={buddyCardStyles.title} numberOfLines={2}>
        {buddy.tagline ?? 'Available as your travel buddy'}
      </Text>
      <Pressable
        style={({ pressed }) => [buddyCardStyles.btn, pressed && { opacity: 0.75 }]}
        onPress={() => router.push(`/(rent-a-buddy)/buddy/${buddy.id}` as any)}
      >
        <Text style={buddyCardStyles.btnText}>View buddy profile</Text>
      </Pressable>
    </View>
  );
}

const buddyCardStyles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.lg, gap: space.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: {
    backgroundColor: color.deep, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 4,
  },
  badgeText: { ...t.stamp, color: color.onInk, fontWeight: '700', fontSize: 10 },
  rating: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  title: { ...t.body, color: color.ink },
  btn: {
    backgroundColor: color.ink, borderRadius: radius.pill,
    paddingVertical: 10, alignItems: 'center', marginTop: 4,
  },
  btnText: { ...t.small, color: color.onInk, fontWeight: '700' },
});

function HostReviewsSummary({ userId }: { userId: string }) {
  const [data, setData]     = useState<{ avgRating: number | null; reviewCount: number; reviews: Review[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getUserReviews(userId, 3)
      .then((d) => { if (active) setData(d as any); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  if (loading || !data || data.reviewCount === 0) return null;

  return (
    <View style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <Text style={{ ...t.bodyStrong, color: color.ink, fontSize: 14 }}>Host Reviews</Text>
        {data.avgRating !== null && (
          <>
            <StarLine rating={data.avgRating} />
            <Text style={{ ...t.small, color: color.mute }}>
              {data.avgRating.toFixed(1)} ({data.reviewCount})
            </Text>
          </>
        )}
      </View>
      {data.reviews.slice(0, 3).map((r) => (
        <View
          key={r.id}
          style={{
            backgroundColor: color.paperRaised,
            borderRadius: 10,
            padding: space.md,
            marginBottom: space.sm,
            borderWidth: 1,
            borderColor: color.haze,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 4 }}>
            <StarLine rating={r.rating} />
            {r.reviewer && (
              <Text style={{ ...t.small, color: color.mute }}>@{r.reviewer.handle ?? r.reviewer.displayName ?? 'traveler'}</Text>
            )}
          </View>
          {r.body ? (
            <Text style={{ ...t.body, color: color.ink, fontSize: 13 }} numberOfLines={3}>
              {r.body}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function PublicPassportScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { userId: currentUserId } = useSession();

  const { profile, postcards, loading, error, isPrivate, notFound, isBlocked, blockedTargetId } = usePublicPassport(username ?? '');
  const follow = useFollow(profile?.id ?? null);
  const ringState = useHighlightRingState(profile?.id ?? null);

  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [sessionAllViewed, setSessionAllViewed] = useState(false);
  const [tab, setTab] = useState<Tab>('postcards');

  // Social profile (friend/block/about data) loaded via the friends service
  const [social, setSocial] = useState<SocialProfile | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [isBlockedRelation, setIsBlockedRelation] = useState(false);
  const [iBlockedThem, setIBlockedThem] = useState(false);
  const [isMutedByMe, setIsMutedByMe] = useState(false);

  // loadSocial has no parameter — it derives userId from the getProfileByHandle response.
  // It runs on username (not profile?.id) so blocked users are detected even when
  // the passport endpoint returns a blocked sentinel (profile is null in that case).
  const loadSocial = useCallback(async () => {
    if (!username) return;
    setSocialLoading(true);

    const res = await getProfileByHandle(username).catch(() => ({ ok: false, data: null }));
    const d: any = res.ok && res.data ? res.data : null;

    // Handle blocked sentinel from the by-handle endpoint:
    // { unavailable: true, reason: "blocked", isBlocker: boolean }
    // isBlocker = true  → viewer blocked the target (I blocked them)
    // isBlocker = false → target blocked the viewer (they blocked me)
    if (res.ok && res.data && (res.data as any).unavailable === true) {
      const reason = (res.data as any).reason;
      if (reason === 'blocked') {
        const isBlocker = (res.data as any).isBlocker === true;
        setIsBlockedRelation(true);
        setIBlockedThem(isBlocker);
      }
      setSocialLoading(false);
      return;
    }

    if (d && d.id) {
      setSocial({
        id: d.id,
        handle: d.handle ?? null,
        name: d.name ?? null,
        openToMeet: d.openToMeet ?? false,
        isPrivate: d.isPrivate ?? false,
        isOwnProfile: d.isOwnProfile ?? (d.id === currentUserId),
        spokenLanguages: d.spokenLanguages ?? [],
        travelStyles: d.travelStyles ?? [],
        travelPace: d.travelPace ?? null,
        budgetStyle: d.budgetStyle ?? null,
        travelGroupStyle: d.travelGroupStyle ?? [],
        lookingFor: d.lookingFor ?? [],
        availabilityTags: d.availabilityTags ?? [],
        planningStyle: d.planningStyle ?? null,
        comfortLevel: d.comfortLevel ?? null,
        reason: d.reason ?? null,
      });
    }

    const userId = d?.id as string | undefined;
    if (userId && userId !== currentUserId) {
      const [blockRes, muteRes] = await Promise.all([
        getBlockStatus(userId).catch(() => ({ ok: false, data: null })),
        getMuteStatus(userId).catch(() => ({ ok: false, data: null })),
      ]);
      if (blockRes.ok && blockRes.data) {
        const bd = blockRes.data as any;
        setIsBlockedRelation(bd.iBlocked || bd.theyBlockedMe);
        setIBlockedThem(bd.iBlocked === true);
      }
      if (muteRes.ok && muteRes.data) {
        setIsMutedByMe((muteRes.data as any).muted ?? false);
      }
    }

    setSocialLoading(false);
  }, [username, currentUserId]);

  const handleUnblock = useCallback(async () => {
    // blockedTargetId comes from the hook (passport blocked sentinel).
    // Fall back to social?.id (loaded by loadSocial) or profile?.id (normal profile).
    const targetId = blockedTargetId ?? social?.id ?? profile?.id;
    if (!targetId) return;
    const res = await unblockUser(targetId);
    if (res.ok) {
      setIsBlockedRelation(false);
      setIBlockedThem(false);
    } else {
      Alert.alert('Error', 'Could not unblock. Please try again.');
    }
  }, [blockedTargetId, social?.id, profile?.id]);

  // Load social data whenever the username changes.
  // Triggers even when the passport endpoint returns a blocked sentinel (profile is null).
  useEffect(() => {
    if (username) {
      loadSocial();
    }
  }, [username, loadSocial]);

  // Reload social data on focus (friend/block/mute state may have changed).
  useFocusEffect(useCallback(() => {
    if (username) {
      loadSocial();
    }
  }, [username, loadSocial]));

  // Reset per-username state when navigating to a different user's profile.
  useEffect(() => {
    setSessionAllViewed(false);
    setSocial(null);
    setIsBlockedRelation(false);
    setIsMutedByMe(false);
    setIBlockedThem(false);
  }, [username]);

  function handleViewerClose() {
    setHighlightViewerOpen(false);
    const highlights = ringState?.highlights ?? [];
    if (highlights.length > 0 && highlights.every((h) => viewedHighlightIds.has(h.id))) {
      setSessionAllViewed(true);
    }
  }

  const insets = useSafeAreaInsets();

  const isOwn = social?.isOwnProfile ?? profile?.isOwnProfile ?? (profile?.id === currentUserId);
  // About tab is only accessible once social checks have resolved and the viewer
  // is neither blocked nor viewing a private profile they don't follow.
  const canViewAbout = isOwn || (!socialLoading && !social?.isPrivate && !isBlockedRelation);
  const displayHandle = social?.handle ?? username ?? '';
  const displayName = social?.name ?? (profile && ('displayName' in profile ? profile.displayName : null)) ?? username ?? '';

  async function handleUnmuteFromBadge() {
    if (!profile?.id) return;
    Alert.alert(
      'Unmute',
      `Unmute ${displayName}? They will be able to reach you again based on your privacy settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unmute',
          onPress: async () => {
            const res = await unmuteUser(profile.id);
            if (res.ok) {
              setIsMutedByMe(false);
            } else {
              Alert.alert('Error', res.error ?? 'Could not unmute user');
            }
          },
        },
      ],
    );
  }

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
          <Text style={styles.stateIcon}>👤</Text>
          <Text style={styles.stateTitle}>{PROFILE_NOT_FOUND_TITLE}</Text>
          <Text style={styles.stateSub}>{PROFILE_NOT_FOUND_SUB}</Text>
        </View>
      );
    }

    if (isBlocked || isBlockedRelation) {
      return (
        <View style={styles.center}>
          <ShieldAlert size={40} color={color.haze} />
          <Text style={styles.stateTitle}>This user is unavailable</Text>
          <Text style={styles.stateSub}>You can't view this profile.</Text>
          {iBlockedThem && (
            <Pressable
              style={{ marginTop: space.md, paddingHorizontal: space.xl, paddingVertical: 10, borderRadius: 20, borderWidth: 1, borderColor: color.haze }}
              onPress={handleUnblock}
            >
              <Text style={{ fontSize: 13, color: color.mute, fontWeight: '600' }}>Unblock</Text>
            </Pressable>
          )}
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

        {/* Match reason badge — only shown to other users when a shared signal exists */}
        {!isOwn && social?.reason && (
          <View style={styles.reasonBadge}>
            <Text style={styles.reasonText}>✈ {social.reason}</Text>
          </View>
        )}

        {/* Muted badge — tappable, shown when the viewer has muted this profile */}
        {!isOwn && isMutedByMe && (
          <Pressable style={styles.mutedBadge} onPress={handleUnmuteFromBadge}>
            <BellOff size={12} color={color.mute} />
            <Text style={styles.mutedBadgeText}>Muted · tap to unmute</Text>
          </Pressable>
        )}

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

        {/* Tab bar — icon-only pill row */}
        <View style={styles.tabBarWrap}>
          {TABS.filter((tb) => {
            if (tb.key === 'about' && !canViewAbout) return false;
            return true;
          }).map((tb) => {
            const active = tab === tb.key;
            return (
              <Pressable
                key={tb.key}
                accessibilityLabel={tb.label}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => setTab(tb.key)}
              >
                <tb.Icon
                  size={20}
                  color={active ? color.onInk : color.mute}
                  strokeWidth={2}
                />
              </Pressable>
            );
          })}
        </View>

        <View style={{ marginTop: space.md }}>
          {tab === 'postcards' && <PostcardsTab postcards={postcards} isOwner={isOwn} />}
          {tab === 'stamps' && (
            <StampsTab
              stamps={profile?.stamps ?? []}
              viewingUsername={!isOwn ? username : undefined}
              viewingUserId={profile?.id}
              isOwner={isOwn}
            />
          )}
          {tab === 'map' && <MapTab postcards={postcards} />}
          {tab === 'about' && (
            <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
              {!canViewAbout ? (
                <View style={styles.privateNote}>
                  <Users size={14} color={color.mute} />
                  <Text style={styles.privateText}>This profile is private. Add as a friend to see more.</Text>
                </View>
              ) : (
                <>
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
                  {profile.id && (
                    <HostReviewsSummary userId={profile.id} />
                  )}
                  {profile.id && (
                    <BuddySection userId={profile.id} />
                  )}
                </>
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

  reasonBadge: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 7, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, alignSelf: 'flex-start',
  },
  reasonText: { ...t.small, color: color.deep, fontWeight: '700', fontSize: 12 },

  followingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 6, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, alignSelf: 'flex-start',
  },
  followingText: { ...t.small, color: color.mute, fontSize: 12 },
  mutedBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 5, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, alignSelf: 'flex-start',
  },
  mutedBadgeText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },

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

  tabBarWrap: {
    marginTop: space.md,
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: { backgroundColor: color.ink, borderColor: color.ink },

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
  menuItemBorder: { borderTopWidth: 1, borderTopColor: color.haze },
  reportSubLabel: { ...t.small, color: color.mute, marginBottom: space.sm },
  reasonRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  reasonRadio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.haze },
  reasonRadioSelected: { borderColor: color.signal, backgroundColor: color.signal },
  reasonLabel: { ...t.body, color: color.ink, fontSize: 14, flex: 1 },
  reportDoneWrap: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  reportDoneIcon: { fontSize: 48, color: color.success },
  reportDoneTitle: { ...t.heading, color: color.ink },
  reportDoneSub: { ...t.body, color: color.mute, textAlign: 'center' },
});

// Alias so st.* works in sub-components above
const st = styles;
