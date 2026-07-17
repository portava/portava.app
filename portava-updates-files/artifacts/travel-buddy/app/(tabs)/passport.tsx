import React, { useState, useCallback, useRef } from 'react';
import { View, Text, Image, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Share2, Clock, Camera, MoreHorizontal } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadAvatar, uploadCover } from '../../src/services/profile';
import { getPendingPosts } from '../../src/services/posts';
import { usePassport } from '../../src/hooks/usePassport';
import { usePostcardActions } from '../../src/hooks/usePostcardActions';
import { NotificationBell } from '../../src/components/NotificationBell';
import { TravelBuddyLoader } from '../../src/components/loading/TravelBuddyLoader';
import { usePassportShare } from '../../src/hooks/usePassportShare';
import { useHighlightRingState, invalidateHighlightCache } from '../../src/hooks/useHighlightRingState';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { HighlightComposer } from '../../src/components/HighlightComposer';
import { PostcardComposer } from '../../src/components/PostcardComposer';
import { MemoriesTab } from '../../src/components/MemoriesTab';
import { SuggestedMemoryModal } from '../../src/components/SuggestedMemoryModal';
import type { PassportMemory, PassportStats } from '../../src/services/passportStamps';
import { getPassportStats } from '../../src/services/passportStamps';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { PassportHero } from '../../src/components/PassportHero';
import { PassportVerificationStamp } from '../../src/components/PassportVerificationStamp';
import { VerificationLevelsRail } from '../../src/components/VerificationLevelsRail';
import type { VerificationLevelStatus } from '../../src/components/VerificationLevelsRail';
import { StampsTab } from '../../src/components/StampsTab';
import { PassportTabsBar, type PassportTabKey } from '../../src/components/PassportTabsBar';
import { HighlightsSection } from '../../src/components/HighlightsSection';
import { PostcardWall } from '../../src/components/PostcardWall';
import { PassportTrips } from '../../src/components/PassportTrips';
import { PassportAbout } from '../../src/components/PassportAbout';
import { MapTab } from '../../src/components/MapTab';
import { RecentlyVisited } from '../../src/components/RecentlyVisited';
import { usePassportSectionOrder } from '../../src/hooks/usePassportSectionOrder';
import { PassportSettingsSheet } from '../../src/components/PassportSettingsSheet';
import { OwnerActionMenu } from '../../src/components/OwnerActionMenu';
import { ProfileCompletionCard } from '../../src/components/ProfileCompletionCard';
import { PassportShareCard } from '../../src/components/PassportShareCard';
import type { OwnProfile, PassportPostcard } from '../../src/types/models';
import type { TripRow } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { CompassStatusCard } from '../../src/components/compass/CompassStatusCard';
import { CompassPassportSuggestions } from '../../src/components/compass/CompassPassportSuggestions';
import { getMyBuddyProfile, type BuddyProfile } from '../../src/services/rentABuddy';

type Tab = PassportTabKey;

export default function PassportScreen() {
  const { profile, postcards, stamps, memories, suggestions, loading, error, reload } = usePassport();
  const { userId: ownUserId } = useSession();
  const [tab, setTab] = useState<Tab>('postcards');
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'profile' | 'passport' | 'preferences' | 'safety'>('profile');
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const insets = useSafeAreaInsets();

  // Suggestion modal — show the first pending suggestion automatically once per session
  const [activeSuggestion, setActiveSuggestion] = useState<PassportMemory | null>(null);
  const suggestionShownRef = React.useRef(false);
  React.useEffect(() => {
    if (!suggestionShownRef.current && suggestions.length > 0) {
      suggestionShownRef.current = true;
      setActiveSuggestion(suggestions[0]);
    }
  }, [suggestions]);

  // Own highlight ring state — refreshKey forces an immediate cache-bust + re-fetch
  // after a new highlight is created so the ring activates without waiting for TTL.
  const [highlightRefreshKey, setHighlightRefreshKey] = useState(0);
  const ownRingState = useHighlightRingState(ownUserId, highlightRefreshKey);
  const hasOwnHighlights = ownRingState?.hasActive ?? false;
  const allOwnHighlightsViewed = ownRingState?.allViewed ?? false;
  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [highlightComposerOpen, setHighlightComposerOpen] = useState(false);
  const [postcardComposerOpen, setPostcardComposerOpen] = useState(false);

  // Tracks whether the composer was triggered from inside the viewer (vs. ring/camera)
  const composerFromViewer = useRef(false);

  // Ring press: view existing highlights or open composer to create a new one
  const handleOwnRingPress = useCallback(() => {
    if (hasOwnHighlights) setHighlightViewerOpen(true);
    else setHighlightComposerOpen(true);
  }, [hasOwnHighlights]);

  // Opens the highlight composer directly (shared by camera sheet + viewer "+" button)
  const openHighlightComposer = useCallback(() => {
    composerFromViewer.current = false;
    setHighlightComposerOpen(true);
  }, []);

  // "+" button inside the viewer: close viewer, open composer, then return to viewer
  const handleAddHighlightFromViewer = useCallback(() => {
    composerFromViewer.current = true;
    setHighlightViewerOpen(false);
    setHighlightComposerOpen(true);
  }, []);

  // Change avatar via camera overlay: pick image → upload → reload
  const handleChangeAvatarViaCamera = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
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

  // Camera overlay button on avatar: action sheet with Change photo / Add highlight / Cancel
  const handleCameraPress = useCallback(() => {
    Alert.alert(
      'Profile photo',
      undefined,
      [
        { text: 'Change display photo', onPress: handleChangeAvatarViaCamera },
        {
          text: hasOwnHighlights ? 'Add or change highlight' : 'Add highlight',
          onPress: openHighlightComposer,
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [handleChangeAvatarViaCamera, hasOwnHighlights, openHighlightComposer]);

  // On successful highlight creation: bust the cache and trigger immediate ring refresh
  const handleHighlightSuccess = useCallback(() => {
    if (ownUserId) invalidateHighlightCache(ownUserId);
    setHighlightRefreshKey((k) => k + 1);
    setHighlightComposerOpen(false);
    if (composerFromViewer.current) {
      composerFromViewer.current = false;
      setHighlightViewerOpen(true);
    }
  }, [ownUserId]);

  // On highlight deleted: re-fetch ring state so the ring de-activates immediately
  // if no highlights remain, without waiting for the 60-second cache TTL.
  const handleHighlightDeleted = useCallback(() => {
    setHighlightRefreshKey((k) => k + 1);
  }, []);

  const [localPostcards, setLocalPostcards] = useState<PassportPostcard[]>([]);

  React.useEffect(() => {
    setLocalPostcards(postcards);
  }, [postcards]);

  React.useEffect(() => {
    if (!tripsLoaded) {
      setTripsLoaded(true);
      listMyTrips().then(setTrips).catch(() => {});
    }
  }, [tab, tripsLoaded]);

  const actions = usePostcardActions(setLocalPostcards);

  const openSettings = useCallback((section: typeof settingsSection = 'profile') => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const handleSaved = useCallback((_updated: OwnProfile) => {
    reload();
  }, [reload]);

  const handleEditProfile = useCallback(() => {
    router.push('/profile/edit' as any);
  }, []);

  const handleViewAsPublic = useCallback(() => {
    const username = profile?.username;
    if (username) router.push(`/u/${username}` as any);
  }, [profile]);

  if (loading) {
    return (
      <View style={styles.center}>
        <TravelBuddyLoader context="screen" accessibilityLabel="Loading your Passport" />
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 32, paddingHorizontal: space.xl, gap: space.lg }]}>
        <Text style={{ ...t.heading, color: color.ink, textAlign: 'center' }}>
          {error ? 'Could not load your passport' : 'Sign in to view your passport'}
        </Text>
        <Text style={{ ...t.body, color: color.mute, textAlign: 'center' }}>
          {error
            ? 'Check your connection and try again.'
            : 'Your travel passport, stamps, and memories live here once you sign in.'}
        </Text>
        {error ? (
          <Pressable
            style={{ backgroundColor: color.signal, paddingHorizontal: space.xl, paddingVertical: 12, borderRadius: radius.md }}
            onPress={reload}
          >
            <Text style={{ ...t.bodyStrong, color: '#fff' }}>Retry</Text>
          </Pressable>
        ) : (
          <Pressable
            style={{ backgroundColor: color.signal, paddingHorizontal: space.xl, paddingVertical: 12, borderRadius: radius.md }}
            onPress={() => router.push('/sign-in')}
          >
            <Text style={{ ...t.bodyStrong, color: '#fff' }}>Sign in</Text>
          </Pressable>
        )}
      </View>
    );
  }

  const handleSuggestionAccepted = (id: string) => {
    setActiveSuggestion(null);
    reload();
  };

  const handleSuggestionDismissed = (id: string) => {
    setActiveSuggestion(null);
  };

  return (
    <View style={{ flex: 1 }}>
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
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        settingsSection={settingsSection}
        openSettings={openSettings}
        actions={actions}
        handleSaved={handleSaved}
        handleEditProfile={handleEditProfile}
        handleViewAsPublic={handleViewAsPublic}
        reload={reload}
        insets={insets}
        hasHighlights={hasOwnHighlights}
        allHighlightsViewed={allOwnHighlightsViewed}
        onHighlightRingPress={handleOwnRingPress}
        onNewHighlightPress={handleCameraPress}
        onAddPostcard={() => setPostcardComposerOpen(true)}
        ownUserId={ownUserId}
        highlightRefreshKey={highlightRefreshKey}
        hasOwnHighlights={hasOwnHighlights}
        setHighlightViewerOpen={setHighlightViewerOpen}
      />
      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ownRingState?.highlights ?? []}
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
      <SuggestedMemoryModal
        suggestion={activeSuggestion}
        visible={activeSuggestion !== null}
        onClose={() => setActiveSuggestion(null)}
        onAccepted={handleSuggestionAccepted}
        onDismissed={handleSuggestionDismissed}
      />
    </View>
  );
}

function PassportContent({
  profile, postcards, stamps, memories, trips, tab, setTab,
  menuOpen, setMenuOpen, settingsOpen, setSettingsOpen,
  settingsSection, openSettings, actions, handleSaved, handleEditProfile, handleViewAsPublic, reload, insets,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress, onAddPostcard,
  ownUserId, highlightRefreshKey, hasOwnHighlights, setHighlightViewerOpen,
}: {
  profile: OwnProfile;
  postcards: PassportPostcard[];
  stamps: import('../../src/types/models').PassportStamp[];
  memories: PassportMemory[];
  trips: TripRow[];
  tab: Tab;
  setTab: (t: Tab) => void;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  settingsSection: 'profile' | 'passport' | 'preferences' | 'safety';
  openSettings: (s?: 'profile' | 'passport' | 'preferences' | 'safety') => void;
  actions: ReturnType<typeof usePostcardActions>;
  handleSaved: (p: OwnProfile) => void;
  handleEditProfile: () => void;
  handleViewAsPublic: () => void;
  reload: () => void;
  insets: { top: number; bottom: number };
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  onAddPostcard?: () => void;
}) {
  const verifiedStamps = stamps.filter((s) => !s.locked).length;
  const { cardRef, share, sharing } = usePassportShare(profile.username ?? null);
  const [pendingCount, setPendingCount] = useState(0);
  // Live passport stats (countries / stamps) via the existing stats endpoint.
  const [passportStats, setPassportStats] = useState<PassportStats | null>(null);
  // User-reorganizable Trips-tab sections (persisted; see usePassportSectionOrder)
  const { order: tripsSectionOrder } = usePassportSectionOrder('tripsTab',
    ['tripsOverview', 'memories']);
  React.useEffect(() => {
    getPassportStats().then((res) => { if (res.ok) setPassportStats(res.data); }).catch(() => {});
  }, []);
  const [coverError, setCoverError] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [buddyProfile, setBuddyProfile] = useState<BuddyProfile | null | undefined>(undefined);
  const [, setTrustSheetOpen] = useState(false);

  const handleChangeCover = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to change your cover photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setCoverUploading(true);
    const uri = result.assets[0].uri;
    const mime = uri.endsWith('.png') ? 'image/png' : uri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const res = await uploadCover(uri, mime);
    setCoverUploading(false);
    if (!res.ok) {
      Alert.alert('Upload failed', res.message ?? 'Could not update your cover photo. Your previous cover is still shown.');
      return;
    }
    reload();
  }, [reload]);

  useFocusEffect(useCallback(() => {
    reload();
    getPendingPosts().then((r) => {
      if (r.ok && r.data) setPendingCount(r.data.length);
    }).catch(() => {});
    getMyBuddyProfile().then(res => {
      setBuddyProfile(res.ok ? (res.data.profile ?? null) : null);
    }).catch(() => setBuddyProfile(null));
  }, [reload]));

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      {/* Top navigation — title + Share / Notifications / More */}
      <View style={[styles.topNav, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.topNavTitle}>Passport</Text>
        <View style={styles.topNavActions}>
          <Pressable
            style={styles.topNavBtn}
            onPress={share}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel="Share Passport"
          >
            {sharing ? (
              <ActivityIndicator size="small" color={color.ink} />
            ) : (
              <Share2 size={20} color={color.ink} />
            )}
          </Pressable>
          <NotificationBell style={styles.topNavBtn} />
          <Pressable
            style={styles.topNavBtn}
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="More Options"
          >
            <MoreHorizontal size={22} color={color.ink} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#FFFFFF' }}
        contentContainerStyle={{ paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Cover photo band — full-width above the hero card.
            Owner sees a camera edit button (bottom-right).
            Fallback (haze) shown when coverPhotoUrl is absent or the URL fails to load. */}
        <View style={styles.coverBand}>
          {profile.coverPhotoUrl && !coverError ? (
            <Image
              source={{ uri: profile.coverPhotoUrl }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onError={() => setCoverError(true)}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: color.haze }]} />
          )}
          {coverUploading && (
            <View style={styles.coverUploadingOverlay}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          )}
          <Pressable
            style={styles.coverEditBtn}
            onPress={handleChangeCover}
            disabled={coverUploading}
            hitSlop={8}
            accessibilityLabel="Change cover photo"
            accessibilityRole="button"
          >
            {coverUploading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Camera size={15} color="#fff" />}
          </Pressable>
        </View>

        {/* Profile header */}
        <PassportHero
          profile={profile}
          isOwner
          hasHighlights={hasHighlights}
          allHighlightsViewed={allHighlightsViewed}
          onAvatarPress={() => openSettings('profile')}
          onHighlightRingPress={onHighlightRingPress}
          onNewHighlightPress={onNewHighlightPress}
          trustScore={profile.trustScore ?? undefined}
          trustLabel={profile.trustLabel ?? undefined}
          onTrustInfo={() => setTrustSheetOpen(true)}
          onEditProfile={() => openSettings('profile')}
          stats={{
            trips: profile.tripCount ?? trips.length,
            followers: profile.followersCount ?? 0,
            following: profile.followingCount ?? 0,
            stamps: passportStats?.totalStamps ?? stamps.length,
          }}
          onTripsPress={() => setTab('trips')}
          onStampsPress={() => setTab('stamps')}
        />

        {/* Pending posts entry point — only shown when there are posts waiting */}
        {pendingCount > 0 && (
          <Pressable style={styles.pendingRow} onPress={() => router.push('/pending-posts' as any)}>
            <View style={[styles.telegraphIcon, { backgroundColor: '#8B5CF620' }]}>
              <Clock size={18} color="#8B5CF6" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.telegraphTitle}>Pending posts</Text>
              <Text style={styles.telegraphSub}>Posts waiting to be shared</Text>
            </View>
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingBadgeText}>{pendingCount}</Text>
            </View>
          </Pressable>
        )}

        {/* Profile completion prompt (owner only) */}
        <ProfileCompletionCard
          profile={profile}
          onOpenSettings={() => openSettings('profile')}
        />

        {/* Compass active-user status (owner only, hides itself when opted out) */}
        <CompassStatusCard />

        {/* Compass "Suggested for You" — personalised recommendations (owner only) */}
        <CompassPassportSuggestions isOwner />


        {/* My Stamps horizontal rail */}
        {/* Highlights — social rail (existing viewer/composer flows) */}
        <HighlightsSection
          userId={ownUserId}
          isOwner
          refreshKey={highlightRefreshKey}
          onOpenViewer={hasOwnHighlights ? () => setHighlightViewerOpen(true) : undefined}
          onNewHighlight={onNewHighlightPress}
        />

        {/* Passport section navigation */}
        <PassportTabsBar active={tab} onChange={setTab} />

        {/* Active section content (sections are reorderable — see usePassportSectionOrder) */}
        <View style={styles.tabContent}>
          {tab === 'postcards' && (
            <PostcardWall
              postcards={postcards}
              isOwner
              onAddPostcard={onAddPostcard}
              onTileLongPress={(card) => {
                // Existing wall-management actions (same usePostcardActions flows)
                Alert.alert(
                  'Manage Postcard',
                  card.locationCity ?? card.locationName ?? undefined,
                  [
                    card.pinnedAt
                      ? { text: 'Unpin from wall', onPress: () => actions.unpin(card.id) }
                      : { text: 'Pin to wall', onPress: () => actions.pin(card.id) },
                    { text: 'Remove from wall', style: 'destructive', onPress: () => actions.remove(card.id) },
                    { text: 'Open post', onPress: () => card.postId && router.push(`/post/${card.postId}` as any) },
                    { text: 'Cancel', style: 'cancel' },
                  ],
                );
              }}
            />
          )}
          {tab === 'trips' && (
            <>
              {tripsSectionOrder.map((sectionKey) => {
                switch (sectionKey) {
                  case 'tripsOverview':
                    return <PassportTrips key={sectionKey} trips={trips} isOwner />;
                  case 'memories':
                    return <MemoriesTab key={sectionKey} memories={memories} onReload={reload} collapsed />;
                  default:
                    return null;
                }
              })}
            </>
          )}
          {tab === 'stamps' && <StampsTab stamps={stamps} isOwner />}
          {tab === 'map' && (
            <>
              <MapTab postcards={postcards} currentCity={profile.homeCity} currentUserId={ownUserId} />
              {/* travel summary — real counts from existing sources */}
              <View style={styles.summaryGrid}>
                {[
                  { label: 'Countries', value: passportStats?.countries ?? 0 },
                  { label: 'Cities', value: passportStats?.cities ?? 0 },
                  { label: 'Trips', value: profile.tripCount ?? trips.length },
                  { label: 'Stamps', value: passportStats?.totalStamps ?? stamps.length },
                ].map((cell) => (
                  <View key={cell.label} style={styles.summaryCell}>
                    <Text style={styles.summaryValue}>{cell.value}</Text>
                    <Text style={styles.summaryLabel}>{cell.label}</Text>
                  </View>
                ))}
              </View>
              <RecentlyVisited postcards={postcards} />
            </>
          )}
          {tab === 'about' && (
            <>
            {/* Buddy Profile card — shown when the user has a Buddy profile */}
            {buddyProfile != null && buddyProfile.status !== 'rejected' && (
              <Pressable
                style={bpCard.wrap}
                onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/' as any)}
              >
                <View style={bpCard.iconWrap}>
                  <Text style={bpCard.icon}>🤝</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={bpCard.title}>
                    {buddyProfile.status === 'active' ? 'Your Buddy Profile' :
                      buddyProfile.status === 'paused' ? 'Buddy Profile (Paused)' : 'Buddy Application'}
                  </Text>
                  <Text style={bpCard.sub}>
                    {buddyProfile.status === 'active'
                      ? `${buddyProfile.city} · ${buddyProfile.reviewCount} review${buddyProfile.reviewCount !== 1 ? 's' : ''}`
                      : buddyProfile.status === 'paused'
                        ? 'Your profile is currently hidden from search'
                        : 'Application under review — we\'ll notify you soon'}
                  </Text>
                </View>
                <View style={[bpCard.badge, {
                  backgroundColor: buddyProfile.status === 'active' ? '#EEF8F3' :
                    buddyProfile.status === 'paused' ? color.haze : '#FFF8ED',
                }]}>
                  <Text style={[bpCard.badgeText, {
                    color: buddyProfile.status === 'active' ? color.success :
                      buddyProfile.status === 'paused' ? color.mute : color.warn,
                  }]}>
                    {buddyProfile.status === 'active' ? 'Active' :
                      buddyProfile.status === 'paused' ? 'Paused' : 'In Review'}
                  </Text>
                </View>
              </Pressable>
            )}

              <PassportAbout
                profile={profile}
                countriesVisited={passportStats?.countries}
                citiesVisited={passportStats?.cities}
                tripsCompleted={profile.tripCount ?? trips.length}
                stampsCount={passportStats?.totalStamps ?? stamps.length}
                trustScore={profile.trustScore ?? undefined}
                trustLabel={profile.trustLabel ?? undefined}
              />
              <PassportVerificationStamp
                status={profile.verificationStatus}
                verifiedSince={profile.verifiedAt}
                idVerified={!!profile.idVerifiedAt}
                selfieMatched={!!profile.selfieVerifiedAt}
                homeCountryVerified={!!profile.homeCountryVerifiedAt}
                noSafetyFlags={(profile.safetyFlagsCount ?? 0) === 0}
                isOwner
              />
              {(() => {
                const lvl = profile.verificationLevel ?? 'none';
                const levels: VerificationLevelStatus = {
                  basicVerified: ['basic_verified', 'trusted_traveler', 'host_verified', 'buddy_verified'].includes(lvl),
                  trustedTraveler: ['trusted_traveler', 'host_verified', 'buddy_verified'].includes(lvl),
                  hostVerified: !!profile.hostVerifiedAt,
                  buddyVerified: !!profile.buddyVerifiedAt,
                };
                return <VerificationLevelsRail levels={levels} />;
              })()}
            </>
          )}
        </View>

      </ScrollView>

      {/* Off-screen share card (captured by usePassportShare) */}
      <View
        style={styles.offScreen}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <PassportShareCard
          ref={cardRef}
          displayName={profile.displayName ?? profile.name ?? null}
          username={profile.username ?? null}
          avatarUrl={profile.avatarUrl ?? null}
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
        onSettings={() => openSettings('passport')}
        onViewAsPublic={handleViewAsPublic}
      />

      {/* Settings sheet */}
      {settingsOpen && (
        <PassportSettingsSheet
          visible={settingsOpen}
          profile={profile}
          onClose={() => setSettingsOpen(false)}
          onSaved={handleSaved}
        />
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },

  summaryGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 12,
    paddingHorizontal: 16, paddingTop: 14,
  },
  summaryCell: {
    flexBasis: 0, flexGrow: 1, minHeight: 72,
    borderRadius: 14, borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  summaryValue: { fontSize: 18, fontWeight: '700', color: '#101828' },
  summaryLabel: { fontSize: 12, color: '#475467' },

  topNav: {
    minHeight: 64, paddingHorizontal: space.lg, paddingBottom: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
  },
  topNavTitle: { fontSize: 23, fontWeight: '700', color: color.ink },
  topNavActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  topNavBtn: {
    width: 44, height: 44, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EAECF0',
  },

  coverBand: { width: '100%', height: 140, overflow: 'hidden' },
  coverUploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverEditBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },

  offScreen: {
    position: 'absolute',
    left: -9999,
    top: -9999,
    opacity: 0,
  },

  telegraphIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: color.signal + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  telegraphTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  telegraphSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    marginTop: 1,
  },

  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginTop: space.xs,
    marginBottom: space.xs,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: '#8B5CF630',
    borderRadius: 14,
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  pendingBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#8B5CF6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  pendingBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },


  tabContent: { marginTop: space.md },
});

const bpCard = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    marginHorizontal: space.lg, marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md,
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#EEF8F3',
    alignItems: 'center', justifyContent: 'center',
  },
  icon: { fontSize: 20 },
  title: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.mute, marginTop: 2 },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm, paddingVertical: 4,
  },
  badgeText: { fontSize: 10, fontWeight: '800', fontFamily: 'Courier' },
});
