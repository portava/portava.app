import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, Sparkles, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../src/theme/tokens';
import { TravelErrorState, TravelLoadingState } from '../../src/components/primitives';
import { BuddyCard } from '../../src/components/BuddyCard';
import {
  searchBuddies, type BuddyProfile, type BuddyCategory,
} from '../../src/services/rentABuddy';

const CATEGORIES: { key: BuddyCategory | 'all'; label: string }[] = [
  { key: 'all',       label: 'All' },
  { key: 'city',      label: 'City Tour' },
  { key: 'arrival',   label: 'Arrival' },
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'food',      label: 'Food' },
  { key: 'language',  label: 'Language' },
  { key: 'content',   label: 'Content' },
];

const PER_PAGE = 10;

export default function Marketplace() {
  const insets = useSafeAreaInsets();
  const { fromQuiz, city: cityParam } = useLocalSearchParams<{ fromQuiz?: string; city?: string }>();

  const [city, setCity]                   = useState(cityParam ?? '');
  const [category, setCategory]           = useState<BuddyCategory | 'all'>('all');
  const [buddies, setBuddies]             = useState<BuddyProfile[]>([]);
  const [page, setPage]                   = useState(1);
  const [total, setTotal]                 = useState(0);
  const [loading, setLoading]             = useState(false);
  const [loadingMore, setLoadingMore]     = useState(false);
  const [refreshing, setRefreshing]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [cityNotLaunched, setCityNotLaunched] = useState(false);

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
      ...(category !== 'all' ? { category: category as BuddyCategory } : {}),
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
  }, [city, category]);

  useEffect(() => {
    if (city.trim().length > 1) load(1);
  }, [category]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch   = () => load(1);
  const onLoadMore = () => load(page + 1);
  const onRefresh  = () => { setRefreshing(true); load(1, true); };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.titleRow}>
          <Text style={s.title}>Find a Buddy</Text>
          {fromQuiz === '1' && (
            <View style={s.quizBadge}><Text style={s.quizBadgeText}>Quiz matched</Text></View>
          )}
        </View>

        {/* City search */}
        <View style={s.cityRow}>
          <MapPin size={15} color={color.signal} />
          <TextInput
            style={s.cityInput}
            placeholder="City (e.g. Cebu)"
            placeholderTextColor={color.mute}
            value={city}
            onChangeText={setCity}
            returnKeyType="search"
            onSubmitEditing={onSearch}
          />
          <Pressable style={s.searchBtn} onPress={onSearch}>
            <Search size={15} color={color.onInk} />
          </Pressable>
        </View>

        {/* Category filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.chipsScroll}
          contentContainerStyle={s.chipsContent}
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
          contentContainerStyle={s.list}
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

  quickActions: { flexDirection: 'row', gap: space.sm, marginBottom: space.xs },
  qaBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, padding: space.sm, backgroundColor: `${color.deep}12`,
    borderRadius: radius.md, borderWidth: 1, borderColor: `${color.deep}30`,
  },
  qaLabel: { ...t.small, color: color.deep, fontWeight: '600' },

  list: { padding: space.lg, paddingBottom: 100 },
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
