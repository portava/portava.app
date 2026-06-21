import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Share2, Pencil, MoreHorizontal, Map as MapIcon, Lock, MessageCircle, Calendar } from 'lucide-react-native';
import { TripHero, TodayNextUp, SavedIdeas } from '../../src/components/TripPage';
import {
  TripPlans, TripCircle, CompassTripBrief, TripStamps, TripSafety, TripPostsSection,
} from '../../src/components/TripPage2';
import { TripPlanSection } from '../../src/components/TripPlanSection';
import { TripAvailabilitySection } from '../../src/components/TripAvailabilitySection';
import { DailyBriefCard } from '../../src/components/DailyBriefCard';
import { ConciergeCommandBar } from '../../src/components/ConciergeCommandBar';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { mockTripDetail, mockNextUp, tripPlans, tripCircle, tripStamps, tripPosts } from '../../src/data/tripDetail';
import { useSession } from '../../src/context/SessionContext';
import { useTrip } from '../../src/hooks/useBackend';
import { openTripChat } from '../../src/services/messaging';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;
  const { data: realTrip, loading } = useTrip(live ? id : undefined);
  const pageScrollRef = useRef<ScrollView>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [meetupDate, setMeetupDate] = useState<string | null>(null);
  const [gapDays, setGapDays] = useState<string[]>([]);
  const [gapDestination, setGapDestination] = useState('');
  const handleGapDays = useCallback((days: string[], dest: string) => {
    setGapDays(days);
    setGapDestination(dest);
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
        <Pressable style={styles.topBtn} onPress={() => { }} hitSlop={6}>
          <Share2 size={15} color={color.ink} /><Text style={styles.topBtnText}>Share Trip</Text>
        </Pressable>
        <Pressable style={styles.topBtn} onPress={() => router.push('/settings')} hitSlop={6}>
          <Pencil size={15} color={color.ink} /><Text style={styles.topBtnText}>Edit Trip</Text>
        </Pressable>
        <Pressable style={styles.topIcon} hitSlop={6}><MoreHorizontal size={18} color={color.ink} /></Pressable>
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
          />
        )}

        {/* ── Concierge Command Bar ── */}
        {live && trip.id ? (
          <ConciergeCommandBar
            tripId={trip.id}
            destination={trip.destinationCity}
          />
        ) : null}

        <TripPlanSection
          tripId={trip.id}
          currentUserId={userId ?? ''}
          isOwner={realTrip ? userId === realTrip.ownerId : false}
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
        <SavedIdeas ideas={trip.savedIdeas} />
        <TripPlans plans={tripPlans} />
        <TripCircle cityCount={tripCircle.cityCount} inCity={tripCircle.inCity} suggested={tripCircle.suggested} />
        <CompassTripBrief />
        <TripStamps stamps={tripStamps} />
        <TripMapPlaceholder />
        <TripSafety />
        <TripPostsSection posts={tripPosts} />
      </ScrollView>

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

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm, backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backText: { ...t.bodyStrong, color: color.signal },
  topBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  topBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  topIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  unreadDot: { position: 'absolute', top: -3, right: -3, width: 7, height: 7, borderRadius: 4, backgroundColor: color.signal },
});

function formatGapLabel(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function GapDayNudgeSection({ gapDays, destination, tripId }: { gapDays: string[]; destination: string; tripId: string }) {
  return (
    <View style={gn.wrap}>
      <Text style={gn.label}>UNPLANNED DAYS</Text>
      <Text style={gn.hint}>Tap a day to get Telegraph suggestions</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={gn.row}>
        {gapDays.map((d) => {
          const label = formatGapLabel(d);
          const prompt = encodeURIComponent(`Help me plan ${label} in ${destination}`);
          return (
            <Pressable
              key={d}
              style={gn.chip}
              onPress={() => router.setParams({ telegraphPrompt: prompt })}
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
