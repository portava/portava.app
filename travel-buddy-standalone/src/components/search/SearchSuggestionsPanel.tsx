/**
 * SearchSuggestionsPanel — grouped live suggestions under the global search bar.
 *
 * Shown while the user is typing (before they submit a full search). Renders:
 *   1. "Search for «q»" row — always first, submits the full search.
 *   2. Matching recent searches (client-filtered prefix matches).
 *   3. Grouped entity suggestions from /api/discovery/suggest, each group
 *      labelled with the shared per-type icon so users can tell at a glance
 *      whether a row is a person, city, Gem, event, trip, hashtag, or place.
 *
 * Progressive: previous suggestions stay visible while newer ones load
 * (thin spinner in the "Search for" row signals activity). Taps navigate
 * via the same resolveRoute used by full search results.
 */
import React from 'react';
import {
  View, Text, ScrollView, Pressable, Image, StyleSheet, ActivityIndicator,
  type NativeSyntheticEvent, type NativeScrollEvent, type ImageStyle,
} from 'react-native';
import { Search, Clock } from 'lucide-react-native';
import { TypeIcon } from './searchNav.tsx';
import type { SuggestGroup } from '../../services/discovery.ts';
import type { UnifiedSearchResult, SearchHistoryEntry } from '../../services/discovery.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { NavBarFiller } from '../../hooks/useNavBarCollapse.ts';

interface Props {
  query: string;
  groups: SuggestGroup[];
  loading: boolean;
  recentSearches: SearchHistoryEntry[];
  onSubmit: (q: string) => void;
  onPickRecent: (entry: SearchHistoryEntry) => void;
  onPickResult: (result: UnifiedSearchResult) => void;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

function SuggestionAvatar({ item }: { item: UnifiedSearchResult }) {
  const uri = item.avatarUrl ?? item.imageUrl;
  if (uri) {
    return <Image source={{ uri }} style={styles.avatar as ImageStyle} />;
  }
  return (
    <View style={styles.avatarFallback}>
      {item.fallbackInitials ? (
        <Text style={styles.avatarInitials}>{item.fallbackInitials}</Text>
      ) : (
        <TypeIcon type={item.type} size={13} tint={color.mute} />
      )}
    </View>
  );
}

export function SearchSuggestionsPanel({
  query, groups, loading, recentSearches,
  onSubmit, onPickRecent, onPickResult, onScroll,
}: Props) {
  const trimmed = query.trim();
  const qLower = trimmed.toLowerCase();

  const matchingRecent = recentSearches
    .filter((r) => {
      const rq = r.query.toLowerCase();
      return rq !== qLower && rq.startsWith(qLower);
    })
    .slice(0, 3);

  const hasAny = groups.some((g) => g.items.length > 0);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 100 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      {/* Always-first: run the full search */}
      <Pressable style={styles.searchForRow} onPress={() => onSubmit(trimmed)}>
        <View style={styles.searchForIcon}>
          <Search size={14} color={color.onInk} />
        </View>
        <Text style={styles.searchForText} numberOfLines={1}>
          Search for “<Text style={styles.searchForQuery}>{trimmed}</Text>”
        </Text>
        {loading && <ActivityIndicator size="small" color={color.mute} />}
      </Pressable>

      {/* Matching recent searches */}
      {matchingRecent.map((entry) => (
        <Pressable key={entry.id} style={styles.row} onPress={() => onPickRecent(entry)}>
          <View style={styles.avatarFallback}>
            <Clock size={13} color={color.mute} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              <Text style={styles.rowTitleBold}>{entry.query.slice(0, trimmed.length)}</Text>
              {entry.query.slice(trimmed.length)}
            </Text>
            <Text style={styles.rowSub} numberOfLines={1}>Recent search</Text>
          </View>
        </Pressable>
      ))}

      {/* Grouped entity suggestions */}
      {groups.map((group) => group.items.length === 0 ? null : (
        <View key={group.type}>
          <View style={styles.groupHeader}>
            <TypeIcon type={group.type} size={12} tint={color.mute} />
            <Text style={styles.groupLabel}>{group.label}</Text>
          </View>
          {group.items.map((item) => (
            <Pressable
              key={`${item.type}:${item.id}`}
              style={styles.row}
              onPress={() => onPickResult(item)}
            >
              <SuggestionAvatar item={item} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                {(item.subtitle || item.locationPreview) && (
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {[item.subtitle, item.locationPreview].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </View>
              <TypeIcon type={item.type} size={13} tint={color.faint} />
            </Pressable>
          ))}
        </View>
      ))}

      {/* Quiet empty state — the Search-for row above remains the primary action */}
      {!loading && !hasAny && matchingRecent.length === 0 && (
        <Text style={styles.emptyHint}>
          No quick matches yet — keep typing, or search everything.
        </Text>
      )}
      <NavBarFiller />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  searchForRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  searchForIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  searchForText: { flex: 1, ...t.body, color: color.ink },
  searchForQuery: { fontWeight: '700' },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { ...t.body, color: color.ink },
  rowTitleBold: { fontWeight: '700' },
  rowSub: { ...t.small, fontSize: 12, lineHeight: 16, color: color.mute, marginTop: 1 },
  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.haze },
  avatarFallback: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitials: { fontSize: 10, fontWeight: '700', color: color.deep },
  emptyHint: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    ...t.small,
    color: color.mute,
  },
});
