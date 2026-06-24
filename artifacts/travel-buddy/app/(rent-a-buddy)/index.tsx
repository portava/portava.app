import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import {
  Search, MapPin, Zap, Users, Shield, ChevronRight,
  ChevronDown, ChevronUp, Star, Plane, ShoppingBag,
  Globe, Camera, Music, BookOpen, HelpCircle,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import {
  TravelSectionHeader, HorizontalScrollStrip,
} from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import { BuddyCard, BuddyCardSkeleton } from '../../src/components/BuddyCard';
import { searchBuddies, type BuddyProfile } from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const CATEGORIES = [
  { key: 'city', label: 'City Explorer', icon: MapPin, desc: 'Navigate like a local' },
  { key: 'nightlife', label: 'Nightlife Guide', icon: Music, desc: 'Safe & fun nights out' },
  { key: 'language', label: 'Language Bridge', icon: Globe, desc: 'Overcome language barriers' },
  { key: 'shopping', label: 'Shopping Helper', icon: ShoppingBag, desc: 'Find the best local deals' },
  { key: 'arrival', label: 'Airport Arrival', icon: Plane, desc: 'Smooth arrival support' },
  { key: 'content', label: 'Content Creator', icon: Camera, desc: 'Film & explore together' },
  { key: 'adventure', label: 'Group Adventures', icon: BookOpen, desc: 'Explore together as a group' },
  { key: 'other', label: 'Custom Request', icon: HelpCircle, desc: 'Build your own experience' },
] as const;

const SAFETY_ITEMS = [
  {
    q: 'How are Buddies verified?',
    a: 'All Buddies complete ID verification, a video call, and a background screening before being approved. Verified badges are reviewed every 6 months.',
  },
  {
    q: 'What is the Trust Score?',
    a: 'Trust Score combines verified identity, response time, booking completion rate, traveler reviews, and community standing into a single safety signal.',
  },
  {
    q: 'Are meetups always in public?',
    a: 'By default, all meetups start in public locations. Buddies suggest pre-approved public zones. You control where you go at all times.',
  },
  {
    q: 'What if something goes wrong?',
    a: 'Every booking includes in-app reporting and our safety team is reachable 24/7. Trusted Circle sharing lets a contact follow your meetup in real time.',
  },
];

const MOCK_NOW_BUDDIES: BuddyProfile[] = [
  {
    id: 'mock-1', userId: 'u1', displayName: 'Amara K.', tagline: 'City insider',
    bio: null, languages: ['English', 'French'], city: 'Paris', country: 'France',
    categories: ['city', 'culture'], hourlyRateUsd: 25, status: 'active', verified: true,
    verifiedAt: null, averageRating: 4.9, reviewCount: 47, responseTimeH: 1,
    coverPhotoUrl: null, galleryUrls: [], createdAt: '', updatedAt: '',
  },
  {
    id: 'mock-2', userId: 'u2', displayName: 'Kenji T.', tagline: 'Night scene expert',
    bio: null, languages: ['English', 'Japanese'], city: 'Tokyo', country: 'Japan',
    categories: ['nightlife', 'city'], hourlyRateUsd: 30, status: 'active', verified: true,
    verifiedAt: null, averageRating: 4.8, reviewCount: 62, responseTimeH: 2,
    coverPhotoUrl: null, galleryUrls: [], createdAt: '', updatedAt: '',
  },
  {
    id: 'mock-3', userId: 'u3', displayName: 'Sofia L.', tagline: 'Language & culture',
    bio: null, languages: ['English', 'Spanish', 'Portuguese'], city: 'Barcelona', country: 'Spain',
    categories: ['language', 'shopping'], hourlyRateUsd: 22, status: 'active', verified: true,
    verifiedAt: null, averageRating: 5.0, reviewCount: 31, responseTimeH: 1,
    coverPhotoUrl: null, galleryUrls: [], createdAt: '', updatedAt: '',
  },
];

function SafetyAccordion() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <View style={acc.wrap}>
      <Text style={acc.heading}>Your Safety Comes First</Text>
      {SAFETY_ITEMS.map((item, i) => (
        <Pressable key={i} style={acc.item} onPress={() => setOpen(open === i ? null : i)}>
          <View style={acc.row}>
            <Shield size={14} color={color.success} style={{ marginTop: 2 }} />
            <Text style={acc.q}>{item.q}</Text>
            {open === i ? <ChevronUp size={14} color={color.mute} /> : <ChevronDown size={14} color={color.mute} />}
          </View>
          {open === i && <Text style={acc.a}>{item.a}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

export default function RentABuddyLanding() {
  const insets = useSafeAreaInsets();
  const [city, setCity] = useState('');
  const [topBuddies, setTopBuddies] = useState<BuddyProfile[]>([]);
  const [loadingTop, setLoadingTop] = useState(false);

  const loadTopBuddies = useCallback(async (searchCity: string) => {
    if (!searchCity.trim()) return;
    setLoadingTop(true);
    const res = await searchBuddies({ city: searchCity, perPage: 4 });
    setLoadingTop(false);
    if (res.ok) setTopBuddies(res.data.buddies);
    else setTopBuddies([]);
  }, []);

  useEffect(() => {
    if (city.trim().length > 2) {
      const timer = setTimeout(() => loadTopBuddies(city), 600);
      return () => clearTimeout(timer);
    } else {
      setTopBuddies([]);
    }
  }, [city, loadTopBuddies]);

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 40 + insets.bottom }}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero */}
      <View style={styles.hero}>
        <View style={styles.stampRow}>
          <Stamp label="Rent a Buddy" tone="signal" rotate={-1} />
        </View>
        <Text style={styles.heroTitle}>Connect with a{'\n'}trusted local Buddy</Text>
        <Text style={styles.heroSub}>
          Verified locals who help you navigate, explore, and experience your destination — safely.
        </Text>

        <View style={styles.searchBox}>
          <Search size={16} color={color.mute} />
          <TextInput
            style={styles.searchInput}
            placeholder="Enter city or destination…"
            placeholderTextColor={color.faint}
            value={city}
            onChangeText={setCity}
            returnKeyType="search"
            onSubmitEditing={() => router.push({ pathname: '/(rent-a-buddy)/search' as any, params: { city } })}
          />
          {city.trim().length > 0 && (
            <Pressable
              style={styles.searchBtn}
              onPress={() => router.push({ pathname: '/(rent-a-buddy)/search' as any, params: { city } })}
            >
              <Text style={styles.searchBtnText}>Go</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Available Now */}
      <TravelSectionHeader
        kicker="LIVE NOW"
        title="Available Now"
        onAction={() => router.push('/(rent-a-buddy)/search' as any)}
      />
      <HorizontalScrollStrip gap={space.md}>
        {MOCK_NOW_BUDDIES.map(b => (
          <View key={b.id} style={{ width: 220 }}>
            <View style={styles.nowBadge}>
              <Zap size={10} color={color.success} fill={color.success} />
              <Text style={styles.nowText}>Available Now</Text>
            </View>
            <BuddyCard buddy={b} compact />
          </View>
        ))}
      </HorizontalScrollStrip>

      {/* Match Me CTA */}
      <View style={styles.matchCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.matchTitle}>Not sure where to start?</Text>
          <Text style={styles.matchSub}>Answer 5 quick questions and we'll match you with the right Buddy.</Text>
        </View>
        <Pressable
          style={styles.matchBtn}
          onPress={() => router.push({ pathname: '/(rent-a-buddy)/search' as any, params: { mode: 'quiz' } })}
        >
          <Users size={14} color={color.onInk} />
          <Text style={styles.matchBtnText}>Match Me</Text>
        </Pressable>
      </View>

      {/* Top Buddies in City */}
      {city.trim().length > 2 && (
        <>
          <TravelSectionHeader
            kicker="TOP RATED"
            title={`Top Buddies in ${city}`}
            onAction={() => router.push({ pathname: '/(rent-a-buddy)/search' as any, params: { city } })}
          />
          <View style={{ paddingHorizontal: space.lg }}>
            {loadingTop ? (
              <><BuddyCardSkeleton /><BuddyCardSkeleton /></>
            ) : topBuddies.length > 0 ? (
              topBuddies.map(b => (
                <BuddyCard
                  key={b.id}
                  buddy={b}
                  onBook={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: b.id } })}
                />
              ))
            ) : (
              <View style={styles.noCity}>
                <Text style={styles.noCityText}>No verified Buddies in {city} yet.</Text>
                <Pressable onPress={() => router.push({ pathname: '/(rent-a-buddy)/waitlist' as any, params: { city } })}>
                  <Text style={styles.noCityLink}>Join the waitlist →</Text>
                </Pressable>
              </View>
            )}
          </View>
        </>
      )}

      {/* Category Grid */}
      <TravelSectionHeader kicker="BROWSE BY TYPE" title="What kind of Buddy do you need?" />
      <View style={styles.categoryGrid}>
        {CATEGORIES.map(cat => {
          const Icon = cat.icon;
          return (
            <Pressable
              key={cat.key}
              style={({ pressed }) => [styles.catCell, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => router.push({ pathname: '/(rent-a-buddy)/search' as any, params: { category: cat.key, city } })}
            >
              <View style={styles.catIcon}>
                <Icon size={20} color={color.deep} />
              </View>
              <Text style={styles.catLabel}>{cat.label}</Text>
              <Text style={styles.catDesc}>{cat.desc}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Safety */}
      <View style={{ paddingHorizontal: space.lg, marginTop: space.xl }}>
        <SafetyAccordion />
      </View>

      {/* Become a Buddy */}
      <View style={[styles.becomeCTA, { marginHorizontal: space.lg, marginTop: space.xl }]}>
        <Star size={20} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={styles.becomeTitle}>Share your city</Text>
          <Text style={styles.becomeSub}>Earn money helping travelers experience your destination authentically.</Text>
        </View>
        <Pressable style={styles.becomeBtn} onPress={() => router.push('/(rent-a-buddy)/become' as any)}>
          <Text style={styles.becomeBtnText}>Apply</Text>
          <ChevronRight size={14} color={color.signal} />
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  hero: { paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.lg },
  stampRow: { marginBottom: space.md },
  heroTitle: { ...t.hero, color: color.ink, marginBottom: space.sm },
  heroSub: { ...t.body, color: color.mute, marginBottom: space.lg, lineHeight: 22 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: color.haze,
    paddingHorizontal: space.md, ...shadow.card,
    height: 48,
  },
  searchInput: { ...t.body, color: color.ink, flex: 1, marginLeft: space.sm },
  searchBtn: {
    backgroundColor: color.signal, borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: space.xs,
  },
  searchBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
  nowBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  nowText: { fontSize: 10, fontWeight: '700', color: color.success, fontFamily: 'Courier', letterSpacing: 0.5 },
  matchCard: {
    marginHorizontal: space.lg, marginTop: space.lg,
    backgroundColor: color.ink, borderRadius: radius.lg,
    padding: space.xl, flexDirection: 'row', alignItems: 'center', gap: space.lg,
    ...shadow.float,
  },
  matchTitle: { ...t.bodyStrong, color: color.onInk, marginBottom: 4 },
  matchSub: { ...t.small, color: color.onInkMute, lineHeight: 18 },
  matchBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  matchBtnText: { ...t.bodyStrong, color: color.onInk },
  noCity: { padding: space.lg, alignItems: 'center', gap: space.sm },
  noCityText: { ...t.body, color: color.mute, textAlign: 'center' },
  noCityLink: { ...t.bodyStrong, color: color.signal },
  categoryGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: space.lg, gap: space.md, marginTop: space.sm,
  },
  catCell: {
    width: '47%', backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.lg, gap: space.xs, ...shadow.card,
  },
  catIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#EAF2F5', alignItems: 'center', justifyContent: 'center',
    marginBottom: space.xs,
  },
  catLabel: { ...t.bodyStrong, color: color.ink },
  catDesc: { ...t.small, color: color.mute, lineHeight: 16 },
  becomeCTA: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1.5, borderColor: color.signal,
    padding: space.lg, ...shadow.card,
  },
  becomeTitle: { ...t.bodyStrong, color: color.ink },
  becomeSub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
  becomeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  becomeBtnText: { ...t.bodyStrong, color: color.signal },
});

const acc = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, overflow: 'hidden', ...shadow.card,
  },
  heading: { ...t.bodyStrong, color: color.ink, padding: space.lg, paddingBottom: space.sm },
  item: { borderTopWidth: 1, borderTopColor: color.haze, padding: space.lg },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  q: { ...t.bodyStrong, color: color.ink, flex: 1 },
  a: { ...t.body, color: color.mute, marginTop: space.sm, lineHeight: 20 },
});
