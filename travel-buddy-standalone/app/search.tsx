import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { KeyboardSafeScrollView } from '../src/components/ui/KeyboardSafeView';
import { useLocalSearchParams, router } from 'expo-router';
import { Search, X, Clock, Zap, MapPin, AlertCircle, Sparkles, PlusCircle } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { SearchResultCard } from '../src/components/search/SearchResultCard';
import {
  searchUnified,
  getSearchHistory,
  saveSearchHistory,
  clearSearchHistory,
} from '../src/services/discovery';
import type { UnifiedSearchResult, SearchHistoryEntry } from '../src/services/discovery';
import { fetchCompassRecommendations } from '../src/services/compass';
import type { CompassRecommendation } from '../src/services/compass';
import { CompassTravelerRow } from '../src/components/compass/CompassTravelerRow';
import { useActiveLocation } from '../src/hooks/useActiveLocation';
import { parseSearchIntent, intentSummary } from '../src/lib/compassIntent';
import { SearchSuggestionsPanel } from '../src/components/search/SearchSuggestionsPanel';
import { useGlobalSearchSuggestions } from '../src/hooks/useGlobalSearchSuggestions';
import { getSubmitQuery } from '../src/platform/input-assistance/search/globalSearch';
import { getAddToTripTarget } from '../src/platform/input-assistance/search/smartActions';
import type { InputSuggestion } from '../src/platform/input-assistance/types/inputSuggestion';
import { TripWishlistPicker, type AddToTripPayload } from '../src/components/discovery/TripWishlistPicker';
import { usePlainBottomInset } from '../src/hooks/useBottomInset';
import { resolveRoute } from '../src/components/search/searchNav';
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

const RECOVERY_CHIPS_BASE = [
  'beach events',
  'hiking spots',
  'food & restaurants',
  'weekend activities',
];

// ── Follow-up filter chips ─────────────────────────────────────────────────────
// params are forwarded to searchUnified as intentParams (server-side application).

interface FollowUpChip {
  key: string;
  label: string;
  /** Extra intent params sent to the backend when this chip is active. */
  params: Record<string, string>;
  /** If set, switch the active tab to this value instead of sending params. */
  switchTab?: TabKey;
}

const FOLLOW_UP_CHIPS: FollowUpChip[] = [
  { key: 'verified',  label: 'Only verified',      params: { intentSafety: 'true' } },
  { key: 'social',    label: 'More social',         params: { intentSocial: 'group' } },
  { key: 'tonight',   label: 'Tonight only',        params: { intentTime: 'tonight' } },
  { key: 'solo',      label: 'Good for solo',       params: { intentSocial: 'solo' } },
  { key: 'cheaper',   label: 'Cheaper options',     params: { intentBudget: 'budget' } },
  { key: 'buddies',   label: 'Show me buddies',     params: {}, switchTab: 'travelers' },
];

// Build the merged intentParams for a given detectedIntent + active chips
function buildIntentParams(
  intent: ReturnType<typeof parseSearchIntent>,
  activeChips: Set<string>,
): Record<string, string> {
  const p: Record<string, string> = {};
  if (intent.category)     p.intentCategory    = intent.category;
  if (intent.social)       p.intentSocial      = intent.social;
  if (intent.safetyBoost)  p.intentSafety      = 'true';
  if (intent.locationHint) p.intentLocationHint = intent.locationHint;

  for (const chipKey of activeChips) {
    const chip = FOLLOW_UP_CHIPS.find((c) => c.key === chipKey);
    if (chip) Object.assign(p, chip.params);
  }
  return p;
}

export default function SearchScreen() {
  const plainInset = usePlainBottomInset();
  const params = useLocalSearchParams<{ q?: string; type?: string }>();
  const { locationState, requestLocation } = useActiveLocation();

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

  // ── Intent state ────────────────────────────────────────────────────────────
  const [detectedIntent, setDetectedIntent] = useState<ReturnType<typeof parseSearchIntent>>({});

  // ── Compass no-results fallback state ───────────────────────────────────────
  const [compassFallback, setCompassFallback] = useState<CompassRecommendation[]>([]);
  const [compassFallbackLoading, setCompassFallbackLoading] = useState(false);

  // ── Active follow-up chips — reset when query or tab changes ───────────────
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set());

  const [recentSearches, setRecentSearches] = useState<SearchHistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const activeQueryRef = useRef('');
  const activeTabRef = useRef<TabKey>('all');

  const locationGranted = locationState.permissionStatus === 'granted';

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

  // Live typeahead — active only in suggest mode with a viable query.
  // Routes through the P1 gateway (`global_search`) additively: gateway rows are
  // shown when available, else it degrades to the proven legacy typeahead.
  const suggestActive = !submitted && query.trim().length >= 2;
  const { groups: suggestGroups, actionSuggestions, loading: suggestLoading } = useGlobalSearchSuggestions(query, {
    lat: userCoords?.lat,
    lng: userCoords?.lng,
    city: userCoords?.city,
    tz,
    surface: 'search',
    enabled: suggestActive,
  });

  useEffect(() => {
    let alive = true;
    getSearchHistory(10).then((history) => {
      if (!alive) return;
      setRecentSearches(history);
      setHistoryLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  /**
   * runSearch — fires the search and handles state updates.
   * @param q        Trimmed search query
   * @param tab      Active tab
   * @param cursor   Pagination cursor (first page when null/undefined)
   * @param intentOverride  Override intentParams (e.g. when a chip is toggled)
   */
  const runSearch = useCallback(async (
    q: string,
    tab: TabKey,
    cursor?: string | null,
    intentOverride?: Record<string, string>,
  ) => {
    const trimmed = q.trim();
    const isFirstPage = !cursor;

    if (isFirstPage) {
      setLoading(true);
      setError(null);
      setTimeLabel(null);
      setSearched(true);
      setCompassFallback([]);
      activeQueryRef.current = trimmed;
      activeTabRef.current = tab;
    } else {
      setLoadingMore(true);
    }

    try {
      // Compute intentParams from the current parsed intent + active chips
      // intentOverride is used when chips trigger a re-query so the caller
      // can pass the just-updated chip set before React re-render flushes it.
      const currentIntent = intentOverride !== undefined
        ? intentOverride
        : buildIntentParams(parseSearchIntent(trimmed), activeChips);

      const res = await searchUnified(trimmed, tab, cursor, {
        ...userCoords,
        tz,
        intentParams: Object.keys(currentIntent).length > 0 ? currentIntent : undefined,
      });

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
          }).catch(() => {});
        } else {
          // No results for any query — always fire Compass fallback regardless of active intent/chips
          const intent = parseSearchIntent(trimmed);
          setCompassFallbackLoading(true);
          fetchCompassRecommendations({
            surface: 'search',
            q: trimmed,
            city: intent.locationHint ?? userCoords?.city,
            limit: 6,
          }).then((cr) => {
            if (trimmed !== activeQueryRef.current) return;
            setCompassFallback(cr.ok && cr.data ? cr.data.recommendations : []);
          }).catch(() => {}).finally(() => {
            setCompassFallbackLoading(false);
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
  }, [userCoords, tz, activeChips]);

  // Debounce search trigger when query or tab changes
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
      setDetectedIntent({});
      setCompassFallback([]);
      setActiveChips(new Set());
      return;
    }

    // Suggest mode: the typeahead hook owns fetching; still parse intent so
    // the "Compass understood" pill assists while the user types.
    if (!submitted) {
      setLoading(false);
      setSearched(false);
      setError(null);
      setDetectedIntent(parseSearchIntent(query));
      setActiveChips(new Set());
      return;
    }

    // Parse intent immediately (synchronous — shows pill without delay)
    const intent = parseSearchIntent(query);
    setDetectedIntent(intent);
    // Reset chips when query changes
    setActiveChips(new Set());

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      router.setParams({ q: query.trim(), type: activeTab });
      runSearch(query, activeTab, null, buildIntentParams(intent, new Set()));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeTab, submitted]);

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab);
    setSubmitted(true); // tab tap while suggesting = run the full search scoped to it
    setResults([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
    setTimeLabel(null);
    setCompassFallback([]);
    setActiveChips(new Set());
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
    setDetectedIntent({});
    setCompassFallback([]);
    setActiveChips(new Set());
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
    // Query-completion rows ("SEARCH FOR …", §13/§43 submit_search) carry the
    // search text to run; entity rows route via the shared resolveRoute (§43).
    const submitQuery = getSubmitQuery(result);
    if (submitQuery) {
      submitSearch(submitQuery);
      return;
    }
    const route = resolveRoute(result);
    if (route) {
      router.push(route as any);
    } else {
      submitSearch(trimmed);
    }
  }

  // §21 smart-action dispatch. An action chip PROPOSES; the write happens behind
  // the target flow's own authorization (§47). `add_to_trip` opens the existing
  // propose-only trip picker (user confirms which trip). Unknown/unhandled
  // actions are a no-op — the chip lane already filters to dispatchable actions,
  // so this never renders a dead chip and never throws.
  const [addToTripPayload, setAddToTripPayload] = useState<AddToTripPayload | null>(null);

  function handleSuggestionAction(suggestion: InputSuggestion) {
    const target = getAddToTripTarget(suggestion);
    if (target) {
      setAddToTripPayload({
        id: target.entityId,
        name: target.city,
        category: 'city',
        type: 'city',
        address: target.country,
        // A city destination has no exact point to save — the trip picker
        // stores name/identity only (privacy-safe, §21 propose-only).
        lat: null,
        lng: null,
      });
    }
  }

  function handleLoadMore() {
    if (loadingMore || loading || !nextCursor) return;
    const currentIntent = buildIntentParams(detectedIntent, activeChips);
    runSearch(query, activeTab, nextCursor, currentIntent);
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

  async function handleClearOneHistory(entryId: string) {
    setRecentSearches((prev) => prev.filter((r) => r.id !== entryId));
    await clearSearchHistory(entryId);
  }

  async function handleClearAllHistory() {
    setRecentSearches([]);
    await clearSearchHistory();
  }

  function handleChipToggle(chip: FollowUpChip) {
    // Tab-switch chip — no intent params, just change the tab
    if (chip.switchTab) {
      handleTabChange(chip.switchTab);
      return;
    }

    const nextChips = new Set(activeChips);
    if (nextChips.has(chip.key)) {
      nextChips.delete(chip.key);
    } else {
      nextChips.add(chip.key);
    }
    setActiveChips(nextChips);

    // Re-query the backend with the updated chip set (server-side filtering)
    if (query.trim().length >= 2) {
      const mergedIntent = buildIntentParams(detectedIntent, nextChips);
      runSearch(query, activeTab, null, mergedIntent);
    }
  }

  const showTabs   = query.trim().length >= 2;
  const showEmptyStart = !showTabs;
  const isEmpty    = searched && !loading && !error && results.length === 0;

  const needsLocationForNearby = timeLabel === 'Nearby (enable location)';

  const recoveryChips = useMemo(() => {
    const chips = [...RECOVERY_CHIPS_BASE];
    if (locationGranted) chips.unshift('travelers nearby');
    return chips;
  }, [locationGranted]);

  const compassUnderstood = useMemo(() => intentSummary(detectedIntent), [detectedIntent]);

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
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

      {/* "Compass understood" summary pill */}
      {showTabs && compassUnderstood && !loading && (
        <View style={styles.intentRow}>
          <View style={styles.intentPill}>
            <Sparkles size={10} color={color.signal} />
            <Text style={styles.intentText}>Compass understood: {compassUnderstood}</Text>
          </View>
        </View>
      )}

      {/* Time/nearby label pill */}
      {showTabs && timeLabel && !needsLocationForNearby && !compassUnderstood && (
        <View style={styles.timeLabelRow}>
          <View style={styles.timeLabelPill}>
            <Text style={styles.timeLabelText}>Showing · {timeLabel}</Text>
          </View>
        </View>
      )}

      {/* Location needed banner */}
      {showTabs && needsLocationForNearby && (
        <Pressable style={styles.locationBanner} onPress={requestLocation}>
          <AlertCircle size={14} color={color.warn} />
          <Text style={styles.locationBannerText}>
            Enable location to find nearby results
          </Text>
          <Text style={styles.locationBannerAction}>Enable</Text>
        </Pressable>
      )}

      {/* Content area */}
      {suggestActive ? (
        <SearchSuggestionsPanel
          query={query}
          groups={suggestGroups}
          loading={suggestLoading}
          recentSearches={recentSearches}
          onSubmit={submitSearch}
          onPickRecent={handlePickRecent}
          onPickResult={handleSuggestionPick}
          actionSuggestions={actionSuggestions}
          onPickAction={handleSuggestionAction}
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
        /* No results — show Compass fallback + recovery chips */
        <ScrollView
          contentContainerStyle={[styles.center, { justifyContent: 'flex-start', paddingTop: space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.emptyTitle}>No results found.</Text>
          <Text style={styles.emptySub}>
            {timeLabel && !needsLocationForNearby
              ? `Nothing matched "${query.trim()}" · ${timeLabel}. Try a different term or filter.`
              : `Nothing matched "${query.trim()}". Try a different search term or filter.`}
          </Text>

          {/* Compass fallback section */}
          {(compassFallbackLoading || compassFallback.length > 0) && (
            <View style={styles.compassFallbackSection}>
              <View style={styles.compassFallbackHeader}>
                <Sparkles size={13} color={color.signal} />
                <Text style={styles.compassFallbackTitle}>Compass Suggestions</Text>
              </View>
              {compassFallbackLoading ? (
                <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.lg }} />
              ) : (
                compassFallback.map((rec) => (
                  <View key={rec.id} style={styles.compassFallbackCard}>
                    <View style={styles.compassFallbackTypeRow}>
                      <Text style={styles.compassFallbackType}>{rec.category || rec.type}</Text>
                    </View>
                    <Text style={styles.compassFallbackCardTitle} numberOfLines={2}>
                      {rec.title ?? rec.type}
                    </Text>
                    {rec.reason ? (
                      <Text style={styles.compassFallbackReason} numberOfLines={2}>{rec.reason}</Text>
                    ) : null}
                  </View>
                ))
              )}

              {/* Create Instead chips */}
              <Text style={styles.createInsteadLabel}>Create Instead</Text>
              <View style={styles.chipsRow}>
                <Pressable
                  style={styles.chip}
                  onPress={() => router.push('/create' as any)}
                >
                  <PlusCircle size={12} color={color.signal} />
                  <Text style={styles.chipText}>Create Event</Text>
                </Pressable>
                <Pressable
                  style={styles.chip}
                  onPress={() => router.push('/(tabs)/ai' as any)}
                >
                  <Sparkles size={12} color={color.signal} />
                  <Text style={styles.chipText}>Post in Pulse</Text>
                </Pressable>
                <Pressable
                  style={styles.chip}
                  onPress={() => handleTabChange('travelers')}
                >
                  <Zap size={12} color={color.signal} />
                  <Text style={styles.chipText}>Find Buddies</Text>
                </Pressable>
                <Pressable
                  style={styles.chip}
                  onPress={() => {
                    // Strip location hint from current query and let user type a new city
                    const stripped = query.replace(/\bin\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)*/g, '').trim();
                    setQuery(stripped.length >= 2 ? stripped : query);
                    router.push('/(tabs)/discovery' as any);
                  }}
                >
                  <MapPin size={12} color={color.signal} />
                  <Text style={styles.chipText}>Choose Another City</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Recovery chips when no Compass fallback */}
          {compassFallback.length === 0 && !compassFallbackLoading && (
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
          )}

          {compassFallback.length === 0 && !compassFallbackLoading && (
            <>
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
            </>
          )}
        </ScrollView>
      ) : showEmptyStart ? (
        /* Pre-search — recent history + quick suggestions */
        <ScrollView
          contentContainerStyle={{ paddingBottom: plainInset }}
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

          {historyLoaded && recentSearches.length === 0 && (
            <View style={[styles.center, { paddingVertical: space.xl, gap: space.sm }]}>
              <Search size={36} color={color.haze} />
              <Text style={{ ...t.small, color: color.mute, textAlign: 'center' }}>
                No search history yet — try searching for a traveler, trip, or place.
              </Text>
            </View>
          )}

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
        </ScrollView>
      ) : (
        /* Results list */
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.type}:${item.id}`}
          renderItem={({ item }) => (
            <SearchResultCard
              result={item}
              onActionStateChange={handleActionStateChange}
            />
          )}
          contentContainerStyle={{ paddingBottom: plainInset }}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.loadingMore}>
                <ActivityIndicator size="small" color={color.signal} />
              </View>
            ) : results.length > 0 ? (
              /* Follow-up filter chips — re-query backend when toggled */
              <View style={styles.followUpSection}>
                <Text style={styles.followUpLabel}>Refine results</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.followUpRow}
                >
                  {FOLLOW_UP_CHIPS.map((chip) => {
                    const isActive = activeChips.has(chip.key);
                    return (
                      <Pressable
                        key={chip.key}
                        style={[styles.chip, isActive && styles.chipActive]}
                        onPress={() => handleChipToggle(chip)}
                      >
                        <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                          {chip.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null
          }
        />
      )}

      {/* §21 propose-only add-to-trip flow, opened by a smart-action chip. The
          picker itself performs the authorized write when the user picks a trip. */}
      <TripWishlistPicker
        place={addToTripPayload}
        visible={!!addToTripPayload}
        onClose={() => setAddToTripPayload(null)}
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
  intentRow: {
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  intentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    backgroundColor: color.signal + '12',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: color.signal + '25',
  },
  intentText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600' as const,
    fontSize: 11,
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
  compassFallbackSection: {
    width: '100%',
    marginTop: space.xl,
    alignItems: 'flex-start',
  },
  compassFallbackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginBottom: space.md,
  },
  compassFallbackTitle: {
    ...t.stamp,
    color: color.ink,
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
    textTransform: 'uppercase' as const,
  },
  compassFallbackCard: {
    width: '100%',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
    marginBottom: space.sm,
  },
  compassFallbackTypeRow: {
    flexDirection: 'row',
  },
  compassFallbackType: {
    ...t.small,
    color: color.signal,
    fontSize: 9,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    backgroundColor: color.signal + '15',
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  compassFallbackCardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
  },
  compassFallbackReason: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    fontStyle: 'italic',
  },
  createInsteadLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    marginTop: space.lg,
    marginBottom: space.sm,
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
  chipActive: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '500' as const,
  },
  chipTextActive: {
    color: color.onInk,
  },
  followUpSection: {
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
  followUpLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  followUpRow: {
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
});
