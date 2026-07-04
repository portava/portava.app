import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { SearchResultCard } from '../src/components/search/SearchResultCard';
import { searchUnified } from '../src/services/discovery';
import type { UnifiedSearchResult } from '../src/services/discovery';
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

export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string; type?: string }>();

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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const activeQueryRef = useRef('');
  const activeTabRef = useRef<TabKey>('all');

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
      const res = await searchUnified(trimmed, tab, cursor);

      if (trimmed !== activeQueryRef.current || tab !== activeTabRef.current) return;

      if (!res.ok) {
        if (isFirstPage) setError(res.error);
        return;
      }

      const { results: newRows, nextCursor: newCursor } = res.data;

      if (isFirstPage) {
        setResults(newRows);
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
  }, []);

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

  const showTabs = query.trim().length >= 2;
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
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptySub}>Try a different search term or filter.</Text>
        </View>
      ) : !searched ? (
        <View style={styles.center}>
          <Search size={36} color={color.haze} />
          <Text style={styles.emptyTitle}>Search everything</Text>
          <Text style={styles.emptySub}>
            Find travelers, trips, events, places, and more
          </Text>
        </View>
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
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
    gap: space.xs,
    marginBottom: space.sm,
    flexWrap: 'nowrap',
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
});
