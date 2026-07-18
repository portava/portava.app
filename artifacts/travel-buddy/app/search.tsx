import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { KeyboardSafeScrollView } from '../src/components/ui/KeyboardSafeView';
import { useLocalSearchParams, router } from 'expo-router';
import { Search, X, Clock, Zap, MapPin, AlertCircle } from 'lucide-react-native';
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
import { CompassTravelerRow } from '../src/components/compass/CompassTravelerRow';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { NavBarFiller, useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { SearchSuggestionsPanel } from '../src/components/search/SearchSuggestionsPanel';
import { useSearchSuggestions } from '../src/hooks/useSearchSuggestions';
import { resolveRoute } from '../src/components/search/searchNav';

type TabKey = 'all' | 'travelers' | 'events' | 'trips' | 'places' | 'hashtags' | 'buddies';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all',       label: 'All' },
  { key: 'travelers', label: 'Travelers' },
  { key: 'events',    label: 'Events' },
  { key: 'trips',     label: 'Trips' },
  { key: 'places',    label: 'Places' },
  { key: 'buddies',   label: 'Buddies' },
  { key: 'hashtags',  label: 'Hashtags' },
];

const VALID_TAB_KEYS = new Set<string>(TABS.map((tb) => tb.key));

const RECOVERY_CHIPS_BASE = [
  'beach events',
  'hiking spots',
  'food & restaurants',
  'weekend activities',
];

export default function SearchScreen() {
  const params = useLocalSearchParams<{ q?: string; type?: string }>();
  const { locationState, requestLocation } = useActiveLocation();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [query, setQuery] = useState(params.q ?? '');
  const [activeTab, setActiveTab] = useState<TabKey>(
    VALID_TAB_KEYS.has(params.type ?? '') ? (params.type as TabKey) : 'all',
  );
  // suggest vs results mode: typing shows live grouped suggestions; a full
  // search runs only after an explicit submit (return key, "Search for" row,
  // tab tap, recent-search tap, or deep link ?q=). Typing again after a
  // submit returns to suggest mode.
  const [submitted, setSubmitted] = useState(!!params.q);

  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeLabel, setTimeLabel] = useState<string | null>(null);

  const [recentSearches, setRecentSearches] = useState<SearchHistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const activeQueryRef = useRef('');
  const activeTabRef = useRef<TabKey>('all');

  const locationGranted = locationState.permissionStatus === 'granted';

  // Pass user coords only when permission already granted — never prompt from search screen
  const userCoords = useMemo(() => {
    if (locationGranted && locationState.coords) {
      return {
        lat: locationState.coords.lat,
        lng: locationState.coords.lng,
        city: (locationState as any).place?.city ?? undefined,
      };
    }
    return undefined;
  }, [locationGranted, locationState]);

  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
  }, []);

  // Live typeahead — active only in suggest mode with a viable query
  const suggestActive = !submitted && query.trim().length >= 2;
  const { groups: suggestGroups, loading: suggestLoading } = useSearchSuggestions(query, {
    lat: userCoords?.lat,
    lng: userCoords?.lng,
    city: userCoords?.city,
    enabled: suggestActive,
  });

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
      setTimeLabel(null);
      setSearched(true);
      activeQueryRef.current = trimmed;
      activeTabRef.current = tab;
    } else {
      setLoadingMore(true);
    }

    try {
      const res = await searchUnified(trimmed, tab, cursor, { ...userCoords, tz });

      if (trimmed !== activeQueryRef.current || tab !== activeTabRef.current) return;

      if (!res.ok) {
        if (isFirstPage) setError(res.error);
        return;
      }

      const { results: newRows, nextCursor: newCursor, timeLabel: label } = res.data;

      if (isFirstPage) {
        setResults(newRows);
        setTimeLabel(label ?? null);

        if (newRows.length > 0) {
          // Optimistic-add with a temp id, then patch with the real server UUID
          // once the save resolves so that per-item deletion is reliable.
          const tempId = `local-${Date.now()}`;
          const newEntry: SearchHistoryEntry = {
            id: tempId,
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
          saveSearchHistory(trimmed, tab).then((serverId) => {
            if (serverId) {
              setRecentSearches((prev) =>
                prev.map((r) => r.id === tempId ? { ...r, id: serverId } : r),
              );
            }
          }).catch(() => {/* non-fatal */});
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
      setTimeLabel(null);
      return;
    }

    // Suggest mode: the typeahead hook owns fetching; no full search yet.
    if (!submitted) {
      setLoading(false);
      setSearched(false);
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
  }, [query, activeTab, runSearch, submitted]);

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab);
    setSubmitted(true); // tab tap while suggesting = run the full search scoped to it
    setResults([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
    setTimeLabel(null);
  }

  function clearQuery() {
    setQuery('');
    setSubmitted(false);
    activeQueryRef.current = ''; // invalidate in-flight search responses
    setResults([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
    setTimeLabel(null);
    inputRef.current?.focus();
  }

  function handleQueryChange(text: string) {
    setQuery(text);
    setSubmitted(false);
    // Invalidate any in-flight full search: its response guard compares
    // against activeQueryRef, so blanking it prevents a superseded request
    // from committing stale results/history while we're back in suggest mode.
    activeQueryRef.current = '';
  }

  const submitSearch = useCallback((q: string, tab?: TabKey) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    if (tab) setActiveTab(tab);
    setQuery(trimmed);
    setSubmitted(true);
  }, []);

  function handlePickRecent(entry: SearchHistoryEntry) {
    const tab = VALID_TAB_KEYS.has(entry.search_type) ? (entry.search_type as TabKey) : 'all';
    submitSearch(entry.query, tab);
  }

  // Tapping a suggestion navigates straight to the entity. The typed query
  // is saved to history (fire-and-forget) so it shows up under Recent.
  function handleSuggestionPick(result: UnifiedSearchResult) {
    const trimmed = query.trim();
    if (trimmed.length >= 2) {
      saveSearchHistory(trimmed, 'all').then((serverId) => {
        if (!serverId) return;
        setRecentSearches((prev) => {
          const deduped = prev.filter((r) => !(r.query === trimmed && r.search_type === 'all'));
          const entry: SearchHistoryEntry = {
            id: serverId, query: trimmed, search_type: 'all',
            searched_at: new Date().toISOString(),
          };
          return [entry, ...deduped].slice(0, 10);
        });
      }).catch(() => {/* non-fatal */});
    }
    const route = resolveRoute(result);
    if (route) {
      router.push(route as any);
    } else {
      submitSearch(trimmed);
    }
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

  // Delete by entry id (not query string) to avoid cross-type collisions
  async function handleClearOneHistory(entryId: string) {
    setRecentSearches((prev) => prev.filter((r) => r.id !== entryId));
    await clearSearchHistory(entryId);
  }

  async function handleClearAllHistory() {
    setRecentSearches([]);
    await clearSearchHistory();
  }

  const showTabs = query.trim().length >= 2;
  const showEmptyStart = !showTabs;
  const isEmpty = searched && !loading && !error && results.length === 0;

  // Detect "enable location" label from the API (returned when nearby intent + no coords)
  const needsLocationForNearby = timeLabel === 'Nearby (enable location)';

  // Build recovery chips — include "Search nearby" only when location is available
  const recoveryChips = useMemo(() => {
    const chips = [...RECOVERY_CHIPS_BASE];
    if (locationGranted) chips.unshift('travelers nearby');
    return chips;
  }, [locationGranted]);

  // Show FlatList result rows only in results mode; all other modes render via ListHeaderComponent
  const showResults = !suggestActive && !loading && !error && !isEmpty && !showEmptyStart;

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      <FlatList
        data={showResults ? results : []}
        keyExtractor={(item) => `${item.type}:${item.id}`}
        renderItem={({ item }) => (
          <SearchResultCard
            result={item}
            onActionStateChange={handleActionStateChange}
          />
        )}
        keyboardShouldPersistTaps="handled"
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={{ backgroundColor: color.paper }}>
            <ScreenHeader title="Search" back />

            {/* Search bar */}
            <View style={styles.searchBar}>
              <Search size={16} color={color.mute} />
              <TextInput
                ref={inputRef}
                style={styles.searchInput}
                value={query}
                onChangeText={handleQueryChange}
                onSubmitEditing={() => submitSearch(query)}
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

            {/* Filter tabs */}
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

            {/* Time/nearby label pill — shown below tabs when a filter is active */}
            {showTabs && timeLabel && !needsLocationForNearby && (
              <View style={styles.timeLabelRow}>
                <View style={styles.timeLabelPill}>
                  <Text style={styles.timeLabelText}>Showing · {timeLabel}</Text>
                </View>
              </View>
            )}

            {/* Location needed banner — shown when nearby search but no location permission */}
            {showTabs && needsLocationForNearby && (
              <Pressable style={styles.locationBanner} onPress={requestLocation}>
                <AlertCircle size={14} color={color.warn} />
                <Text style={styles.locationBannerText}>
                  Enable location to find nearby results
                </Text>
                <Text style={styles.locationBannerAction}>Enable</Text>
              </Pressable>
            )}

            {/* Content area — all non-results modes */}
            {suggestActive ? (
              <SearchSuggestionsPanel
                query={query}
                groups={suggestGroups}
                loading={suggestLoading}
                recentSearches={recentSearches}
                onSubmit={submitSearch}
                onPickRecent={handlePickRecent}
                onPickResult={handleSuggestionPick}
                onScroll={navBarScrollHandler}
              />
            ) : loading ? (
              <View style={styles.center}>
                <ActivityIndicator color={color.signal} />
              </View>
            ) : error ? (
              <Pressable style={styles.center} onPress={() => runSearch(query, activeTab)}>
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.retryHint}>Tap to retry</Text>
              </Pressable>
            ) : isEmpty ? (
              /* No results */
              <View style={[styles.center, { justifyContent: 'flex-start', paddingTop: space.xl }]}>
                <Text style={styles.emptyTitle}>No results found.</Text>
                <Text style={styles.emptySub}>
                  {timeLabel && !needsLocationForNearby
                    ? `Nothing matched "${query.trim()}" · ${timeLabel}. Try a different term or filter.`
                    : `Nothing matched "${query.trim()}". Try a different search term or filter.`}
                </Text>

                {/* Contextual recovery chips */}
                <View style={[styles.chipsRow, { marginTop: space.lg }]}>
                  {locationGranted && (
                    <Pressable
                      style={[styles.chip, styles.chipPrimary]}
                      onPress={() => submitSearch('travelers nearby')}
                    >
                      <MapPin size={12} color={color.onInk} />
                      <Text style={[styles.chipText, { color: color.onInk }]}>Search nearby</Text>
                    </Pressable>
                  )}
                  {!locationGranted && (
                    <Pressable
                      style={[styles.chip, styles.chipPrimary]}
                      onPress={requestLocation}
                    >
                      <MapPin size={12} color={color.onInk} />
                      <Text style={[styles.chipText, { color: color.onInk }]}>Enable location</Text>
                    </Pressable>
                  )}
                  <Pressable
                    style={styles.chip}
                    onPress={() => router.push('/(tabs)/ai' as any)}
                  >
                    <Zap size={12} color={color.signal} />
                    <Text style={styles.chipText}>Ask Compass</Text>
                  </Pressable>
                </View>

                <Text style={[styles.chipsLabel, { marginTop: space.xl }]}>Try searching for</Text>
                <View style={styles.chipsRow}>
                  {recoveryChips.slice(0, 4).map((chip) => (
                    <Pressable
                      key={chip}
                      style={styles.chip}
                      onPress={() => submitSearch(chip)}
                    >
                      <Text style={styles.chipText}>{chip}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : showEmptyStart ? (
              /* Pre-search — recent history + quick suggestions */
              <View>
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
                        key={item.id}
                        style={styles.historyRow}
                        onPress={() => handlePickRecent(item)}
                      >
                        <Clock size={14} color={color.mute} />
                        <Text style={styles.historyRowText} numberOfLines={1}>{item.query}</Text>
                        <Pressable hitSlop={8} onPress={() => handleClearOneHistory(item.id)}>
                          <X size={14} color={color.faint} />
                        </Pressable>
                      </Pressable>
                    ))}
                  </View>
                )}

                {/* When history has loaded but is empty: show nothing (blank canvas) */}
                {historyLoaded && recentSearches.length === 0 && (
                  <View style={[styles.center, { paddingVertical: space.xl }]}>
                    <Search size={36} color={color.haze} />
                  </View>
                )}

                {/* Suggestion chips — only shown when there is history to contextualise them */}
                {recentSearches.length > 0 && (
                  <View style={styles.historySection}>
                    <Text style={styles.historyTitle}>Try searching for</Text>
                    <View style={[styles.chipsRow, { marginTop: space.sm }]}>
                      {locationGranted && (
                        <Pressable style={[styles.chip, styles.chipPrimary]} onPress={() => submitSearch('travelers nearby')}>
                          <MapPin size={12} color={color.onInk} />
                          <Text style={[styles.chipText, { color: color.onInk }]}>Travelers nearby</Text>
                        </Pressable>
                      )}
                      {recoveryChips.map((chip) => (
                        <Pressable key={chip} style={styles.chip} onPress={() => submitSearch(chip)}>
                          <Zap size={12} color={color.signal} />
                          <Text style={styles.chipText}>{chip}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}

                {/* Compass traveler matches — below search suggestions */}
                <CompassTravelerRow city={userCoords?.city ?? null} limit={6} />
              </View>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <>
            {loadingMore ? (
              <View style={styles.loadingMore}>
                <ActivityIndicator size="small" color={color.signal} />
              </View>
            ) : null}
            <NavBarFiller />
          </>
        }
      />
    </KeyboardSafeScrollView>
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
  timeLabelRow: {
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  timeLabelPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,77,46,0.10)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  timeLabelText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600' as const,
  },
  locationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    backgroundColor: 'rgba(200,133,26,0.10)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(200,133,26,0.30)',
  },
  locationBannerText: {
    flex: 1,
    ...t.small,
    color: color.warn,
  },
  locationBannerAction: {
    ...t.small,
    fontWeight: '700' as const,
    color: color.warn,
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
  chipPrimary: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '500' as const,
  },
});
