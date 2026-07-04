import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { Search, X, MapPin, Calendar, Hash, Users, ChevronRight } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { TravelerRow } from '../src/components/TravelerRow';
import { searchUsers, type TravelerSearchResult } from '../src/services/follows';
import { supabase, isSupabaseConfigured } from '../src/lib/supabase';
import { color, space, radius, type as t } from '../src/theme/tokens';

type SearchTab = 'people' | 'places' | 'events' | 'hashtags';

interface PlaceResult {
  id: string;
  name: string;
  city?: string;
  country?: string;
  category?: string;
  lat?: number;
  lng?: number;
}

interface EventResult {
  id: string;
  title: string;
  locationName?: string;
  startsAt?: string;
  city?: string;
  hostName?: string;
}

interface HashtagResult {
  tag: string;
  postCount?: number;
}

function apiBase(): string {
  return (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
}

async function freshToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function searchPlaces(query: string): Promise<PlaceResult[]> {
  if (!isSupabaseConfigured || !query.trim()) return [];
  try {
    const token = await freshToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = `${apiBase()}/api/places/search?q=${encodeURIComponent(query)}&limit=20`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.places ?? json.results ?? json ?? []) as PlaceResult[];
  } catch {
    return [];
  }
}

async function searchEvents(query: string): Promise<EventResult[]> {
  if (!isSupabaseConfigured || !query.trim()) return [];
  try {
    const token = await freshToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url = `${apiBase()}/api/events/search?q=${encodeURIComponent(query)}&limit=20`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.events ?? json.results ?? json ?? []) as EventResult[];
  } catch {
    return [];
  }
}

async function searchHashtags(query: string): Promise<HashtagResult[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const token = await freshToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const path = query.trim()
      ? `/api/hashtags/suggestions?q=${encodeURIComponent(query)}&limit=20`
      : `/api/hashtags/trending?limit=20`;
    const res = await fetch(`${apiBase()}${path}`, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    const list = json.hashtags ?? json.suggestions ?? json.trending ?? json ?? [];
    return (list as any[]).map((h: any) => ({
      tag: typeof h === 'string' ? h : (h.tag ?? h.name ?? h.hashtag ?? ''),
      postCount: h.postCount ?? h.count ?? undefined,
    })).filter((h) => h.tag);
  } catch {
    return [];
  }
}

const TABS: { key: SearchTab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
  { key: 'events', label: 'Events' },
  { key: 'hashtags', label: 'Hashtags' },
];

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SearchTab>('people');
  const [loading, setLoading] = useState(false);

  const [people, setPeople] = useState<TravelerSearchResult[]>([]);
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [events, setEvents] = useState<EventResult[]>([]);
  const [hashtags, setHashtags] = useState<HashtagResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const runSearch = useCallback(async (q: string, tab: SearchTab) => {
    const trimmed = q.trim();
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      if (tab === 'people') {
        const res = await searchUsers(trimmed);
        setPeople(res.data ?? []);
      } else if (tab === 'places') {
        const res = await searchPlaces(trimmed);
        setPlaces(res);
      } else if (tab === 'events') {
        const res = await searchEvents(trimmed);
        setEvents(res);
      } else {
        const res = await searchHashtags(trimmed);
        setHashtags(res);
      }
    } catch {
      setError('Something went wrong. Tap to retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmedLen = query.trim().length;

    if (activeTab === 'hashtags') {
      // 1 char: too short to search, too long for trending — show blank prompt
      if (trimmedLen === 1) {
        setHashtags([]);
        setSearched(false);
        setLoading(false);
        return;
      }
      // 0 chars → fetch trending; >= 2 chars → fetch suggestions
      setLoading(true);
      debounceRef.current = setTimeout(() => { runSearch(query, 'hashtags'); }, 300);
      return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }

    // Non-hashtag tabs: minimum 2 characters before any network request
    if (trimmedLen < 2) {
      setPeople([]);
      setPlaces([]);
      setEvents([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => { runSearch(query, activeTab); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, activeTab, runSearch]);

  function handleTabChange(tab: SearchTab) {
    setActiveTab(tab);
    setSearched(false);
  }

  function clearQuery() {
    setQuery('');
    setPeople([]);
    setPlaces([]);
    setEvents([]);
    setSearched(false);
    inputRef.current?.focus();
  }

  const isEmpty = searched && !loading && !error && (
    (activeTab === 'people' && people.length === 0) ||
    (activeTab === 'places' && places.length === 0) ||
    (activeTab === 'events' && events.length === 0) ||
    (activeTab === 'hashtags' && hashtags.length === 0)
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader title="Search" back />

      <View style={styles.searchBar}>
        <Search size={16} color={color.mute} />
        <TextInput
          ref={inputRef}
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search travelers, trips, events, places, or hashtags"
          placeholderTextColor={color.faint}
          autoFocus
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <Pressable onPress={clearQuery} hitSlop={8}>
            <X size={16} color={color.mute} />
          </Pressable>
        )}
      </View>

      <View style={styles.tabRow}>
        {TABS.map((tb) => (
          <Pressable
            key={tb.key}
            style={[styles.tab, activeTab === tb.key && styles.tabActive]}
            onPress={() => handleTabChange(tb.key)}
          >
            <Text style={[styles.tabText, activeTab === tb.key && styles.tabTextActive]}>
              {tb.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error ? (
        <Pressable style={styles.center} onPress={() => runSearch(query, activeTab)}>
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      ) : isEmpty ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptySub}>Try a different search term.</Text>
        </View>
      ) : !searched ? (
        <View style={styles.center}>
          <Search size={32} color={color.haze} />
          <Text style={styles.emptyTitle}>Search {activeTab}</Text>
          <Text style={styles.emptySub}>
            {activeTab === 'people' && 'Find travelers by name or @handle'}
            {activeTab === 'places' && 'Find cafes, beaches, venues, and more'}
            {activeTab === 'events' && 'Find events by name, city, or category'}
            {activeTab === 'hashtags' && 'Search hashtags'}
          </Text>
        </View>
      ) : (
        <>
          {activeTab === 'people' && (
            <FlatList
              data={people}
              keyExtractor={(i) => i.id}
              contentContainerStyle={{ paddingBottom: 100 }}
              renderItem={({ item }) => (
                <TravelerRow user={item} />
              )}
            />
          )}

          {activeTab === 'places' && (
            <FlatList
              data={places}
              keyExtractor={(i) => i.id}
              contentContainerStyle={{ paddingBottom: 100 }}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => router.push(`/destination/${item.id}` as any)}
                >
                  <View style={styles.rowIcon}>
                    <MapPin size={16} color={color.deep} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
                    {(item.city || item.category) && (
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {[item.category, item.city].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                  <ChevronRight size={14} color={color.faint} />
                </Pressable>
              )}
            />
          )}

          {activeTab === 'events' && (
            <FlatList
              data={events}
              keyExtractor={(i) => i.id}
              contentContainerStyle={{ paddingBottom: 100 }}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => router.push(`/event/${item.id}` as any)}
                >
                  <View style={styles.rowIcon}>
                    <Calendar size={16} color={color.deep} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                    {(item.locationName || item.city) && (
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {item.locationName ?? item.city}
                        {item.startsAt ? ` · ${new Date(item.startsAt).toLocaleDateString()}` : ''}
                      </Text>
                    )}
                  </View>
                  <ChevronRight size={14} color={color.faint} />
                </Pressable>
              )}
            />
          )}

          {activeTab === 'hashtags' && (
            <FlatList
              data={hashtags}
              keyExtractor={(i) => i.tag}
              contentContainerStyle={{ paddingBottom: 100 }}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => router.push(`/hashtag/${encodeURIComponent(item.tag)}` as any)}
                >
                  <View style={styles.rowIcon}>
                    <Hash size={16} color={color.deep} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>#{item.tag}</Text>
                    {item.postCount != null && (
                      <Text style={styles.rowSub}>{item.postCount} posts</Text>
                    )}
                  </View>
                  <ChevronRight size={14} color={color.faint} />
                </Pressable>
              )}
            />
          )}
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1.5,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    ...t.body,
    color: color.ink,
    padding: 0,
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    gap: space.xs,
    marginBottom: space.sm,
  },
  tab: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  tabText: { ...t.small, color: color.mute, fontWeight: '600' as const, fontSize: 12 },
  tabTextActive: { color: color.onInk },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  errorText: { ...t.body, color: color.signal, textAlign: 'center' },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '600' as const },
  rowSub: { ...t.small, color: color.mute, marginTop: 1 },
});
