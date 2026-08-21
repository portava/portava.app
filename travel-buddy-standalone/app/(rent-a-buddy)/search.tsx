import React, { useState, useEffect, useCallback, Component } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, ScrollView,
  StyleSheet, RefreshControl,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Search, MapPin, Zap, Users, Globe, ShoppingBag,
  Plane, Camera, Music, BookOpen, HelpCircle, CheckCircle, X, Bell,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout, avatar } from '../../src/theme/tokens';
import { Stamp } from '../../src/components/ui';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { ErrorState } from '../../src/components/ui/ErrorState';
import { ProfileCard } from '../../src/components/cards/ProfileCard';
import { ProfileSkeleton } from '../../src/components/loading/ProfileSkeleton';
import {
  searchBuddies, saveMatchPreferences, runMatch,
  type BuddyProfile, type BuddyCategory, type CoordPair, type MatchPreferences,
} from '../../src/services/rentABuddy';
import { useLocationContext } from '../../src/context/LocationContext';
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

type ScreenMode = 'categories' | 'quiz' | 'results' | 'quizResults';

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
  const { resolvedLocation, setSessionLocation, clearSessionLocation } = useLocationContext();
  // Same city resolution CompassBuddyRow uses (canonical location, not a
  // blank manual field) — so this screen's "All" tab never contradicts the
  // Compass-matched row rendered a few lines above it on the same screen.
  const fallbackCity = resolvedLocation.place.city ?? null;
  const fallbackLat = resolvedLocation.coords?.lat;
  const fallbackLng = resolvedLocation.coords?.lng;

  const [bookingDate] = useState<string | undefined>(params.bookingDate);

  const [mode, setMode] = useState<ScreenMode>(
    params.mode === 'quiz' ? 'quiz'
      : params.category ? 'results'
        : 'categories'
  );
  const [city, setCity] = useState(params.city ?? fallbackCity ?? '');
  const [cityLat, setCityLat] = useState<number | undefined>(
    params.lat ? Number(params.lat) : fallbackLat,
  );
  const [cityLng, setCityLng] = useState<number | undefined>(
    params.lng ? Number(params.lng) : fallbackLng,
  );
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<BuddyCategory | undefined>(
    params.category as BuddyCategory | undefined
  );

  const [quizStep, setQuizStep] = useState(0);
  const [quizAnswers, setQuizAnswers] = useState<string[]>([]);
  const [quizCityWarning, setQuizCityWarning] = useState(false);

  const [buddies, setBuddies] = useState<BuddyProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [withScores, setWithScores] = useState(false);

  // "Buddies elsewhere" fallback — shown instead of a bare dead end when the
  // resolved/typed city genuinely has none, so a real (honestly city-labeled)
  // result is always the outcome of a search, never a silent zero.
  const [elsewhereBuddies, setElsewhereBuddies] = useState<BuddyProfile[]>([]);
  const [elsewhereLoading, setElsewhereLoading] = useState(false);

  // Quiz results — a dedicated pipeline from the "results" list, because a
  // completed quiz always needs a real outcome (ranked matches, or an
  // explicit no-matches summary of what was captured), never a silent
  // reuse of the plain-browse empty state.
  const [quizMatching, setQuizMatching] = useState(false);
  const [quizMatchError, setQuizMatchError] = useState<string | null>(null);
  const [quizMatches, setQuizMatches] = useState<Array<BuddyProfile & { compatibilityScore: number }>>([]);
  const [quizRanBadge, setQuizRanBadge] = useState(false);

  const doSearch = useCallback(async (reset = true) => {
    if (!city.trim()) return;
    const nextPage = reset ? 1 : page + 1;
    if (reset) { setLoading(true); setError(null); setElsewhereBuddies([]); }
    try {
    const res = await searchBuddies({
      city,
      ...((cityLat != null && cityLng != null
        ? { lat: cityLat, lng: cityLng }
        : {}) as CoordPair),
      category: selectedCategory,
      page: nextPage,
      perPage: 10,
      ...(bookingDate ? { date: bookingDate } : {}),
    });
    if (!res.ok) { setError(res.error); return; }
    const newBuddies = res.data.buddies;
    setBuddies(reset ? newBuddies : prev => [...prev, ...newBuddies]);
    setTotal(res.data.total);
    setPage(nextPage);
    // Honest fallback: this city genuinely has none — show real, correctly
    // city-labeled Buddies from elsewhere rather than a bare dead end that
    // contradicts the Compass row on the previous screen.
    if (reset && newBuddies.length === 0) {
      setElsewhereLoading(true);
      const elsewhereRes = await searchBuddies({ city: '', category: selectedCategory, perPage: 6 });
      setElsewhereLoading(false);
      setElsewhereBuddies(elsewhereRes.ok ? elsewhereRes.data.buddies.filter(b => b.city !== city) : []);
    }
    setHasMore(newBuddies.length === 10 && (nextPage * 10) < res.data.total);
    } catch {
      // A rejected promise must never strand the results on skeletons
      // with no error (beta-audit P2 fix).
      setError('Search failed. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [city, cityLat, cityLng, selectedCategory, page, bookingDate]);

  useEffect(() => {
    if (mode === 'results') doSearch(true);
  }, [mode, selectedCategory, city, cityLat, cityLng]);

  /** Quiz answers -> the backend's MatchPreferences shape, plus the raw Q&A for editing/reference. */
  const buildPreferencesFromQuiz = (answers: string[]): MatchPreferences => {
    const [languageAns, budgetAns, groupAns, vibeAns, settingAns] = answers;
    const budgetMinUsd =
      budgetAns === '$20–$40/hr' ? 20 : budgetAns === '$40–$70/hr' ? 40 : undefined;
    const budgetMaxUsd =
      budgetAns === 'Under $20/hr' ? 20 : budgetAns === '$20–$40/hr' ? 40 : budgetAns === '$40–$70/hr' ? 70 : undefined;
    const groupSize =
      groupAns === '2 people' ? 2 : groupAns === '3–5 people' ? 4 : groupAns === '6+ people' ? 6 : 1;
    const rawAnswers: Record<string, string> = {};
    QUIZ_STEPS.forEach((step, i) => { if (answers[i]) rawAnswers[step.id] = answers[i]; });
    return {
      vibe: vibeAns ?? null,
      budgetMinUsd,
      budgetMaxUsd,
      groupSize,
      publicOnly: settingAns === 'Fully public only',
      safetyPrefs: { languageRequired: languageAns === 'Yes, essential' },
      rawAnswers,
    };
  };

  const runQuizMatch = useCallback(async (answers: string[]) => {
    setQuizMatching(true);
    setQuizMatchError(null);
    const prefs = buildPreferencesFromQuiz(answers);
    // Persist so these preferences inform future matching and can be
    // reviewed/edited by retaking the quiz — never just discarded on completion.
    saveMatchPreferences(prefs).catch(() => {});
    const res = await runMatch(city, prefs, 10);
    setQuizMatching(false);
    if (!res.ok) { setQuizMatchError(res.error); return; }
    setQuizMatches(res.data.results);
    setQuizRanBadge(true);
  }, [city]);

  const handleQuizAnswer = (answer: string) => {
    const next = [...quizAnswers, answer];
    setQuizAnswers(next);
    if (quizStep < QUIZ_STEPS.length - 1) {
      setQuizStep(s => s + 1);
      return;
    }
    // A city is required to produce a real match — block completion and
    // surface the requirement instead of silently landing on an empty state.
    if (!city.trim()) {
      setQuizCityWarning(true);
      setCityPickerOpen(true);
      return;
    }
    setWithScores(true);
    setMode('quizResults');
    runQuizMatch(next);
  };

  const handleCategorySelect = (cat: BuddyCategory) => {
    setSelectedCategory(cat);
    setMode('results');
  };

  const handleBack = () => {
    if (mode === 'results' || mode === 'quizResults') {
      setMode('categories');
      setBuddies([]);
      setError(null);
      setQuizMatches([]);
      setQuizMatchError(null);
      setQuizRanBadge(false);
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

  const quizPrefsSummary = quizAnswers.length === QUIZ_STEPS.length ? buildPreferencesFromQuiz(quizAnswers) : null;

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
            <Pressable onPress={() => {
              setCity('');
              setCityLat(undefined);
              setCityLng(undefined);
              setBuddies([]);
              setMode('categories');
              clearSessionLocation();
              router.setParams({ city: undefined, lat: undefined, lng: undefined });
            }}>
              <X size={14} color={color.mute} />
            </Pressable>
          )}
        </View>

        {/* Universal city picker — canonical Places drive proximity-ranked results */}
        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => {
            const selectedCity = place.city ?? place.name;
            setCityLat(place.lat ?? undefined);
            setCityLng(place.lng ?? undefined);
            setCity(selectedCity);
            setSessionLocation(place);
            router.setParams({
              city: selectedCity,
              lat: place.lat != null ? String(place.lat) : undefined,
              lng: place.lng != null ? String(place.lng) : undefined,
            });
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
            <Pressable style={styles.cityPrompt} onPress={() => setCityPickerOpen(true)}>
              <MapPin size={14} color={color.warn} />
              <Text style={styles.cityPromptText}>
                {quizCityWarning
                  ? 'A city is required to match you with local Buddies — tap to choose one.'
                  : 'A city is required to get matched with local Buddies. Tap to choose one.'}
              </Text>
            </Pressable>
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
          {!city.trim() ? (
            // Distinct from "zero results" — nobody has told this screen
            // where to search yet, so say that plainly instead of implying
            // no Buddies exist anywhere.
            <EmptyState
              icon={Search}
              title="Enter a city to search Buddies"
              description="Pick a destination and we'll show verified local Buddies there."
              primaryAction={{ label: 'Choose a city', onPress: () => setCityPickerOpen(true) }}
            />
          ) : loading && !refreshing ? (
            <View style={{ padding: space.lg }}>
              <ProfileSkeleton />
              <ProfileSkeleton />
              <ProfileSkeleton />
            </View>
          ) : error ? (
            <ErrorState
              message={error}
              onRetry={() => doSearch(true)}
            />
          ) : buddies.length === 0 ? (
            <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 40 + insets.bottom }}>
              <EmptyState
                icon={Users}
                title={`No Buddies in ${city} yet`}
                description="Join the waitlist and we'll notify you when one becomes available here."
                primaryAction={{ label: 'Join Waitlist', onPress: () => router.push({ pathname: '/(rent-a-buddy)/waitlist' as any, params: { city } }) }}
              />
              {elsewhereLoading ? (
                <ProfileSkeleton />
              ) : elsewhereBuddies.length > 0 ? (
                <View style={{ marginTop: space.lg }}>
                  <Text style={styles.sectionLabel}>BUDDIES AVAILABLE ELSEWHERE</Text>
                  {elsewhereBuddies.map(b => (
                    <ProfileCard
                      key={b.id}
                      id={b.id}
                      displayName={b.displayName ?? 'Buddy'}
                      avatarUrl={b.coverPhotoUrl}
                      trustScore={b.trustScore}
                      isVerified={b.verified}
                      bio={b.tagline ?? b.bio}
                      onPress={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: b.id } })}
                    />
                  ))}
                </View>
              ) : null}
            </ScrollView>
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
                <ProfileCard
                  id={item.buddy.id}
                  displayName={item.buddy.displayName ?? 'Buddy'}
                  avatarUrl={item.buddy.coverPhotoUrl}
                  trustScore={item.buddy.trustScore}
                  isVerified={item.buddy.verified}
                  bio={item.why ?? item.buddy.tagline ?? item.buddy.bio}
                  onPress={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: item.buddy.id } })}
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

      {/* QUIZ RESULTS mode — a completed quiz always ends in a real outcome */}
      {mode === 'quizResults' && (
        <>
          {quizMatching ? (
            <View style={{ padding: space.lg }}>
              <ProfileSkeleton />
              <ProfileSkeleton />
              <ProfileSkeleton />
            </View>
          ) : quizMatchError ? (
            <ErrorState
              message={quizMatchError}
              onRetry={() => runQuizMatch(quizAnswers)}
            />
          ) : quizMatches.length > 0 ? (
            <FlatList
              data={quizMatches}
              keyExtractor={item => item.id}
              contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 40 + insets.bottom }}
              ListHeaderComponent={
                <View style={styles.resultsHeader}>
                  <Text style={styles.resultsCount}>
                    {quizMatches.length} matched Buddies in {city}
                  </Text>
                  {quizRanBadge && (
                    <View style={styles.matchedBadge}>
                      <CheckCircle size={11} color={color.success} />
                      <Text style={styles.matchedText}>Ranked by compatibility</Text>
                    </View>
                  )}
                </View>
              }
              renderItem={({ item }) => (
                <ProfileCard
                  id={item.id}
                  displayName={item.displayName ?? 'Buddy'}
                  avatarUrl={item.coverPhotoUrl}
                  trustScore={item.trustScore}
                  isVerified={item.verified}
                  bio={item.verified ? `Matches your quiz answers for ${city}` : item.tagline ?? item.bio}
                  onPress={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: item.id } })}
                />
              )}
            />
          ) : (
            <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 40 + insets.bottom }}>
              <View style={styles.noMatchWrap}>
                <Users size={28} color={color.mute} />
                <Text style={styles.noMatchTitle}>No matches in {city} right now</Text>
                <Text style={styles.noMatchSub}>
                  Here's what we captured — we'll use it the moment a Buddy matching your
                  criteria becomes available.
                </Text>
              </View>

              <View style={styles.summaryCard}>
                <Text style={styles.summaryLabel}>Your preferences</Text>
                {QUIZ_STEPS.map((step, i) => (
                  quizAnswers[i] ? (
                    <View key={step.id} style={styles.summaryRow}>
                      <Text style={styles.summaryQ} numberOfLines={1}>{step.q}</Text>
                      <Text style={styles.summaryA} numberOfLines={1}>{quizAnswers[i]}</Text>
                    </View>
                  ) : null
                ))}
              </View>

              <Pressable
                style={styles.waitlistCTA}
                onPress={() => router.push({
                  pathname: '/(rent-a-buddy)/waitlist' as any,
                  params: {
                    city,
                    budget: quizPrefsSummary?.budgetMaxUsd ? String(quizPrefsSummary.budgetMaxUsd) : undefined,
                    notes: `From Match quiz: ${quizAnswers.join(' · ')}`,
                  },
                })}
              >
                <Bell size={14} color={color.onInk} />
                <Text style={styles.waitlistCTAText}>Join the waitlist for {city}</Text>
              </Pressable>

              <Text style={styles.broadenLabel}>Or broaden your search</Text>
              <View style={styles.broadenRow}>
                <Pressable
                  style={styles.broadenChip}
                  onPress={() => { setCityPickerOpen(true); }}
                >
                  <MapPin size={12} color={color.deep} />
                  <Text style={styles.broadenChipText}>Change city</Text>
                </Pressable>
                {(quizPrefsSummary?.budgetMaxUsd != null) && (
                  <Pressable
                    style={styles.broadenChip}
                    onPress={() => {
                      const relaxed = quizAnswers.slice();
                      relaxed[1] = 'Flexible';
                      setQuizAnswers(relaxed);
                      runQuizMatch(relaxed);
                    }}
                  >
                    <Zap size={12} color={color.deep} />
                    <Text style={styles.broadenChipText}>Relax budget</Text>
                  </Pressable>
                )}
                <Pressable
                  style={styles.broadenChip}
                  onPress={() => { setMode('categories'); setSelectedCategory(undefined); }}
                >
                  <Text style={styles.broadenChipText}>Browse all Buddies</Text>
                </Pressable>
              </View>
            </ScrollView>
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
    width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2,
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
  noMatchWrap: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  noMatchTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17, textAlign: 'center' },
  noMatchSub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },
  summaryCard: {
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.lg, marginTop: space.lg, gap: space.sm,
  },
  summaryLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginBottom: 2 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  summaryQ: { ...t.small, color: color.mute, flex: 1.4 },
  summaryA: { ...t.small, color: color.ink, fontWeight: '600', flex: 1, textAlign: 'right' },
  waitlistCTA: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    backgroundColor: color.ink, borderRadius: radius.md, padding: space.lg, marginTop: space.lg,
  },
  waitlistCTAText: { ...t.bodyStrong, color: color.onInk },
  broadenLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1.5, marginTop: space.xl, marginBottom: space.sm },
  broadenRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  broadenChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  broadenChipText: { ...t.small, fontWeight: '600', color: color.ink },
});
