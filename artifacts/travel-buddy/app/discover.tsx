import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, ActivityIndicator,
  Pressable, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { TravelerRow } from '../src/components/TravelerRow';
import { searchUsers, getSuggestedTravelers, type TravelerSearchResult } from '../src/services/follows';
import { color, space, radius, type as t } from '../src/theme/tokens';

export default function DiscoverScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TravelerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [suggestions, setSuggestions] = useState<TravelerSearchResult[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  // Load follow-back suggestions once on mount
  useEffect(() => {
    let alive = true;
    setLoadingSuggestions(true);
    getSuggestedTravelers(10).then((res) => {
      if (!alive) return;
      setSuggestions(res.data ?? []);
      setLoadingSuggestions(false);
    });
    return () => { alive = false; };
  }, []);

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

  const showEmpty = searched && !loading && results.length === 0;
  const showIdle = !searched && !loading && !query.trim();

  return (
    <View style={styles.root}>
      <ScreenHeader title="Find Travelers" back />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
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
              ListHeaderComponent={
                <Text style={styles.sectionHeader}>People you may know</Text>
              }
              ListFooterComponent={
                loadingSuggestions ? <ActivityIndicator color={color.signal} style={{ marginTop: space.lg }} /> : null
              }
              renderItem={({ item }) => <TravelerRow user={item} />}
            />
          ) : loadingSuggestions ? (
            <View style={styles.center}>
              <ActivityIndicator color={color.signal} />
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
            renderItem={({ item }) => <TravelerRow user={item} />}
          />
        )}
      </KeyboardAvoidingView>
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
  sectionHeader: {
    ...t.small,
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.sm,
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
});
