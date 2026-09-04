import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert, RefreshControl } from 'react-native';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader } from '../../src/hooks/useCollapsingHeader';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Clock } from 'lucide-react-native';
import { PortavaShareIcon } from '../../src/components/icons/PortavaShareIcon';
import { uploadAvatar, uploadCover } from '../../src/services/profile';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import { getPendingPosts } from '../../src/services/posts';
import { FEED_FOCUS_TTL_MS } from '../../src/hooks/usePosts';
import { usePassport, isProfileStaleSince } from '../../src/hooks/usePassport';
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
import type { PassportMemory, PassportStats } from '../../src/services/passportStamps';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { PassportOwnerMenuSheet } from '../../src/components/passport/PassportOwnerMenuSheet';
import { CreateHubSheet } from '../../src/components/create/CreateHubSheet';
import { ProfileCompletionCard } from '../../src/components/ProfileCompletionCard';
import { PassportShareCard } from '../../src/components/PassportShareCard';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import type { OwnProfile, PassportPostcard } from '../../src/types/models';
import type { TripRow } from '../../src/services/trips';
import { color, space, radius, type as t, avatar } from '../../src/theme/tokens';
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
import { PassportTravelInfoSection } from '../../src/components/passport/PassportTravelInfoSection';
import { PassportQuickLinks } from '../../src/components/passport/PassportQuickLinks.tsx';
import { PassportHomePreviews } from '../../src/components/passport/PassportHomePreviews.tsx';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { PassportSectionReorderSheet } from '../../src/components/passport/PassportSectionReorderSheet';
import { resolveSectionOrder, resolveHiddenSections, type PassportSectionKey } from '../../src/components/passport/passportSections';
import { PassportTabReorderSheet } from '../../src/components/passport/PassportTabReorderSheet';
import { TrustScoreInfoSheet } from '../../src/components/passport/TrustScoreInfoSheet';
import { resolveTabOrder, type PassportTabKey, TAB_LABELS } from '../../src/components/passport/passportTabs';
import { MapTab } from '../../src/components/MapTab';
import { DestinationsTab } from '../../src/components/passport/DestinationsTab';
import { groupByDestination } from '../../src/utils/destinationGrouping';
import { useAvailabilityStore } from '../../src/context/AvailabilityStore';
import { resolveAvailabilityChip } from '../../src/lib/availabilityChip';
import { useScreenTiming } from '../../src/hooks/useScreenTiming';

export default function PassportScreen() {
  const { pickMedia } = useMediaPicker();
  const { profile, postcards, stamps, stampsNew, memories, suggestions, loading, error, stampsTotal, loadingMoreStamps, loadMoreStamps, updateStamp, reload, lastLoadedAt } = usePassport();
  const { markFirstContent, epoch } = useScreenTiming('Passport');
  const { userId: ownUserId, signOut } = useSession();
  // Deep links (e.g. the stamp-earned toast) can request a specific tab via
  // ?tab=stamps — honor it on first mount, falling back to the default when
  // absent or invalid so normal in-app navigation is unaffected.
  const { tab: deepLinkTab } = useLocalSearchParams<{ tab?: string }>();
  const initialTab: PassportTabKey =
    deepLinkTab === 'stamps' || deepLinkTab === 'postcards' || deepLinkTab === 'memories'
      || deepLinkTab === 'trips' || deepLinkTab === 'map' || deepLinkTab === 'destinations'
      ? (deepLinkTab as PassportTabKey)
      : 'postcards';
  const [tab, setTab] = useState<PassportTabKey>(initialTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [stampsViewOpen, setStampsViewOpen] = useState(false);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [sectionOrderOverride, setSectionOrderOverride] = useState<PassportSectionKey[] | null>(null);
  const [hiddenSectionsOverride, setHiddenSectionsOverride] = useState<PassportSectionKey[] | null>(null);
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
    const assets = await pickMedia({
      title: 'Change display photo',
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!assets?.[0]) return;
    const uri = assets[0].uri;
    const mime = uri.endsWith('.png') ? 'image/png' : uri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const res = await uploadAvatar(uri, mime);
    if (!res.ok) {
      Alert.alert('Upload failed', res.message ?? 'Could not update your display photo.');
      return;
    }
    reload();
  }, [reload, pickMedia]);

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
      listMyTrips().then(setTrips).finally(() => setTripsLoaded(true)).catch(() => {});
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
  // Perf timing: fire on every focus cycle when profile is loaded.
  // epoch increments on each focus so warm opens fire even without data changes.
  useEffect(() => {
    if (profile) markFirstContent();
  }, [epoch, !!profile]); // eslint-disable-line react-hooks/exhaustive-deps

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
          onPress={error ? reload : () => router.push('/(auth)/sign-in')}
          accessibilityLabel={error ? 'Retry' : 'Sign in'}
          accessibilityRole="button"
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

  // Hidden sections: derive the effective (visible) section order for the owner
  // by filtering out any sections the owner has toggled off. Position in the
  // ordering is preserved so sections reappear in the right place when un-hidden.
  const _rawSectionOrder = sectionOrderOverride ?? resolveSectionOrder(profile.passportSectionOrder);
  const _hiddenSet = resolveHiddenSections(hiddenSectionsOverride ?? profile.passportHiddenSections);
  const effectiveSectionOrder = _hiddenSet.size > 0
    ? _rawSectionOrder.filter((k) => !_hiddenSet.has(k))
    : _rawSectionOrder;

  return (
    <View style={[s.root, { backgroundColor: PP.paperDeep }]}>
      <PassportContent
        profile={profile}
        postcards={localPostcards}
        stamps={stamps}
        stampsNew={stampsNew}
        onStampUpdated={updateStamp}
        memories={memories}
        trips={trips}
        tripsLoaded={tripsLoaded}
        tab={tab}
        setTab={setTab}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        openSettings={openSettings}
        actions={actions}
        handleEditProfile={handleEditProfile}
        handleViewAsPublic={handleViewAsPublic}
        reload={reload}
        stampsTotal={stampsTotal}
        loadingMoreStamps={loadingMoreStamps}
        loadMoreStamps={loadMoreStamps}
        lastLoadedAt={lastLoadedAt}
        insets={insets}
        hasHighlights={hasOwnHighlights}
        allHighlightsViewed={allOwnHighlightsViewed}
        highlights={ownRingState?.highlights ?? []}
        onHighlightRingPress={handleOwnRingPress}
        onNewHighlightPress={handleCameraPress}
        onDirectAddHighlight={openHighlightComposer}
        onHighlightBubblePress={(i) => { setHighlightViewerIndex(i); setHighlightViewerOpen(true); }}
        onAddPostcard={() => setPostcardComposerOpen(true)}
        stampsViewOpen={stampsViewOpen}
        setStampsViewOpen={setStampsViewOpen}
        verificationLevels={verificationLevels}
        noSafetyFlags={noSafetyFlags}
        cardRef={cardRef}
        share={share}
        sharing={sharing}
        sectionOrder={effectiveSectionOrder}
        onArrangeSections={() => setReorderOpen(true)}
        tabOrder={tabOrderOverride ?? resolveTabOrder(profile.passportTabOrder)}
        onArrangeTabs={() => setTabReorderOpen(true)}
        onChangeAvatar={handleChangeAvatarViaCamera}
        onSignOut={async () => {
          try {
            await signOut();
            router.replace('/(auth)/sign-in');
          } catch {
            Alert.alert('Sign out failed', 'Could not sign you out — please try again.');
          }
        }}
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
        initialHidden={hiddenSectionsOverride ?? profile.passportHiddenSections}
        onClose={() => setReorderOpen(false)}
        onSaved={(order, hidden) => {
          setSectionOrderOverride(order);
          setHiddenSectionsOverride(hidden.length > 0 ? hidden : null);
          reload();
        }}
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
  profile, postcards, stamps, stampsNew, onStampUpdated, memories, trips, tripsLoaded, tab, setTab,
  menuOpen, setMenuOpen,
  openSettings, actions, handleEditProfile, handleViewAsPublic,
  reload, stampsTotal, loadingMoreStamps, loadMoreStamps,
  lastLoadedAt, insets, hasHighlights, allHighlightsViewed, highlights,
  onHighlightRingPress, onNewHighlightPress, onDirectAddHighlight, onHighlightBubblePress, onAddPostcard,
  stampsViewOpen, setStampsViewOpen, verificationLevels, noSafetyFlags, cardRef, share, sharing,
  sectionOrder, onArrangeSections, tabOrder, onArrangeTabs,
  onChangeAvatar, onSignOut,
}: {
  profile: OwnProfile;
  postcards: PassportPostcard[];
  stamps: import('../../src/types/models').PassportStamp[];
  /** v2 stamps from the single usePassport pipeline — feeds the Stamps grid. */
  stampsNew: import('../../src/services/passportStamps').PassportStampNew[];
  /** Propagates stamp edits (visibility) back into the shared pipeline. */
  onStampUpdated: (updated: import('../../src/services/passportStamps').PassportStampNew) => void;
  memories: PassportMemory[];
  trips: TripRow[];
  /** True once the initial trips fetch (for the Plans tab) has resolved. */
  tripsLoaded: boolean;
  tab: PassportTabKey;
  setTab: (t: PassportTabKey) => void;
  menuOpen: boolean; setMenuOpen: (v: boolean) => void;
  openSettings: (s?: 'profile' | 'passport' | 'preferences' | 'safety') => void;
  actions: ReturnType<typeof usePostcardActions>;
  handleEditProfile: () => void;
  handleViewAsPublic: () => void;
  reload: () => void;
  /** Server-reported total stamp count (pagination sentinel). */
  stampsTotal: number;
  /** True while a next stamps page is being fetched. */
  loadingMoreStamps: boolean;
  /** Fetch the next page of stamps (no-op when all loaded). */
  loadMoreStamps: () => void;
  /** Ref from usePassport stamped only on successful fetch — used for focus TTL. */
  lastLoadedAt: React.MutableRefObject<number>;
  insets: { top: number; bottom: number };
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  highlights: any[];
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  /** Direct path to the highlight composer — used by the highlights strip "+" button. */
  onDirectAddHighlight?: () => void;
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
  /** Direct avatar/photo picker — skips the Alert chooser. */
  onChangeAvatar?: () => void;
  /** Sign the current user out (confirmation prompt handled by the sheet). */
  onSignOut?: () => Promise<void>;
}) {
  const { pickMedia } = useMediaPicker();
  const verifiedStamps = (stamps ?? []).filter((st) => !st.locked).length;
  const destinationCount = useMemo(
    () => groupByDestination(memories, stamps, postcards, trips).length,
    [memories, stamps, postcards, trips],
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [coverUploading, setCoverUploading] = useState(false);
  const [buddyProfile, setBuddyProfile] = useState<BuddyProfile | null | undefined>(undefined);
  const [trustSheetOpen, setTrustSheetOpen] = useState(false);
  // Owner passport stats reported up from PassportStatsRow (single fetch) —
  // powers the World Traveler stamp on the identity card.
  const [passportStats, setPassportStats] = useState<PassportStats | null>(null);
  const [createHubOpen, setCreateHubOpen] = useState(false);

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
    const assets = await pickMedia({
      title: 'Change cover photo',
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.85,
    });
    if (!assets?.[0]) return;
    setCoverUploading(true);
    const uri = assets[0].uri;
    const mime = uri.endsWith('.png') ? 'image/png' : uri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const res = await uploadCover(uri, mime);
    setCoverUploading(false);
    if (!res.ok) {
      Alert.alert('Upload failed', res.message ?? 'Could not update your cover photo.');
      return;
    }
    reload();
  }, [reload, pickMedia]);

  useFocusEffect(useCallback(() => {
    // Only re-fetch passport data when it's older than the feed TTL — avoids
    // scroll-position resets caused by unconditional reloads on every tab re-entry.
    // lastLoadedAt is stamped inside usePassport only on a successful fetch, so a
    // failed reload never silences the next focus retry.
    // QA round 2, bug 8: the TTL alone kept a just-saved bio invisible for up to
    // five minutes. isProfileStaleSince lets a profile write force the next
    // focus refetch without weakening the guard for ordinary tab re-entry.
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS
        || isProfileStaleSince(lastLoadedAt.current)) {
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
  const bottomInset = useLayoverAwareBottomInset();
  const { largeHeaderStyle, compactBarStyle, compactBarInteractive } = useCollapsingHeader();
  const [statsIconOnly, setStatsIconOnly] = useState(false);

  // Pull-to-refresh: re-fetches the passport (bypassing the focus TTL), plus
  // the lightweight availability chip so both stay in sync with the backend.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    reload();
    refreshAvailability().catch(() => {});
  }, [reload, refreshAvailability]);
  // usePassport's `loading` isn't exposed here, so clear the spinner once the
  // shared pipeline stamps a fresh lastLoadedAt (successful reload landed).
  const refreshStartedAt = React.useRef(0);
  React.useEffect(() => {
    if (!refreshing) return;
    refreshStartedAt.current = Date.now();
    const id = setInterval(() => {
      if (lastLoadedAt.current >= refreshStartedAt.current || Date.now() - refreshStartedAt.current > 8000) {
        setRefreshing(false);
        clearInterval(id);
      }
    }, 150);
    return () => clearInterval(id);
  }, [refreshing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Filled by StampsTab with its load-more function (paginated grid data).
  const stampsLoadMoreRef = React.useRef<(() => void) | null>(null);
  const handleScroll = useCallback((e: any) => {
    navScrollHandler(e);
    setStatsIconOnly(e.nativeEvent.contentOffset.y > 60);
    // Infinite scroll for passport stamps: when the stamps tab is active and
    // the user nears the bottom, fetch the next page. StampsTab binds the ref
    // to the SINGLE shared pipeline (usePassport.loadMoreStamps), which guards
    // itself (in-flight + stamps.length === total sentinel), so calling it on
    // every near-bottom scroll event is safe and issues exactly one paged
    // request per page.
    if (tab === 'stamps') {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 400) {
        stampsLoadMoreRef.current?.();
      }
    }
  }, [navScrollHandler, tab]);

  const renderTabsSection = () => (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.tabBar}
        contentContainerStyle={s.tabBarContent}
      >
        {tabOrder.map((key) => (
          <Pressable
            key={key}
            style={s.tabItem}
            onPress={() => setTab(key)}
            accessibilityLabel={TAB_LABELS[key]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
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
      </ScrollView>

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
          <TripsTab trips={trips} isOwner loading={!tripsLoaded} />
        )}
        {tab === 'stamps' && (
          <StampsTab
            stamps={[]}
            // Owner mode: no viewingUsername so StampsTab stays on the
            // paginated /stamps/me pipeline (a truthy username forces the
            // public-profile fetch and disables load-more). Data is owned by
            // usePassport (single fetch pipeline) and passed in via `data`;
            // loadMoreRef is bound by StampsTab to that same pipeline.
            isOwner
            viewingUserId={profile.id}
            loadMoreRef={stampsLoadMoreRef}
            data={stampsNew}
            dataTotal={stampsTotal}
            dataLoadingMore={loadingMoreStamps}
            onLoadMore={loadMoreStamps}
            onStampUpdated={onStampUpdated}
            onRetry={reload}
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
        onPrivacySettings={() => {
          // QA round 2, minor A: 'safety' routes to /profile/edit/safety
          // ("Safety & Verification"). This link is labelled PRIVACY SETTINGS,
          // which is 'passport' -> /profile/edit/privacy ("Privacy & Visibility").
          openSettings('passport');
        }}
      />
      <PassportTravelInfoSection trips={trips} />
      <View style={{ height: 24 }} />
    </>
  );

  return (
    <View style={s.root}>
      {/* Compact sticky bar — fades in as the large AppHeader scrolls away.
          Replaces the always-visible absolute share/bell buttons. */}
      <Animated.View
        style={[s.compactBar, { paddingTop: insets.top }, compactBarStyle, { pointerEvents: compactBarInteractive ? 'auto' : 'none' }]}
      >
        <View style={s.compactBarInner}>
          <Text style={s.compactBarTitle}>Passport</Text>
          <View style={s.compactBarActions}>
            <Pressable
              style={s.compactBarBtn}
              onPress={share}
              disabled={sharing}
              accessibilityLabel="Share Passport"
              hitSlop={8}
            >
              {sharing
                ? <ActivityIndicator size="small" color={PP.ink} />
                : <PortavaShareIcon size={20} color={PP.ink} />}
            </Pressable>
            <NotificationBell style={s.compactBarBell} />
          </View>
        </View>
      </Animated.View>
      <ScrollView
        testID="main-scroll"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={color.signal} />
        }
      >
        <AppHeader
          variant="primary"
          title="Passport"
          animatedStyle={largeHeaderStyle}
          rightActions={[
            { icon: <PortavaShareIcon size={22} color={color.ink} />, onPress: share, accessibilityLabel: 'Share passport' },
          ]}
        />
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
          onEditProfile={handleEditProfile}
          onSavedPress={() => router.push('/saved' as any)}
          countriesVisited={passportStats?.countries ?? null}
          availabilityChip={ownerChipState}
          onAvailabilityChipPress={() => router.push('/availability' as any)}
        />
        <PassportStatsRow
          profile={profile}
          isOwner
          iconOnly={statsIconOnly}
          onStatsLoaded={setPassportStats}
          onStatPress={(label) => {
            if (label === 'Trips') setTab('plans');
            else if (label === 'Stamps') setStampsViewOpen(true);
            else if (label === 'Countries') setTab('map');
            else if (label === 'Followers') router.push('/followers' as any);
            else if (label === 'Following') router.push('/following' as any);
          }}
        />

        {/* ── §3 high-priority previews (recent stamps / Featured Journey /
             next Trip / memories) read from the /passport/:userId/projection
             aggregate. Additive + fail-soft: renders nothing until the
             aggregate loads, so the existing owner sections below are
             unaffected. Owner context → no viewer Make-a-Plan / Shared Context. */}
        <PassportHomePreviews userId={profile.id} isOwner />

        {/* ── Pending posts ── */}
        {pendingCount > 0 && (
          <Pressable
            style={s.pendingRow}
            onPress={() => router.push('/pending-posts' as any)}
            accessibilityLabel={`${pendingCount} pending post${pendingCount === 1 ? '' : 's'}`}
            accessibilityRole="button"
          >
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

        {/* ── Passport detail-surface entry points (§3 / §28) ──
             Navigation into the standalone Passport surfaces (My World, Trust,
             Travel Identity, Journeys, Plans, Availability) + the Share/QR
             sheet, which are route-registered but were previously unreachable
             from this tab. */}
        <PassportQuickLinks onShare={() => router.push('/passport/share' as any)} />

        {/* ── Buddy Profile card ── */}
        {buddyProfile != null && buddyProfile.status !== 'rejected' && (
          <Pressable
            style={s.bpCard}
            onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/' as any)}
            accessibilityLabel={
              buddyProfile.status === 'active' ? 'Your Buddy Profile'
              : buddyProfile.status === 'paused' ? 'Buddy Profile (Paused)'
              : 'Buddy Application'
            }
            accessibilityRole="button"
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
          onAddHighlight={onDirectAddHighlight ?? onNewHighlightPress}
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

      {/* Share + bell are now in the compact sticky bar above — no duplicate floaters */}

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

      {/* Owner action menu — five-section scrollable sheet */}
      <PassportOwnerMenuSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        username={profile.username}
        onEditProfile={() => { setMenuOpen(false); handleEditProfile(); }}
        onChangeAvatar={() => { setMenuOpen(false); onChangeAvatar?.(); }}
        onChangeCover={() => { setMenuOpen(false); handleChangeCover(); }}
        onArrangeTabs={() => { setMenuOpen(false); onArrangeTabs(); }}
        onManageHighlights={() => { setMenuOpen(false); onDirectAddHighlight?.(); }}
        onViewAsPublic={() => { setMenuOpen(false); handleViewAsPublic(); }}
        onViewMyStamps={() => { setMenuOpen(false); setStampsViewOpen(true); }}
        onArrangeSections={() => { setMenuOpen(false); onArrangeSections(); }}
        onSwitchTab={(tabKey) => { setMenuOpen(false); setTab(tabKey as PassportTabKey); }}
        onCreatePress={() => { setMenuOpen(false); setCreateHubOpen(true); }}
        onSignOut={onSignOut}
      />

      {/* Create hub sheet — opened from the owner action menu's Create entry */}
      <CreateHubSheet
        visible={createHubOpen}
        onClose={() => setCreateHubOpen(false)}
      />

      {/* Trust Score info sheet — itemized breakdown for the owner */}
      <TrustScoreInfoSheet
        visible={trustSheetOpen}
        onClose={() => setTrustSheetOpen(false)}
        score={profile.trustScore ?? null}
        label={profile.trustLabel ?? null}
        breakdown={profile.trustScoreBreakdown ?? null}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ── Compact sticky bar ────────────────────────────────────────────────────
  compactBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: PP.paperDeep,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PP.borderLight,
  },
  compactBarInner: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
  },
  compactBarTitle: { fontSize: 18, fontWeight: '700', color: PP.ink, flex: 1, letterSpacing: -0.3 },
  compactBarActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  compactBarBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  compactBarBell: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' } as any,

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
    width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2,
    backgroundColor: PP.paperDeep,
    alignItems: 'center', justifyContent: 'center',
  },
  bpTitle: { ...t.bodyStrong, color: PP.ink },
  bpSub: { ...t.small, color: PP.inkMuted, marginTop: 2 },
  bpBadge: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 4 },
  bpBadgeText: { fontSize: 10, fontWeight: '800', fontFamily: 'Courier' },

  // Document-style tab bar
  tabBar: {
    marginTop: 24,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
    marginHorizontal: 16,
  },
  tabBarContent: {
    flexDirection: 'row',
  },
  tabItem: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginRight: 20,
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
    width: avatar.s38, height: avatar.s38, borderRadius: avatar.s38 / 2,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: PP.borderLight,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: PP.ink, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  bellBtn: {
    position: 'absolute', right: space.lg, zIndex: 20,
    width: avatar.s38, height: avatar.s38, borderRadius: avatar.s38 / 2,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: PP.borderLight,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: PP.ink, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  offScreen: { position: 'absolute', left: -9999, top: -9999, opacity: 0 },
});
