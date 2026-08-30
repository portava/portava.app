import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, ActivityIndicator, RefreshControl, Alert, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { MessageCircle, CalendarClock, ChevronDown, ChevronUp, Compass, Shield, UserPlus } from 'lucide-react-native';
import { localDateKey } from '../src/utils/localDate';
import { AppHeader } from '../src/components/ui/AppHeader';
import { getMyFollowing, getMyFollowers, type FollowUser } from '../src/services/follows';
import { sendTripInvite } from '../src/services/friends';
import { getTrip } from '../src/services/trips';
import { openCircleChat } from '../src/services/messaging';
import {
  getMyCircleAgeSettings, updateCircleAgeSettings,
  type CircleAgeSettings,
} from '../src/services/circleAgeSettings';
import { getCircleAvailability, type MemberAvailability } from '../src/services/availability';
import { AvailabilityGrid } from '../src/components/AvailabilityGrid';
import { BestDaysBanner } from '../src/components/BestDaysBanner';
import { MeetupCreationSheet } from '../src/components/MeetupCreationSheet';
import { useSession } from '../src/context/SessionContext';
import { color, space, radius, type as t, shadow, icon, avatar, dot } from '../src/theme/tokens';
import { HighlightRing } from '../src/components/HighlightRing';
import { HighlightViewer } from '../src/components/HighlightViewer';
import { useHighlightRingState } from '../src/hooks/useHighlightRingState';
import { UserAvatarButton } from '../src/components/interaction/UserAvatarButton';
import { UserNameButton } from '../src/components/interaction/UserNameButton';
import { UserOverflowMenu } from '../src/components/interaction/UserOverflowMenu';
import { useBlockedIds } from '../src/context/BlockedIdsContext';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { usePlainBottomInset } from '../src/hooks/useBottomInset';


function CircleUserRow({
  u, reason, tripId,
}: { u: FollowUser; reason?: string; tripId?: string }) {
  const ringState = useHighlightRingState(u.id);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [inviteState, setInviteState] = useState<'idle' | 'loading' | 'done'>('idle');
  const invitingRef = useRef(false);
  const { blockedIds, blockerIds } = useBlockedIds();

  if (hidden || blockedIds.has(u.id) || blockerIds.has(u.id)) return null;

  const displayName = u.name ?? u.handle ?? 'Traveler';

  async function handleInvite() {
    if (invitingRef.current || inviteState !== 'idle' || !tripId) return;
    invitingRef.current = true;
    setInviteState('loading');
    try {
      const res = await sendTripInvite(tripId, u.id);
      if (res.ok) {
        setInviteState('done');
      } else {
        setInviteState('idle');
        Alert.alert('Could not send invite', res.message ?? 'Please try again.');
      }
    } catch {
      setInviteState('idle');
      Alert.alert('Could not send invite', 'Network error. Please try again.');
    } finally {
      invitingRef.current = false;
    }
  }

  return (
    <>
      <View style={styles.row}>
        <HighlightRing
          hasActive={ringState?.hasActive ?? false}
          allViewed={ringState?.allViewed ?? false}
          size={52}
          ringWidth={2}
          gap={2}
          onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
        >
          <UserAvatarButton userId={u.id} handle={u.handle} avatarUrl={u.avatarUrl} size={52} />
        </HighlightRing>
        <View style={{ flex: 1 }}>
          <UserNameButton userId={u.id} handle={u.handle} displayName={displayName} style={styles.name} />
          {u.handle ? <Text style={styles.handle}>@{u.handle}</Text> : null}
          {reason ? <Text style={styles.reason}>{reason}</Text> : null}
        </View>
        {tripId ? (
          <Pressable
            style={[styles.inviteBtn, inviteState !== 'idle' && styles.inviteBtnDone]}
            onPress={handleInvite}
            disabled={inviteState !== 'idle'}
            hitSlop={8}
          >
            {inviteState === 'loading' ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : inviteState === 'done' ? (
              <Text style={styles.inviteBtnText}>Invited ✓</Text>
            ) : (
              <>
                <UserPlus size={13} color={color.onInk} />
                <Text style={styles.inviteBtnText}>Invite</Text>
              </>
            )}
          </Pressable>
        ) : (
          <UserOverflowMenu
            userId={u.id}
            displayName={displayName}
            onBlockSuccess={() => setHidden(true)}
          />
        )}
      </View>
      <HighlightViewer
        visible={viewerOpen}
        highlights={ringState?.highlights ?? []}
        onClose={() => setViewerOpen(false)}
      />
    </>
  );
}

function next14Days(): string[] {
  const days: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    // LOCAL day, not toISOString()'s UTC day — east of UTC the first column was
    // yesterday and the 14th bookable day silently vanished.
    days.push(localDateKey(d));
  }
  return days;
}

// RichText surface note: the Circle screen displays the viewer's own travel circle
// (a per-user singleton — no parameterised /circle/:id route exists).  Circle data
// is a flat member list; there is no freeform description field on the circle model.
// If a circle bio/description is added in the future, render it with:
//   <RichText content={circle.description} tags={circle.descriptionTags} hashtagUsages={circle.descriptionHashtags} />
export default function Circle() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const bottomInset = usePlainBottomInset();
  const { userId, isAuthed, configured } = useSession();
  const { tripId } = useLocalSearchParams<{ tripId?: string }>();
  const [tripTitle, setTripTitle] = useState<string | null>(null);
  const [tab, setTab]               = useState<'circle' | 'followers'>('circle');
  const [following, setFollowing]   = useState<FollowUser[]>([]);
  const [followers, setFollowers]   = useState<FollowUser[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [avMembers,   setAvMembers]   = useState<MemberAvailability[]>([]);
  const [avExpanded,  setAvExpanded]  = useState(false);
  const [meetupDate,  setMeetupDate]  = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Circle age settings
  const [ageSettings, setAgeSettings] = useState<CircleAgeSettings | null>(null);
  const [ageSettingsOpen, setAgeSettingsOpen] = useState(false);
  const [ageEnabled, setAgeEnabled] = useState(false);
  const [minAgeStr, setMinAgeStr] = useState('');
  const [maxAgeStr, setMaxAgeStr] = useState('');
  const [ageSaving, setAgeSaving] = useState(false);

  const live = configured && isAuthed;
  const circleDays = useMemo(() => next14Days(), []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    const [fwRes, frRes] = await Promise.all([getMyFollowing(), getMyFollowers()]);
    setFollowing(fwRes.data ?? []);
    setFollowers(frRes.data ?? []);
    if (isRefresh) setRefreshing(false); else setLoading(false);
  }, []);

  useEffect(() => {
    if (live && userId) {
      getCircleAvailability(userId).then((res) => {
        if (res.ok && res.data) setAvMembers(res.data.members);
      });
    }
  }, [live, userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setTripTitle(null);
    if (!tripId) return;
    let active = true;
    getTrip(tripId).then((t) => {
      if (active) setTripTitle(t?.title ?? null);
    });
    return () => { active = false; };
  }, [tripId]);

  useEffect(() => {
    if (!live) return;
    getMyCircleAgeSettings().then((res) => {
      if (res.ok && res.data) {
        setAgeSettings(res.data);
        setAgeEnabled(res.data.ageLimitEnabled);
        setMinAgeStr(res.data.minAge != null ? String(res.data.minAge) : '');
        setMaxAgeStr(res.data.maxAge != null ? String(res.data.maxAge) : '');
      }
    });
  }, [live]);

  async function handleSaveAgeSettings() {
    if (ageSaving) return;
    setAgeSaving(true);
    const minAge = ageEnabled && minAgeStr ? parseInt(minAgeStr) : null;
    const maxAge = ageEnabled && maxAgeStr ? parseInt(maxAgeStr) : null;
    const res = await updateCircleAgeSettings({
      ageLimitEnabled: ageEnabled,
      minAge,
      maxAge,
    });
    setAgeSaving(false);
    if (res.ok && res.data) {
      setAgeSettings(res.data);
      Alert.alert('Saved', 'Your circle age settings have been updated.');
    } else {
      Alert.alert('Error', res.message ?? 'Could not save age settings');
    }
  }

  function circleReason(u: FollowUser, activeTab: 'circle' | 'followers'): string | undefined {
    if (activeTab === 'circle') {
      return u.followsYou ? 'Follows you back' : undefined;
    }
    return u.youFollow ? 'Mutual' : 'Follows you';
  }

  const list = tab === 'circle' ? following : followers;

  async function handleOpenCircleChat() {
    if (!userId || chatLoading) return;
    setChatLoading(true);
    const res = await openCircleChat(userId);
    setChatLoading(false);
    if (res.ok && res.data) {
      const { threadId, title } = res.data;
      const params = new URLSearchParams({ title: title ?? 'My Circle', threadType: 'circle', contextId: userId ?? '' });
      router.push(`/messages/${threadId}?${params.toString()}`);
    } else {
      Alert.alert('Chat unavailable', res.message ?? 'Could not open your circle chat.');
    }
  }

  const freeCount = avMembers.filter((m) => m.quickStatus?.status === 'free_now').length;

  // Compute best days client-side from weekly availability + upcoming 14 days
  const WDAY_IDX = ['sun','mon','tue','wed','thu','fri','sat'];
  const bestDays = useMemo(() => {
    return circleDays
      .map((date) => {
        const wd = WDAY_IDX[new Date(date + 'T12:00:00').getDay()];
        const count = avMembers.filter((m) => {
          if (Object.keys(m.weeklyDays).length === 0) return false;
          return ((m.weeklyDays as any)[wd]?.length ?? 0) > 0;
        }).length;
        return { date, count };
      })
      .filter((d) => d.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }, [avMembers, circleDays]);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >
        <AppHeader
          variant="detail"
          title="Circle"
          onBack={router.back}
          rightActions={[
            { icon: <Compass size={22} color={color.signal} />, onPress: () => router.push('/discover' as any), accessibilityLabel: 'Discover travelers' },
          ]}
        />

        {tripId ? (
          <View style={styles.tripInviteBanner}>
            <UserPlus size={14} color={color.signal} />
            <Text style={styles.tripInviteBannerText}>
              {tripTitle ? `Select someone to invite to ${tripTitle}` : 'Select someone to invite to your trip'}
            </Text>
          </View>
        ) : null}

        {userId ? (
          <Pressable
            style={styles.chatBtn}
            onPress={handleOpenCircleChat}
            disabled={chatLoading}
          >
            <View style={{ position: 'relative' }}>
              <MessageCircle size={15} color={color.onInk} />
              <View style={styles.unreadDot} />
            </View>
            <Text style={styles.chatBtnText}>Circle Chat</Text>
          </Pressable>
        ) : null}

        <View style={styles.tabBar}>
          <Pressable style={[styles.tab, tab === 'circle' && styles.tabActive]} onPress={() => setTab('circle')}>
            <Text style={[styles.tabText, tab === 'circle' && styles.tabTextActive]}>
              Following{following.length > 0 ? ` ${following.length}` : ''}
            </Text>
          </Pressable>
          <Pressable style={[styles.tab, tab === 'followers' && styles.tabActive]} onPress={() => setTab('followers')}>
            <Text style={[styles.tabText, tab === 'followers' && styles.tabTextActive]}>
              Followers{followers.length > 0 ? ` ${followers.length}` : ''}
            </Text>
          </Pressable>
        </View>

        {tab === 'circle' && userId && (
          <Pressable
            style={[styles.chatBanner, chatLoading && { opacity: 0.6 }]}
            onPress={handleOpenCircleChat}
            disabled={chatLoading}
          >
            {chatLoading
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <MessageCircle size={16} color={color.onInk} />
            }
            <Text style={styles.chatBannerText}>Circle Group Chat</Text>
            <Text style={styles.chatBannerSub}>Message everyone in your circle</Text>
          </Pressable>
        )}

        {/* Circle age settings — only shown in circle tab for the logged-in owner */}
        {tab === 'circle' && live && (
          <View style={styles.ageSection}>
            <Pressable style={styles.ageHead} onPress={() => setAgeSettingsOpen((v) => !v)}>
              <Text style={styles.ageTitle}>Circle Age Limit</Text>
              {ageSettings?.ageLimitEnabled && ageSettings.label && (
                <View style={styles.ageBadge}>
                  <Text style={styles.ageBadgeText}>{ageSettings.label}</Text>
                </View>
              )}
              <View style={{ flex: 1 }} />
              {ageSettingsOpen
                ? <ChevronUp size={16} color={color.mute} />
                : <ChevronDown size={16} color={color.mute} />}
            </Pressable>
            {ageSettingsOpen && (
              <View style={styles.ageBody}>
                <View style={styles.ageToggleRow}>
                  <Text style={styles.ageToggleLabel}>Enable age restriction</Text>
                  <Pressable
                    style={[styles.toggle, ageEnabled && styles.toggleOn]}
                    onPress={() => setAgeEnabled((v) => !v)}
                    hitSlop={8}
                  >
                    <View style={[styles.toggleThumb, ageEnabled && styles.toggleThumbOn]} />
                  </Pressable>
                </View>
                {ageEnabled && (
                  <View style={styles.ageRangeRow}>
                    <View style={styles.ageRangeField}>
                      <Text style={styles.ageHint}>Min age</Text>
                      <TextInput
                        style={styles.ageInput}
                        value={minAgeStr}
                        onChangeText={setMinAgeStr}
                        placeholder="e.g. 18"
                        placeholderTextColor={color.faint}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                    </View>
                    <Text style={styles.ageDash}>–</Text>
                    <View style={styles.ageRangeField}>
                      <Text style={styles.ageHint}>Max age</Text>
                      <TextInput
                        style={styles.ageInput}
                        value={maxAgeStr}
                        onChangeText={setMaxAgeStr}
                        placeholder="e.g. 35"
                        placeholderTextColor={color.faint}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                    </View>
                  </View>
                )}
                {ageEnabled && (
                  <Text style={styles.ageHint}>
                    People outside this range will be blocked from accepting circle invites. Leave a field blank for no bound.
                  </Text>
                )}
                <Pressable
                  style={[styles.ageSaveBtn, ageSaving && { opacity: 0.6 }]}
                  onPress={handleSaveAgeSettings}
                  disabled={ageSaving}
                >
                  {ageSaving
                    ? <ActivityIndicator size="small" color={color.onInk} />
                    : <Text style={styles.ageSaveBtnText}>Save</Text>}
                </Pressable>
              </View>
            )}
          </View>
        )}

        {tab === 'circle' && following.length > 0 && (
          <View style={styles.safeReturnHint}>
            <Shield size={13} color={color.deep} />
            <Text style={styles.safeReturnHintText}>
              People you follow can be added as{' '}
              <Text style={styles.safeReturnHintBold}>Trusted Contacts</Text>
              {' '}in Safe Return — a personal check-in system that alerts your circle if you don't confirm you're safe on time.
            </Text>
          </View>
        )}

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <View style={{ padding: space.lg, gap: space.md }}>
            {/* ── Availability grid — shown when circle data is loaded ── */}
            {live && avMembers.length > 0 && (
              <View style={styles.avSection}>
                <Pressable style={styles.avHead} onPress={() => setAvExpanded((v) => !v)}>
                  <CalendarClock size={14} color={color.deep} />
                  <Text style={styles.avTitle}>Circle Availability</Text>
                  {freeCount > 0 && (
                    <View style={styles.avBadge}>
                      <Text style={styles.avBadgeText}>{freeCount} free now</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }} />
                  {avExpanded
                    ? <ChevronUp size={16} color={color.mute} />
                    : <ChevronDown size={16} color={color.mute} />}
                </Pressable>

                {avExpanded && (
                  <View style={styles.avCard}>
                    {bestDays.length > 0 && (
                      <BestDaysBanner
                        bestDays={bestDays}
                        totalMembers={avMembers.length}
                        onDayPress={(date) => setSelectedDay(date)}
                      />
                    )}
                    <AvailabilityGrid
                      members={avMembers}
                      days={circleDays}
                      currentUserId={userId ?? ''}
                      mode="circle"
                      onEditOwn={() => router.push('/availability')}
                      onPlanMeetup={(date) => setMeetupDate(date)}
                      selectedDay={selectedDay}
                      onSelectedDayChange={setSelectedDay}
                    />
                    <Pressable style={styles.avEditBtn} onPress={() => router.push('/availability')}>
                      <Text style={styles.avEditBtnText}>Update my availability →</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}

            {/* ── Following / Followers list ── */}
            {list.map((u) => (
              <CircleUserRow key={u.id} u={u} reason={circleReason(u, tab)} tripId={tripId} />
            ))}
            {list.length === 0 && (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyIcon}>{tab === 'circle' ? '🌍' : '👥'}</Text>
                <Text style={styles.emptyTitle}>
                  {tab === 'circle' ? 'No one in your circle yet' : 'No followers yet'}
                </Text>
                <Text style={styles.emptyNote}>
                  {tab === 'circle'
                    ? 'Find travelers and follow them to build your circle.'
                    : 'Share your passport and connect with other travelers.'}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Meetup creation — triggered from availability grid "Plan meetup this day" */}
      {meetupDate && userId && (
        <MeetupCreationSheet
          circleOwnerId={userId}
          initialTitle={`Meetup — ${meetupDate}`}
          onDismiss={() => setMeetupDate(null)}
          onCreated={() => setMeetupDate(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chatBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, paddingVertical: space.sm + 2, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: color.signal },
  chatBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  unreadDot: { position: 'absolute', top: -3, right: -3, width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2, backgroundColor: color.onInk },
  tabBar: { flexDirection: 'row', gap: space.sm, margin: space.lg, marginBottom: 0, padding: 4, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.bodyStrong, color: color.mute, fontSize: 13 },
  tabTextActive: { color: color.onInk },

  chatBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.md, marginBottom: 0,
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
  },
  chatBannerText: { ...t.bodyStrong, color: color.onInk, flex: 1 },
  chatBannerSub: { ...t.small, color: color.onInk + 'BB', fontSize: 11 },

  avSection: { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, overflow: 'hidden' },
  avHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  avTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  avBadge: { backgroundColor: '#FEF9C3', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
  avBadgeText: { fontSize: 11, fontWeight: '700', color: '#A16207' },
  avCard: { borderTopWidth: 1, borderTopColor: color.haze, paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  avEditBtn: { alignSelf: 'flex-start' },
  avEditBtnText: { ...t.small, color: color.signal, fontWeight: '700' },
  safeReturnHint: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.sm, marginBottom: 0,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.sm + 2,
  },
  safeReturnHintText: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 18, flex: 1 },
  safeReturnHintBold: { fontWeight: '700', color: color.ink },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  avatar: { width: avatar.s52, height: avatar.s52, borderRadius: avatar.s52 / 2, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0EDE8' },
  name: { ...t.bodyStrong, color: color.ink },
  handle: { ...t.small, color: color.mute, marginTop: 2, fontFamily: 'Courier' },
  reason: { fontSize: 11, color: color.signal, marginTop: 2 },
  emptyBox: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyNote: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },
  discoverBtn: { padding: 4 },

  ageSection: { marginHorizontal: space.lg, marginTop: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, overflow: 'hidden', ...shadow.card },
  ageHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  ageTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  ageBadge: { backgroundColor: '#FEF3C7', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: '#F59E0B' },
  ageBadgeText: { fontSize: 11, fontWeight: '700', color: '#92400E' },
  ageBody: { borderTopWidth: 1, borderTopColor: color.haze, padding: space.md, gap: space.sm },
  ageToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ageToggleLabel: { ...t.body, color: color.ink, fontWeight: '600', fontSize: 13 },
  ageHint: { ...t.small, color: color.mute, fontSize: 11 },
  ageRangeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  ageRangeField: { flex: 1, gap: 4 },
  ageInput: { ...t.body, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: color.paper, textAlign: 'center' },
  ageDash: { ...t.bodyStrong, color: color.mute, marginBottom: 8 },
  ageSaveBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm + 2, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ageSaveBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 13 },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: color.haze, justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: color.signal },
  toggleThumb: { width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2, backgroundColor: color.paperRaised },
  toggleThumbOn: { alignSelf: 'flex-end' },
  tripInviteBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginTop: 8, marginBottom: 2, backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#BFDBFE' },
  tripInviteBannerText: { fontSize: 13, fontWeight: '600', color: '#1D4ED8', flexShrink: 1 },
  inviteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  inviteBtnDone: { backgroundColor: color.mute },
  inviteBtnText: { fontSize: 12, fontWeight: '700', color: color.onInk },
});
