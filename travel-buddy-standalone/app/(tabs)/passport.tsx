import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useBottomInset } from '../../src/hooks/useBottomInset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Share2, Clock } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadAvatar, uploadCover } from '../../src/services/profile';
import { getPendingPosts } from '../../src/services/posts';
import { FEED_FOCUS_TTL_MS } from '../../src/hooks/usePosts';
import { usePassport } from '../../src/hooks/usePassport';
import { usePostcardActions } from '../../src/hooks/usePostcardActions';
import { NotificationBell } from '../../src/components/NotificationBell';
import { usePassportShare } from '../../src/hooks/usePassportShare';
import { useHighlightRingState, invalidateHighlightCache } from '../../src/hooks/useHighlightRingState';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { HighlightComposer } from '../../src/components/HighlightComposer';
import { PostcardComposer } from '../../src/components/PostcardComposer';
import { MemoriesTab } from '../../src/components/MemoriesTab';
import { TripsTab } from '../../src/components/TripsTab';
import { SuggestedMemoryModal } from '../../src/components/SuggestedMemoryModal';
import type { PassportMemory } from '../../src/services/passportStamps';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { OwnerActionMenu } from '../../src/components/OwnerActionMenu';
import { ProfileCompletionCard } from '../../src/components/ProfileCompletionCard';
import { PassportShareCard } from '../../src/components/PassportShareCard';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import type { OwnProfile, PassportPostcard } from '../../src/types/models';
import type { TripRow } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { CompassStatusCard } from '../../src/components/compass/CompassStatusCard';
import { CompassPassportSuggestions } from '../../src/components/compass/CompassPassportSuggestions';
import { getMyBuddyProfile, type BuddyProfile } from '../../src/services/rentABuddy';
import type { VerificationLevelStatus } from '../../src/components/VerificationLevelsRail';

// ── New passport design components ──────────────────────────────────────────
import { PassportIdentityCard, PassportStatsRow } from '../../src/components/passport/PassportIdentityCard';
import { PassportDivider } from '../../src/components/passport/PassportDivider';
import { PassportStampCollection } from '../../src/components/passport/PassportStampCollection';
import { PassportStampsFullView } from '../../src/components/passport/PassportStampsFullView';
import { PassportHighlightsStrip } from '../../src/components/passport/PassportHighlightsStrip';
import { PassportAboutSection } from '../../src/components/passport/PassportAboutSection';
import { PassportSafetySection } from '../../src/components/passport/PassportSafetySection';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';
import { PassportSectionReorderSheet } from '../../src/components/passport/PassportSectionReorderSheet';
import { resolveSectionOrder, type PassportSectionKey } from '../../src/components/passport/passportSections';
import { PassportTabReorderSheet } from '../../src/components/passport/PassportTabReorderSheet';
import { resolveTabOrder, type PassportTabKey, TAB_LABELS } from '../../src/components/passport/passportTabs';
import { MapTab } from '../../src/components/MapTab';
import { DestinationsTab } from '../../src/components/passport/DestinationsTab';
import { groupByDestination } from '../../src/utils/destinationGrouping';
import { useAvailabilityStore } from '../../src/context/AvailabilityStore';
import { resolveAvailabilityChip } from '../../src/lib/availabilityChip';

export default function PassportScreen() {
  const { profile, postcards, stamps, memories, suggestions, loading, error, reload, lastLoadedAt } = usePassport();
  const { userId: ownUserId } = useSession();
  const [tab, setTab] = useState<PassportTabKey>('postcards');
  const [menuOpen, setMenuOpen] = useState(false);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [stampsViewOpen, setStampsViewOpen] = useState(false);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [sectionOrderOverride, setSectionOrderOverride] = useState<PassportSectionKey[] | null>(null);
  const [tabReorderOpen, setTabReorderOpen] = useState(false);
  const [tabOrderOverride, setTabOrderOverride] = useState<PassportTabKey[] | null>(null);
  const insets = useSafeAreaInsets();

  // Suggestion modal — show the first pending suggestion once per session
  const [activeSuggestion, setActiveSuggestion] = useState<PassportMemory | null>(null);
  const suggestionShownRef = React.useRef(false);
  React.useEffect(() => {
    if (!suggestionShownRef.current && suggestions.length > 0) {
      suggestionShownRef.current = true;
      setActiveSuggestion(suggestions[0]);
    }
  }, [suggestions]);

  // Highlight ring state
  const [highlightRefreshKey, setHighlightRefreshKey] = useState(0);
  const ownRingState = useHighlightRingState(ownUserId, highlightRefreshKey);
  const hasOwnHighlights = ownRingState?.hasActive ?? false;
  const allOwnHighlightsViewed = ownRingState?.allViewed ?? false;
  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [highlightViewerIndex, setHighlightViewerIndex] = useState(0);
  const [highlightComposerOpen, setHighlightComposerOpen] = useState(false);
  const [postcardComposerOpen, setPostcardComposerOpen] = useState(false);
  const composerFromViewer = useRef(false);

  const handleOwnRingPress = useCallback(() => {
    if (hasOwnHighlights) setHighlightViewerOpen(true);
    else setHighlightComposerOpen(true);
  }, [hasOwnHighlights]);

  const openHighlightComposer = useCallback(() => {
    composerFromViewer.current = false;
    setHighlightComposerOpen(true);
  }, []);

  const handleAddHighlightFromViewer = useCallback(() => {
    composerFromViewer.current = true;
    setHighlightViewerOpen(false);
    setHighlightComposerOpen(true);
  }, []);

  const handleChangeAvatarViaCamera = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [1, 1], quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const uri = result.assets[0].uri;
    const mime = uri.endsWith('.png') ? 'image/png' : uri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const res = await uploadAvatar(uri, mime);
    if (!res.ok) {
      Alert.alert('Upload failed', res.message ?? 'Could not update your display photo.');
      return;
    }
    reload();
  }, [reload]);

  const handleCameraPress = useCallback(() => {
    Alert.alert('Profile photo', undefined, [
      { text: 'Change display photo', onPress: handleChangeAvatarViaCamera },
      {
        text: hasOwnHighlights ? 'Add or change highlight' : 'Add highlight',
        onPress: openHighlightComposer,
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [handleChangeAvatarViaCamera, hasOwnHighlights, openHighlightComposer]);

  const handleHighlightSuccess = useCallback(() => {
    if (ownUserId) invalidateHighlightCache(ownUserId);
    setHighlightRefreshKey((k) => k + 1);
    setHighlightComposerOpen(false);
    if (composerFromViewer.current) {
      composerFromViewer.current = false;
      setHighlightViewerOpen(true);
    }
  }, [ownUserId]);

  const handleHighlightDeleted = useCallback(() => {
    setHighlightRefreshKey((k) => k + 1);
  }, []);

  const [localPostcards, setLocalPostcards] = useState<PassportPostcard[]>([]);
  React.useEffect(() => { setLocalPostcards(postcards); }, [postcards]);

  React.useEffect(() => {
    if ((tab === 'plans' || tab === 'destinations') && !tripsLoaded) {
      setTripsLoaded(true);
      listMyTrips().then(setTrips).catch(() => {});
    }
  }, [tab, tripsLoaded]);

  const actions = usePostcardActions(setLocalPostcards);

  // Settings hub routes — the old PassportSettingsSheet sections map to hub sub-pages.
  const openSettings = useCallback((section: 'profile' | 'passport' | 'preferences' | 'safety' = 'profile') => {
    const route =
      section === 'passport' ? '/profile/edit/privacy'
      : section === 'preferences' ? '/profile/edit/about'
      : section === 'safety' ? '/profile/edit/safety'
      : '/profile/edit/identity';
    router.push(route as any);
  }, []);

  const handleEditProfile = useCallback(() => { router.push('/profile/edit' as any); }, []);
  const handleViewAsPublic = useCallback(() => {
    const username = profile?.username;
    if (username) router.push(`/u/${username}` as any);
  }, [profile]);

  // ── MUST be called before any early return ───────────────────────────────
  // Hooks called after a conditional return violate React's Rules of Hooks:
  // on the first render (loading) the hook is skipped, on the second render it
  // runs — React throws "Rendered more hooks than during the previous render"
  // and the page goes blank. profile is null while loading; the hook accepts
  // a null username safely.
  const { cardRef, share, sharing } = usePassportShare(profile?.username ?? null);

  if (loading) {
    return (
      <View style={[s.center, { backgroundColor: PP.paperDeep }]}>
        <ActivityIndicator color={PP.ink} />
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={[s.center, { paddingTop: insets.top + 32, paddingHorizontal: space.xl, gap: space.lg, backgroundColor: PP.paperDeep }]}>
        <Text style={{ ...t.heading, color: PP.ink, textAlign: 'center' }}>
          {error ? 'Could not load your passport' : 'Sign in to view your passport'}
        </Text>
        <Text style={{ ...t.body, color: PP.inkMuted, textAlign: 'center' }}>
          {error ? 'Check your connection and try again.' : 'Your travel passport lives here once you sign in.'}
        </Text>
        <Pressable
          style={{ backgroundColor: PP.ink, paddingHorizontal: space.xl, paddingVertical: 12, borderRadius: radius.pill }}
          onPress={error ? reload : () => router.push('/sign-in')}
        >
          <Text style={{ ...t.bodyStrong, color: PP.paper }}>{error ? 'Retry' : 'Sign in'}</Text>
        </Pressable>
      </View>
    );
  }

  const verifiedStamps = (stamps ?? []).filter((s) => !s.locked).length;

  // Compute verification levels for SafetySection
  const lvl = profile.verificationLevel ?? 'none';
  const verificationLevels: VerificationLevelStatus = {
    basicVerified:  ['basic_verified', 'trusted_traveler', 'host_verified', 'buddy_verified'].includes(lvl),
    trustedTraveler:['trusted_traveler', 'host_verified', 'buddy_verified'].includes(lvl),
    hostVerified:   !!profile.hostVerifiedAt,
    buddyVerified:  !!profile.buddyVerifiedAt,
  };
  const noSafetyFlags = (profile.safetyFlagsCount ?? 0) === 0;

  return (
    <View style={[s.root, { backgroundColor: PP.paperDeep }]}>
      <PassportContent
        profile={profile}
        postcards={localPostcards}
        stamps={stamps}
        memories={memories}
        trips={trips}
        tab={tab}
        setTab={setTab}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        openSettings={openSettings}
        actions={actions}
        handleEditProfile={handleEditProfile}
        handleViewAsPublic={handleViewAsPublic}
        reload={reload}
        lastLoadedAt={lastLoadedAt}
        insets={insets}
        hasHighlights={hasOwnHighlights}
        allHighlightsViewed={allOwnHighlightsViewed}
        highlights={ownRingState?.highlights ?? []}
        onHighlightRingPress={handleOwnRingPress}
        onNewHighlightPress={handleCameraPress}
        onHighlightBubblePress={(i) => { setHighlightViewerIndex(i); setHighlightViewerOpen(true); }}
        onAddPostcard={() => setPostcardComposerOpen(true)}
        stampsViewOpen={stampsViewOpen}
        setStampsViewOpen={setStampsViewOpen}
        verificationLevels={verificationLevels}
        noSafetyFlags={noSafetyFlags}
        cardRef={cardRef}
        share={share}
        sharing={sharing}
        sectionOrder={sectionOrderOverride ?? resolveSectionOrder(profile.passportSectionOrder)}
        onArrangeSections={() => setReorderOpen(true)}
        tabOrder={tabOrderOverride ?? resolveTabOrder(profile.passportTabOrder)}
        onArrangeTabs={() => setTabReorderOpen(true)}
      />

      {/* ── Modals ── */}
      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ownRingState?.highlights ?? []}
        startIndex={highlightViewerIndex}
        currentUserId={ownUserId ?? undefined}
        onClose={() => setHighlightViewerOpen(false)}
        onAddHighlight={handleAddHighlightFromViewer}
        onDeleted={handleHighlightDeleted}
      />
      <HighlightComposer
        visible={highlightComposerOpen}
        onClose={() => setHighlightComposerOpen(false)}
        onSuccess={handleHighlightSuccess}
      />
      <PostcardComposer
        visible={postcardComposerOpen}
        onClose={() => setPostcardComposerOpen(false)}
        onSuccess={() => { setPostcardComposerOpen(false); reload(); }}
      />
      <PassportSectionReorderSheet
        visible={reorderOpen}
        initialOrder={sectionOrderOverride ?? resolveSectionOrder(profile.passportSectionOrder)}
        onClose={() => setReorderOpen(false)}
        onSaved={(order) => { setSectionOrderOverride(order); reload(); }}
      />
      <PassportTabReorderSheet
        visible={tabReorderOpen}
        initialOrder={tabOrderOverride ?? profile.passportTabOrder}
        onClose={() => setTabReorderOpen(false)}
        onSaved={(order) => { setTabOrderOverride(order); }}
      />
      <SuggestedMemoryModal
        suggestion={activeSuggestion}
        visible={activeSuggestion !== null}
        onClose={() => setActiveSuggestion(null)}
        onAccepted={(_id) => { setActiveSuggestion(null); reload(); }}
        onDismissed={(_id) => { setActiveSuggestion(null); }}
      />
    </View>
  );
}

// ─── PassportContent ──────────────────────────────────────────────────────────

function PassportContent({
  profile, postcards, stamps, memories, trips, tab, setTab,
  menuOpen, setMenuOpen,
  openSettings, actions, handleEditProfile, handleViewAsPublic,
  reload, lastLoadedAt, insets, hasHighlights, allHighlightsViewed, highlights,
  onHighlightRingPress, onNewHighlightPress, onHighlightBubblePress, onAddPostcard,
  stampsViewOpen, setStampsViewOpen, verificationLevels, noSafetyFlags, cardRef, share, sharing,
  sectionOrder, onArrangeSections, tabOrder, onArrangeTabs,
}: {
  profile: OwnProfile;
  postcards: PassportPostcard[];
  stamps: import('../../src/types/models').PassportStamp[];
  memories: PassportMemory[];
  trips: TripRow[];
  tab: PassportTabKey;
  setTab: (t: PassportTabKey) => void;
  menuOpen: boolean; setMenuOpen: (v: boolean) => void;
  openSettings: (s?: 'profile' | 'passport' | 'preferences' | 'safety') => void;
  actions: ReturnType<typeof usePostcardActions>;
  handleEditProfile: () => void;
  handleViewAsPublic: () => void;
  reload: () => void;
  /** Ref from usePassport stamped only on successful fetch — used for focus TTL. */
  lastLoadedAt: React.MutableRefObject<number>;
  insets: { top: number; bottom: number };
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  highlights: any[];
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  onHighlightBubblePress?: (index: number) => void;
  onAddPostcard?: () => void;
  stampsViewOpen: boolean;
  setStampsViewOpen: (v: boolean) => void;
  verificationLevels: VerificationLevelStatus;
  noSafetyFlags: boolean;
  cardRef: any;
  share: () => void;
  sharing: boolean;
  sectionOrder: PassportSectionKey[];
  onArrangeSections: () => void;
  tabOrder: PassportTabKey[];
  onArrangeTabs: () => void;
}) {
  const verifiedStamps = (stamps ?? []).filter((st) => !st.locked).length;
  const destinationCount = useMemo(
    () => groupByDestination(memories, stamps, postcards, trips).length,
    [memories, stamps, postcards, trips],
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [coverUploading, setCoverUploading] = useState(false);
  const [buddyProfile, setBuddyProfile] = useState<BuddyProfile | null | undefined>(undefined);
  const [, setTrustSheetOpen] = useState(false);

  // Availability chip — read from the store; refresh on focus so it stays in sync
  // with the backend after the user saves changes on the availability screen.
  const { availability, quickStatus, refresh: refreshAvailability } = useAvailabilityStore();
  const ownerChipState = resolveAvailabilityChip({
    openToMeet: availability.openToMeet,
    quickStatus: quickStatus ?? null,
    trips: availability.trips,
    homeCity: profile.homeCity ?? null,
    // Show homeCity context if the profile has one (owner always sees their own city).
    showHomeCity: !!(profile.homeCity),
  });

  const handleChangeCover = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to change your cover photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [16, 9], quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setCoverUploading(true);
    const uri = result.assets[0].uri;
    const mime = uri.endsWith('.png') ? 'image/png' : uri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const res = await uploadCover(uri, mime);
    setCoverUploading(false);
    if (!res.ok) {
      Alert.alert('Upload failed', res.message ?? 'Could not update your cover photo.');
      return;
    }
    reload();
  }, [reload]);

  useFocusEffect(useCallback(() => {
    // Only re-fetch passport data when it's older than the feed TTL — avoids
    // scroll-position resets caused by unconditional reloads on every tab re-entry.
    // lastLoadedAt is stamped inside usePassport only on a successful fetch, so a
    // failed reload never silences the next focus retry.
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {
      reload();
    }
    // These three fetches are lightweight and don't affect scroll position, so
    // they stay unconditional.
    // Refresh availability so the chip always reflects the latest saved state
    // (e.g. the user toggled "Open to meet" on the availability screen and saved).
    refreshAvailability().catch(() => {});
    getPendingPosts().then((r) => {
      if (r.ok && r.data) setPendingCount(r.data.length);
    }).catch(() => {});
    getMyBuddyProfile().then(res => {
      setBuddyProfile(res.ok ? (res.data.profile ?? null) : null);
    }).catch(() => setBuddyProfile(null));
  }, [reload, refreshAvailability]));

  const navScrollHandler = useNavBarScrollHandler();
  const bottomInset = useBottomInset();
  const [statsIconOnly, setStatsIconOnly] = useState(false);
  const handleScroll = useCallback((e: any) => {
    navScrollHandler(e);
    setStatsIconOnly(e.nativeEvent.contentOffset.y > 60);
  }, [navScrollHandler]);

  const renderTabsSection = () => (
    <>
      <View style={s.tabBar}>
        {tabOrder.map((key) => (
          <Pressable
            key={key}
            style={s.tabItem}
            onPress={() => setTab(key)}
          >
            <Text style={[s.tabText, tab === key && s.tabTextActive]}>
              {key === 'destinations' && destinationCount > 0
                ? `${TAB_LABELS[key]} · ${destinationCount}`.toUpperCase()
                : key === 'plans' && trips.length > 0
                ? `${TAB_LABELS[key]} · ${trips.length}`.toUpperCase()
                : TAB_LABELS[key].toUpperCase()}
            </Text>
            {tab === key && <View style={s.tabIndicator} />}
          </Pressable>
        ))}
      </View>

      {/* ── Tab content ── */}
      <View style={s.tabContent}>
        {tab === 'postcards' && (
          <PostcardsTab
            postcards={postcards}
            isOwner
            actions={actions}
            onAddPostcard={onAddPostcard}
          />
        )}
        {tab === 'memories' && (
          <MemoriesTab memories={memories} onReload={reload} />
        )}
        {tab === 'plans' && (
          <TripsTab trips={trips} isOwner />
        )}
        {tab === 'stamps' && (
          <StampsTab
            stamps={[]}
            viewingUsername={profile.username ?? undefined}
            viewingUserId={profile.id}
          />
        )}
        {tab === 'map' && (
          <MapTab postcards={postcards} />
        )}
        {tab === 'destinations' && (
          <DestinationsTab
            memories={memories}
            stamps={stamps}
            postcards={postcards}
            trips={trips}
          />
        )}
      </View>
    </>
  );

  const renderDossierSection = () => (
    <>
      {/* ── Passport dossier sections ── */}
      <PassportDivider label="DOSSIER" />
      <PassportAboutSection
        profile={profile}
        isOwner
        onEdit={handleEditProfile}
      />
      <View style={{ height: 16 }} />
      <PassportSafetySection
        levels={verificationLevels}
        trustScore={profile.trustScore}
        trustLabel={profile.trustLabel}
        noSafetyFlags={noSafetyFlags}
        isOwner
        onPrivacySettings={() => openSettings('safety')}
      />
      <View style={{ height: 24 }} />
    </>
  );

  return (
    <View style={s.root}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {sectionOrder.map((sectionKey) => (
          <React.Fragment key={sectionKey}>
            {sectionKey === 'identity' && (
              <>
        {/* ── Identity Document Card ── */}
        <PassportIdentityCard
          profile={profile}
          isOwner
          onMenuPress={() => setMenuOpen(true)}
          onAvatarPress={() => openSettings('profile')}
          onChangeCover={handleChangeCover}
          coverUploading={coverUploading}
          hasHighlights={hasHighlights}
          allHighlightsViewed={allHighlightsViewed}
          onHighlightRingPress={onHighlightRingPress}
          onNewHighlightPress={onNewHighlightPress}
          trustScore={profile.trustScore ?? undefined}
          trustLabel={profile.trustLabel ?? undefined}
          onTrustInfo={() => setTrustSheetOpen(true)}
          onEditBio={handleEditProfile}
          onSavedPress={() => router.push('/saved' as any)}
          availabilityChip={ownerChipState}
          onAvailabilityChipPress={() => router.push('/availability' as any)}
        />
        <PassportStatsRow
          profile={profile}
          isOwner
          iconOnly={statsIconOnly}
          onStatPress={(label) => {
            if (label === 'Trips') setTab('plans');
            else if (label === 'Stamps') setTab('stamps');
            else if (label === 'Countries') setTab('map');
          }}
        />

        {/* ── Pending posts ── */}
        {pendingCount > 0 && (
          <Pressable style={s.pendingRow} onPress={() => router.push('/pending-posts' as any)}>
            <View style={s.pendingIcon}>
              <Clock size={18} color="#8B5CF6" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.pendingTitle}>Pending posts</Text>
              <Text style={s.pendingSub}>Posts waiting to be shared</Text>
            </View>
            <View style={s.pendingBadge}>
              <Text style={s.pendingBadgeText}>{pendingCount}</Text>
            </View>
          </Pressable>
        )}

        {/* ── Owner utility cards ── */}
        <ProfileCompletionCard profile={profile} onOpenSettings={() => openSettings('profile')} />
        <CompassStatusCard />
        <CompassPassportSuggestions isOwner />

        {/* ── Buddy Profile card ── */}
        {buddyProfile != null && buddyProfile.status !== 'rejected' && (
          <Pressable
            style={s.bpCard}
            onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/' as any)}
          >
            <View style={s.bpIcon}><Text style={{ fontSize: 20 }}>🤝</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.bpTitle}>
                {buddyProfile.status === 'active' ? 'Your Buddy Profile'
                  : buddyProfile.status === 'paused' ? 'Buddy Profile (Paused)' : 'Buddy Application'}
              </Text>
              <Text style={s.bpSub}>
                {buddyProfile.status === 'active'
                  ? `${buddyProfile.city} · ${buddyProfile.reviewCount} review${buddyProfile.reviewCount !== 1 ? 's' : ''}`
                  : buddyProfile.status === 'paused'
                    ? 'Your profile is currently hidden from search'
                    : "Application under review — we'll notify you soon"}
              </Text>
            </View>
            <View style={[s.bpBadge, {
              backgroundColor: buddyProfile.status === 'active' ? '#EEF8F3'
                : buddyProfile.status === 'paused' ? color.haze : '#FFF8ED',
            }]}>
              <Text style={[s.bpBadgeText, {
                color: buddyProfile.status === 'active' ? color.success
                  : buddyProfile.status === 'paused' ? color.mute : color.warn,
              }]}>
                {buddyProfile.status === 'active' ? 'Active'
                  : buddyProfile.status === 'paused' ? 'Paused' : 'In Review'}
              </Text>
            </View>
          </Pressable>
        )}
              </>
            )}

            {sectionKey === 'stamps' && (
              <>
        {/* ── Stamps section ── */}
        <PassportDivider label="MY STAMPS" />
        <PassportStampCollection
          stamps={stamps}
          isOwner
          onViewAll={() => setStampsViewOpen(true)}
          onStampPress={() => setStampsViewOpen(true)}
        />
              </>
            )}

            {sectionKey === 'highlights' && (
              <>
        {/* ── Highlights ── */}
        <PassportDivider label="HIGHLIGHTS" />
        <PassportHighlightsStrip
          highlights={highlights}
          hasActive={hasHighlights ?? false}
          allViewed={allHighlightsViewed ?? false}
          isOwner
          onHighlightPress={onHighlightBubblePress}
          onAddHighlight={onNewHighlightPress}
        />
              </>
            )}

            {sectionKey === 'tabs' && renderTabsSection()}
            {sectionKey === 'dossier' && renderDossierSection()}
          </React.Fragment>
        ))}

        {/* Full stamps modal */}
        <PassportStampsFullView
          visible={stampsViewOpen}
          onClose={() => setStampsViewOpen(false)}
          stamps={stamps}
          isOwner
          totalCount={verifiedStamps}
        />

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ── Absolute UI: share + bell + menus ── */}
      <Pressable
        style={[s.shareBtn, { top: insets.top + space.sm }]}
        onPress={share}
        disabled={sharing}
        hitSlop={8}
        accessibilityLabel="Share Passport"
      >
        {sharing
          ? <ActivityIndicator size="small" color={PP.ink} />
          : <Share2 size={20} color={PP.ink} strokeWidth={1.5} />}
      </Pressable>
      <NotificationBell style={[s.bellBtn, { top: insets.top + space.sm }]} />

      {/* Off-screen share card */}
      <View style={s.offScreen} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <PassportShareCard
          ref={cardRef}
          displayName={profile.displayName ?? profile.name ?? null}
          username={profile.username ?? null}
          avatarUrl={profile.avatarUrl ?? null}
          // trips[] only loads once the Plans tab is opened — without the
          // profile count a shared card could say 0 trips.
          tripCount={profile.tripCount ?? trips.length}
          stampCount={verifiedStamps}
          tagline={profile.bio ?? null}
        />
      </View>

      {/* Owner action menu */}
      <OwnerActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        username={profile.username}
        onEditProfile={() => { setMenuOpen(false); handleEditProfile(); }}
        onSettings={() => { setMenuOpen(false); router.push('/profile/edit' as any); }}
        onViewAsPublic={handleViewAsPublic}
        onArrangeSections={onArrangeSections}
        onArrangeTabs={onArrangeTabs}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Pending posts row
  pendingRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    marginHorizontal: 16, marginTop: 4, marginBottom: 4,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: '#8B5CF630',
    borderRadius: 12, paddingHorizontal: space.md, paddingVertical: 12,
  },
  pendingIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#8B5CF620',
    alignItems: 'center', justifyContent: 'center',
  },
  pendingTitle: { ...t.bodyStrong, color: PP.ink, fontSize: 14, fontWeight: '700' },
  pendingSub: { ...t.small, color: PP.inkMuted, fontSize: 11, marginTop: 1 },
  pendingBadge: {
    minWidth: 22, height: 22, borderRadius: 11,
    backgroundColor: '#8B5CF6',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  pendingBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // Buddy profile card
  bpCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    marginHorizontal: 16, marginTop: space.md,
    backgroundColor: PP.paper,
    borderRadius: 12, borderWidth: 1, borderColor: PP.borderLight,
    padding: space.md,
  },
  bpIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: PP.paperDeep,
    alignItems: 'center', justifyContent: 'center',
  },
  bpTitle: { ...t.bodyStrong, color: PP.ink },
  bpSub: { ...t.small, color: PP.inkMuted, marginTop: 2 },
  bpBadge: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 4 },
  bpBadgeText: { fontSize: 10, fontWeight: '800', fontFamily: 'Courier' },

  // Document-style tab bar
  tabBar: {
    flexDirection: 'row',
    marginTop: 24,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
    marginHorizontal: 16,
  },
  tabItem: {
    paddingVertical: 12,
    marginRight: 24,
    position: 'relative',
  },
  tabText: {
    ...PP_LABEL, fontSize: 13, color: PP.inkMuted, letterSpacing: 0, textTransform: 'none', fontWeight: '500'
  },
  tabTextActive: { color: PP.ink, fontWeight: '700' },
  tabIndicator: {
    position: 'absolute', bottom: -1, left: 0, right: 0,
    height: 2, backgroundColor: PP.ink,
  },
  tabContent: { marginTop: 0 },

  // Saved empty state
  savedEmpty: {
    alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32, gap: 8,
  },
  savedEmptyIcon: { fontSize: 40 },
  savedEmptyTitle: { fontSize: 16, fontWeight: '700', color: PP.ink },
  savedEmptySub: { fontSize: 13, color: PP.inkMuted, textAlign: 'center', lineHeight: 18 },

  // Floating action buttons
  shareBtn: {
    position: 'absolute', right: space.lg + 38 + space.sm, zIndex: 20,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: PP.borderLight,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: PP.ink, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  bellBtn: {
    position: 'absolute', right: space.lg, zIndex: 20,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: PP.borderLight,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: PP.ink, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  offScreen: { position: 'absolute', left: -9999, top: -9999, opacity: 0 },
});
