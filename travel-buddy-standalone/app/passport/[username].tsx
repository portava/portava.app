/**
 * app/passport/[username].tsx
 * Public-facing Passport viewer — passport document design.
 * Works without auth (read-only). Preserves all existing functionality.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert, Modal,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MoreVertical } from 'lucide-react-native';
import { getPublicShowcase, type ShowcaseStamp } from '../../src/services/stampShowcase';
import { blockUser } from '../../src/services/blocks';
import { openDirectThread } from '../../src/services/messaging';
import { submitReport, type ReportReason } from '../../src/services/reports';
import { useSession } from '../../src/context/SessionContext';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { useFollow } from '../../src/hooks/useFollow';
import { useHighlightRingState } from '../../src/hooks/useHighlightRingState';
import { usePublicPassport } from '../../src/hooks/usePublicPassport';
import { usePassportProjection } from '../../src/hooks/usePassportProjection.ts';
import {
  PassportHomePreviews,
  PassportViewerMemoriesList,
  PassportViewerPlansList,
} from '../../src/components/passport/PassportHomePreviews.tsx';
import { PrivateProfileWall } from '../../src/components/privacy/PrivateProfileWall';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { MapTab } from '../../src/components/MapTab';
import { resolveTabOrder, type PassportTabKey, TAB_LABELS } from '../../src/components/passport/passportTabs';
import { resolveDisplayName, formatHandle, truncateDisplayName } from '../../src/utils/identity';
import { space, radius, dot } from '../../src/theme/tokens';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';
import type { PublicProfile } from '../../src/types/models';
import { resolveViewerActions } from '../../src/features/passport/viewerActions.ts';
import { usePassportViewedTelemetry } from '../../src/features/passport/usePassportViewedTelemetry.ts';
import {
  trackFollowFromPassport,
  trackMessageFromPassport,
  trackPassportQrScanned,
} from '../../src/features/passport/passportTelemetry.ts';
import { isQrScanEntry } from '../../src/features/passport/passportQrProjection.ts';
import { trustHref } from '../../src/features/passport/passportNav.ts';
import { TripInvitePickerSheet } from '../../src/features/passport/TripInvitePickerSheet.tsx';
import { useCurrentTravelerState } from '../../src/components/passport/TravelerStateChip.tsx';

// New passport design components
import { PublicStampShowcaseSection } from '../../src/components/stamps/PublicStampShowcaseSection';
import { PassportIdentityCard, PassportStatsRow } from '../../src/components/passport/PassportIdentityCard';
import { PassportDivider } from '../../src/components/passport/PassportDivider';
import { CircleSection } from '../../src/components/profile/CircleSection';
import { UuidHandleRedirect, isUuidParam } from '../../src/components/profile/UuidHandleRedirect';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';

// Tab order is resolved from the owner's saved preference at render time.

export default function PassportDeepLinkScreen() {
  const { username: rawUsername } = useLocalSearchParams<{ username: string }>();
  // BETA: /passport/<uuid> links (e.g. traveler map cards falling back to the
  // raw id for handle-less accounts) resolve to the canonical
  // /passport/<handle> URL before the document screen fetches anything.
  if (isUuidParam(rawUsername)) {
    return <UuidHandleRedirect userId={rawUsername} pathPrefix="/passport" />;
  }
  return <PassportDocumentScreenInner />;
}

function PassportDocumentScreenInner() {
  const { username: rawUsername, via } = useLocalSearchParams<{ username: string; via?: string }>();
  const username = (rawUsername ?? '').replace(/^@/, '');

  // §32 passport_qr_scanned — the QR image encodes the passport deep link with
  // a `via=qr` marker (passportQrProjection.buildQrPayload), so arriving here
  // through that link IS the scan. Emitted once per screen mount, before any
  // fetch: the scan happened whether or not the passport then loads. The
  // marker never changes what is shown — the projection is re-fetched under
  // normal privacy policy (§25 "Scanning a QR never bypasses privacy policy").
  const qrEmittedRef = React.useRef(false);
  useEffect(() => {
    if (qrEmittedRef.current) return;
    if (!isQrScanEntry(via)) return;
    qrEmittedRef.current = true;
    trackPassportQrScanned();
  }, [via]);

  const {
    profile, postcards, loading, error, isPrivate, isFriend, friendRequestPending,
    previewProfile, privateProfileId, notFound, isBlocked, postcardSentinel,
  } = usePublicPassport(username);
  const { isAuthed, userId: viewerUserId } = useSession();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const isOwner = !!profile && !!viewerUserId && profile.id === viewerUserId;
  const follow = useFollow(profile?.id ?? privateProfileId ?? null);
  const ringState = useHighlightRingState(profile?.id ?? null);
  const [showcaseItems, setShowcaseItems] = useState<ShowcaseStamp[] | null>(null);
  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [tab, setTab] = useState<PassportTabKey>('postcards');
  const [statsIconOnly, setStatsIconOnly] = useState(false);
  const [availStatusSheetOpen, setAvailStatusSheetOpen] = useState(false);
  // Tracks a request sent this session so the header badge can flip to "Pending"
  // without a full data reload. Must live here — above all early returns.
  const [requestSent, setRequestSent] = useState(false);
  const [messageStarting, setMessageStarting] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [reportPickerOpen, setReportPickerOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();
  const bottomInset = usePlainBottomInset();

  // §29 aggregate for THIS viewer — powers the §3 Home previews, the §17 "YOU
  // TWO" Shared-Context entry / §18 Make-a-Plan, and the permitted Memories /
  // Plans the tabs render (F3). All privacy filtering is server-side; a
  // null/own id makes it a no-op. Called before any early return (Rules of Hooks).
  const projection = usePassportProjection(profile?.id ?? null);

  // F7 / §30: which viewer actions this Passport may OFFER comes from the
  // server projection's capabilities.actions — never from `isAuthed`. Fail
  // closed: no projection (anonymous, loading, failed) offers nothing.
  const viewerActions = resolveViewerActions(projection.data, { isOwner });

  // §5 / §31: the §5 state as the SERVER projected it for this viewer, with
  // expiry-on-read — the read-only status sheet must never show a lapsed
  // state as current either. (The card's chip runs the same hook.)
  const currentTravelerState = useCurrentTravelerState(projection.data?.travelerState ?? null);

  // §32 passport_viewed — once the projection is in, so the event carries the
  // server-decided viewerContext. Owners viewing themselves via this route are
  // counted by the owner tab, not here.
  usePassportViewedTelemetry(
    profile?.id ?? null,
    projection.data?.viewerContext ?? null,
    !isOwner && !!profile && !!projection.data,
  );

  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);

  // Fetch the public showcase after profile is resolved.
  // Reset to null immediately so switching between users never shows stale stamps.
  useEffect(() => {
    if (!profile || !username) return;
    let alive = true;
    setShowcaseItems(null);
    getPublicShowcase(username).then((items) => {
      if (alive) setShowcaseItems(items);
    }).catch(() => {
      if (alive) setShowcaseItems(null);
    });
    return () => { alive = false; };
  }, [profile, username]);

  const handleScroll = useCallback((e: any) => {
    navBarScrollHandler(e);
    setStatsIconOnly(e.nativeEvent.contentOffset.y > 60);
  }, [navBarScrollHandler]);

  // §32 follow_from_passport — a follow (not an unfollow) initiated here.
  const handleFollowPress = useCallback(async () => {
    if (!profile) return false;
    const wasFollowing = follow.isFollowing;
    const ok = await follow.toggle();
    if (ok && !wasFollowing) trackFollowFromPassport(profile.id);
    return ok;
  }, [profile, follow]);

  const handleMessagePress = useCallback(async () => {
    if (!profile || messageStarting) return;
    setMessageStarting(true);
    try {
      const res = await openDirectThread(profile.id);
      if (res.ok && res.data) {
        // §32 message_from_passport — the thread opened; the message was initiated here.
        trackMessageFromPassport(profile.id);
        const displayName = truncateDisplayName(resolveDisplayName(profile));
        const params = new URLSearchParams({
          threadType: 'direct',
          title: displayName,
          otherUserId: profile.id,
        });
        router.push(`/messages/${res.data.threadId}?${params.toString()}` as any);
      } else {
        Alert.alert("Couldn't start conversation", 'Please try again.');
      }
    } finally {
      setMessageStarting(false);
    }
  }, [profile, messageStarting]);

  const handleMorePress = useCallback(() => {
    if (!profile) return;
    setMoreMenuOpen(true);
  }, [profile]);

  const handleReportPress = useCallback(() => {
    setMoreMenuOpen(false);
    setReportPickerOpen(true);
  }, []);

  const handleBlockPress = useCallback(() => {
    if (!profile) return;
    setMoreMenuOpen(false);
    const displayName = truncateDisplayName(resolveDisplayName(profile));
    Alert.alert(`Block ${displayName}?`,
      "They won't be able to message you, follow you, or see your profile.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block', style: 'destructive',
          onPress: async () => {
            const res = await blockUser(profile.id);
            if (res.ok) {
              router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any);
            } else {
              Alert.alert('Error', res.error ?? 'Could not block user');
            }
          },
        },
      ],
    );
  }, [profile]);

  async function doReport(reason: ReportReason) {
    if (!profile) return;
    const res = await submitReport({ targetUserId: profile.id, reason });
    if (res.ok) Alert.alert('Report submitted', 'Thank you for helping keep the community safe.');
    else Alert.alert('Could not submit report', res.error ?? 'Please try again.');
  }

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>{formatHandle(username) ?? 'Passport'}</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={PP.ink} />
        </View>
      </View>
    );
  }

  if (notFound) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>Not Found</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateIcon}>🔍</Text>
          <Text style={vs.stateTitle}>No one here</Text>
          <Text style={vs.stateSub}>@{username} doesn't exist.</Text>
          <Pressable style={vs.homeBtn} onPress={() => router.replace('/(tabs)/' as any)}>
            <Text style={vs.homeBtnText}>Go home</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (isPrivate && !isFriend) {
    // The passport header (avatar, name, @handle) is always public.
    // Build a minimal PublicProfile so PassportIdentityCard can render it;
    // null bio/location/interests simply won't render in the card.
    const wallPreviewId = previewProfile?.id ?? privateProfileId ?? '';
    const wallPreviewHandle = previewProfile?.handle ?? username ?? null;
    const minProfile: PublicProfile = {
      id: wallPreviewId,
      username: wallPreviewHandle,
      displayName: previewProfile?.displayName ?? null,
      bio: null,
      avatarUrl: previewProfile?.avatarUrl ?? null,
      homeCity: null,
      homeCountry: null,
      travelStyle: null,
      interests: [],
      verified: false,
      verificationStatus: 'unverified',
      verifiedAt: null,
      passportVisibility: 'private',
      createdAt: null,
    };
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>{formatHandle(username) ?? 'Passport'}</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.headerRule} />
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Header always visible — private only gates the content below */}
          <PassportIdentityCard
            profile={minProfile}
            isOwner={false}
          />
          {/* Lock message + Add Friend CTA */}
          <PrivateProfileWall
            profile={{
              id: wallPreviewId,
              handle: wallPreviewHandle,
              displayName: previewProfile?.displayName ?? null,
              avatarUrl: previewProfile?.avatarUrl ?? null,
            }}
            friendRequestPending={friendRequestPending || requestSent}
            isOwnProfile={isOwner}
            onRequestSent={() => setRequestSent(true)}
          />
        </ScrollView>
      </View>
    );
  }

  if (isBlocked) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>{formatHandle(username) ?? 'Passport'}</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateIcon}>🚫</Text>
          <Text style={vs.stateTitle}>Passport unavailable</Text>
          <Text style={vs.stateSub}>This profile isn't available to you.</Text>
        </View>
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>Error</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateTitle}>Couldn't load Passport</Text>
          <Text style={vs.stateSub}>{error ?? 'Unknown error'}</Text>
        </View>
      </View>
    );
  }

  // ── Visitor stats ──────────────────────────────────────────────────────────
  // Countries/cities must not be derived from postcards alone (BZ): most
  // postcards never carry a tagged location, so a user with real earned
  // stamps but zero geotagged postcards showed 0/0 here while the owner's
  // own passport view (backed by /me/passport/stats, which counts from
  // stamps) correctly showed 1+. Union in the public stamp showcase's
  // city/country fields so both views count from the same underlying facts.
  const countries = new Set([
    ...postcards.map((c) => c.locationCountry).filter(Boolean),
    ...(showcaseItems ?? []).map((s) => s.country).filter(Boolean),
  ]).size;
  const cities = new Set([
    ...postcards.map((c) => c.locationCity).filter(Boolean),
    ...(showcaseItems ?? []).map((s) => s.city).filter(Boolean),
  ]).size;

  const visitorStats = [
    { n: postcards.length, label: 'Postcards' },
    { n: countries,        label: 'Countries' },
    { n: cities,           label: 'Cities' },
    { n: follow.followersCount, label: 'Followers' },
  ];

  return (
    <View style={[vs.container, { backgroundColor: PP.paperDeep }]}>
      {/* Nav header */}
      <View style={[vs.header, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
          style={vs.backBtn}
          hitSlop={8}
        >
          <ArrowLeft size={20} color={PP.ink} />
        </Pressable>
        <Text style={vs.headerTitle} numberOfLines={1}>
          {truncateDisplayName(resolveDisplayName(profile))}
        </Text>
        {isAuthed && !isOwner ? (
          <Pressable style={vs.moreBtn} onPress={handleMorePress} hitSlop={8} accessibilityLabel="More options">
            <MoreVertical size={20} color={PP.ink} />
          </Pressable>
        ) : (
          <View style={{ width: 38 }} />
        )}
      </View>

      {/* Header rule */}
      <View style={vs.headerRule} />

      {/* Overflow menu — Modal-based (not Alert.alert, which doesn't render
          multi-button dialogs reliably on web) */}
      <Modal
        visible={moreMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMoreMenuOpen(false)}
      >
        <Pressable style={vs.menuOverlay} onPress={() => setMoreMenuOpen(false)}>
          <View style={vs.menuCard}>
            <Pressable style={vs.menuItem} onPress={handleReportPress}>
              <Text style={vs.menuItemText}>Report</Text>
            </Pressable>
            <Pressable style={[vs.menuItem, vs.menuItemBorder]} onPress={handleBlockPress}>
              <Text style={[vs.menuItemText, { color: '#B91C1C' }]}>Block</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Report reason picker */}
      <Modal
        visible={reportPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setReportPickerOpen(false)}
      >
        <Pressable style={vs.menuOverlay} onPress={() => setReportPickerOpen(false)}>
          <View style={vs.menuCard}>
            {(['spam', 'harassment', 'fake_account', 'other'] as ReportReason[]).map((reason, i) => (
              <Pressable
                key={reason}
                style={[vs.menuItem, i > 0 && vs.menuItemBorder]}
                onPress={() => { setReportPickerOpen(false); doReport(reason); }}
              >
                <Text style={vs.menuItemText}>
                  {reason === 'spam' ? 'Spam'
                    : reason === 'harassment' ? 'Harassment'
                    : reason === 'fake_account' ? 'Fake account'
                    : 'Other'}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {/* ── Passport Identity Card ── */}
        <PassportIdentityCard
          profile={profile}
          isOwner={false}
          hasHighlights={ringState?.hasActive}
          allHighlightsViewed={ringState?.allViewed}
          onHighlightRingPress={ringState?.hasActive ? () => setHighlightViewerOpen(true) : undefined}
          // F7 / §30: every viewer action is gated on the SERVER projection's
          // capabilities.actions (resolveViewerActions), never on isAuthed.
          isFollowing={viewerActions.canFollow ? follow.isFollowing : undefined}
          followLoading={viewerActions.canFollow ? (follow.loading || follow.toggling) : undefined}
          onFollowPress={viewerActions.canFollow ? handleFollowPress : undefined}
          onMessagePress={viewerActions.canMessage ? handleMessagePress : undefined}
          onInviteTripPress={viewerActions.canInviteTrip ? () => setInviteSheetOpen(true) : undefined}
          // §3 / §9: the trust summary the server projected FOR THIS VIEWER —
          // the number only where the server exposed it, else the label; the
          // drill-down opens Trust & Credentials for this traveler (§2 viewer nav).
          trustScore={projection.data?.trust?.score ?? undefined}
          trustLabel={projection.data?.trust?.label ?? undefined}
          onTrustInfo={
            viewerActions.canViewTrust && projection.data?.trust
              ? () => router.push(trustHref(profile.id) as never)
              : undefined
          }
          countriesVisited={countries}
          // §5: the server-projected current state (never client-derived).
          travelerState={projection.data?.travelerState ?? null}
          onTravelerStatePress={currentTravelerState ? () => setAvailStatusSheetOpen(true) : undefined}
        />
        <PassportStatsRow
          profile={profile}
          isOwner={false}
          overrideStats={visitorStats}
          onStatPress={(label) => {
            if (label === 'Countries') setTab('map');
            else if (label === 'Followers') {
              router.push(`/followers?userId=${profile.id}&title=${encodeURIComponent(truncateDisplayName(resolveDisplayName(profile)))}` as any);
            }
          }}
          iconOnly={statsIconOnly}
        />

        {/* ── Circle — mutual connections (visitor only) ── */}
        {!isOwner && <CircleSection targetUserId={profile.id} />}

        {/* ── §3 Passport Home previews + §17/§18 viewer affordances ──
             Recent stamps / Featured Journey / next Trip / memories, plus (for a
             non-owner viewer) the "YOU TWO" Shared-Context entry and the
             capability-gated Make-a-Plan action. Reads the shared projection
             fetched above; fails soft to nothing when the aggregate is
             unavailable. This is what makes SharedContextScreen reachable (F1). */}
        <PassportHomePreviews
          userId={profile.id}
          isOwner={isOwner}
          otherName={truncateDisplayName(resolveDisplayName(profile))}
          hookOverride={projection}
        />

        {/* ── Featured stamps showcase (public, read-only) ── */}
        {isFlagEnabled('stamp_showcase_enabled') && showcaseItems && showcaseItems.length > 0 && (
          <PublicStampShowcaseSection
            items={showcaseItems}
            onPress={(item) => {
              router.push(`/stamp/${item.userStampId}` as any);
            }}
          />
        )}

        {/* ── Document-style tab bar — order from owner's saved preference ── */}
        {(() => {
          const tabOrder = resolveTabOrder(profile.passportTabOrder);
          return (
            <>
              <PassportDivider />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={vs.tabBar}
                contentContainerStyle={vs.tabBarContent}
              >
                {tabOrder.map((key) => (
                  <Pressable key={key} style={vs.tabItem} onPress={() => setTab(key)}>
                    <Text style={[vs.tabText, tab === key && vs.tabTextActive]}>
                      {TAB_LABELS[key].toUpperCase()}
                    </Text>
                    {tab === key && <View style={vs.tabIndicator} />}
                  </Pressable>
                ))}
              </ScrollView>
              <View style={vs.tabRule} />
              <View style={{ marginTop: space.md }}>
                {tab === 'postcards' && <PostcardsTab postcards={postcards} isOwner={false} sentinel={postcardSentinel ?? undefined} />}
                {tab === 'stamps'    && <StampsTab stamps={[]} viewingUsername={username} viewingUserId={profile?.id} />}
                {tab === 'map'       && <MapTab postcards={postcards} sentinel={postcardSentinel ?? undefined} />}
                {/* F3: render the memories/plans THIS viewer is permitted to
                    see from the server-filtered projection (not a hardcoded []).
                    The projection returns nothing when the owner hasn't shared
                    any with this viewer, so an unpermitted viewer still sees a
                    clear empty state — read-only, never the owner's edit tab. */}
                {tab === 'memories'  && (
                  <PassportViewerMemoriesList
                    memories={projection.data?.memories ?? []}
                    loading={projection.loading}
                  />
                )}
                {tab === 'plans'     && (
                  <PassportViewerPlansList
                    plans={projection.data?.upcomingPlans ?? []}
                    loading={projection.loading}
                  />
                )}
              </View>
            </>
          );
        })()}
      </ScrollView>

      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ringState?.highlights ?? []}
        onClose={() => setHighlightViewerOpen(false)}
      />

      {/* ── §3 viewer action: Invite to trip (mounted only when the server
           projection said can_invite_trip — see onInviteTripPress above) ── */}
      {viewerActions.canInviteTrip ? (
        <TripInvitePickerSheet
          visible={inviteSheetOpen}
          onClose={() => setInviteSheetOpen(false)}
          subjectId={profile.id}
          subjectName={truncateDisplayName(resolveDisplayName(profile))}
          viewerUserId={viewerUserId ?? null}
        />
      ) : null}

      {/* ── Read-only §5 traveler-state sheet (public view) — the SERVER-projected
           state, expiry-on-read; never a client-derived status. ── */}
      <Modal
        visible={availStatusSheetOpen && !!currentTravelerState}
        transparent
        animationType="fade"
        onRequestClose={() => setAvailStatusSheetOpen(false)}
      >
        <Pressable style={vs.sheetBackdrop} onPress={() => setAvailStatusSheetOpen(false)}>
          <View style={vs.sheetCard} testID="traveler-state-sheet">
            <View style={vs.sheetDot} />
            <View style={{ flex: 1 }}>
              <Text style={vs.sheetPrimary}>
                {currentTravelerState?.label ?? ''}
              </Text>
              {currentTravelerState?.city ? (
                <Text style={vs.sheetSecondary}>{currentTravelerState.city}</Text>
              ) : null}
              {projection.data?.availability?.openToPlans ? (
                <Text style={vs.sheetSecondary}>Open to plans</Text>
              ) : null}
            </View>
            <Pressable onPress={() => setAvailStatusSheetOpen(false)} hitSlop={8}>
              <ArrowLeft size={18} color={PP.inkMuted} style={{ transform: [{ rotate: '180deg' }] }} />
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const vs = StyleSheet.create({
  container: { flex: 1 },
  menuOverlay: {
    flex: 1, backgroundColor: 'rgba(17,17,15,0.3)',
    alignItems: 'flex-end', paddingTop: 60, paddingRight: 16,
  },
  menuCard: {
    backgroundColor: PP.paper, borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.inkFaint, minWidth: 160, overflow: 'hidden',
  },
  menuItem: { paddingVertical: 12, paddingHorizontal: 16 },
  menuItemText: { fontSize: 14, fontWeight: '600', color: PP.ink },
  menuItemBorder: { borderTopWidth: 1, borderTopColor: PP.inkFaint },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 10,
    backgroundColor: PP.paper,
  },
  headerRule: { height: 2, backgroundColor: PP.ink },
  backBtn: { padding: 6, width: 38 },
  headerTitle: {
    fontFamily: 'Courier', fontSize: 13, fontWeight: '700',
    color: PP.ink, flex: 1, textAlign: 'center',
    letterSpacing: 0.5,
  },
  moreBtn: { padding: 6, width: 38, alignItems: 'center' },

  stateCenter: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md, minHeight: 300,
  },
  stateIcon: { fontSize: 48 },
  stateTitle: { fontSize: 18, fontWeight: '700', color: PP.ink, textAlign: 'center' },
  stateSub: { fontSize: 14, color: PP.inkMuted, textAlign: 'center', lineHeight: 20 },
  homeBtn: {
    marginTop: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.xl,
    backgroundColor: PP.ink, borderRadius: radius.pill,
  },
  homeBtnText: { color: PP.paper, fontWeight: '700', fontSize: 14 },

  tabBar: { marginHorizontal: 16, marginTop: 4 },
  tabBarContent: { flexDirection: 'row' },
  tabItem: { paddingHorizontal: 12, alignItems: 'center', paddingVertical: 10, position: 'relative' },
  tabText: { ...PP_LABEL, fontSize: 10, color: PP.inkMuted, letterSpacing: 1.5 },
  tabTextActive: { color: PP.ink },
  tabIndicator: {
    position: 'absolute', bottom: 0, left: '20%', right: '20%',
    height: 2, borderRadius: 1, backgroundColor: PP.inkLight,
  },
  tabRule: { height: 1, backgroundColor: PP.borderLight, marginHorizontal: 16 },

  /* Read-only availability status sheet */
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  sheetCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#F0FAF4',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
    padding: 16,
  },
  sheetDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: '#22C55E',
  },
  sheetPrimary: {
    fontSize: 15,
    fontWeight: '700',
    color: '#166534',
  },
  sheetSecondary: {
    fontSize: 13,
    color: '#166534',
    marginTop: 2,
  },
});
