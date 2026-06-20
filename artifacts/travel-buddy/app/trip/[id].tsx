import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Share2, Pencil, MoreHorizontal, Map as MapIcon, Lock } from 'lucide-react-native';
import { TripHero, TodayNextUp, SavedIdeas } from '../../src/components/TripPage';
import {
  TripPlans, TripCircle, CompassTripBrief, TripStamps, TripMapPreview, TripSafety, TripPostsSection,
} from '../../src/components/TripPage2';
import { TripPlanSection } from '../../src/components/TripPlanSection';
import { mockTripDetail, mockNextUp, tripPlans, tripCircle, tripStamps, tripPosts } from '../../src/data/tripDetail';
import { useSession } from '../../src/context/SessionContext';
import { useTrip } from '../../src/hooks/useBackend';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;
  const { data: realTrip, loading } = useTrip(live ? id : undefined);

  // Live: merge the real trip row into the hero; keep mock sub-sections until their
  // tables land. Mock fallback when not signed in.
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

  if (live && loading) {
    return <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.signal} /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ChevronLeft size={22} color={color.signal} />
          <Text style={styles.backText}>My Trip</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.topBtn} onPress={() => { /* share */ }} hitSlop={6}>
          <Share2 size={15} color={color.ink} /><Text style={styles.topBtnText}>Share Trip</Text>
        </Pressable>
        <Pressable style={styles.topBtn} onPress={() => router.push('/settings')} hitSlop={6}>
          <Pencil size={15} color={color.ink} /><Text style={styles.topBtnText}>Edit Trip</Text>
        </Pressable>
        <Pressable style={styles.topIcon} hitSlop={6}><MoreHorizontal size={18} color={color.ink} /></Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false}>
        <TripHero trip={trip} />
        <TodayNextUp nextUp={mockNextUp} />
        <TripPlanSection
          tripId={trip.id}
          currentUserId={userId ?? ''}
          isOwner={realTrip ? userId === realTrip.ownerId : false}
          tripStartDate={realTrip?.startDate ?? undefined}
          tripEndDate={realTrip?.endDate ?? undefined}
        />
        <SavedIdeas ideas={trip.savedIdeas} />
        <TripPlans plans={tripPlans} />
        <TripCircle cityCount={tripCircle.cityCount} inCity={tripCircle.inCity} suggested={tripCircle.suggested} />
        <CompassTripBrief />
        <TripStamps stamps={tripStamps} />
        <TripMapPlaceholder />
        <TripSafety />
        <TripPostsSection posts={tripPosts} />
      </ScrollView>
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
});

/* Trip map section — placeholder this pass. Live location is OFF/private by default
   and never rendered until the Live Map UI pass. */
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
