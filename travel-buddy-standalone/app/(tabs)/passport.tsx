import React, { useState, useCallback, useRef } from 'react';
import { View, Text, Image, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Share2, Clock, Camera } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadAvatar, uploadCover } from '../../src/services/profile';
import { getPendingPosts } from '../../src/services/posts';
import { usePassport } from '../../src/hooks/usePassport';
import { usePostcardActions } from '../../src/hooks/usePostcardActions';
import { NotificationBell } from '../../src/components/NotificationBell';
import { usePassportShare } from '../../src/hooks/usePassportShare';
import { useHighlightRingState, invalidateHighlightCache } from '../../src/hooks/useHighlightRingState';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { HighlightComposer } from '../../src/components/HighlightComposer';
import { PostcardComposer } from '../../src/components/PostcardComposer';
import { MemoriesTab } from '../../src/components/MemoriesTab';
import { SuggestedMemoryModal } from '../../src/components/SuggestedMemoryModal';
import type { PassportMemory } from '../../src/services/passportStamps';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { PassportHero } from '../../src/components/PassportHero';
import { CompactStatsRow } from '../../src/components/CompactStatsRow';
import { PassportVerificationStamp } from '../../src/components/PassportVerificationStamp';
import { VerificationLevelsRail } from '../../src/components/VerificationLevelsRail';
import type { VerificationLevelStatus } from '../../src/components/VerificationLevelsRail';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { TripsTab } from '../../src/components/TripsTab';
import { PassportStampsRail } from '../../src/components/PassportStampsRail';
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

type Tab = 'all' | 'stamps' | 'plans' | 'postcards';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all',       label: 'All' },
  { key: 'stamps',    label: 'Stamps' },
  { key: 'plans',     label: 'Plans' },
  { key: 'postcards', label: 'Postcards' },
];

export default function PassportScreen() {
  const { profile, postcards, stamps, memories, suggestions, loading, error, reload } = usePassport();
  const { userId: ownUserId } = useSession();
  const [tab, setTab] = useState<Tab>('all');
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
    if (tab === 'plans' && !tripsLoaded) {
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
        <ActivityIndicator color={color.signal} />
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
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: space.xxxl }}
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
          onMenuPress={() => setMenuOpen(true)}
          onAvatarPress={() => openSettings('profile')}
          onHighlightRingPress={onHighlightRingPress}
          onNewHighlightPress={onNewHighlightPress}
          trustScore={profile.trustScore ?? undefined}
          trustLabel={profile.trustLabel ?? undefined}
          onTrustInfo={() => setTrustSheetOpen(true)}
        />

        {/* Verification Stamp — full-width, no longer paired with large trust card */}
        <PassportVerificationStamp
          status={profile.verificationStatus}
          verifiedSince={profile.verifiedAt}
          idVerified={!!profile.idVerifiedAt}
          selfieMatched={!!profile.selfieVerifiedAt}
          homeCountryVerified={!!profile.homeCountryVerifiedAt}
          noSafetyFlags={(profile.safetyFlagsCount ?? 0) === 0}
          isOwner
        />

        {/* Stats strip — Trips | Cities | Postcards | Followers | Following */}
        <CompactStatsRow
          tripCount={profile.tripCount ?? trips.length}
          followersCount={profile.followersCount ?? 0}
          followingCount={profile.followingCount ?? 0}
          onCellPress={(label) => {
            if (label === 'Postcards') setTab('postcards');
            else if (label === 'Trips')  setTab('plans');
          }}
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

        {/* My Stamps horizontal rail */}
        <PassportStampsRail
          stamps={stamps}
          isVerified={profile.verificationStatus === 'verified'}
          verifiedSince={profile.verifiedAt}
          isOwner
          onViewAll={() => setTab('stamps')}
          onStampPress={() => setTab('stamps')}
          onVerificationStampPress={() => setTab('stamps')}
        />

        {/* Tab bar — full-width segmented control */}
        <View style={styles.tabBarWrap}>
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
        </View>

        {/* Tab content */}
        <View style={styles.tabContent}>
          {tab === 'all' && (
            <>
              <PostcardsTab
                postcards={postcards}
                isOwner
                actions={actions}
                onAddPostcard={onAddPostcard}
              />
              <MemoriesTab memories={memories} onReload={reload} collapsed />
            </>
          )}
          {tab === 'stamps' && <StampsTab stamps={stamps} isOwner />}
          {tab === 'plans' && <TripsTab trips={trips} isOwner />}
          {tab === 'postcards' && (
            <PostcardsTab
              postcards={postcards}
              isOwner
              actions={actions}
              onAddPostcard={onAddPostcard}
            />
          )}
        </View>

        {/* Verification Levels — always visible at the bottom of the scroll */}
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
          tripCount={trips.length}
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

      {/* Share button — top-right, next to bell */}
      <Pressable
        style={[styles.shareBtn, { top: insets.top + space.sm }]}
        onPress={share}
        disabled={sharing}
        hitSlop={8}
        accessibilityLabel="Share Passport"
      >
        {sharing ? (
          <ActivityIndicator size="small" color={color.ink} />
        ) : (
          <Share2 size={18} color={color.ink} />
        )}
      </Pressable>

      {/* Notifications bell — absolutely positioned top-right, shows popover preview */}
      <NotificationBell style={[styles.bellBtn, { top: insets.top + space.sm }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper },

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

  shareBtn: {
    position: 'absolute',
    right: space.lg + 38 + space.sm,
    zIndex: 20,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellBtn: {
    position: 'absolute',
    right: space.lg,
    zIndex: 20,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
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

  tabBarWrap: {
    flexDirection: 'row',
    marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    padding: 4,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 13 },
  tabTextActive: { color: color.onInk },

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
