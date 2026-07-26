import React, { useState, useCallback } from 'react';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useNavBarScrollHandler, NavBarFiller } from '../../src/hooks/useNavBarCollapse';
import { postCompassFrontloadEvent } from '../../src/services/compass';
import {
  View, Text, ScrollView, Pressable,
  ActivityIndicator, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import EventsTabScreen from './events';
import { NotificationBell } from '../../src/components/NotificationBell';
import {
  Plus, Users, CalendarDays, MapPin, CalendarClock,
  ChevronRight, Check, X, Plane, Briefcase,
} from 'lucide-react-native';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { Stamp } from '../../src/components/ui';
import { useSession } from '../../src/context/SessionContext';
import { useMyTrips, usePendingTripInvites } from '../../src/hooks/useBackend';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { acceptTripInvite, declineTripInvite, type TripInvite } from '../../src/services/trips';
import { addEventToTrip } from '../../src/services/events';
import { classifyInviteAcceptError } from '../../src/lib/inviteCardGoneHandler';
import { useScreenTiming } from '../../src/hooks/useScreenTiming';
import { useSnapshotCache } from '../../src/hooks/useSnapshotCache';
import type { TripRow } from '../../src/services/trips';
import { CachedImage } from '../../src/components/CachedImage';
import { AvatarImage } from '../../src/components/ui/DisplayMediaImage';
import { useBlockedIds } from '../../src/context/BlockedIdsContext';
import { TripCard } from '../../src/components/cards/TripCard';
import { TripCardSkeleton } from '../../src/components/loading/TripCardSkeleton';
import { EmptyState } from '../../src/components/ui/EmptyState';

function MeetupsShortcut({ count }: { count: number }) {
  const label = count > 9 ? '9+' : count > 0 ? String(count) : null;
  return (
    <Pressable
      style={styles.meetupsCard}
      onPress={() => router.push('/meetups' as any)}
      accessibilityLabel={count > 0 ? `Meetups — ${count} upcoming` : 'Meetups'}
      accessibilityRole="button"
    >
      <View>
        <View style={styles.meetupsIcon}>
          <CalendarClock size={18} color={color.onInk} />
        </View>
        {label ? (
          <View style={styles.meetupsBadge}>
            <Text style={styles.meetupsBadgeText}>{label}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.meetupsText}>
        <Text style={styles.meetupsTitle}>Meetups</Text>
        <Text style={styles.meetupsSub}>View and plan get-togethers</Text>
      </View>
      <ChevronRight size={18} color={color.mute} />
    </Pressable>
  );
}

function InviteCard({ invite, onDone }: { invite: TripInvite; onDone: () => void }) {
  const [busy, setBusy] = React.useState<'accept' | 'decline' | null>(null);
  const [tripGone, setTripGone] = React.useState(false);
  const [inviteCoverErr, setInviteCoverErr] = React.useState(false);
  const { blockedIds, blockerIds } = useBlockedIds();

  async function handle(action: 'accept' | 'decline') {
    setBusy(action);
    try {
      if (action === 'accept') {
        await acceptTripInvite(invite.tripId);
        onDone();
        router.push(`/trip/${invite.tripId}` as any);
      } else {
        await declineTripInvite(invite.tripId);
        onDone();
      }
    } catch (e: unknown) {
      if (action === 'accept' && classifyInviteAcceptError(e) === 'gone') {
        setTripGone(true);
        setBusy(null);
      } else {
        const msg = (e as { message?: string } | null)?.message;
        Alert.alert('Error', msg ?? 'Something went wrong. Please try again.');
        setBusy(null);
      }
    }
  }

  const dateStr = invite.startDate
    ? invite.endDate
      ? `${invite.startDate} – ${invite.endDate}`
      : invite.startDate
    : 'Dates TBD';

  const destination = invite.destinationCountry
    ? `${invite.destinationCity}, ${invite.destinationCountry}`
    : invite.destinationCity;

  return (
    <View style={styles.inviteCard}>
      {invite.coverUrl && !inviteCoverErr ? (
        <CachedImage source={{ uri: invite.coverUrl }} style={styles.inviteCover} resizeMode="cover" onError={() => setInviteCoverErr(true)} />
      ) : (
        <View style={[styles.inviteCover, styles.inviteCoverPlaceholder]}>
          <MapPin size={22} color={color.onInk} />
        </View>
      )}
      <View style={styles.inviteBody}>
        <Pressable
          style={styles.inviteInviterRow}
          onPress={() => {
            if (!invite.inviter?.handle) return;
            const isBlocked = blockedIds.has(invite.inviter.id) || blockerIds.has(invite.inviter.id);
            if (isBlocked) return;
            router.push(`/u/${invite.inviter.handle}` as any);
          }}
          disabled={!invite.inviter?.handle}
        >
          <AvatarImage
            uri={invite.inviter?.avatarUrl}
            user={{ displayName: invite.inviter?.name }}
            size={20}
            style={styles.inviterAvatar}
          />
          <Text style={styles.inviterLabel} numberOfLines={1}>
            <Text style={styles.inviterName}>{invite.inviter?.name ?? 'Someone'}</Text>
            {' invited you'}
          </Text>
        </Pressable>
        <Text style={styles.inviteTitle} numberOfLines={1}>{invite.tripTitle}</Text>
        <View style={styles.inviteMeta}>
          <MapPin size={12} color={color.mute} />
          <Text style={styles.inviteMetaText} numberOfLines={1}>{destination}</Text>
        </View>
        <View style={styles.inviteMeta}>
          <CalendarDays size={12} color={color.mute} />
          <Text style={styles.inviteMetaText}>{dateStr}</Text>
        </View>
        {(invite.visibility || invite.memberCount != null) && (
          <View style={styles.inviteMeta}>
            <Users size={12} color={color.mute} />
            <Text style={styles.inviteMetaText} numberOfLines={1}>
              {invite.memberCount != null ? `${invite.memberCount} member${invite.memberCount !== 1 ? 's' : ''}` : ''}
              {invite.memberCount != null && invite.visibility ? ' · ' : ''}
              {invite.visibility === 'public' ? 'Public'
                : invite.visibility === 'buddies' ? 'Buddies only'
                : invite.visibility === 'invite' ? 'Invite only'
                : invite.visibility === 'private' ? 'Private'
                : ''}
            </Text>
          </View>
        )}
        {tripGone ? (
          <View style={styles.inviteGoneBanner}>
            <X size={14} color={color.mute} />
            <Text style={styles.inviteGoneText}>This trip is no longer active.</Text>
          </View>
        ) : (
          <View style={styles.inviteActions}>
            <Pressable
              style={[styles.inviteBtn, styles.inviteBtnDecline]}
              onPress={() => handle('decline')}
              disabled={busy !== null}
              accessibilityLabel="Decline trip invite"
              accessibilityRole="button"
            >
              {busy === 'decline'
                ? <ActivityIndicator size={14} color={color.mute} />
                : <X size={14} color={color.mute} />}
              <Text style={styles.inviteBtnDeclineText}>Decline</Text>
            </Pressable>
            <Pressable
              style={[styles.inviteBtn, styles.inviteBtnAccept]}
              onPress={() => handle('accept')}
              disabled={busy !== null}
              accessibilityLabel="Accept trip invite"
              accessibilityRole="button"
            >
              {busy === 'accept'
                ? <ActivityIndicator size={14} color={color.onInk} />
                : <Check size={14} color={color.onInk} />}
              <Text style={styles.inviteBtnAcceptText}>Accept</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

function PendingInvitesSection({ onAccepted }: { onAccepted: () => void }) {
  const { invites, reload } = usePendingTripInvites();

  if (!invites.length) return null;

  async function handleDone() {
    await reload();
    onAccepted();
  }

  return (
    <View style={styles.inviteSection}>
      <Text style={styles.inviteSectionTitle}>Trip Invites</Text>
      {invites.map((inv) => (
        <InviteCard key={inv.tripId} invite={inv} onDone={handleDone} />
      ))}
    </View>
  );
}

type TripsTab = 'trips' | 'events';

function TripsScreen() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { data: realTrips, loading, error, reload } = useMyTrips();
  const { meetups: meetupCount } = useUnreadCounts();
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TripsTab>('trips');

  // "Add event to trip" mode — entered when the event detail screen pushes
  // /trips?addEventId=…; the user picks a trip and we attach the event to it.
  const { addEventId, addEventTitle } = useLocalSearchParams<{ addEventId?: string; addEventTitle?: string }>();
  const [addTarget, setAddTarget] = useState<{ id: string; title: string } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  React.useEffect(() => {
    if (typeof addEventId === 'string' && addEventId.length > 0) {
      setAddTarget({ id: addEventId, title: typeof addEventTitle === 'string' ? addEventTitle : '' });
    }
  }, [addEventId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePickTripForEvent = useCallback(async (tripId: string) => {
    if (!addTarget || addBusy) return;
    setAddBusy(true);
    try {
      const res = await addEventToTrip(addTarget.id, tripId);
      if (res.ok) {
        const title = addTarget.title || 'Event';
        setAddTarget(null);
        Alert.alert('Added to trip', `“${title}” is now on this trip's plan.`, [
          { text: 'View trip', onPress: () => router.push(`/trip/${tripId}` as any) },
          { text: 'Done', style: 'cancel' },
        ]);
      } else {
        Alert.alert('Could not add event', res.message ?? 'Please try again.');
      }
    } finally {
      setAddBusy(false);
    }
  }, [addTarget, addBusy]);
  const insets = useSafeAreaInsets();
  const navScrollHandler = useNavBarScrollHandler();
  const { markFirstContent, epoch } = useScreenTiming('Trips');

  // Stale-while-revalidate: pre-paint the trip list from the previous session's
  // snapshot while the network fetch is in-flight.
  const { snapshot: tripsSnapshot, save: saveTripsSnapshot, clear: clearTripsSnapshot } = useSnapshotCache<TripRow[]>('trips');

  // Track whether the initial network load has completed — once true, live data
  // (even empty) always wins over the snapshot so stale trips are never sticky.
  const [tripsLoadedOnce, setTripsLoadedOnce] = useState(false);
  React.useEffect(() => {
    if (!loading && !tripsLoadedOnce) setTripsLoadedOnce(true);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Use snapshot only while the initial load is in-flight. Once any response
  // arrives (even empty) live data always wins — no stale trips left on screen.
  const displayTrips = tripsLoadedOnce ? realTrips : (tripsSnapshot ?? realTrips);

  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'trips' }).catch(() => {});
  }, []));

  React.useEffect(() => { if (live) reload(); }, [live, reload]);

  // Persist trip list to snapshot after each successful load.
  // Save even on empty arrays so a genuinely-empty list clears the old snapshot.
  React.useEffect(() => {
    if (!loading && !error) {
      saveTripsSnapshot(realTrips);
    }
  }, [realTrips, loading, error, saveTripsSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Perf timing: before first load, fire when snapshot has data;
  // after first load, fire only when live data is present.
  React.useEffect(() => {
    const hasContent = tripsLoadedOnce
      ? realTrips.length > 0
      : realTrips.length > 0 || (tripsSnapshot?.length ?? 0) > 0;
    if (hasContent) markFirstContent();
  }, [epoch, tripsLoadedOnce, realTrips.length > 0, (tripsSnapshot?.length ?? 0) > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {activeTab === 'trips' ? (
        <>
          <ScrollView
            onScroll={navScrollHandler}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingBottom: 0 }}
            refreshControl={
              <RefreshControl
                refreshing={loading && displayTrips.length > 0}
                onRefresh={() => { clearTripsSnapshot(); reload(); }}
                tintColor={color.signal}
              />
            }
          >
            <AppHeader
              variant="primary"
              title="Trips"
              rightActions={[
                { icon: <NotificationBell />, accessibilityLabel: 'Notifications' },
                { icon: <Plus size={22} color={color.ink} />, onPress: () => router.push('/trip/new'), accessibilityLabel: 'New trip' },
              ]}
            />

            {/* Segmented tab control — Trips | Events */}
            <View style={styles.segControl}>
              {(['trips', 'events'] as const).map((tab) => (
                <Pressable
                  key={tab}
                  style={[styles.segBtn, activeTab === tab && styles.segBtnActive]}
                  onPress={() => setActiveTab(tab)}
                  accessibilityLabel={tab === 'trips' ? 'Trips' : 'Events'}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === tab }}
                >
                  <Text style={[styles.segLabel, activeTab === tab && styles.segLabelActive]}>
                    {tab === 'trips' ? 'Trips' : 'Events'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Trip content */}
            <View style={{ padding: space.lg, gap: space.lg }}>
              <MeetupsShortcut count={meetupCount} />

              {/* Layover Mode quick-access banner */}
              <Pressable style={styles.layoverBanner} onPress={() => setLayoverOpen(true)}>
                <Plane size={16} color="#1565C0" />
                <Text style={styles.layoverBannerText}>Got a layover? Plan activities, check safety & more →</Text>
              </Pressable>

              {live && <PendingInvitesSection onAccepted={reload} />}
              {live && addTarget && (
                <View style={styles.addBanner}>
                  <Briefcase size={16} color={color.signal} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.addBannerTitle} numberOfLines={1}>
                      Add {addTarget.title ? `“${addTarget.title}”` : 'this event'} to a trip
                    </Text>
                    <Text style={styles.addBannerSub}>Tap one of your trips below to add it.</Text>
                  </View>
                  {addBusy
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : (
                      <Pressable onPress={() => setAddTarget(null)} hitSlop={8} accessibilityLabel="Cancel adding event">
                        <X size={16} color={color.mute} />
                      </Pressable>
                    )}
                </View>
              )}
              {live ? (
                <LiveTrips
                  trips={displayTrips}
                  loading={loading && displayTrips.length === 0}
                  error={error}
                  onPickTrip={addTarget ? handlePickTripForEvent : undefined}
                />
              ) : (
                <Pressable style={styles.signInCta} onPress={() => router.push('/(auth)/sign-in' as any)}>
                  <Text style={styles.signInCtaTitle}>Sign in to see your trips</Text>
                  <Text style={styles.signInCtaSub}>Log or plan a trip, track destinations, and share your travel story.</Text>
                </Pressable>
              )}
              <Pressable style={styles.empty} onPress={() => router.push('/trip/new')}>
                <Plus size={20} color={color.deep} />
                <Text style={styles.emptyText}>Start a new trip</Text>
              </Pressable>
              <NavBarFiller />
            </View>
          </ScrollView>

          <LayoverModeSheet
            visible={layoverOpen}
            onClose={() => setLayoverOpen(false)}
          />
        </>
      ) : (
        <>
          {/* segControl stays visible for navigation between tabs */}
          <View style={{ paddingTop: insets.top }}>
            <View style={styles.segControl}>
              {(['trips', 'events'] as const).map((tab) => (
                <Pressable
                  key={tab}
                  style={[styles.segBtn, activeTab === tab && styles.segBtnActive]}
                  onPress={() => setActiveTab(tab)}
                  accessibilityLabel={tab === 'trips' ? 'Trips' : 'Events'}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeTab === tab }}
                >
                  <Text style={[styles.segLabel, activeTab === tab && styles.segLabelActive]}>
                    {tab === 'trips' ? 'Trips' : 'Events'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          {/* Offset the EventsTabScreen's own paddingTop: insets.top so it sits
              flush under our segmented control, not behind the status bar again. */}
          <View style={{ flex: 1, marginTop: -insets.top }}>
            <EventsTabScreen />
          </View>
        </>
      )}
    </View>
  );
}

function TripCardItem({ tr, onPickTrip }: { tr: any; onPickTrip?: (tripId: string) => void }) {
  return (
    <TripCard
      id={tr.id}
      title={tr.title}
      destinationCity={tr.destinationCity}
      destinationCountry={tr.destinationCountry ?? null}
      startDate={tr.startDate ?? null}
      endDate={tr.endDate ?? null}
      status={tr.status}
      coverUrl={tr.coverUrl ?? null}
      onPress={() => (onPickTrip ? onPickTrip(tr.id) : router.push(`/trip/${tr.id}`))}
    />
  );
}

function LiveTrips({ trips, loading, error, onPickTrip }: { trips: any[]; loading: boolean; error: string | null; onPickTrip?: (tripId: string) => void }) {
  if (loading) {
    return (
      <>
        <TripCardSkeleton />
        <TripCardSkeleton />
        <TripCardSkeleton />
      </>
    );
  }
  if (error) return <View style={styles.state}><Text style={styles.stateText}>Couldn't load your trips. Pull to retry.</Text></View>;
  if (!trips.length) {
    return (
      <EmptyState
        icon={MapPin}
        title="No trips yet"
        description="Create your first trip to start planning, saving places, and meeting travelers."
        primaryAction={{ label: 'Plan your first trip', onPress: () => router.push('/trip/new') }}
      />
    );
  }
  return (
    <>
      {trips.map((tr) => (
        <TripCardItem key={tr.id} tr={tr} onPickTrip={onPickTrip} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  addBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal,
    backgroundColor: color.paperRaised,
  },
  addBannerTitle: { ...t.small, fontWeight: '700', color: color.ink },
  addBannerSub: { ...t.small, color: color.mute },
  signInCta: {
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: space.sm,
  },
  signInCtaTitle: { ...t.bodyStrong, color: color.ink, fontSize: 15, textAlign: 'center' },
  signInCtaSub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  newBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
  meetupsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.md,
    ...shadow.card,
    borderWidth: 1,
    borderColor: color.haze,
  },
  meetupsIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meetupsText: {
    flex: 1,
    gap: 2,
  },
  meetupsTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
  },
  meetupsSub: {
    ...t.small,
    color: color.mute,
  },
  meetupsBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  meetupsBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 11,
  },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card },
  cover: { width: '100%', height: 150, backgroundColor: color.haze },
  coverFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center', gap: 6 },
  coverFallbackText: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.onInk, letterSpacing: 0.5, maxWidth: '70%', textAlign: 'center' },
  body: { padding: space.lg, gap: space.sm },
  stampRow: { flexDirection: 'row', gap: space.sm },
  title: { ...t.title, color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { ...t.small, color: color.mute },
  empty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed' },
  emptyText: { ...t.body, color: color.deep, fontWeight: '600' },
  state: { padding: space.xxl, alignItems: 'center' },
  stateText: { ...t.small, color: color.mute },
  bigEmpty: { alignItems: 'center', gap: space.sm, padding: space.xxl, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze },
  bigEmptyTitle: { ...t.title, color: color.ink, fontSize: 18 },
  bigEmptySub: { ...t.small, color: color.mute, textAlign: 'center' },

  inviteSection: { gap: space.sm },
  inviteSectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  inviteCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
  },
  inviteCover: { width: '100%', height: 90 },
  inviteCoverPlaceholder: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteBody: { padding: space.md, gap: space.sm },
  inviteInviterRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inviterAvatar: { width: 20, height: 20, borderRadius: 10 },
  inviterAvatarPlaceholder: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  inviterLabel: { ...t.small, color: color.mute, flex: 1 },
  inviterName: { fontWeight: '600', color: color.ink },
  inviteTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  inviteMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteMetaText: { ...t.small, color: color.mute },
  inviteActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  inviteGoneBanner: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs, paddingVertical: space.sm, paddingHorizontal: space.sm, backgroundColor: color.haze, borderRadius: radius.sm },
  inviteGoneText: { ...(t.small as object), color: color.mute, flex: 1 },
  inviteBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  inviteBtnDecline: {
    backgroundColor: color.haze,
  },
  inviteBtnDeclineText: { ...t.small, color: color.mute, fontWeight: '600' },
  inviteBtnAccept: {
    backgroundColor: color.ink,
  },
  inviteBtnAcceptText: { ...t.small, color: color.onInk, fontWeight: '700' },
  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#E3F2FD', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  layoverBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: '#1565C0' },

  segControl: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    marginTop: space.md,
    marginBottom: space.xs,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    padding: 4,
  },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.pill,
  },
  segBtnActive: { backgroundColor: color.ink },
  segLabel: { ...t.small, fontWeight: '700', color: color.mute, fontSize: 13 },
  segLabelActive: { color: color.onInk },
});

export default function Trips() {
  return (
    <ScreenErrorBoundary>
      <TripsScreen />
    </ScreenErrorBoundary>
  );
}
