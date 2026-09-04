import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert, Share, Modal, RefreshControl, type LayoutChangeEvent } from 'react-native';
import { CachedImage } from '../../src/components/CachedImage';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Pencil, MessageCircle, Calendar, Plane, Users, BookImage, CalendarClock, MapPin, ShieldCheck, Radio, Link2, Bell } from 'lucide-react-native';
import { PortavaShareIcon } from '../../src/components/icons/PortavaShareIcon';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { useScreenTiming } from '../../src/hooks/useScreenTiming';
import { useNextBestAction } from '../../src/hooks/useNextBestAction';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { ReadinessSummary } from '../../src/services/tripIntel';
import {
  TripHero, TodayNextUp, SavedIdeas, TripSavedPlacesSection,
  CompassTripBrief, CompassBriefErrorBoundary, TripStamps, TripPostsSection,
  TripCrewSection, TripCircle, TripMapPreview,
} from '../../src/components/TripPage';
import { ActiveSafeReturnCard } from '../../src/components/safeReturn/ActiveSafeReturnCard';
import { TripHeartbeatCard } from '../../src/components/compass/TripHeartbeatCard';
import { SafeReturnSetupSheet } from '../../src/components/safeReturn/SafeReturnSetupSheet';
import { MissedCheckinPrompt } from '../../src/components/safeReturn/MissedCheckinPrompt';
import { getActiveSession, type SafeReturnSession } from '../../src/services/safeReturn';
import { TripPlanSection } from '../../src/components/TripPlanSection';
import { NeighborhoodMatchSection } from '../../src/components/trip/NeighborhoodMatchSection';
import { TripAvailabilitySection } from '../../src/components/TripAvailabilitySection';
import { TripReservationsSection } from '../../src/components/trip/TripReservationsSection';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { TripBudgetSection } from '../../src/components/trip/TripBudgetSection';
import { DailyBriefCard } from '../../src/components/DailyBriefCard';
import { TripReadinessCard } from '../../src/components/trip/TripReadinessCard';
import { BeforeYouGoSection } from '../../src/components/trip/BeforeYouGoSection';
import { TripFsqPlacesSection } from '../../src/components/trip/TripFsqPlacesSection';
import { TripDestinationInfoCard } from '../../src/components/trip/TripDestinationInfoCard';
import { toFsqCityKey } from '../../src/utils/fsqCityKey';
import { ConciergeCommandBar, type ConciergeCommandBarHandle } from '../../src/components/ConciergeCommandBar';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { TripInviteSheet } from '../../src/components/TripInviteSheet';
import { TripInviteLinksSheet } from '../../src/components/TripInviteLinksSheet';
import type { TripDetail } from '../../src/types/models';
import { useSession } from '../../src/context/SessionContext';
import { useTrip, usePendingTripInvites } from '../../src/hooks/useBackend';
import { openTripChat } from '../../src/services/messaging';
import { getTripMemory, createTripMemory, type Memory } from '../../src/services/memories';
import { getEventsNearTrip, type EventSummary } from '../../src/services/events';
import { updateTrip, createInviteLink, getTripMemberRole, fetchTripPrivatePreview } from '../../src/services/trips';
import { PrivateTripCard, type PrivateTripPreview } from '../../src/components/privacy/PrivateTripCard';
import { getCanonicalPlace } from '../../src/services/places';
import type { CanonicalPlace } from '../../src/types/canonicalPlace';
import { color, space, radius, type as t, avatar, dot } from '../../src/theme/tokens';
import { useStampToast } from '../../src/components/stamps/StampEarnedToast';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';
import { deriveTripDisplayStatus } from '../../src/lib/tripStatus';
import { canonicalUrl } from '../../src/constants/canonicalUrl';

function TripDetailScreen() {
  // `focus` lets another route deep-link into a section of this screen rather
  // than the top of it. Today the only value is 'plan', used by app/plan/[id]
  // — a trip's plan has no route of its own, it is a section here.
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const insets = useSafeAreaInsets();
  const { configured, isAuthed, userId } = useSession();
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const { markFirstContent, epoch } = useScreenTiming('TripDetail');
  const { checkForNewStamps } = useStampToast();
  const navBarScrollHandler = useNavBarScrollHandler();
  const bottomInset = usePlainBottomInset();
  const live = configured && isAuthed;
  const { data: realTrip, loading, error: tripError, reload: reloadTrip } = useTrip(live ? id : undefined);
  // Next best action (Trip Brain wave) — fail-soft null when the server flag
  // is off or the request fails, so TodayNextUp keeps its empty state.
  const { action: nextBestAction } = useNextBestAction(live ? id : null);

  // Perf timing: fire on every focus cycle when trip data is loaded.
  // epoch increments on each focus so warm opens fire even without data changes.
  useEffect(() => {
    if (realTrip) markFirstContent();
  }, [epoch, !!realTrip]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canonical place linked to this trip's destination ─────────────────────
  // Loads the place name for the "See destination" link row.  Fail-soft: a
  // missing or erroring fetch leaves canonicalTripPlace as null and omits the
  // link — the rest of the trip screen is unaffected.
  useEffect(() => {
    // NOTE: the trip service exposes this as `destinationPlaceId` (from the
    // `destination_place_id` column) — `canonicalPlaceId` is not a field the
    // API ever returns, so reading it always left this CTA permanently dead.
    const placeId = (realTrip as any)?.destinationPlaceId as string | undefined;
    if (!placeId) { setCanonicalTripPlace(null); return; }
    let cancelled = false;
    getCanonicalPlace(placeId)
      .then((place) => { if (!cancelled) setCanonicalTripPlace(place); })
      .catch(() => { if (!cancelled) setCanonicalTripPlace(null); });
    return () => { cancelled = true; };
  }, [(realTrip as any)?.destinationPlaceId]);
  const { invites } = usePendingTripInvites();
  const isPendingInvite = live ? invites.some((inv) => inv.tripId === id) : false;
  const pageScrollRef    = useRef<ScrollView>(null);
  const commandBarRef    = useRef<ConciergeCommandBarHandle>(null);
  const commandBarY      = useRef<number>(0);
  // Canonical place linked to this trip's destination — loaded when
  // realTrip.destinationPlaceId is set.
  const [canonicalTripPlace, setCanonicalTripPlace] = useState<CanonicalPlace | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [linksSheetOpen, setLinksSheetOpen] = useState(false);
  const [crewRefreshKey, setCrewRefreshKey] = useState(0);
  const [meetupDate, setMeetupDate] = useState<string | null>(null);
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [gapDays, setGapDays] = useState<string[]>([]);
  const [gapDestination, setGapDestination] = useState('');
  const [activeSafeReturnSession, setActiveSafeReturnSession] = useState<SafeReturnSession | null>(null);
  const [safeReturnSetupOpen, setSafeReturnSetupOpen] = useState(false);
  const [safeReturnChecking, setSafeReturnChecking] = useState(false);
  const [showMissedPrompt, setShowMissedPrompt] = useState(false);
  const [completingTrip, setCompletingTrip] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [pageRefreshing, setPageRefreshing] = useState(false);
  const [readinessRefresh, setReadinessRefresh] = useState(false);
  // QA round 2, bug 2: single source of truth for BOTH progress gauges on this
  // page. Populated by TripReadinessCard via onSummary below.
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null);
  const [memberRole, setMemberRole] = useState<string | null>(null);
  /** Set when the trip is private and the API returns a minimal preview sentinel. */
  const [privateTrip, setPrivateTrip] = useState<PrivateTripPreview | null>(null);

  const handlePageRefresh = useCallback(async () => {
    setPageRefreshing(true);
    setReadinessRefresh(true);
    await reloadTrip();
    setPageRefreshing(false);
    // Reset refresh flag after a tick so the card re-uses cached data on next render
    setTimeout(() => setReadinessRefresh(false), 100);
  }, [reloadTrip]);

  const handleGapDays = useCallback((days: string[], dest: string) => {
    setGapDays(days);
    setGapDestination(dest);
  }, []);

  const handleGapDayChipPress = useCallback(() => {
    pageScrollRef.current?.scrollTo({ y: commandBarY.current, animated: true });
    // Small delay lets the scroll animation start before the keyboard appears
    setTimeout(() => { commandBarRef.current?.focus(); }, 350);
  }, []);

  // ── ?focus=plan — scroll the plan section into view once, after load ────────
  // Same mechanism as handleGapDayChipPress: the section records its y offset
  // via onLayout and we scroll the page ScrollView to it. Gated on realTrip so
  // the offset is measured against the fully rendered page, and latched so a
  // re-render (or the user scrolling away) does not yank them back.
  const planSectionY = useRef<number>(0);
  const focusHandled = useRef(false);
  useEffect(() => {
    if (focus !== 'plan' || !realTrip || focusHandled.current) return;
    focusHandled.current = true;
    const t = setTimeout(() => {
      pageScrollRef.current?.scrollTo({ y: Math.max(0, planSectionY.current - 16), animated: true });
    }, 250);
    return () => clearTimeout(t);
  }, [focus, realTrip]);

  const handleSafeReturnClose = useCallback(() => setSafeReturnSetupOpen(false), []);

  // Resolve the current user's membership role so co-hosts can access the budget.
  useEffect(() => {
    if (!live || !id) return;
    getTripMemberRole(id).then((role) => setMemberRole(role)).catch(() => {});
  }, [live, id]);

  // When the trip fails to load (access denied / private), check whether the
  // server returns a private-trip sentinel so we can render PrivateTripCard
  // instead of the generic "trip not found" message.
  useEffect(() => {
    if (loading || !!realTrip || !id) {
      setPrivateTrip(null);
      return;
    }
    let cancelled = false;
    fetchTripPrivatePreview(id).then((preview) => {
      if (!cancelled && preview) setPrivateTrip(preview);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id, loading, realTrip]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    async function pollSafeReturn() {
      try {
        const r = await getActiveSession();
        if (cancelled) return;
        const sess = r.session ?? null;
        // Only surface sessions tied to this trip (or sessions with no trip context)
        const relevant = sess && (sess.tripId === id || sess.tripId === null) ? sess : null;
        setActiveSafeReturnSession(relevant);
        if (relevant?.status === 'missed') setShowMissedPrompt(true);
      } catch { }
    }
    pollSafeReturn();
    const iv = setInterval(pollSafeReturn, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [live, id]);

  async function handleOpenChat() {
    if (!id || chatLoading) return;
    setChatLoading(true);
    const res = await openTripChat(id);
    setChatLoading(false);
    if (res.ok && res.data) {
      const { threadId, title } = res.data;
      const params = new URLSearchParams({ title: title ?? realTrip?.title ?? 'Trip Chat', threadType: 'trip', contextId: id });
      router.push(`/messages/${threadId}?${params.toString()}`);
    } else {
      Alert.alert('Chat unavailable', res.message ?? 'Could not open the trip chat. Make sure you are an accepted trip member.');
    }
  }

  async function handleMarkComplete() {
    if (!live || !id || completingTrip) return;
    Alert.alert(
      'Mark trip as complete?',
      'This will update the trip status to completed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark complete',
          onPress: async () => {
            setCompletingTrip(true);
            const updated = await updateTrip(id, { status: 'completed' });
            setCompletingTrip(false);
            if (updated) {
              checkForNewStamps(2000);
            } else {
              Alert.alert('Error', 'Could not mark the trip as complete. Try again.');
            }
          },
        },
      ],
    );
  }

  async function handleShareTrip() {
    if (!live || !id || !realTrip || shareLoading) return;
    setShareLoading(true);
    try {
      const link = await createInviteLink(id);
      const inviteUrl = link
        ? `travelbuddy://invite/${link.token}`
        : canonicalUrl(`/trips/${id}`);
      const tripName = realTrip.title ?? realTrip.destinationCity ?? 'a trip';
      await Share.share({
        title: `Join my trip${realTrip.title ? ` — ${realTrip.title}` : ''}!`,
        message: `I'm planning ${tripName} and I'd love for you to join!\n${inviteUrl}`,
        url: inviteUrl,
      });
    } catch {
      Alert.alert('Could not share', 'Sharing is not available right now. Try again.');
    } finally {
      setShareLoading(false);
    }
  }

  if (!configured) {
    return <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.signal} /></View>;
  }

  if (!isAuthed) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ ...t.bodyStrong, color: color.ink, marginBottom: space.sm }}>Sign in to view trips</Text>
        <Text style={{ ...t.small, color: color.mute, textAlign: 'center', marginBottom: space.lg }}>
          You need to be signed in to view trip details.
        </Text>
        <Pressable
          style={{ paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.signal }}
          onPress={() => router.back()}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.signal} /></View>;
  }

  // Network/API failure is NOT "trip not found" — show an honest error with
  // retry instead of the misleading not-found copy (beta-audit fix).
  if (!realTrip && tripError) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ ...t.bodyStrong, color: color.ink, marginBottom: space.sm }}>Couldn't load this trip</Text>
        <Text style={{ ...t.small, color: color.mute, textAlign: 'center' }}>Check your connection and try again.</Text>
        <Pressable
          style={{ marginTop: space.lg, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.signal }}
          onPress={reloadTrip}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Try again</Text>
        </Pressable>
        <Pressable style={{ marginTop: space.sm, padding: space.sm }} onPress={() => router.back()}>
          <Text style={{ ...t.small, color: color.mute }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // Private trip: server returned a minimal preview sentinel instead of full detail.
  if (!realTrip && privateTrip) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={{ paddingTop: insets.top + space.sm, paddingHorizontal: space.md, paddingBottom: space.sm }}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={{ padding: 4 }}>
            <ChevronLeft size={22} color={color.ink} />
          </Pressable>
        </View>
        <ScrollView>
          <PrivateTripCard trip={privateTrip} />
        </ScrollView>
      </View>
    );
  }

  if (!realTrip) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ ...t.bodyStrong, color: color.ink, marginBottom: space.sm }}>Trip not found</Text>
        <Text style={{ ...t.small, color: color.mute, textAlign: 'center' }}>This trip may have been deleted or you may not have access to it.</Text>
        <Pressable
          style={{ marginTop: space.lg, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.signal }}
          onPress={() => router.back()}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const trip: TripDetail = {
    id: realTrip.id,
    title: realTrip.title,
    destinationCity: realTrip.destinationCity,
    destinationCountry: realTrip.destinationCountry ?? '',
    neighborhoods: realTrip.neighborhoods,
    startDate: realTrip.startDate ?? '',
    endDate: realTrip.endDate ?? '',
    nights: (realTrip.startDate && realTrip.endDate)
      ? Math.max(0, Math.round(
          (new Date(realTrip.endDate).getTime() - new Date(realTrip.startDate).getTime()) / 86_400_000,
        ))
      : 0,
    status: realTrip.status,
    visibility: realTrip.visibility,
    travelStyle: realTrip.travelStyle ?? '',
    openToMeet: realTrip.openToMeet,
    coverUrl: realTrip.coverUrl ?? '',
    coverMediaType: realTrip.coverMediaType ?? null,
    // QA round 2, bug 2: prefer the readiness score — it is the only number that
    // actually counts plan items, stay, transport, budget, entry, documents and
    // reservations (api-server/src/lib/tripReadiness.ts). Falls back to the legacy
    // trips.progress column when the readiness flag is off, in which case the card
    // renders nothing and never reports a summary.
    progress: readiness ? readiness.score : (realTrip.progress ?? 0),
    // The hero's checklist was hard-coded to [] — it never rendered a single step.
    // Same order/labels as CATEGORIES in TripReadinessCard.tsx and
    // READINESS_CATEGORIES in api-server/src/lib/tripReadiness.ts.
    progressSteps: readiness
      ? ([
          ['plan', 'Plan'], ['stay', 'Stay'], ['transport', 'Transport'],
          ['budget', 'Budget'], ['entry', 'Entry'], ['documents', 'Documents'],
          ['reservations', 'Reservations'],
        ] as ReadonlyArray<readonly [string, string]>).map(([key, label]) => ({
          label,
          done: readiness.categories?.[key] === 'ready',
        }))
      : [],
    timeline: [],
    savedIdeas: [],
    safetyStatus: 'unknown',
    tripNotes: realTrip.tripNotes ?? null,
  };

  const todayDate = new Date().toISOString().slice(0, 10);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScrollView
        ref={pageScrollRef}
        testID="trip-detail-scroll"
        contentContainerStyle={{ paddingBottom: bottomInset }}
        showsVerticalScrollIndicator={false}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={pageRefreshing} onRefresh={handlePageRefresh} />
        }
      >
        {/* Back nav + action bar — scrolls with page content */}
        <View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ChevronLeft size={22} color={color.signal} />
            <Text style={styles.backText}>My Trip</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {isAuthed && (
            <Pressable
              style={[styles.topBtn, chatLoading && { opacity: 0.5 }]}
              onPress={handleOpenChat}
              disabled={chatLoading}
              hitSlop={6}
            >
              {chatLoading
                ? <ActivityIndicator size="small" color={color.signal} />
                : (
                  <MessageCircle size={15} color={color.signal} />
                )
              }
              <Text style={[styles.topBtnText, { color: color.signal }]}>Chat</Text>
            </Pressable>
          )}
          {isAuthed && realTrip?.ownerId === userId && (
            <Pressable
              style={styles.topBtn}
              onPress={() => setInviteSheetOpen(true)}
              hitSlop={6}
            >
              <Users size={15} color={color.signal} />
              <Text style={[styles.topBtnText, { color: color.signal }]}>Invite</Text>
            </Pressable>
          )}
          {rentBuddyEnabled && (
            <Pressable
              style={styles.topBtn}
              hitSlop={6}
              onPress={() => {
                // Buddy search reads city/category/bookingDate — pass what it consumes.
                const params = new URLSearchParams();
                if (trip.destinationCity) params.set('city', trip.destinationCity);
                if (realTrip?.startDate) params.set('bookingDate', realTrip.startDate);
                router.push(`/(rent-a-buddy)/search?${params.toString()}` as any);
              }}
            >
              <Users size={15} color={color.ink} /><Text style={styles.topBtnText}>Rent a Buddy</Text>
            </Pressable>
          )}
          {isAuthed && realTrip?.ownerId === userId && (
            <Pressable
              style={[styles.topBtn, shareLoading && { opacity: 0.5 }]}
              hitSlop={6}
              disabled={shareLoading}
              onPress={handleShareTrip}
            >
              {shareLoading
                ? <ActivityIndicator size={14} color={color.ink} />
                : <PortavaShareIcon size={15} color={color.ink} />}
              <Text style={styles.topBtnText}>Share Trip</Text>
            </Pressable>
          )}
          {isAuthed && realTrip?.ownerId === userId && (
            <Pressable
              style={styles.topBtn}
              hitSlop={6}
              onPress={() => setLinksSheetOpen(true)}
            >
              <Link2 size={15} color={color.ink} />
              <Text style={styles.topBtnText}>Links</Text>
            </Pressable>
          )}
          {isAuthed && realTrip?.ownerId === userId && (
            <Pressable
              style={styles.topBtn}
              hitSlop={6}
              onPress={() => router.push(`/trip/edit?id=${trip.id}` as any)}
            >
              <Pencil size={15} color={color.ink} /><Text style={styles.topBtnText}>Edit Trip</Text>
            </Pressable>
          )}
          {isAuthed && (
            <Pressable
              style={styles.topBtn}
              hitSlop={6}
              onPress={() => router.push(
                `/reminders/new?targetType=trip&targetId=${encodeURIComponent(trip.id)}&targetLabel=${encodeURIComponent(trip.title ?? 'Trip')}` as any,
              )}
            >
              <Bell size={15} color={color.ink} /><Text style={styles.topBtnText}>Remind me</Text>
            </Pressable>
          )}
        </View>
        <TripHero trip={trip} />

        {/* Destination city overview card — shows city/country heading + any
            trip notes as a city description; tappable to open in maps */}
        <TripDestinationInfoCard trip={trip} />

        {/* "See destination" — shown when the trip's destination has been linked
            to a canonical place; taps through to the Living Destination Page. */}
        {canonicalTripPlace ? (
          <Pressable
            style={styles.seeDestinationRow}
            onPress={() => router.push(`/place/${(realTrip as any).destinationPlaceId}` as any)}
            accessibilityRole="link"
            accessibilityLabel={`See ${canonicalTripPlace.name} destination page`}
          >
            <MapPin size={16} color={color.signal} />
            <Text style={styles.seeDestinationText}>
              📍 {canonicalTripPlace.name} — See destination →
            </Text>
          </Pressable>
        ) : null}

        {/* ── Before you go — entry/visa + country essentials, always visible ── */}
        {live && trip.id ? (
          <BeforeYouGoSection tripId={trip.id} />
        ) : null}

        {/* ── Trip notes ── */}
        {trip.tripNotes ? (
          <View style={styles.tripNotesCard}>
            <Text style={styles.tripNotesText}>{trip.tripNotes}</Text>
          </View>
        ) : null}

        {/* ── Daily Brief (accepted members only; graceful fallback for others) ── */}
        {live && trip.id ? (
          <DailyBriefCard tripId={trip.id} date={todayDate} onGapDays={handleGapDays} />
        ) : null}

        {/* ── Trip Readiness — renders nothing when flag is off (null response) ── */}
        {live && trip.id ? (
          <TripReadinessCard tripId={trip.id} refresh={readinessRefresh} onSummary={setReadiness} />
        ) : null}

        {/* ── FSQ places — renders nothing until city is ingested server-side ── */}
        {live ? (
          <TripFsqPlacesSection cityKey={toFsqCityKey(trip.destinationCity, trip.destinationCountry) ?? undefined} />
        ) : null}

        {/* Planning prompts don't make sense once the trip has ended — derive
            from end date rather than the (possibly stale) stored status. */}
        {deriveTripDisplayStatus(trip.status, trip.endDate) !== 'completed' && (
          <TodayNextUp nextUp={null} tripId={trip.id} action={nextBestAction} />
        )}

        {/* ── Gap-day nudge ── */}
        {live && gapDays.length > 0 && trip.status !== 'planning' && (
          <GapDayNudgeSection
            gapDays={gapDays}
            destination={gapDestination || trip.destinationCity || ''}
            tripId={trip.id}
            onChipPress={handleGapDayChipPress}
          />
        )}

        {/* ── Concierge Command Bar ── */}
        {live && trip.id ? (
          <View onLayout={(e: LayoutChangeEvent) => { commandBarY.current = e.nativeEvent.layout.y; }}>
            <ConciergeCommandBar
              ref={commandBarRef}
              tripId={trip.id}
              destination={trip.destinationCity}
            />
          </View>
        ) : null}

        <View onLayout={(e: LayoutChangeEvent) => { planSectionY.current = e.nativeEvent.layout.y; }}>
          <TripPlanSection
            tripId={trip.id}
            currentUserId={userId ?? ''}
            isOwner={realTrip ? userId === realTrip.ownerId : false}
            isPendingInvite={isPendingInvite}
            tripStartDate={realTrip?.startDate ?? undefined}
            tripEndDate={realTrip?.endDate ?? undefined}
            pageScrollRef={pageScrollRef}
          />
        </View>
        {live && trip.id ? (
          <TripReservationsSection tripId={trip.id} />
        ) : null}
        {live && trip.id ? (
          <TripAvailabilitySection
            tripId={trip.id}
            currentUserId={userId ?? ''}
            startDate={realTrip?.startDate ?? undefined}
            endDate={realTrip?.endDate ?? undefined}
            onPlanMeetup={(date) => setMeetupDate(date)}
          />
        ) : null}
        {/* ── Events near this destination ── */}
        {live && trip.id ? (
          <EventsNearTripSection tripId={trip.id} />
        ) : null}

        <SavedIdeas ideas={[]} tripId={trip.id} />
        <TripSavedPlacesSection tripId={trip.id} />

        {live && trip.id ? (
          <NeighborhoodMatchSection tripId={trip.id} />
        ) : null}

        {live && (
          <TripCircle
            cityCount={0}
            inCity={[]}
            suggested={[]}
            currentUserId={userId}
            tripId={trip.id}
            city={trip.destinationCity ?? undefined}
          />
        )}

        {live && trip.id && (
          <Pressable
            style={styles.circleFindBanner}
            onPress={() =>
              router.push({
                pathname: '/circle-presence',
                params: {
                  contextType: 'trip',
                  contextId: trip.id,
                  contextLabel: trip.destinationCity ?? 'Trip Circle',
                  ...(realTrip?.endDate ? { contextEndDate: realTrip.endDate } : {}),
                  ...(realTrip?.ownerId === userId ? { isHost: 'true' } : {}),
                },
              } as any)
            }
          >
            <Radio size={16} color="#2E7D32" />
            <Text style={styles.circleFindBannerText}>Find Your Circle →</Text>
          </Pressable>
        )}

        {live && trip.id && (
          <Pressable
            style={styles.circleShareBanner}
            onPress={() => router.push({ pathname: '/circle-context-settings', params: { contextType: 'trip', contextId: trip.id, contextLabel: trip.destinationCity ?? 'this trip' } } as any)}
          >
            <Users size={16} color={color.deep} />
            <Text style={styles.circleShareBannerText}>Circle sharing settings for this trip →</Text>
          </Pressable>
        )}

        {/* Layover Mode entry — shown between TripCircle and CompassTripBrief */}
        <Pressable style={styles.layoverBanner} onPress={() => setLayoverOpen(true)}>
          <View style={styles.layoverBannerIcon}>
            <Plane size={18} color="#1565C0" />
          </View>
          <View style={styles.layoverBannerBody}>
            <Text style={styles.layoverBannerTitle}>Layover at this destination?</Text>
            <Text style={styles.layoverBannerSub}>Plan your time, transit tips, stay safe →</Text>
          </View>
        </Pressable>

        {/* Need someone local? — Rent a Buddy entry (flag-gated) */}
        {rentBuddyEnabled && (
          <NeedSomeoneLocalSection
            city={trip.destinationCity}
            tripId={trip.id}
            startDate={realTrip?.startDate ?? undefined}
            endDate={realTrip?.endDate ?? undefined}
            groupSize="1"
          />
        )}

        <CompassBriefErrorBoundary>
          <CompassTripBrief
            tripId={id}
            city={realTrip?.destinationCity ?? trip?.destinationCity ?? undefined}
            startDate={realTrip?.startDate ?? undefined}
            endDate={realTrip?.endDate ?? undefined}
          />
        </CompassBriefErrorBoundary>
        <CompassBriefErrorBoundary>
          <TripHeartbeatCard tripId={id} />
        </CompassBriefErrorBoundary>
        <TripStamps stamps={[]} />
        <TripMapPreview tripId={trip.id} />
        {live && trip.id ? (
          <TripCrewSection tripId={trip.id} refreshKey={crewRefreshKey} />
        ) : null}
        {activeSafeReturnSession ? (
          <ActiveSafeReturnCard
            session={activeSafeReturnSession}
            onSessionEnded={() => {
              setActiveSafeReturnSession(null);
              checkForNewStamps(2000);
            }}
            onSessionUpdated={(s) => setActiveSafeReturnSession(s)}
          />
        ) : (
          <Pressable
            style={[styles.safeSetupBtn, safeReturnChecking && { opacity: 0.7 }]}
            onPress={() => setSafeReturnSetupOpen(true)}
            disabled={safeReturnChecking}
          >
            {safeReturnChecking
              ? <ActivityIndicator size="small" color={color.deep} />
              : <ShieldCheck size={16} color={color.deep} />}
            <Text style={styles.safeSetupBtnText}>
              {safeReturnChecking ? 'Checking…' : 'Set up Safe Return'}
            </Text>
          </Pressable>
        )}
        {activeSafeReturnSession && activeSafeReturnSession.status === 'missed' && (
          <MissedCheckinPrompt
            visible={showMissedPrompt}
            session={activeSafeReturnSession}
            onDismiss={() => setShowMissedPrompt(false)}
            onSafe={() => {
              setShowMissedPrompt(false);
              setActiveSafeReturnSession(null);
              checkForNewStamps(2000);
            }}
            onExtended={(s) => { setShowMissedPrompt(false); setActiveSafeReturnSession(s); }}
          />
        )}
        {/* Mark as complete — shown to trip owner when trip is not yet completed */}
        {live && isAuthed && realTrip?.ownerId === userId && realTrip?.status !== 'completed' && (
          <Pressable
            style={[styles.markCompleteBtn, completingTrip && { opacity: 0.6 }]}
            onPress={handleMarkComplete}
            disabled={completingTrip}
          >
            {completingTrip
              ? <ActivityIndicator size="small" color={color.success} />
              : <Text style={styles.markCompleteBtnText}>Mark trip as complete</Text>}
          </Pressable>
        )}
        <SafeReturnSetupSheet
          visible={safeReturnSetupOpen}
          tripId={live ? trip.id : undefined}
          onClose={handleSafeReturnClose}
          onCheckingChange={setSafeReturnChecking}
        />
        <Modal visible={safeReturnChecking} transparent animationType="fade" statusBarTranslucent>
          <View style={srStyles.overlay}>
            <View style={srStyles.card}>
              <ActivityIndicator color={color.deep} />
              <Text style={srStyles.label}>Checking Safe Return…</Text>
            </View>
          </View>
        </Modal>
        <TripPostsSection posts={[]} />
        {live && trip.id ? (
          <TripMemorySection
            tripId={trip.id}
            isOwner={realTrip ? userId === realTrip.ownerId : false}
            tripStatus={realTrip?.status}
          />
        ) : null}
        {live && trip.id ? (
          <TripBudgetSection
            tripId={trip.id}
            isOwnerOrCohost={realTrip
              ? userId === realTrip.ownerId || memberRole === 'co_host'
              : false}
            isOwner={realTrip ? userId === realTrip.ownerId || memberRole === 'co_host' : false}
          />
        ) : null}
        {live && trip.id ? (
          <ReviewsSection
            entityType="trip"
            entityId={trip.id}
            entityName={trip.destinationCity ?? 'this trip'}
            canReview={realTrip?.status === 'completed' && !!userId && userId !== realTrip?.ownerId}
          />
        ) : null}
      </ScrollView>

      {/* Layover Mode sheet */}
      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
        initialCity={trip.destinationCity ?? undefined}
      />

      {/* Meetup creation — triggered from availability grid "Plan meetup this day" */}
      {meetupDate && (
        <MeetupCreationSheet
          tripId={trip.id}
          initialTitle={`Meetup — ${meetupDate}`}
          onDismiss={() => setMeetupDate(null)}
          onCreated={() => setMeetupDate(null)}
        />
      )}

      {/* Invite sheet — opened from the Invite button in the top bar (owner only) */}
      <TripInviteSheet
        tripId={trip.id}
        visible={inviteSheetOpen}
        onDismiss={() => setInviteSheetOpen(false)}
        onInviteSent={() => setCrewRefreshKey((k) => k + 1)}
      />

      {/* Invite links management — view usage and revoke (owner only) */}
      <TripInviteLinksSheet
        tripId={trip.id}
        visible={linksSheetOpen}
        onDismiss={() => setLinksSheetOpen(false)}
      />
    </View>
  );
}

function NeedSomeoneLocalSection({
  city, tripId, startDate, endDate, groupSize, travelerLanguage,
}: {
  city?: string | null;
  tripId: string;
  startDate?: string;
  endDate?: string;
  groupSize?: string;
  travelerLanguage?: string;
}) {
  const CATEGORIES = [
    { key: 'arrival', label: 'Arrival Buddy' },
    { key: 'city', label: 'City Buddy' },
    { key: 'nightlife', label: 'Nightlife Buddy' },
    { key: 'language', label: 'Language Buddy' },
    { key: 'content', label: 'Content Buddy' },
  ] as const;

  function handleCategoryPress(category: string) {
    // Buddy search consumes city / category / bookingDate — map the trip's
    // start date onto bookingDate so results match the trip window.
    const params = new URLSearchParams({ city: city ?? '', category });
    if (startDate) params.set('bookingDate', startDate);
    router.push(`/(rent-a-buddy)/search?${params.toString()}` as any);
  }

  return (
    <View style={nl.wrap}>
      <View style={nl.head}>
        <View style={nl.stamp}><Text style={nl.stampText}>RENT A BUDDY</Text></View>
        <Text style={nl.title}>Need someone local?</Text>
        <Text style={nl.sub}>{city ? `Find a buddy in ${city}` : 'Find a local buddy for your trip'}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={nl.chips}>
        {CATEGORIES.map((c) => (
          <Pressable key={c.key} style={nl.chip} onPress={() => handleCategoryPress(c.key)}>
            <Users size={12} color={color.signal} />
            <Text style={nl.chipText}>{c.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const nl = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.xl, backgroundColor: '#FFF5F5', borderRadius: 14, borderWidth: 1, borderColor: color.signal + '30', padding: space.md, gap: space.sm },
  head: { gap: 4 },
  stamp: { alignSelf: 'flex-start', backgroundColor: color.signal, paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: 4, transform: [{ rotate: '-1deg' }], marginBottom: space.xs },
  stampText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', color: '#fff', letterSpacing: 1.5 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  sub: { ...t.small, color: color.mute },
  chips: { gap: space.sm, paddingVertical: space.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderColor: color.signal, borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 7, backgroundColor: '#fff' },
  chipText: { ...t.small, fontWeight: '700', color: color.signal, fontSize: 12 },
});

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm, backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { ...t.bodyStrong, color: color.signal },
  topBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  topBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  topIcon: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  unreadDot: { position: 'absolute', top: -3, right: -3, width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2, backgroundColor: color.signal },
  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: space.lg, marginTop: space.lg, backgroundColor: '#E3F2FD', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: '#BBDEFB' },
  layoverBannerIcon: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#BBDEFB' },
  layoverBannerBody: { flex: 1, gap: 1 },
  layoverBannerTitle: { fontSize: 14, fontWeight: '700', color: '#0D47A1' },
  layoverBannerSub: { fontSize: 12, fontWeight: '400', color: '#1565C0', opacity: 0.85 },
  circleFindBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: space.lg, marginTop: space.md, backgroundColor: '#E8F5E9', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  circleFindBannerText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#2E7D32' },
  circleShareBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: space.lg, marginTop: space.md, backgroundColor: '#EAF2F4', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  circleShareBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: color.deep },
  safeSetupBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  safeSetupBtnText: { ...t.body, color: color.deep, fontWeight: '600' },
  markCompleteBtn: { marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.success, backgroundColor: '#F0FDF4', alignItems: 'center' },
  markCompleteBtnText: { ...t.body, color: color.success, fontWeight: '700' },
  tripNotesCard: { marginHorizontal: space.lg, marginBottom: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.lg, borderWidth: 1, borderColor: color.haze },
  tripNotesText: { ...t.small, color: color.ink, lineHeight: 20 },
  seeDestinationRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.sm, marginBottom: space.xs, backgroundColor: color.paperRaised, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: color.haze },
  seeDestinationText: { ...t.small, color: color.signal, fontWeight: '600', flex: 1 },
});

const srStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  label: { ...t.body, color: color.ink, fontSize: 14 },
});

function formatGapLabel(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function GapDayNudgeSection({
  gapDays, destination: _destination, tripId: _tripId, onChipPress,
}: {
  gapDays: string[];
  destination: string;
  tripId: string;
  onChipPress: () => void;
}) {
  return (
    <View style={gn.wrap}>
      <Text style={gn.label}>UNPLANNED DAYS</Text>
      <Text style={gn.hint}>Tap a day to ask Telegraph for ideas</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={gn.row}>
        {gapDays.map((d) => {
          const label = formatGapLabel(d);
          return (
            <Pressable
              key={d}
              style={gn.chip}
              onPress={onChipPress}
            >
              <Calendar size={11} color={color.signal} />
              <Text style={gn.chipText}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const gn = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.lg, gap: 4 },
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.8 },
  hint: { ...t.small, color: color.mute, fontSize: 11, marginBottom: 4 },
  row: { gap: space.sm, paddingVertical: 2 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: 7,
    borderRadius: radius.pill, borderWidth: 1,
    borderColor: color.signal, backgroundColor: '#FFF5F5',
  },
  chipText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
});

function TripMemorySection({
  tripId, isOwner, tripStatus,
}: {
  tripId: string;
  isOwner: boolean;
  tripStatus?: string;
}) {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [memLoading, setMemLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [memoryCoverFailed, setMemoryCoverFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTripMemory(tripId).then((res) => {
      if (cancelled) return;
      if (res.ok) setMemory(res.memory);
      setMemLoading(false);
    }).catch(() => {
      if (!cancelled) setMemLoading(false);
    });
    return () => { cancelled = true; };
  }, [tripId]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    const res = await createTripMemory(tripId);
    if (res.ok) {
      setMemory(res.memory);
      router.push(`/memory/${res.memory.id}` as any);
    } else {
      Alert.alert('Error', res.message ?? 'Could not create memory');
    }
    setCreating(false);
  }

  if (memLoading) return null;

  return (
    <View style={tm.wrap}>
      <Text style={tm.title}>Trip Memory</Text>
      {memory ? (
        <Pressable style={tm.card} onPress={() => router.push(`/memory/${memory.id}` as any)}>
          {memory.cover?.mediaUrl && !memoryCoverFailed ? (
            <CachedImage source={{ uri: memory.cover.mediaUrl }} style={tm.cover} onError={() => setMemoryCoverFailed(true)} />
          ) : (
            <View style={[tm.cover, tm.coverEmpty]}>
              <BookImage size={28} color={color.onInk} />
            </View>
          )}
          <View style={tm.cardBody}>
            <Text style={tm.cardTitle} numberOfLines={1}>
              {memory.title ?? 'Untitled Memory'}
            </Text>
            {memory.caption ? (
              <Text style={tm.cardCaption} numberOfLines={2}>{memory.caption}</Text>
            ) : null}
            <Text style={tm.cardState}>{memory.state === 'published' ? '✓ Published' : 'Draft'}</Text>
          </View>
        </Pressable>
      ) : isOwner && tripStatus === 'completed' ? (
        <Pressable
          style={[tm.createBtn, creating && { opacity: 0.5 }]}
          onPress={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : (
            <BookImage size={16} color={color.signal} />
          )}
          <Text style={tm.createBtnText}>
            {creating ? 'Creating…' : 'Create a memory from this trip'}
          </Text>
        </Pressable>
      ) : (
        <View style={tm.empty}>
          <BookImage size={22} color={color.faint} />
          <Text style={tm.emptyText}>No memory for this trip yet</Text>
        </View>
      )}
    </View>
  );
}

const tm = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md },
  title: { ...t.title, color: color.ink, fontSize: 18 },
  card: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  cover: { width: 90, height: 90 },
  coverEmpty: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, padding: space.md, gap: 4, justifyContent: 'center' },
  cardTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  cardCaption: { ...t.small, color: color.mute, lineHeight: 16 },
  cardState: { fontSize: 11, color: color.signal, fontWeight: '600', marginTop: 2 },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: color.signal,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    backgroundColor: '#FFF5F5',
  },
  createBtnText: { ...t.body, color: color.signal, fontWeight: '600' },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    padding: space.xl,
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    borderStyle: 'dashed',
  },
  emptyText: { ...t.small, color: color.faint },
});

// ── EventsNearTripSection ─────────────────────────────────────────────────────

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function EventCoverImage({ uri, style, emptyStyle }: { uri: string; style: any; emptyStyle: any }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[style, emptyStyle]}>
        <CalendarClock size={18} color={color.faint} />
      </View>
    );
  }
  return <CachedImage source={{ uri }} style={style} onError={() => setFailed(true)} />;
}

function EventsNearTripSection({ tripId }: { tripId: string }) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getEventsNearTrip(tripId).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setEvents(res.data.events.slice(0, 10));
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [tripId]);

  if (!loaded || events.length === 0) return null;

  return (
    <View style={ev.wrap}>
      <View style={ev.head}>
        <CalendarClock size={15} color={color.signal} />
        <Text style={ev.title}>Events here</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={ev.row}
      >
        {events.map((e) => (
          <Pressable
            key={e.id}
            style={ev.card}
            onPress={() => router.push(`/event/${e.id}?tripId=${tripId}` as any)}
          >
            {e.coverUrl ? (
              <EventCoverImage uri={e.coverUrl} style={ev.cover} emptyStyle={ev.coverEmpty} />
            ) : (
              <View style={[ev.cover, ev.coverEmpty]}>
                <CalendarClock size={18} color={color.faint} />
              </View>
            )}
            <View style={ev.cardBody}>
              <Text style={ev.cardTitle} numberOfLines={2}>{e.title}</Text>
              {e.startsAt ? (
                <Text style={ev.cardMeta}>{formatEventDate(e.startsAt)}</Text>
              ) : null}
              {e.locationName ? (
                <View style={ev.cardLocRow}>
                  <MapPin size={10} color={color.mute} />
                  <Text style={ev.cardMeta} numberOfLines={1}>{e.locationName}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const ev = StyleSheet.create({
  wrap:        { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.sm },
  head:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title:       { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  row:         { gap: space.md, paddingVertical: space.xs, paddingRight: space.lg },
  card:        { width: 160, backgroundColor: color.paperRaised, borderRadius: 12, borderWidth: 1, borderColor: color.haze, overflow: 'hidden' },
  cover:       { width: '100%', height: 90 },
  coverEmpty:  { backgroundColor: '#E8F0F2', alignItems: 'center', justifyContent: 'center' },
  cardBody:    { padding: space.sm, gap: 3 },
  cardTitle:   { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12, lineHeight: 16 },
  cardMeta:    { ...t.small, color: color.mute, fontSize: 10, flex: 1 },
  cardLocRow:  { flexDirection: 'row', alignItems: 'center', gap: 3 },
});

export default function TripDetail() {
  return (
    <ScreenErrorBoundary>
      <TripDetailScreen />
    </ScreenErrorBoundary>
  );
}
