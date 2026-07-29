import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import {
  ArrowLeft, Search, MapPin, Users, Shield, ChevronRight,
  ChevronDown, ChevronUp, Star, Plane, ShoppingBag,
  Globe, Camera, Music, BookOpen, HelpCircle, AlertCircle, Bell,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import {
  TravelSectionHeader, HorizontalScrollStrip,
} from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import { BuddyCard, BuddyCardSkeleton } from '../../src/components/BuddyCard';
import { searchBuddies, getLaunchStatus, getAvailableNow, type BuddyProfile } from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';

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

// ── City availability banner ──────────────────────────────────────────────────

type LaunchInfo = {
  status: string;
  message: string;
  available: boolean;
  betaAvailable: boolean;
  waitlistOpen: boolean;
};

function CityAvailabilityBanner({ city, availableNowCount }: { city: string; availableNowCount: number | null }) {
  const [info, setInfo] = useState<LaunchInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (city.trim().length <= 2) { setInfo(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      const r = await getLaunchStatus(city.trim());
      if (cancelled) return;
      setLoading(false);
      if (r.ok) setInfo(r.data as LaunchInfo);
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [city]);

  if (city.trim().length <= 2) return null;
  if (loading) return (
    <View style={bannerStyles.loading}>
      <ActivityIndicator size="small" color={color.signal} />
      <Text style={bannerStyles.loadingText}>Checking availability…</Text>
    </View>
  );
  if (!info) return null;

  const isLive      = info.status === 'public_mvp';
  const isBeta      = info.status === 'beta_testing';
  const isPaused    = info.status === 'paused' || info.status === 'suspended';
  const isWaitlist  = info.status === 'waitlist_only' || info.status === 'buddy_applications_open' || info.status === 'internal_testing';
  const isDisabled  = info.status === 'disabled';

  // `isLive` only means the city has been rolled out to public MVP — it does
  // NOT mean a buddy is online right now. Previously this rendered a green
  // "live" success banner regardless of real availability, which then sat
  // directly above (or, worse, on top of) the "Available Now" section's own
  // "no buddies right now" empty state — two contradictory claims about the
  // same city on the same screen. Fold real availability into THIS banner so
  // there is exactly one message about the city, and it can never lie.
  const hasNoBuddiesRightNow = isLive && availableNowCount != null && availableNowCount === 0;
  const effectiveMessage = hasNoBuddiesRightNow
    ? `Rent a Buddy is live in ${city} — no buddies are online right now. Check back soon, or browse other live cities below.`
    : info.message;

  const bannerColor = hasNoBuddiesRightNow ? '#F59E0B15'
    : isLive   ? '#10B98115'
    : isBeta   ? '#EC489915'
    : isPaused ? '#EF444415'
    : isWaitlist ? '#F59E0B15'
    : '#99999915';

  const borderColor = hasNoBuddiesRightNow ? '#F59E0B'
    : isLive   ? '#10B981'
    : isBeta   ? '#EC4899'
    : isPaused ? '#EF4444'
    : isWaitlist ? '#F59E0B'
    : '#999999';

  const textColor = hasNoBuddiesRightNow ? '#D97706'
    : isLive   ? '#059669'
    : isBeta   ? '#BE185D'
    : isPaused ? '#DC2626'
    : isWaitlist ? '#D97706'
    : '#6B7280';

  return (
    <View style={[bannerStyles.banner, { backgroundColor: bannerColor, borderColor }]}>
      <AlertCircle size={15} color={textColor} />
      <Text style={[bannerStyles.message, { color: textColor }]}>{effectiveMessage}</Text>
      {info.waitlistOpen && !isLive && !isBeta && (
        <Pressable
          style={[bannerStyles.pill, { borderColor }]}
          onPress={() => router.push({ pathname: '/(rent-a-buddy)/waitlist' as any, params: { city } })}
        >
          <Bell size={10} color={textColor} />
          <Text style={[bannerStyles.pillText, { color: textColor }]}>Join waitlist</Text>
        </Pressable>
      )}
      {isBeta && (
        <Pressable
          style={[bannerStyles.pill, { borderColor }]}
          onPress={() => router.push({ pathname: '/(rent-a-buddy)/waitlist' as any, params: { city } })}
        >
          <Text style={[bannerStyles.pillText, { color: textColor }]}>Request beta access</Text>
        </Pressable>
      )}
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  loading: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.lg, marginTop: space.sm },
  loadingText: { ...t.small, color: color.mute },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginHorizontal: space.lg, marginTop: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, flexWrap: 'wrap' },
  message: { ...t.small, flex: 1, lineHeight: 18 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1, backgroundColor: '#ffffff20', marginTop: 4 },
  pillText: { fontSize: 10, fontWeight: '700' },
});

// ── Main landing screen ───────────────────────────────────────────────────────

export default function RentABuddyLanding() {
  const insets = useSafeAreaInsets();
  const [city, setCity] = useState('');
  const [cityCoords, setCityCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [topBuddies, setTopBuddies] = useState<BuddyProfile[]>([]);
  const [loadingTop, setLoadingTop] = useState(false);
  const [availableNow, setAvailableNow] = useState<BuddyProfile[]>([]);
  const [availableNowCity, setAvailableNowCity] = useState<string | null>(null);

  const loadTopBuddies = useCallback(async (searchCity: string) => {
    if (!searchCity.trim()) return;
    setLoadingTop(true);
    const res = await searchBuddies({ city: searchCity, perPage: 4 });
    setLoadingTop(false);
    if (res.ok) setTopBuddies(res.data.buddies);
    else setTopBuddies([]);
  }, []);

  useEffect(() => {
    if (city.trim().length < 2) return;
    getAvailableNow(city).then(res => {
      if (res.ok) {
        setAvailableNow(res.data.buddies.slice(0, 6));
        setAvailableNowCity(city);
      }
    }).catch(() => {});
  }, [city]);

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
      contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
      showsVerticalScrollIndicator={false}
    >
      {/* Back nav */}
      <View style={[styles.backRow, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.push('/(tabs)/' as any)} hitSlop={8} style={{ padding: 4 }}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
      </View>

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
          <Pressable style={{ flex: 1 }} onPress={() => setCityPickerOpen(true)}>
            <Text
              style={[styles.searchInput, !city && { color: color.haze }]}
              numberOfLines={1}
            >
              {city || 'Enter city or destination…'}
            </Text>
          </Pressable>
          {city.trim().length > 0 && (
            <Pressable
              style={styles.searchBtn}
              onPress={() => router.push({
                pathname: '/(rent-a-buddy)/search' as any,
                params: {
                  city,
                  ...(cityCoords ? { lat: String(cityCoords.lat), lng: String(cityCoords.lng) } : {}),
                },
              })}
            >
              <Text style={styles.searchBtnText}>Go</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Universal city picker — selections are canonical Places, not raw text */}
      <GlobalPlacePicker
        visible={cityPickerOpen}
        onClose={() => setCityPickerOpen(false)}
        onSelect={(place: Place) => {
          setCity(place.city ?? place.name);
          setCityCoords(place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null);
        }}
        mode="city"
        title="Where do you need a Buddy?"
        usedFor="buddy_search"
      />

      {/* City availability banner — shown when city is typed. Fed the same
          availableNow count used by the list below so the two can never
          disagree (one honest claim per city, not two). */}
      <CityAvailabilityBanner
        city={city}
        availableNowCount={availableNowCity === city ? availableNow.length : null}
      />

      {/* Available Now */}
      <TravelSectionHeader
        kicker="LIVE NOW"
        title="Available Now"
        onAction={() => router.push('/(rent-a-buddy)/search' as any)}
      />
      {availableNow.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.md }}
        >
          {availableNow.map(b => (
            <Pressable
              key={b.id}
              style={{ width: 140 }}
              onPress={() => router.push(`/(rent-a-buddy)/buddy/${b.id}` as any)}
            >
              <BuddyCard
                buddy={b}
                compact
                availableNow
                onBook={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: b.id } })}
              />
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}>
          <Text style={{ color: color.mute, fontSize: 14, lineHeight: 20 }}>
            {availableNowCity
              ? `No Buddies available right now in ${availableNowCity} — check back soon.`
              : 'Enter a city above to see who\'s available right now.'}
          </Text>
        </View>
      )}

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

      {/* Legal disclaimer */}
      <View style={styles.disclaimer}>
        <View style={styles.disclaimerRow}>
          <Shield size={14} color={color.mute} />
          <Text style={styles.disclaimerTitle}>Community Companionship Only</Text>
        </View>
        <Text style={styles.disclaimerText}>
          Rent a Buddy is a local guide and travel companionship service. It is <Text style={{ fontWeight: '700' }}>not</Text> a dating,
          escort, adult-service, romantic, or sexual-service platform. All meetups begin at
          public locations. Both parties are responsible for their own safety and local law compliance.
          {'\n\n'}In a genuine emergency, contact local services immediately (112 / 911 / 999).
        </Text>
      </View>

      {/* Become a Buddy */}
      <View style={[styles.becomeCTA, { marginHorizontal: space.lg, marginTop: space.md, marginBottom: space.xl }]}>
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
  backRow: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  hero: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg },
  disclaimer: {
    marginHorizontal: space.lg, marginTop: space.xl,
    backgroundColor: '#F7F7F7', borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.lg,
  },
  disclaimerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.sm },
  disclaimerTitle: { ...t.small, fontWeight: '700', color: color.ink, letterSpacing: 0.2 },
  disclaimerText: { ...t.small, color: color.mute, lineHeight: 18 },
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
