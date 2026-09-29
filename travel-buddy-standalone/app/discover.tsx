import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, ActivityIndicator,
  Pressable, StyleSheet, LayoutAnimation,
} from 'react-native';
import { KeyboardSafeScrollView } from '../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { Search, X, RefreshCw, Sparkles, Users } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { ProfileCard } from '../src/components/cards/ProfileCard';
import { ProfileSkeleton } from '../src/components/loading/ProfileSkeleton';
import { EmptyState } from '../src/components/ui/EmptyState';
import { ErrorState } from '../src/components/ui/ErrorState';
import { searchUsers, getSuggestedTravelers, clearSuggestionsSeen, followUser, unfollowUser, type TravelerSearchResult } from '../src/services/follows';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { useNavBarScrollHandler } from '../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

export default function DiscoverScreen() {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TravelerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [suggestions, setSuggestions] = useState<TravelerSearchResult[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [refreshingSuggestions, setRefreshingSuggestions] = useState(false);
  // Track whether suggestions were ever non-empty so we can distinguish
  // "user ran through the list" from "server returned nothing on first load".
  const [hasHadSuggestions, setHasHadSuggestions] = useState(false);
  // Optimistic follow overrides — Map<userId, isFollowing>; presence overrides server value
  const [followOverrides, setFollowOverrides] = useState<Map<string, boolean>>(new Map());
  // Optimistic request-pending overrides — Map<userId, pending>; for private accounts
  const [requestPendingOverrides, setRequestPendingOverrides] = useState<Map<string, boolean>>(new Map());
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  // census-discovery §106 (tm-people): a failed read is its own state, never an
  // empty list. `searchFailed` is the last search's read failing (network, a
  // db_error, the search stop's refusal); `suggestionsFailed` is the same for
  // "People you may know".
  const [searchFailed, setSearchFailed] = useState(false);
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  // The generation of the latest search. Every new query, clear or retry bumps
  // it; an answer for an older generation never writes the screen (the
  // DiscoveryCategoryTab loadIdRef pattern, D-W11X2-38).
  const searchSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const loadSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    setSuggestionsFailed(false);
    const res = await getSuggestedTravelers(10);
    if (!res.ok || !res.data) {
      // Not "you've seen everyone": the read failed, and the screen says so.
      setSuggestionsFailed(true);
      setLoadingSuggestions(false);
      return;
    }
    const data = res.data;
    setSuggestions(data);
    if (data.length > 0) setHasHadSuggestions(true);
    setLoadingSuggestions(false);
  }, []);

  // Load follow-back suggestions once on mount
  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const handleRefreshSuggestions = useCallback(async () => {
    if (refreshingSuggestions || loadingSuggestions) return;
    setRefreshingSuggestions(true);
    await clearSuggestionsSeen();
    await loadSuggestions();
    setRefreshingSuggestions(false);
  }, [refreshingSuggestions, loadingSuggestions, loadSuggestions]);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeqRef.current;
    setSearchFailed(false);
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await searchUsers(q.trim());
    // Only the latest request writes: a slower answer for an earlier query can
    // neither replace the later one's rows nor end its loading.
    if (seq !== searchSeqRef.current) return;
    setLoading(false);
    setSearched(true);
    if (!res.ok || !res.data) {
      // A failed read is not "No travelers found".
      setResults([]);
      setSearchFailed(true);
      return;
    }
    setResults(res.data);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // The query changed: whatever is in flight answers a question no longer asked.
    searchSeqRef.current++;
    setSearchFailed(false);
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      runSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  function handleClear() {
    setQuery('');
    setResults([]);
    setSearched(false);
    inputRef.current?.focus();
  }

  const handleSuggestionFollowed = useCallback((userId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSuggestions((prev) => prev.filter((s) => s.id !== userId));
  }, []);

  // Sends a follow request to a private account. The server converts the follow
  // call into a pending friend_request row. We track pending state locally so the
  // button immediately shows "Pending" and reverts on failure.
  const handleRequest = useCallback(async (userId: string, currentlyPending: boolean) => {
    if (currentlyPending || togglingIds.has(userId)) return;
    setTogglingIds((prev) => new Set([...prev, userId]));
    setRequestPendingOverrides((prev) => new Map(prev).set(userId, true));
    try {
      const res = await followUser(userId);
      if (!res.ok) {
        setRequestPendingOverrides((prev) => new Map(prev).set(userId, false));
      }
      // On success we leave pending=true (server confirmed the request)
    } catch {
      setRequestPendingOverrides((prev) => new Map(prev).set(userId, false));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }, [togglingIds]);

  const handleFollow = useCallback(async (userId: string, currentlyFollowing: boolean) => {
    if (togglingIds.has(userId)) return;
    setTogglingIds((prev) => new Set([...prev, userId]));
    // Optimistic update
    setFollowOverrides((prev) => new Map(prev).set(userId, !currentlyFollowing));
    try {
      const res = currentlyFollowing
        ? await unfollowUser(userId)
        : await followUser(userId);
      if (!res.ok) {
        // Service returned a non-throwing failure — revert optimistic update
        setFollowOverrides((prev) => new Map(prev).set(userId, currentlyFollowing));
        return;
      }
      // Only remove from suggestions once the server confirmed a follow
      if (!currentlyFollowing) {
        handleSuggestionFollowed(userId);
      }
    } catch {
      // Network-level throw — revert optimistic update
      setFollowOverrides((prev) => new Map(prev).set(userId, currentlyFollowing));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }, [togglingIds, handleSuggestionFollowed]);

  const showEmpty = searched && !loading && !searchFailed && results.length === 0;
  const showIdle = !searched && !loading && !query.trim();

  return (
    <View style={styles.root}>
      <AppHeader variant="detail" title="Find Travelers" onBack={router.back} />

      <KeyboardSafeScrollView>
        <View style={styles.searchRow}>
          <Search size={16} color={color.faint} style={styles.searchIcon} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Search by name or @username"
            placeholderTextColor={color.faint}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <Pressable onPress={handleClear} style={styles.clearBtn} hitSlop={8}>
              <X size={15} color={color.mute} />
            </Pressable>
          )}
        </View>

        {loading && (
          <View style={styles.list}>
            <ProfileSkeleton />
            <ProfileSkeleton />
            <ProfileSkeleton />
          </View>
        )}

        {/* Idle state: show suggestions if available, otherwise placeholder */}
        {!loading && showIdle && (
          suggestionsFailed && !loadingSuggestions ? (
            <View style={styles.center}>
              <ErrorState
                message="We couldn't load suggestions just now."
                onRetry={() => { void loadSuggestions(); }}
              />
            </View>
          ) : suggestions.length > 0 ? (
            <FlatList
              data={suggestions}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onScroll={navBarScrollHandler}
              scrollEventThrottle={16}
              ListHeaderComponent={
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionHeader}>People you may know</Text>
                  <Pressable
                    onPress={handleRefreshSuggestions}
                    hitSlop={8}
                    disabled={refreshingSuggestions || loadingSuggestions}
                    style={styles.sectionRefreshBtn}
                  >
                    {refreshingSuggestions ? (
                      <ActivityIndicator size="small" color={color.signal} />
                    ) : (
                      <RefreshCw size={14} color={color.signal} />
                    )}
                  </Pressable>
                </View>
              }
              ListFooterComponent={
                <>
                  {loadingSuggestions ? (
                    <View style={{ gap: space.sm, marginTop: space.sm }}>
                      <ProfileSkeleton />
                      <ProfileSkeleton />
                    </View>
                  ) : null}
                  <PlainBottomFiller />
                </>
              }
              renderItem={({ item }) => {
                const isFollowing = followOverrides.has(item.id) ? followOverrides.get(item.id)! : item.isFollowing;
                const requestPending = requestPendingOverrides.has(item.id) ? requestPendingOverrides.get(item.id)! : (item.friendRequestPending ?? false);
                return (
                  <ProfileCard
                    id={item.id}
                    displayName={item.displayName ?? item.username ?? 'Traveler'}
                    handle={item.username}
                    avatarUrl={item.avatarUrl}
                    isVerified={item.verified}
                    isFollowing={isFollowing}
                    isPrivate={item.isPrivate}
                    requestPending={requestPending}
                    onPress={() => router.push(`/u/${item.username ?? item.id}` as any)}
                    onFollow={item.isPrivate ? undefined : () => handleFollow(item.id, isFollowing)}
                    onRequest={item.isPrivate ? () => handleRequest(item.id, requestPending) : undefined}
                  />
                );
              }}
            />
          ) : loadingSuggestions ? (
            <View style={styles.list}>
              <Text style={styles.sectionHeader}>People you may know</Text>
              <View style={{ gap: space.sm }}>
                <ProfileSkeleton />
                <ProfileSkeleton />
                <ProfileSkeleton />
              </View>
            </View>
          ) : hasHadSuggestions ? (
            <View style={styles.center}>
              <EmptyState
                icon={Users}
                title="You've seen everyone for now"
                description="Refresh to discover new travelers"
                primaryAction={{
                  label: refreshingSuggestions ? '…' : 'See new faces',
                  onPress: handleRefreshSuggestions,
                }}
              />
            </View>
          ) : (
            <EmptyState
              icon={Users}
              title="Find your next travel buddy"
              description="Search by name or @username to discover travelers"
            />
          )
        )}

        {!loading && searchFailed && !!query.trim() && (
          <ErrorState
            message="We couldn't search travelers just now. Nothing was searched, so this doesn't mean no one matched."
            onRetry={() => { void runSearch(query); }}
          />
        )}

        {!loading && showEmpty && (
          <EmptyState
            icon={Users}
            title="No travelers found"
            description="Try a different name or @username"
          />
        )}

        {!loading && results.length > 0 && (
          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            onScroll={navBarScrollHandler}
            scrollEventThrottle={16}
            renderItem={({ item }) => {
              const isFollowing = followOverrides.has(item.id) ? followOverrides.get(item.id)! : item.isFollowing;
              const requestPending = requestPendingOverrides.has(item.id) ? requestPendingOverrides.get(item.id)! : (item.friendRequestPending ?? false);
              return (
                <ProfileCard
                  id={item.id}
                  displayName={item.displayName ?? item.username ?? 'Traveler'}
                  handle={item.username}
                  avatarUrl={item.avatarUrl}
                  isVerified={item.verified}
                  isFollowing={isFollowing}
                  isPrivate={item.isPrivate}
                  requestPending={requestPending}
                  onPress={() => router.push(`/u/${item.username ?? item.id}` as any)}
                  onFollow={item.isPrivate ? undefined : () => handleFollow(item.id, isFollowing)}
                  onRequest={item.isPrivate ? () => handleRequest(item.id, requestPending) : undefined}
                />
              );
            }}
            ListFooterComponent={<PlainBottomFiller />}
          />
        )}
      </KeyboardSafeScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.lg,
    marginVertical: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchIcon: {
    marginRight: space.sm,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: color.ink,
    height: '100%',
  },
  clearBtn: {
    padding: 4,
    marginLeft: space.sm,
  },
  list: {
    padding: space.lg,
    gap: space.sm,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  sectionHeader: {
    ...t.small,
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionRefreshBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.sm,
    paddingBottom: 60,
  },
  idleIcon: {
    fontSize: 48,
    marginBottom: space.sm,
  },
  idleTitle: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  idleSub: {
    fontSize: 13,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
  },
  newFacesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.signal,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    marginTop: space.sm,
    minWidth: 44,
    justifyContent: 'center',
  },
  newFacesBtnDisabled: {
    opacity: 0.5,
  },
  newFacesBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: color.onInk,
  },
});
