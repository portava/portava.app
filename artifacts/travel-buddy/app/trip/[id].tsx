import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert, Share, Image, type LayoutChangeEvent } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Share2, Pencil, Map as MapIcon, Lock, MessageCircle, Calendar, Plane, Users, BookImage } from 'lucide-react-native';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import {
  TripHero, TodayNextUp, SavedIdeas,
  TripPlans, TripCircle, CompassTripBrief, TripStamps, TripSafety, TripPostsSection,
  TripCrewSection,
} from '../../src/components/TripPage';
import { TripPlanSection } from '../../src/components/TripPlanSection';
import { TripAvailabilitySection } from '../../src/components/TripAvailabilitySection';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { DailyBriefCard } from '../../src/components/DailyBriefCard';
import { ConciergeCommandBar, type ConciergeCommandBarHandle } from '../../src/components/ConciergeCommandBar';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { mockTripDetail, mockNextUp, tripPlans, tripCircle, tripStamps, tripPosts } from '../../src/data/tripDetail';
import { useSession } from '../../src/context/SessionContext';
import { useTrip, usePendingTripInvites } from '../../src/hooks/useBackend';
import { openTripChat } from '../../src/services/messaging';
import { getTripMemory, createTripMemory, type Memory } from '../../src/services/memories';
import { color, space, radius, type as t } from '../../src/theme/tokens';

// RichText surface note: the TripDetail model (`src/types/models.ts: TripDetail`)
// does not expose a freeform description/notes field for RichText rendering.
// The `notes` field exists on `TripPlanItem` (individual plan items) and is wired
// via the plan-item detail sheets.  If a trip-level description is added to the
// DB schema and the `TripDetail` type in the future, render it here with:
//   <RichText content={trip.description} tags={trip.descriptionTags} hashtagUsages={trip.descriptionHashtags} />
export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { configured, isAuthed, userId } = useSession();
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const live = configured && isAuthed;
  const { data: realTrip, loading } = useTrip(live ? id : undefined);
  const { invites } = usePendingTripInvites();
  const isPendingInvite = live ? invites.some((inv) => inv.tripId === id) : false;
  const pageScrollRef    = useRef<ScrollView>(null);
  const commandBarRef    = useRef<ConciergeCommandBarHandle>(null);
  const commandBarY      = useRef<number>(0);
  const [chatLoading, setChatLoading] = useState(false);
  const [meetupDate, setMeetupDate] = useState<string | null>(null);
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [gapDays, setGapDays] = useState<string[]>([]);
  const [gapDestination, setGapDestination] = useState('');
  const handleGapDays = useCallback((days: string[], dest: string) => {
    setGapDays(days);
    setGapDestination(dest);
  }, []);

  const handleGapDayChipPress = useCallback(() => {
    pageScrollRef.current?.scrollTo({ y: commandBarY.current, animated: true });
    // Small delay lets the scroll animation start before the keyboard appears
    setTimeout(() => { commandBarRef.current?.focus(); }, 350);
  }, []);

  const trip = live && realTrip ? {
    ...mockTripDetail,
    id: realTrip.id,
    title: realTrip.title,
    destinationCity: realTrip.destinationCity,
    destinationCountry: realTrip.destinationCountry ?? mockTripDetail.destinationCountry,
    startDate: realTrip.startDate ?? mockTripDetail.startDate,
    endDate: realTrip.endDate ?? mockTripDetail.endDate,
    status: realTrip.status,
    visibility: realTrip.visibility,
    coverUrl: realTrip.coverUrl ?? mockTripDetail.coverUrl,
  } : mockTripDetail;

  async function handleOpenChat() {
    if (!trip.id || chatLoading) return;
    setChatLoading(true);
    const res = await openTripChat(trip.id);
    setChatLoading(false);
    if (res.ok && res.data) {
      const { threadId, title } = res.data;
      const params = new URLSearchParams({ title: title ?? trip.title ?? 'Trip Chat', threadType: 'trip', contextId: trip.id });
      router.push(`/messages/${threadId}?${params.toString()}`);
    } else {
      Alert.alert('Chat unavailable', res.message ?? 'Could not open the trip chat. Make sure you are an accepted trip member.');
    }
  }

  if (live && loading) {
    return <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.signal} /></View>;
  }

  const todayDate = new Date().toISOString().slice(0, 10);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
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
                <View style={{ position: 'relative' }}>
                  <MessageCircle size={15} color={color.signal} />
                  <View style={styles.unreadDot} />
                </View>
              )
            }
            <Text style={[styles.topBtnText, { color: color.signal }]}>Chat</Text>
          </Pressable>
        )}
        {rentBuddyEnabled && (
          <Pressable
            style={styles.topBtn}
            hitSlop={6}
            onPress={() => {
              const params = new URLSearchParams({ tripId: trip.id });
              if (trip.destinationCity) params.set('city', trip.destinationCity);
              router.push(`/(rent-a-buddy)/search?${params.toString()}` as any);
            }}
          >
            <Users size={15} color={color.ink} /><Text style={styles.topBtnText}>Rent a Buddy</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.topBtn}
          hitSlop={6}
          onPress={() => {
            Share.share({
              message: `Check out my trip${trip.title ? ` — ${trip.title}` : ''}!\nhttps://travelbuddy.app/trips/${trip.id}`,
            }).catch(() => {
              Alert.alert('Could not share', 'Sharing is not available on this device right now.');
            });
          }}
        >
          <Share2 size={15} color={color.ink} /><Text style={styles.topBtnText}>Share Trip</Text>
        </Pressable>
        <View style={[styles.topBtn, { opacity: 0.35 }]} accessibilityLabel="Edit trip (coming soon)">
          <Pencil size={15} color={color.ink} /><Text style={styles.topBtnText}>Edit Trip</Text>
        </View>
      </View>

      <ScrollView ref={pageScrollRef} contentContainerStyle={{ paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false}>
        <TripHero trip={trip} />

        {/* ── Daily Brief (accepted members only; graceful fallback for others) ── */}
        {live && trip.id ? (
          <DailyBriefCard tripId={trip.id} date={todayDate} onGapDays={handleGapDays} />
        ) : null}

        <TodayNextUp nextUp={mockNextUp} />

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

        <TripPlanSection
          tripId={trip.id}
          currentUserId={userId ?? ''}
          isOwner={realTrip ? userId === realTrip.ownerId : false}
          isPendingInvite={isPendingInvite}
          tripStartDate={realTrip?.startDate ?? undefined}
          tripEndDate={realTrip?.endDate ?? undefined}
          pageScrollRef={pageScrollRef}
        />
        {live && trip.id ? (
          <TripAvailabilitySection
            tripId={trip.id}
            currentUserId={userId ?? ''}
            startDate={realTrip?.startDate ?? undefined}
            endDate={realTrip?.endDate ?? undefined}
            onPlanMeetup={(date) => setMeetupDate(date)}
          />
        ) : null}
        <SavedIdeas ideas={trip.savedIdeas} tripId={trip.id} />
        <TripPlans plans={tripPlans} />
        <TripCircle cityCount={tripCircle.cityCount} inCity={tripCircle.inCity} suggested={tripCircle.suggested} />

        {/* Layover Mode entry — shown between TripCircle and CompassTripBrief */}
        <Pressable style={styles.layoverBanner} onPress={() => setLayoverOpen(true)}>
          <Plane size={16} color="#1565C0" />
          <Text style={styles.layoverBannerText}>Got a layover at this destination? Plan it →</Text>
        </Pressable>

        {/* Need someone local? — Rent a Buddy entry (flag-gated) */}
        {rentBuddyEnabled && (
          <NeedSomeoneLocalSection
            city={trip.destinationCity}
            tripId={trip.id}
            startDate={realTrip?.startDate ?? undefined}
            endDate={realTrip?.endDate ?? undefined}
            groupSize={String((Array.isArray(tripCircle.inCity) ? tripCircle.inCity.length : tripCircle.inCity) + 1)}
          />
        )}

        <CompassTripBrief />
        <TripStamps stamps={tripStamps} />
        <TripMapPlaceholder />
        {live && trip.id ? (
          <TripCrewSection tripId={trip.id} />
        ) : null}
        <TripSafety />
        <TripPostsSection posts={tripPosts} />
        {live && trip.id ? (
          <TripMemorySection
            tripId={trip.id}
            isOwner={realTrip ? userId === realTrip.ownerId : false}
            tripStatus={realTrip?.status}
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
    const params = new URLSearchParams({ city: city ?? '', category, tripId });
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (groupSize) params.set('groupSize', groupSize);
    if (travelerLanguage) params.set('lang', travelerLanguage);
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
  topIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  unreadDot: { position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: color.signal },
  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: space.lg, marginTop: space.lg, backgroundColor: '#E3F2FD', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  layoverBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: '#1565C0' },
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
          {memory.cover?.mediaUrl ? (
            <Image source={{ uri: memory.cover.mediaUrl }} style={tm.cover} />
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

function TripMapPlaceholder() {
  return (
    <View style={mp.wrap}>
      <Text style={mp.h}>Trip Map</Text>
      <View style={mp.card}>
        <View style={mp.iconWrap}><MapIcon size={26} color={color.deep} /></View>
        <Text style={mp.title}>Map coming soon</Text>
        <Text style={mp.sub}>Saved places and trip pins will appear here.</Text>
        <View style={mp.privacy}>
          <Lock size={12} color={color.mute} />
          <Text style={mp.privacyText}>Location sharing is private by default.</Text>
        </View>
      </View>
    </View>
  );
}

const mp = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md },
  h: { ...t.title, color: color.ink, fontSize: 18 },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, borderStyle: 'dashed', padding: space.xl, alignItems: 'center', gap: 6 },
  iconWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  sub: { ...t.small, color: color.mute, textAlign: 'center' },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm, backgroundColor: color.paper, paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill },
  privacyText: { ...t.small, color: color.mute, fontSize: 11 },
});
