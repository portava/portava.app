import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, ActivityIndicator,
  Pressable, StyleSheet, LayoutAnimation,
} from 'react-native';
import { KeyboardSafeScrollView } from '../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { Search, X, RefreshCw, Sparkles } from 'lucide-react-native';
import { AppHeader } from '../src/components/ui/AppHeader';
import { TravelerRow } from '../src/components/TravelerRow';
import { TravelerRowSkeleton } from '../src/components/TravelerRowSkeleton';
import { searchUsers, getSuggestedTravelers, clearSuggestionsSeen, type TravelerSearchResult } from '../src/services/follows';
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const loadSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    const res = await getSuggestedTravelers(10);
    const data = res.data ?? [];
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
    if (!q.trim()) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await searchUsers(q.trim());
    setLoading(false);
    setSearched(true);
    setResults(res.data ?? []);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
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

  const showEmpty = searched && !loading && results.length === 0;
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
          <View style={styles.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        )}

        {/* Idle state: show suggestions if available, otherwise placeholder */}
        {!loading && showIdle && (
          suggestions.length > 0 ? (
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
                      <TravelerRowSkeleton />
                      <TravelerRowSkeleton />
                    </View>
                  ) : null}
                  <PlainBottomFiller />
                </>
              }
              renderItem={({ item }) => (
                <TravelerRow user={item} onFollowed={handleSuggestionFollowed} />
              )}
            />
          ) : loadingSuggestions ? (
            <View style={styles.list}>
              <Text style={styles.sectionHeader}>People you may know</Text>
              <View style={{ gap: space.sm }}>
                <TravelerRowSkeleton />
                <TravelerRowSkeleton />
                <TravelerRowSkeleton />
              </View>
            </View>
          ) : hasHadSuggestions ? (
            <View style={styles.center}>
              <Text style={styles.idleIcon}>👥</Text>
              <Text style={styles.idleTitle}>You've seen everyone for now</Text>
              <Text style={styles.idleSub}>Refresh to discover new travelers</Text>
              <Pressable
                style={[styles.newFacesBtn, refreshingSuggestions && styles.newFacesBtnDisabled]}
                onPress={handleRefreshSuggestions}
                disabled={refreshingSuggestions}
              >
                {refreshingSuggestions ? (
                  <ActivityIndicator size="small" color={color.onInk} />
                ) : (
                  <>
                    <Sparkles size={14} color={color.onInk} />
                    <Text style={styles.newFacesBtnText}>See new faces</Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.idleIcon}>🌍</Text>
              <Text style={styles.idleTitle}>Find your next travel buddy</Text>
              <Text style={styles.idleSub}>Search by name or @username to discover travelers</Text>
            </View>
          )
        )}

        {!loading && showEmpty && (
          <View style={styles.center}>
            <Text style={styles.idleIcon}>🔍</Text>
            <Text style={styles.idleTitle}>No travelers found</Text>
            <Text style={styles.idleSub}>Try a different name or @username</Text>
          </View>
        )}

        {!loading && results.length > 0 && (
          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            onScroll={navBarScrollHandler}
            scrollEventThrottle={16}
            renderItem={({ item }) => <TravelerRow user={item} />}
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
