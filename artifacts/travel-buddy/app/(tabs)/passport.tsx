import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bell, Share2, MessageCircle } from 'lucide-react-native';
import { usePassport } from '../../src/hooks/usePassport';
import { usePostcardActions } from '../../src/hooks/usePostcardActions';
import { useRequestCount } from '../../src/hooks/useRequests';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { usePassportShare } from '../../src/hooks/usePassportShare';
import { useHighlightRingState, invalidateHighlightCache } from '../../src/hooks/useHighlightRingState';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { HighlightComposer } from '../../src/components/HighlightComposer';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { PassportHero } from '../../src/components/PassportHero';
import { CompactStatsRow } from '../../src/components/CompactStatsRow';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { TripsTab } from '../../src/components/TripsTab';
import { MapTab } from '../../src/components/MapTab';
import { AboutTab } from '../../src/components/AboutTab';
import { PassportSettingsSheet } from '../../src/components/PassportSettingsSheet';
import { OwnerActionMenu } from '../../src/components/OwnerActionMenu';
import { ProfileCompletionCard } from '../../src/components/ProfileCompletionCard';
import { PassportShareCard } from '../../src/components/PassportShareCard';
import { mockPassport } from '../../src/data/passport';
import type { OwnProfile, PassportPostcard } from '../../src/types/models';
import type { TripRow } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';

type Tab = 'postcards' | 'stamps' | 'trips' | 'map' | 'about';
const TABS: { key: Tab; label: string }[] = [
  { key: 'postcards', label: 'Postcards' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'trips', label: 'Trips' },
  { key: 'map', label: 'Map' },
  { key: 'about', label: 'About' },
];

export default function PassportScreen() {
  const { profile, postcards, stamps, loading, error, reload } = usePassport();
  const { userId: ownUserId } = useSession();
  const [tab, setTab] = useState<Tab>('postcards');
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'profile' | 'passport' | 'preferences' | 'safety'>('profile');
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const insets = useSafeAreaInsets();

  // Own highlight ring state — refreshKey forces an immediate cache-bust + re-fetch
  // after a new highlight is created so the ring activates without waiting for TTL.
  const [highlightRefreshKey, setHighlightRefreshKey] = useState(0);
  const ownRingState = useHighlightRingState(ownUserId, highlightRefreshKey);
  const hasOwnHighlights = ownRingState?.hasActive ?? false;
  const allOwnHighlightsViewed = ownRingState?.allViewed ?? false;
  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [highlightComposerOpen, setHighlightComposerOpen] = useState(false);

  // Ring press: view existing highlights or open composer to create a new one
  const handleOwnRingPress = useCallback(() => {
    if (hasOwnHighlights) setHighlightViewerOpen(true);
    else setHighlightComposerOpen(true);
  }, [hasOwnHighlights]);

  // Camera button: always opens the composer directly (for adding a new highlight)
  const handleNewHighlightPress = useCallback(() => {
    setHighlightComposerOpen(true);
  }, []);

  // On successful highlight creation: bust the cache and trigger immediate ring refresh
  const handleHighlightSuccess = useCallback(() => {
    if (ownUserId) invalidateHighlightCache(ownUserId);
    setHighlightRefreshKey((k) => k + 1);
    setHighlightComposerOpen(false);
  }, [ownUserId]);

  const [localPostcards, setLocalPostcards] = useState<PassportPostcard[]>([]);

  React.useEffect(() => {
    setLocalPostcards(postcards);
  }, [postcards]);

  React.useEffect(() => {
    if (tab === 'trips' && !tripsLoaded) {
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
    const mock = mockPassport;
    const fallbackProfile: OwnProfile = {
      id: mock.user.id, handle: mock.user.handle, name: mock.user.name,
      displayName: mock.user.name, username: mock.user.handle,
      bio: mock.user.bio ?? null, avatarUrl: mock.user.avatarUrl,
      homeCity: mock.user.homeCity, homeCountry: mock.user.homeCountry,
      currentCity: mock.user.currentCity ?? null, travelStyle: mock.user.travelStyle,
      interests: mock.user.interests, verified: mock.user.verified,
      verificationStatus: mock.user.verified ? 'verified' : 'unverified',
      verifiedAt: null,
      openToMeet: mock.user.openToMeet, isPrivate: mock.user.isPrivate,
      passportVisibility: 'public', coverPhotoUrl: null,
      usernameUpdatedAt: null, createdAt: '2026-01-01T00:00:00Z',
      spokenLanguages: [], defaultLanguage: null, travelStyles: [],
      travelPace: null, budgetStyle: null, travelGroupStyle: [],
      lookingFor: [], comfortLevel: null, availabilityTags: [],
      planningStyle: null, publicSocialLinks: {}, preferredLanguage: null,
    };
    return (
      <View style={{ flex: 1 }}>
        <PassportContent
          profile={fallbackProfile}
          postcards={[]}
          stamps={mock.stamps}
          trips={[]}
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
          onNewHighlightPress={handleNewHighlightPress}
        />
        <HighlightViewer
          visible={highlightViewerOpen}
          highlights={ownRingState?.highlights ?? []}
          currentUserId={ownUserId ?? undefined}
          onClose={() => setHighlightViewerOpen(false)}
        />
        <HighlightComposer
          visible={highlightComposerOpen}
          onClose={() => setHighlightComposerOpen(false)}
          onSuccess={handleHighlightSuccess}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PassportContent
        profile={profile}
        postcards={localPostcards}
        stamps={stamps}
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
        onNewHighlightPress={handleNewHighlightPress}
      />
      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ownRingState?.highlights ?? []}
        currentUserId={ownUserId ?? undefined}
        onClose={() => setHighlightViewerOpen(false)}
      />
      <HighlightComposer
        visible={highlightComposerOpen}
        onClose={() => setHighlightComposerOpen(false)}
        onSuccess={handleHighlightSuccess}
      />
    </View>
  );
}

function PassportContent({
  profile, postcards, stamps, trips, tab, setTab,
  menuOpen, setMenuOpen, settingsOpen, setSettingsOpen,
  settingsSection, openSettings, actions, handleSaved, handleEditProfile, handleViewAsPublic, reload, insets,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress,
}: {
  profile: OwnProfile;
  postcards: PassportPostcard[];
  stamps: import('../../src/types/models').PassportStamp[];
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
}) {
  const verifiedStamps = stamps.filter((s) => !s.locked).length;
  const { count: requestCount, reload: reloadCount } = useRequestCount();
  const { cardRef, share, sharing } = usePassportShare(profile.username ?? null);
  const { messages: unreadMessages } = useUnreadCounts();

  useFocusEffect(useCallback(() => {
    reloadCount();
    reload();
  }, [reloadCount, reload]));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
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
        />

        {/* Compact stats row */}
        <CompactStatsRow
          postcards={postcards}
          stamps={verifiedStamps}
          trips={trips}
        />

        {/* Telegraph quick action */}
        <Pressable style={styles.telegraphRow} onPress={() => router.push('/(tabs)/messages' as any)}>
          <View style={styles.telegraphIcon}>
            <MessageCircle size={18} color={color.signal} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.telegraphTitle}>Telegraph</Text>
            <Text style={styles.telegraphSub}>Messages, trip chats & travel conversations</Text>
          </View>
          {unreadMessages > 0 && (
            <View style={styles.telegraphBadge}>
              <Text style={styles.telegraphBadgeText}>{unreadMessages > 99 ? '99+' : String(unreadMessages)}</Text>
            </View>
          )}
        </Pressable>

        {/* Profile completion prompt (owner only) */}
        <ProfileCompletionCard
          profile={profile}
          onOpenSettings={() => openSettings('profile')}
        />

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

        {/* Tab content */}
        <View style={styles.tabContent}>
          {tab === 'postcards' && (
            <PostcardsTab
              postcards={postcards}
              isOwner
              actions={actions}
            />
          )}
          {tab === 'stamps' && <StampsTab stamps={stamps} />}
          {tab === 'trips' && <TripsTab trips={trips} isOwner />}
          {tab === 'map' && <MapTab postcards={postcards} />}
          {tab === 'about' && (
            <AboutTab
              profile={profile}
              isOwner
              onOpenSettings={() => openSettings('preferences')}
            />
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

      {/* Notifications bell — absolutely positioned top-right */}
      <Pressable
        style={[styles.bellBtn, { top: insets.top + space.sm }]}
        onPress={() => router.push('/notifications' as any)}
        hitSlop={8}
        accessibilityLabel="Open notifications inbox"
      >
        <Bell size={20} color={color.ink} />
        {requestCount > 0 && (
          <View style={styles.bellBadge}>
            <Text style={styles.bellBadgeText}>{requestCount > 9 ? '9+' : String(requestCount)}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper },

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
  bellBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700', lineHeight: 11 },

  telegraphRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: 14,
    paddingHorizontal: space.md,
    paddingVertical: 12,
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
  telegraphBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  telegraphBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

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

  tabContent: { marginTop: space.md },
});
