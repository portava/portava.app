import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, RefreshControl, Switch,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Search, Sparkles, MapPin, SlidersHorizontal } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../src/theme/tokens';
import { TravelErrorState, TravelLoadingState } from '../../src/components/primitives';
import { BuddyCard } from '../../src/components/BuddyCard';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';
import {
  searchBuddies, type BuddyProfile, type BuddyCategory, type BuddySortBy, type CoordPair,
} from '../../src/services/rentABuddy';
import { useLocationContext } from '../../src/context/LocationContext';

type SessionMode = 'any' | 'in_person' | 'remote';

const CATEGORIES: { key: BuddyCategory | 'all'; label: string }[] = [
  { key: 'all',       label: 'All' },
  { key: 'city',      label: 'City Tour' },
  { key: 'arrival',   label: 'Arrival' },
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'food',      label: 'Food' },
  { key: 'language',  label: 'Language' },
  { key: 'content',   label: 'Content' },
];

const SORT_OPTIONS: { key: BuddySortBy; label: string }[] = [
  { key: 'best_match',    label: 'Best Match' },
  { key: 'highest_rated', label: 'Top Rated' },
  { key: 'available_soon', label: 'Available Soon' },
  { key: 'price_low',     label: 'Price ↑' },
  { key: 'price_high',    label: 'Price ↓' },
  { key: 'response_time', label: 'Fastest Reply' },
  { key: 'newest',        label: 'Newest' },
];

const BUDGET_OPTS: { label: string; max: number | undefined }[] = [
  { label: 'Any',     max: undefined },
  { label: '≤$20/hr', max: 20 },
  { label: '≤$40/hr', max: 40 },
  { label: '≤$70/hr', max: 70 },
];

const RATING_OPTS: { label: string; min: number | undefined }[] = [
  { label: 'Any rating', min: undefined },
  { label: '4.0+ ⭐',    min: 4.0 },
  { label: '4.5+ ⭐',    min: 4.5 },
];

const SESSION_MODES: { key: SessionMode; label: string }[] = [
  { key: 'any',       label: 'Any' },
  { key: 'in_person', label: 'In-person' },
  { key: 'remote',    label: 'Remote' },
];

const PER_PAGE = 10;

export default function Marketplace() {
  const plainInset = usePlainBottomInset();
  const insets = useSafeAreaInsets();
  const { setSessionLocation } = useLocationContext();
  const {
    fromQuiz,
    city: cityParam,
    lat: latParam,
    lng: lngParam,
  } = useLocalSearchParams<{ fromQuiz?: string; city?: string; lat?: string; lng?: string }>();

  const [city, setCity]                       = useState(cityParam ?? '');
  const [cityLat, setCityLat]                 = useState<number | undefined>(
    latParam ? Number(latParam) : undefined,
  );
  const [cityLng, setCityLng]                 = useState<number | undefined>(
    lngParam ? Number(lngParam) : undefined,
  );
  const [category, setCategory]               = useState<BuddyCategory | 'all'>('all');
  const [sortBy, setSortBy]                   = useState<BuddySortBy>('best_match');
  const [language, setLanguage]               = useState('');
  const [verifiedOnly, setVerifiedOnly]       = useState(false);
  const [budgetIdx, setBudgetIdx]             = useState(0);
  const [ratingIdx, setRatingIdx]             = useState(0);
  const [sessionMode, setSessionMode]         = useState<SessionMode>('any');
  const [filtersOpen, setFiltersOpen]         = useState(false);
  const [cityPickerOpen, setCityPickerOpen]   = useState(false);

  const [buddies, setBuddies]                 = useState<BuddyProfile[]>([]);
  const [page, setPage]                       = useState(1);
  const [total, setTotal]                     = useState(0);
  const [loading, setLoading]                 = useState(false);
  const [loadingMore, setLoadingMore]         = useState(false);
  const [refreshing, setRefreshing]           = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [cityNotLaunched, setCityNotLaunched] = useState(false);

  const budget = BUDGET_OPTS[budgetIdx];
  const rating = RATING_OPTS[ratingIdx];

  const load = useCallback(async (pg: number, silent = false) => {
    if (!city.trim()) return;
    if (pg === 1) {
      if (!silent) setLoading(true);
      setError(null);
      setCityNotLaunched(false);
    } else {
      setLoadingMore(true);
    }
    const res = await searchBuddies({
      city: city.trim(),
      ...((cityLat != null && cityLng != null
        ? { lat: cityLat, lng: cityLng }
        : {}) as CoordPair),
      ...(category !== 'all' ? { category: category as BuddyCategory } : {}),
      sortBy,
      verifiedOnly: verifiedOnly || undefined,
      ...(language.trim() ? { language: language.trim() } : {}),
      ...(budget.max != null ? { maxBudgetUsd: budget.max } : {}),
      ...(rating.min != null ? { minRating: rating.min } : {}),
      ...(sessionMode !== 'any' ? { sessionMode } : {}),
      page: pg,
      perPage: PER_PAGE,
    });
    if (pg === 1) {
      if (!silent) setLoading(false);
      setRefreshing(false);
    } else {
      setLoadingMore(false);
    }
    if (!res.ok) {
      if (res.error === 'city_not_available' || res.error === 'city_not_launched') {
        setCityNotLaunched(true);
      } else {
        setError(res.error);
      }
      if (pg === 1) setBuddies([]);
      return;
    }
    if (pg === 1) {
      setBuddies(res.data.buddies);
    } else {
      setBuddies(prev => [...prev, ...res.data.buddies]);
    }
    setTotal(res.data.total);
    setPage(pg);
  }, [city, cityLat, cityLng, category, sortBy, verifiedOnly, language, budget, rating, sessionMode]);

  useEffect(() => {
    if (city.trim().length > 1) load(1);
  }, [load]);

  const onSearch   = () => load(1);
  const onLoadMore = () => load(page + 1);
  const onRefresh  = () => { setRefreshing(true); load(1, true); };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.titleRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={{ padding: 4, marginRight: 4 }}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={s.title}>Find a Buddy</Text>
          {fromQuiz === '1' && (
            <View style={s.quizBadge}><Text style={s.quizBadgeText}>Quiz matched</Text></View>
          )}
        </View>

        {/* City search */}
        <View style={s.cityRow}>
          <MapPin size={15} color={color.signal} />
          <Pressable style={{ flex: 1 }} onPress={() => setCityPickerOpen(true)}>
            <Text style={[s.cityInput, !city && { color: color.mute }]} numberOfLines={1}>
              {city || 'City (e.g. Cebu)'}
            </Text>
          </Pressable>
          <Pressable style={s.searchBtn} onPress={onSearch}>
            <Search size={15} color={color.onInk} />
          </Pressable>
        </View>

        {/* Universal city picker — canonical Places with coords for proximity ranking */}
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
          }}
          mode="city"
          title="Find Buddies in…"
          usedFor="buddy_search"
        />

        {/* Category filter chips */}
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          style={s.chipsScroll} contentContainerStyle={s.chipsContent}
        >
          {CATEGORIES.map(c => (
            <Pressable
              key={c.key}
              style={[s.chip, category === c.key && s.chipActive]}
              onPress={() => setCategory(c.key)}
            >
              <Text style={[s.chipText, category === c.key && s.chipTextActive]}>{c.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* Sort + filter row */}
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          style={s.sortScroll} contentContainerStyle={s.sortContent}
        >
          {SORT_OPTIONS.map(opt => (
            <Pressable
              key={opt.key}
              style={[s.sortChip, sortBy === opt.key && s.sortChipActive]}
              onPress={() => setSortBy(opt.key)}
            >
              <Text style={[s.sortText, sortBy === opt.key && s.sortTextActive]}>{opt.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* Advanced filter toggle */}
        <Pressable
          style={s.filterToggleBtn}
          onPress={() => setFiltersOpen(o => !o)}
        >
          <SlidersHorizontal size={13} color={filtersOpen ? color.signal : color.mute} />
          <Text style={[s.filterToggleText, filtersOpen && { color: color.signal }]}>
            {filtersOpen ? 'Hide filters' : 'More filters'}
          </Text>
        </Pressable>

        {filtersOpen && (
          <View style={s.filterPanel}>
            {/* Language */}
            <Text style={s.filterLabel}>Language needed</Text>
            <TextInput
              style={s.filterInput}
              placeholder="e.g. English, Spanish…"
              placeholderTextColor={color.mute}
              value={language}
              onChangeText={setLanguage}
              returnKeyType="search"
              onSubmitEditing={onSearch}
            />

            {/* Rating */}
            <Text style={s.filterLabel}>Minimum rating</Text>
            <View style={s.budgetRow}>
              {RATING_OPTS.map((r, i) => (
                <Pressable
                  key={i}
                  style={[s.budgetChip, ratingIdx === i && s.budgetChipActive]}
                  onPress={() => setRatingIdx(i)}
                >
                  <Text style={[s.budgetText, ratingIdx === i && s.budgetTextActive]}>{r.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Session mode */}
            <Text style={s.filterLabel}>Session type</Text>
            <View style={s.budgetRow}>
              {SESSION_MODES.map((m) => (
                <Pressable
                  key={m.key}
                  style={[s.budgetChip, sessionMode === m.key && s.budgetChipActive]}
                  onPress={() => setSessionMode(m.key)}
                >
                  <Text style={[s.budgetText, sessionMode === m.key && s.budgetTextActive]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Budget */}
            <Text style={s.filterLabel}>Max budget</Text>
            <View style={s.budgetRow}>
              {BUDGET_OPTS.map((b, i) => (
                <Pressable
                  key={i}
                  style={[s.budgetChip, budgetIdx === i && s.budgetChipActive]}
                  onPress={() => setBudgetIdx(i)}
                >
                  <Text style={[s.budgetText, budgetIdx === i && s.budgetTextActive]}>{b.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* Verified only */}
            <View style={s.verifiedRow}>
              <Text style={s.filterLabel}>Verified buddies only</Text>
              <Switch
                value={verifiedOnly}
                onValueChange={setVerifiedOnly}
                trackColor={{ true: color.success, false: color.haze }}
                thumbColor={color.paperRaised}
              />
            </View>
          </View>
        )}

        {/* Quick actions */}
        <View style={s.quickActions}>
          <Pressable style={s.qaBtn} onPress={() => router.push('/(rent-a-buddy)/match-quiz' as any)}>
            <Sparkles size={14} color={color.deep} />
            <Text style={s.qaLabel}>Match Quiz</Text>
          </Pressable>
          <Pressable style={s.qaBtn} onPress={() => router.push('/(rent-a-buddy)/request-buddy' as any)}>
            <MapPin size={14} color={color.deep} />
            <Text style={s.qaLabel}>Open Request</Text>
          </Pressable>
        </View>
      </View>

      {/* Body */}
      {!city.trim() ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>🌍</Text>
          <Text style={s.emptyText}>Enter a city to find available Buddies nearby.</Text>
        </View>
      ) : loading ? (
        <TravelLoadingState label="Searching buddies…" />
      ) : error ? (
        <TravelErrorState title="Search failed" sub={error} onRetry={() => load(1)} />
      ) : cityNotLaunched ? (
        <View style={s.notLaunched}>
          <Text style={s.notLaunchedIcon}>🛫</Text>
          <Text style={s.notLaunchedTitle}>Not available in {city}</Text>
          <Text style={s.notLaunchedSub}>
            Rent a Buddy hasn't launched in this city yet. Post an open request and we'll notify you when Buddies become available.
          </Text>
          <Pressable style={s.waitlistBtn} onPress={() => router.push('/(rent-a-buddy)/request-buddy' as any)}>
            <Text style={s.waitlistBtnText}>Post an Open Request</Text>
          </Pressable>
        </View>
      ) : buddies.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>😔</Text>
          <Text style={s.emptyText}>No Buddies found. Try a different category or city.</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={[s.list, { paddingBottom: plainInset }]}
        >
          <Text style={s.resultCount}>{total} Buddies in {city}</Text>
          {buddies.map(buddy => (
            <BuddyCard
              key={buddy.id}
              buddy={buddy}
              availableNow={buddy.availableNow}
              onPress={() => router.push({ pathname: '/(rent-a-buddy)/buddy/[id]', params: { id: buddy.id } } as any)}
            />
          ))}
          {buddies.length < total && (
            <Pressable style={s.loadMoreBtn} onPress={onLoadMore} disabled={loadingMore}>
              {loadingMore
                ? <ActivityIndicator size="small" color={color.signal} />
                : <Text style={s.loadMoreText}>Load more</Text>}
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  title: { ...t.title, color: color.ink },
  quizBadge: { backgroundColor: `${color.deep}20`, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  quizBadgeText: { ...t.small, color: color.deep, fontWeight: '600' },

  cityRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, marginBottom: space.sm,
  },
  cityInput: { ...t.body, color: color.ink, flex: 1, paddingVertical: 10 },
  searchBtn: {
    backgroundColor: color.ink, borderRadius: radius.sm,
    padding: space.sm, alignItems: 'center', justifyContent: 'center',
  },

  chipsScroll: { marginBottom: space.sm },
  chipsContent: { gap: space.sm, paddingRight: space.md },
  chip: {
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: color.paperRaised,
  },
  chipActive: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive: { color: color.onInk },

  sortScroll: { marginBottom: space.xs },
  sortContent: { gap: space.xs, paddingRight: space.md },
  sortChip: {
    borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.sm, paddingVertical: 4, backgroundColor: color.paperRaised,
  },
  sortChipActive: { backgroundColor: color.signal, borderColor: color.signal },
  sortText: { fontSize: 10, color: color.mute, fontWeight: '600', fontFamily: 'Courier' },
  sortTextActive: { color: '#fff' },

  filterToggleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingVertical: space.xs, marginBottom: space.xs,
  },
  filterToggleText: { ...t.small, color: color.mute, fontWeight: '600' },

  filterPanel: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    padding: space.md, marginBottom: space.sm,
    borderWidth: 1, borderColor: color.haze,
  },
  filterLabel: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.xs, marginTop: space.sm },
  filterInput: {
    ...t.body, color: color.ink, backgroundColor: color.haze,
    borderRadius: radius.sm, padding: space.sm,
  },
  budgetRow: { flexDirection: 'row', gap: space.xs },
  budgetChip: {
    borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.sm, paddingVertical: 4, backgroundColor: color.paperRaised,
  },
  budgetChipActive: { backgroundColor: color.deep, borderColor: color.deep },
  budgetText: { fontSize: 10, color: color.mute, fontWeight: '600' },
  budgetTextActive: { color: '#fff' },
  verifiedRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginTop: space.sm,
  },

  quickActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs, marginBottom: space.xs },
  qaBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, padding: space.sm, backgroundColor: `${color.deep}12`,
    borderRadius: radius.md, borderWidth: 1, borderColor: `${color.deep}30`,
  },
  qaLabel: { ...t.small, color: color.deep, fontWeight: '600' },

  list: { padding: space.lg },
  resultCount: { ...t.small, color: color.mute, marginBottom: space.md },
  loadMoreBtn: {
    alignItems: 'center', padding: space.lg,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    marginTop: space.md,
  },
  loadMoreText: { ...t.body, color: color.signal, fontWeight: '600' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxxl },
  emptyIcon: { fontSize: 40, marginBottom: space.md },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },

  notLaunched: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxxl },
  notLaunchedIcon: { fontSize: 40, marginBottom: space.md },
  notLaunchedTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm, textAlign: 'center' },
  notLaunchedSub: { ...t.body, color: color.mute, textAlign: 'center', marginBottom: space.xl },
  waitlistBtn: {
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingHorizontal: space.xl, paddingVertical: space.md,
  },
  waitlistBtnText: { ...t.bodyStrong, color: color.onInk },
});
