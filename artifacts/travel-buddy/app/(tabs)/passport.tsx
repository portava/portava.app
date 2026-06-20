import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePassport } from '../../src/hooks/usePassport';
import { usePostcardActions } from '../../src/hooks/usePostcardActions';
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
  const [tab, setTab] = useState<Tab>('postcards');
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'profile' | 'passport' | 'preferences' | 'safety'>('profile');
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const insets = useSafeAreaInsets();

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

  const handleSaved = useCallback((updated: OwnProfile) => {
    reload();
  }, [reload]);

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
      openToMeet: mock.user.openToMeet, isPrivate: mock.user.isPrivate,
      passportVisibility: 'public', coverPhotoUrl: null,
      usernameUpdatedAt: null, createdAt: '2026-01-01T00:00:00Z',
    };
    return <PassportContent
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
      handleViewAsPublic={handleViewAsPublic}
      insets={insets}
    />;
  }

  return (
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
      handleViewAsPublic={handleViewAsPublic}
      insets={insets}
    />
  );
}

function PassportContent({
  profile, postcards, stamps, trips, tab, setTab,
  menuOpen, setMenuOpen, settingsOpen, setSettingsOpen,
  settingsSection, openSettings, actions, handleSaved, handleViewAsPublic, insets,
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
  handleViewAsPublic: () => void;
  insets: { top: number; bottom: number };
}) {
  const verifiedStamps = stamps.filter((s) => !s.locked).length;

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile header */}
        <PassportHero
          profile={profile}
          isOwner
          onMenuPress={() => setMenuOpen(true)}
          onAvatarPress={() => openSettings('profile')}
        />

        {/* Compact stats row */}
        <CompactStatsRow
          postcards={postcards}
          stamps={verifiedStamps}
          trips={trips}
        />

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

      {/* Owner action menu */}
      <OwnerActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        username={profile.username}
        onEditProfile={() => openSettings('profile')}
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
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper },

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
