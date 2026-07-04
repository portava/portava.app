import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Search, X, Clock, Zap } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { SearchResultCard } from '../src/components/search/SearchResultCard';
import {
  searchUnified,
  getSearchHistory,
  saveSearchHistory,
  clearSearchHistory,
} from '../src/services/discovery';
import type { UnifiedSearchResult, SearchHistoryEntry } from '../src/services/discovery';
import { useActiveLocation } from '../src/hooks/useActiveLocation';
import { color, space, radius, type as t } from '../src/theme/tokens';

type TabKey = 'all' | 'travelers' | 'events' | 'trips' | 'places' | 'hashtags';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'travelers', label: 'Travelers' },
  { key: 'events', label: 'Events' },
  { key: 'trips', label: 'Trips' },
  { key: 'places', label: 'Places' },
  { key: 'hashtags', label: 'Hashtags' },
];

const VALID_TAB_KEYS = new Set<string>(TABS.map((tb) => tb.key));

const RECOVERY_CHIPS = [
  'travelers nearby',
  'beach events',
  'hiking spots',
  'food & restaurants',
  'weekend activities',
];

export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string; type?: string }>();
  const { locationState } = useActiveLocation();

  const [query, setQuery] = useState(params.q ?? '');
  const [activeTab, setActiveTab] = useState<TabKey>(
    VALID_TAB_KEYS.has(params.type ?? '') ? (params.type as TabKey) : 'all',
  );

  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recentSearches, setRecentSearches] = useState<SearchHistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const activeQueryRef = useRef('');
  const activeTabRef = useRef<TabKey>('all');

  // Pass user coords only when already granted — never prompt for location from the search screen.
  const userCoords = useMemo(() => {
    if (locationState.permissionStatus === 'granted' && locationState.coords) {
      return { lat: locationState.coords.lat, lng: locationState.coords.lng };
    }
    return undefined;
  }, [locationState.permissionStatus, locationState.coords]);

  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
  }, []);

  // Load recent searches on mount
  useEffect(() => {
    let alive = true;
    getSearchHistory(10).then((history) => {
      if (!alive) return;
      setRecentSearches(history);
      setHistoryLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const runSearch = useCallback(async (q: string, tab: TabKey, cursor?: string | null) => {
    const trimmed = q.trim();
    const isFirstPage = !cursor;

    if (isFirstPage) {
      setLoading(true);
      setError(null);
      setSearched(true);
      activeQueryRef.current = trimmed;
      activeTabRef.current = tab;
    } else {
      setLoadingMore(true);
    }

    try {
      const res = await searchUnified(trimmed, tab, cursor, { ...userCoords, tz });

      // Discard stale responses when query/tab changed mid-flight
      if (trimmed !== activeQueryRef.current || tab !== activeTabRef.current) return;

      if (!res.ok) {
        if (isFirstPage) setError(res.error);
        return;
      }

      const { results: newRows, nextCursor: newCursor } = res.data;

      if (isFirstPage) {
        setResults(newRows);
        // Optimistically update history list + persist to API
        if (newRows.length > 0) {
          void saveSearchHistory(trimmed, tab);
          const newEntry: SearchHistoryEntry = {
            id: `local-${Date.now()}`,
            query: trimmed,
            search_type: tab,
            searched_at: new Date().toISOString(),
          };
          setRecentSearches((prev) => {
            const deduped = prev.filter(
              (r) => !(r.query === trimmed && r.search_type === tab),
            );
            return [newEntry, ...deduped].slice(0, 10);
          });
        }
      } else {
        setResults((prev) => {
          const seen = new Set(prev.map((r) => `${r.type}:${r.id}`));
          return [...prev, ...newRows.filter((r) => !seen.has(`${r.type}:${r.id}`))];
        });
      }
      setNextCursor(newCursor);
    } catch {
      if (isFirstPage) setError('Something went wrong. Tap to retry.');
    } finally {
      if (isFirstPage) setLoading(false);
      else setLoadingMore(false);
    }
  }, [userCoords, tz]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmedLen = query.trim().length;

    if (trimmedLen < 2) {
      setResults([]);
      setNextCursor(null);
      setSearched(false);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      router.setParams({ q: query.trim(), type: activeTab });
      runSearch(query, activeTab);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, activeTab, runSearch]);

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab);
    setResults([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
  }

  function clearQuery() {
    setQuery('');
    setResults([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
    inputRef.current?.focus();
  }

  function handleLoadMore() {
    if (loadingMore || loading || !nextCursor) return;
    runSearch(query, activeTab, nextCursor);
  }

  function handleActionStateChange(resultId: string, updates: Record<string, boolean>) {
    setResults((prev) =>
      prev.map((r) =>
        r.id === resultId
          ? { ...r, actionState: { ...(r.actionState ?? {}), ...updates } }
          : r,
      ),
    );
  }

  async function handleClearOneHistory(q: string) {
    setRecentSearches((prev) => prev.filter((r) => r.query !== q));
    await clearSearchHistory(q);
  }

  async function handleClearAllHistory() {
    setRecentSearches([]);
    await clearSearchHistory();
  }

  const showTabs = query.trim().length >= 2;
  const showEmptyStart = !showTabs;
  const isEmpty = searched && !loading && !error && results.length === 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader title="Search" back />

      {/* Search bar */}
      <View style={styles.searchBar}>
        <Search size={16} color={color.mute} />
        <TextInput
          ref={inputRef}
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search travelers, trips, events, places…"
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

      {/* Filter tabs — only shown when query ≥ 2 chars */}
      {showTabs && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabScrollView}
          contentContainerStyle={styles.tabRow}
        >
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
        </ScrollView>
      )}

      {/* Content area */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error ? (
        <Pressable style={styles.center} onPress={() => runSearch(query, activeTab)}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retryHint}>Tap to retry</Text>
        </Pressable>
      ) : isEmpty ? (
        /* No results — show recovery chips */
        <ScrollView
          contentContainerStyle={[styles.center, { justifyContent: 'flex-start', paddingTop: space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.emptyTitle}>No results for "{query.trim()}"</Text>
          <Text style={styles.emptySub}>Try a different search term or filter.</Text>
          <Text style={[styles.chipsLabel, { marginTop: space.xl }]}>Try searching for</Text>
          <View style={styles.chipsRow}>
            {RECOVERY_CHIPS.map((chip) => (
              <Pressable
                key={chip}
                style={styles.chip}
                onPress={() => setQuery(chip)}
              >
                <Zap size={12} color={color.signal} />
                <Text style={styles.chipText}>{chip}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : showEmptyStart ? (
        /* Query empty — recent searches + suggestions */
        <ScrollView
          contentContainerStyle={{ paddingBottom: 100 }}
          keyboardShouldPersistTaps="handled"
        >
          {historyLoaded && recentSearches.length > 0 && (
            <View style={styles.historySection}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyTitle}>Recent</Text>
                <Pressable onPress={handleClearAllHistory} hitSlop={8}>
                  <Text style={styles.clearAll}>Clear all</Text>
                </Pressable>
              </View>
              {recentSearches.map((item) => (
                <Pressable
                  key={`${item.query}:${item.search_type}`}
                  style={styles.historyRow}
                  onPress={() => setQuery(item.query)}
                >
                  <Clock size={14} color={color.mute} />
                  <Text style={styles.historyRowText} numberOfLines={1}>{item.query}</Text>
                  <Pressable hitSlop={8} onPress={() => handleClearOneHistory(item.query)}>
                    <X size={14} color={color.faint} />
                  </Pressable>
                </Pressable>
              ))}
            </View>
          )}

          {(!historyLoaded || recentSearches.length === 0) && (
            <View style={[styles.center, { paddingVertical: space.xl }]}>
              <Search size={36} color={color.haze} />
              <Text style={styles.emptyTitle}>Search everything</Text>
              <Text style={styles.emptySub}>
                Find travelers, trips, events, places, and more
              </Text>
            </View>
          )}

          {/* Quick suggestions */}
          <View style={styles.historySection}>
            <Text style={styles.historyTitle}>Try searching for</Text>
            <View style={[styles.chipsRow, { marginTop: space.sm }]}>
              {RECOVERY_CHIPS.map((chip) => (
                <Pressable key={chip} style={styles.chip} onPress={() => setQuery(chip)}>
                  <Zap size={12} color={color.signal} />
                  <Text style={styles.chipText}>{chip}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.type}:${item.id}`}
          renderItem={({ item }) => (
            <SearchResultCard
              result={item}
              onActionStateChange={handleActionStateChange}
            />
          )}
          contentContainerStyle={{ paddingBottom: 100 }}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.loadingMore}>
                <ActivityIndicator size="small" color={color.signal} />
              </View>
            ) : null
          }
        />
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
  tabScrollView: {
    marginBottom: space.sm,
    flexGrow: 0,
  },
  tabRow: {
    paddingHorizontal: space.lg,
    gap: space.xs,
    flexDirection: 'row',
  },
  tab: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  tabText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 12,
    fontWeight: '600' as const,
  },
  tabTextActive: {
    color: color.onInk,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.signal,
    textAlign: 'center',
  },
  retryHint: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  emptySub: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
  },
  loadingMore: {
    paddingVertical: space.xl,
    alignItems: 'center',
  },
  historySection: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  historyTitle: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  clearAll: {
    ...t.small,
    color: color.signal,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  historyRowText: {
    flex: 1,
    ...t.body,
    color: color.ink,
  },
  chipsLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingHorizontal: space.lg,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '500' as const,
  },
});
