import React, { useState, useEffect, useCallback, Component } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList,
  StyleSheet, RefreshControl,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Search, MapPin, Zap, Users, Globe, ShoppingBag,
  Plane, Camera, Music, BookOpen, HelpCircle, CheckCircle, X,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import {
  TravelEmptyState, TravelErrorState,
} from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import { BuddyCard, BuddyCardSkeleton } from '../../src/components/BuddyCard';
import { searchBuddies, type BuddyProfile, type BuddyCategory } from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CompassBuddyRow } from '../../src/components/compass/CompassBuddyRow';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';

class CompassBuddyErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? null : this.props.children; }
}

type ScreenMode = 'categories' | 'quiz' | 'results';

const CATEGORIES = [
  { key: 'city' as BuddyCategory, label: 'City Explorer', icon: MapPin, desc: 'Navigate like a local' },
  { key: 'nightlife' as BuddyCategory, label: 'Nightlife Guide', icon: Music, desc: 'Safe & fun nights out' },
  { key: 'language' as BuddyCategory, label: 'Language Bridge', icon: Globe, desc: 'Overcome language barriers' },
  { key: 'shopping' as BuddyCategory, label: 'Shopping Helper', icon: ShoppingBag, desc: 'Find the best local deals' },
  { key: 'arrival' as BuddyCategory, label: 'Airport Arrival', icon: Plane, desc: 'Smooth arrival support' },
  { key: 'content' as BuddyCategory, label: 'Content Creator', icon: Camera, desc: 'Film & explore together' },
  { key: 'adventure' as BuddyCategory, label: 'Group Adventures', icon: BookOpen, desc: 'Explore together as a group' },
  { key: 'other' as BuddyCategory, label: 'Custom Request', icon: HelpCircle, desc: 'Build your own experience' },
];

const QUIZ_STEPS = [
  {
    id: 'language',
    q: 'Do you need a Buddy who speaks your language?',
    options: ['Yes, essential', 'Nice to have', 'Not important'],
  },
  {
    id: 'budget',
    q: "What's your hourly budget?",
    options: ['Under $20/hr', '$20–$40/hr', '$40–$70/hr', 'Flexible'],
  },
  {
    id: 'group',
    q: 'How many people are in your group?',
    options: ['Just me', '2 people', '3–5 people', '6+ people'],
  },
  {
    id: 'vibe',
    q: 'What kind of experience are you looking for?',
    options: ['Low-key & chill', 'Active & packed', 'Cultural & educational', 'Social & lively'],
  },
  {
    id: 'setting',
    q: 'Preferred meetup style?',
    options: ['Fully public only', 'Public start, flexible', "Buddy's preference is fine"],
  },
];

function computeCompatibility(answers: string[], buddy: BuddyProfile): { score: number; why: string } {
  let score = 60;
  const budgetAns = answers[1];
  if (budgetAns === 'Under $20/hr' && buddy.hourlyRateUsd != null && buddy.hourlyRateUsd < 20) score += 15;
  else if (budgetAns === '$20–$40/hr' && buddy.hourlyRateUsd != null && buddy.hourlyRateUsd >= 20 && buddy.hourlyRateUsd <= 40) score += 15;
  else if (budgetAns === '$40–$70/hr' && buddy.hourlyRateUsd != null && buddy.hourlyRateUsd > 40) score += 15;
  if (buddy.verified) score += 15;
  if (buddy.averageRating != null && buddy.averageRating >= 4.5) score += 10;
  score = Math.min(score, 99);
  const why = buddy.verified
    ? `Verified Buddy within your budget who matches your ${answers[3]?.toLowerCase() ?? 'vibe'} preference`
    : `Good match for your group size and budget range`;
  return { score, why };
}

export default function RentABuddySearch() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ city?: string; category?: string; mode?: string; bookingDate?: string; lat?: string; lng?: string }>();

  const [bookingDate] = useState<string | undefined>(params.bookingDate);

  const [mode, setMode] = useState<ScreenMode>(
    params.mode === 'quiz' ? 'quiz'
      : params.category ? 'results'
        : 'categories'
  );
  const [city, setCity] = useState(params.city ?? '');
  const [cityLat, setCityLat] = useState<number | undefined>(
    params.lat ? Number(params.lat) : undefined,
  );
  const [cityLng, setCityLng] = useState<number | undefined>(
    params.lng ? Number(params.lng) : undefined,
  );
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<BuddyCategory | undefined>(
    params.category as BuddyCategory | undefined
  );

  const [quizStep, setQuizStep] = useState(0);
  const [quizAnswers, setQuizAnswers] = useState<string[]>([]);

  const [buddies, setBuddies] = useState<BuddyProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [withScores, setWithScores] = useState(false);

  const doSearch = useCallback(async (reset = true) => {
    if (!city.trim()) return;
    const nextPage = reset ? 1 : page + 1;
    if (reset) { setLoading(true); setError(null); }
    const res = await searchBuddies({
      city,
      ...(cityLat != null ? { lat: cityLat } : {}),
      ...(cityLng != null ? { lng: cityLng } : {}),
      category: selectedCategory,
      page: nextPage,
      perPage: 10,
      ...(bookingDate ? { date: bookingDate } : {}),
    });
    setLoading(false);
    setRefreshing(false);
    if (!res.ok) { setError(res.error); return; }
    const newBuddies = res.data.buddies;
    setBuddies(reset ? newBuddies : prev => [...prev, ...newBuddies]);
    setTotal(res.data.total);
    setPage(nextPage);
    setHasMore(newBuddies.length === 10 && (nextPage * 10) < res.data.total);
  }, [city, cityLat, cityLng, selectedCategory, page, bookingDate]);

  useEffect(() => {
    if (mode === 'results') doSearch(true);
  }, [mode, selectedCategory]);

  const handleQuizAnswer = (answer: string) => {
    const next = [...quizAnswers, answer];
    setQuizAnswers(next);
    if (quizStep < QUIZ_STEPS.length - 1) {
      setQuizStep(s => s + 1);
    } else {
      setWithScores(true);
      setMode('results');
    }
  };

  const handleCategorySelect = (cat: BuddyCategory) => {
    setSelectedCategory(cat);
    setMode('results');
  };

  const handleBack = () => {
    if (mode === 'results') {
      setMode('categories');
      setBuddies([]);
      setError(null);
    } else if (mode === 'quiz') {
      if (quizStep > 0) setQuizStep(s => s - 1);
      else setMode('categories');
    } else {
      if (router.canGoBack()) router.back();
      else router.push('/(rent-a-buddy)/' as any);
    }
  };

  const getScoredBuddies = () =>
    withScores
      ? buddies.map(b => ({ buddy: b, ...computeCompatibility(quizAnswers, b) }))
        .sort((a, b) => b.score - a.score)
      : buddies.map(b => ({ buddy: b, score: undefined as any, why: undefined as any }));

  return (
    <View style={styles.page}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={handleBack}
          hitSlop={layout.hitSlop}
        >
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>

        <View style={styles.searchBar}>
          <Search size={14} color={color.mute} />
          <Pressable style={{ flex: 1 }} onPress={() => setCityPickerOpen(true)}>
            <Text style={[styles.searchInput, !city && { color: color.haze }]} numberOfLines={1}>
              {city || 'City or destination…'}
            </Text>
          </Pressable>
          {city.length > 0 && (
            <Pressable onPress={() => { setCity(''); setCityLat(undefined); setCityLng(undefined); setBuddies([]); setMode('categories'); }}>
              <X size={14} color={color.mute} />
            </Pressable>
          )}
        </View>

        {/* Universal city picker — canonical Places drive proximity-ranked results */}
        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => {
            setCityLat(place.lat ?? undefined);
            setCityLng(place.lng ?? undefined);
            setCity(place.city ?? place.name);
            setMode('results');
          }}
          mode="city"
          title="Search Buddies in…"
          usedFor="buddy_search"
        />

        {mode === 'results' && (
          <Pressable
            style={styles.quizBtn}
            onPress={() => { setMode('quiz'); setQuizStep(0); setQuizAnswers([]); }}
          >
            <Zap size={12} color={color.signal} />
            <Text style={styles.quizBtnText}>Match</Text>
          </Pressable>
        )}
      </View>

      {/* Category filter row in results mode */}
      {mode === 'results' && (
        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterChip, !selectedCategory && styles.filterChipActive]}
            onPress={() => { setSelectedCategory(undefined); doSearch(true); }}
          >
            <Text style={[styles.filterChipText, !selectedCategory && styles.filterChipTextActive]}>All</Text>
          </Pressable>
          {CATEGORIES.map(cat => (
            <Pressable
              key={cat.key}
              style={[styles.filterChip, selectedCategory === cat.key && styles.filterChipActive]}
              onPress={() => { setSelectedCategory(cat.key); }}
            >
              <Text style={[styles.filterChipText, selectedCategory === cat.key && styles.filterChipTextActive]}>
                {cat.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* CATEGORIES mode */}
      {mode === 'categories' && (
        <FlatList
          data={CATEGORIES}
          keyExtractor={c => c.key}
          numColumns={2}
          columnWrapperStyle={{ gap: space.md, paddingHorizontal: space.lg }}
          contentContainerStyle={{ paddingTop: space.lg, paddingBottom: 40, gap: space.md }}
          ListHeaderComponent={
            <View>
              <CompassBuddyErrorBoundary>
                <CompassBuddyRow city={city.trim() || null} />
              </CompassBuddyErrorBoundary>
              <View style={{ paddingHorizontal: space.lg, marginBottom: space.md }}>
              <Text style={styles.sectionLabel}>BROWSE BY TYPE</Text>
              <Text style={styles.sectionTitle}>What kind of Buddy do you need?</Text>
              <Pressable
                style={styles.quizCTA}
                onPress={() => { setMode('quiz'); setQuizStep(0); setQuizAnswers([]); }}
              >
                <Users size={16} color={color.onInk} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.quizCTATitle}>Let us match you</Text>
                  <Text style={styles.quizCTASub}>5 quick questions → your ideal Buddy</Text>
                </View>
                <Text style={{ color: color.onInk, fontSize: 18 }}>→</Text>
              </Pressable>
            </View>
            </View>
          }
          renderItem={({ item }) => {
            const Icon = item.icon;
            return (
              <Pressable
                style={({ pressed }) => [styles.catCell, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => handleCategorySelect(item.key)}
              >
                <View style={styles.catIcon}><Icon size={22} color={color.deep} /></View>
                <Text style={styles.catLabel}>{item.label}</Text>
                <Text style={styles.catDesc}>{item.desc}</Text>
              </Pressable>
            );
          }}
        />
      )}

      {/* QUIZ mode */}
      {mode === 'quiz' && (
        <View style={styles.quizWrap}>
          <View style={styles.quizProgress}>
            {QUIZ_STEPS.map((_, i) => (
              <View
                key={i}
                style={[styles.quizDot, i <= quizStep && styles.quizDotActive]}
              />
            ))}
          </View>
          <Text style={styles.quizStepLabel}>Question {quizStep + 1} of {QUIZ_STEPS.length}</Text>
          <Text style={styles.quizQ}>{QUIZ_STEPS[quizStep].q}</Text>
          {!city.trim() && (
            <View style={styles.cityPrompt}>
              <MapPin size={14} color={color.warn} />
              <Text style={styles.cityPromptText}>Enter a city above to get matched with local Buddies</Text>
            </View>
          )}
          <View style={styles.quizOptions}>
            {QUIZ_STEPS[quizStep].options.map(opt => (
              <Pressable
                key={opt}
                style={({ pressed }) => [styles.quizOption, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => handleQuizAnswer(opt)}
              >
                <Text style={styles.quizOptionText}>{opt}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* RESULTS mode */}
      {mode === 'results' && (
        <>
          {loading && !refreshing ? (
            <View style={{ padding: space.lg }}>
              <BuddyCardSkeleton />
              <BuddyCardSkeleton />
              <BuddyCardSkeleton />
            </View>
          ) : error ? (
            <TravelErrorState
              title="Couldn't load Buddies"
              sub={error}
              onRetry={() => doSearch(true)}
            />
          ) : buddies.length === 0 ? (
            <TravelEmptyState
              title="No verified Buddies available"
              sub={`No Buddies found in ${city || 'this city'} right now. Join the waitlist and we'll notify you when one becomes available.`}
              action="Join Waitlist"
              onAction={() => router.push({ pathname: '/(rent-a-buddy)/waitlist' as any, params: { city } })}
            />
          ) : (
            <FlatList
              data={getScoredBuddies()}
              keyExtractor={item => item.buddy.id}
              contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 40 + insets.bottom }}
              ListHeaderComponent={
                <View style={styles.resultsHeader}>
                  <Text style={styles.resultsCount}>
                    {total} verified Buddies {city ? `in ${city}` : ''}
                  </Text>
                  {withScores && (
                    <View style={styles.matchedBadge}>
                      <CheckCircle size={11} color={color.success} />
                      <Text style={styles.matchedText}>Ranked by compatibility</Text>
                    </View>
                  )}
                </View>
              }
              renderItem={({ item }) => (
                <BuddyCard
                  buddy={item.buddy}
                  compatibilityScore={item.score}
                  whyMatched={item.why}
                  onBook={() => router.push({ pathname: '/(rent-a-buddy)/request-buddy' as any, params: { buddyId: item.buddy.id } })}
                />
              )}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => { setRefreshing(true); doSearch(true); }}
                  tintColor={color.signal}
                />
              }
              onEndReached={() => { if (hasMore && !loading) doSearch(false); }}
              onEndReachedThreshold={0.3}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, height: 40,
  },
  searchInput: { ...t.body, color: color.ink, flex: 1, fontSize: 14 },
  quizBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#FFF0ED', borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderWidth: 1, borderColor: color.signal,
  },
  quizBtnText: { fontSize: 12, fontWeight: '700', color: color.signal },
  filterRow: {
    flexDirection: 'row', paddingHorizontal: space.lg, paddingVertical: space.sm,
    gap: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  filterChip: {
    paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  filterChipActive: { backgroundColor: color.ink, borderColor: color.ink },
  filterChipText: { ...t.small, fontWeight: '600', color: color.ink },
  filterChipTextActive: { color: color.onInk },
  sectionLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2, marginBottom: 4 },
  sectionTitle: { ...t.title, color: color.ink, marginBottom: space.lg, fontSize: 20 },
  quizCTA: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg,
    ...shadow.float,
  },
  quizCTATitle: { ...t.bodyStrong, color: color.onInk },
  quizCTASub: { ...t.small, color: color.onInkMute, marginTop: 2 },
  catCell: {
    flex: 1, backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.lg, gap: space.xs, ...shadow.card,
  },
  catIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#EAF2F5', alignItems: 'center', justifyContent: 'center', marginBottom: space.xs,
  },
  catLabel: { ...t.bodyStrong, color: color.ink },
  catDesc: { ...t.small, color: color.mute, lineHeight: 16 },
  quizWrap: { flex: 1, padding: space.xl },
  quizProgress: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  quizDot: { flex: 1, height: 3, borderRadius: 99, backgroundColor: color.haze },
  quizDotActive: { backgroundColor: color.signal },
  quizStepLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginBottom: space.sm },
  quizQ: { ...t.title, color: color.ink, fontSize: 22, lineHeight: 28, marginBottom: space.xl },
  cityPrompt: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#FFF8ED', borderRadius: radius.sm, padding: space.md,
    marginBottom: space.lg, borderWidth: 1, borderColor: color.warn,
  },
  cityPromptText: { ...t.small, color: color.warn, flex: 1 },
  quizOptions: { gap: space.md },
  quizOption: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: color.haze,
    padding: space.lg, ...shadow.card,
  },
  quizOptionText: { ...t.bodyStrong, color: color.ink },
  resultsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  resultsCount: { ...t.small, color: color.mute, fontWeight: '600' },
  matchedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EEF8F3', borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 3 },
  matchedText: { fontSize: 10, fontWeight: '700', color: color.success, fontFamily: 'Courier', letterSpacing: 0.3 },
});
