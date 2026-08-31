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
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Search, Clock } from 'lucide-react-native';
import { TypeIcon } from './searchNav.tsx';
import type { SuggestGroup } from '../../services/discovery.ts';
import type { UnifiedSearchResult, SearchHistoryEntry } from '../../services/discovery.ts';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { PlainBottomFiller } from '../../hooks/useBottomInset.ts';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import { ActionSuggestionRow } from '../../platform/input-assistance/components/ActionSuggestionRow.tsx';
import type { InputSuggestion } from '../../platform/input-assistance/types/inputSuggestion.ts';

interface Props {
  query: string;
  groups: SuggestGroup[];
  loading: boolean;
  recentSearches: SearchHistoryEntry[];
  onSubmit: (q: string) => void;
  onPickRecent: (entry: SearchHistoryEntry) => void;
  onPickResult: (result: UnifiedSearchResult) => void;
  /** §21 smart-action chips (e.g. "Add Bangkok to your trip"). Rendered above the
   *  entity groups and dispatched via `onPickAction` (NOT a search submit). */
  actionSuggestions?: InputSuggestion[];
  onPickAction?: (suggestion: InputSuggestion) => void;
  /** @deprecated Panel no longer owns a ScrollView; scroll is handled by the outer FlatList. */
  onScroll?: never;
}

function SuggestionAvatar({ item }: { item: UnifiedSearchResult }) {
  const uri = item.avatarUrl ?? item.imageUrl ?? null;
  const fallback = (
    <View style={styles.avatarFallback}>
      {item.fallbackInitials ? (
        <Text style={styles.avatarInitials}>{item.fallbackInitials}</Text>
      ) : (
        <TypeIcon type={item.type} size={13} tint={color.mute} />
      )}
    </View>
  );
  // avatarUrl (profile-media) and imageUrl for people/place results can both
  // point into a private bucket, so this must go through the signed-URL
  // hydration layer (DisplayMediaImage/useHydratedMedia) rather than binding
  // straight to <Image>.
  return (
    <DisplayMediaImage
      uri={uri}
      width={avatar.s28}
      height={avatar.s28}
      style={styles.avatar}
      resizeMode="cover"
      fallback={fallback}
      testID={`suggestion-avatar-${item.type}-${item.id}`}
    />
  );
}

export function SearchSuggestionsPanel({
  query, groups, loading, recentSearches,
  onSubmit, onPickRecent, onPickResult,
  actionSuggestions, onPickAction,
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
    // Intentionally a plain View — scroll is owned by the outer FlatList.
    // A nested ScrollView here would create a scroll-capture conflict.
    <View>
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

      {/* §21 smart-action chips (e.g. "Add Bangkok to your trip") — high intent,
          shown just under the always-first search row and dispatched (not a
          search submit). Only present when the gateway recognised an action. */}
      {actionSuggestions && actionSuggestions.length > 0 && onPickAction ? (
        <View style={styles.actionSection}>
          {actionSuggestions.map((s) => (
            <ActionSuggestionRow key={s.id} suggestion={s} onAction={onPickAction} />
          ))}
        </View>
      ) : null}

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
      <PlainBottomFiller />
    </View>
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
    width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  searchForText: { flex: 1, ...t.body, color: color.ink },
  searchForQuery: { fontWeight: '700' },
  actionSection: {
    paddingHorizontal: space.sm,
    paddingBottom: space.xs,
  },
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
  avatar: { width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: color.haze },
  avatarFallback: {
    width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2,
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
