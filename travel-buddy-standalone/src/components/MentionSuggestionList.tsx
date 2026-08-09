/**
 * MentionSuggestionList — suggestion dropdown for MentionInput.
 *
 * Renders a FlatList of entity or hashtag rows above the keyboard.
 * The parent positions it between the message list and the compose bar.
 *
 * Usage:
 *   <MentionSuggestionList
 *     suggestions={suggestions}
 *     loading={loading}
 *     visible={visible}
 *     onSelect={(s) => mentionRef.current?.insertTag(s)}
 *   />
 */
import React from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { CachedImage } from './CachedImage.tsx';
import { Hash, User, Briefcase, MapPin, Users, Calendar } from 'lucide-react-native';
import {
  type AnyMentionSuggestion,
  type EntityTagSuggestion,
  type HashtagSuggestion,
} from '../services/tagging.ts';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MentionSuggestionListProps {
  suggestions: AnyMentionSuggestion[];
  loading: boolean;
  visible: boolean;
  onSelect: (suggestion: AnyMentionSuggestion) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeLabel(type: string): string {
  switch (type) {
    case 'user': return 'User';
    case 'trip': return 'Trip';
    case 'circle': return 'Circle';
    case 'place': return 'Place';
    case 'event': return 'Event';
    case 'hashtag': return 'Hashtag';
    default: return type;
  }
}

function TypeIcon({ type, size = 12 }: { type: string; size?: number }) {
  const iconColor = color.onInk;
  switch (type) {
    case 'user': return <User size={size} color={iconColor} />;
    case 'trip': return <Briefcase size={size} color={iconColor} />;
    case 'circle': return <Users size={size} color={iconColor} />;
    case 'place': return <MapPin size={size} color={iconColor} />;
    case 'event': return <Calendar size={size} color={iconColor} />;
    case 'hashtag': return <Hash size={size} color={iconColor} />;
    default: return null;
  }
}

function formatUsageCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Row components ────────────────────────────────────────────────────────────

function EntityRow({
  item,
  onPress,
}: {
  item: EntityTagSuggestion;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.avatarWrap}>
        {item.avatarUrl ? (
          <CachedImage source={{ uri: item.avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <TypeIcon type={item.type} size={14} />
          </View>
        )}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.type === 'user' && item.handle ? `@${item.handle}` : item.name}
        </Text>
        {item.subtitle ? (
          <Text style={styles.rowSub} numberOfLines={1}>{item.subtitle}</Text>
        ) : null}
      </View>
      <View style={styles.chip}>
        <TypeIcon type={item.type} size={10} />
        <Text style={styles.chipText}>{typeLabel(item.type)}</Text>
      </View>
    </Pressable>
  );
}

function HashtagRow({
  item,
  onPress,
}: {
  item: HashtagSuggestion;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={[styles.avatar, styles.hashtagIcon]}>
        <Hash size={14} color={color.signal} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>#{item.slug}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {formatUsageCount(item.usageCount)} post{item.usageCount === 1 ? '' : 's'}
          {item.isFollowing ? ' · Following' : ''}
        </Text>
      </View>
      <View style={[styles.chip, styles.hashtagChip]}>
        <Text style={[styles.chipText, { color: color.signal }]}>Hashtag</Text>
      </View>
    </Pressable>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MentionSuggestionList({
  suggestions,
  loading,
  visible,
  onSelect,
}: MentionSuggestionListProps) {
  if (!visible) return null;

  return (
    <View style={styles.container}>
      {loading && suggestions.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={color.mute} />
        </View>
      ) : suggestions.length === 0 ? (
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>No results</Text>
        </View>
      ) : (
        <FlatList
          data={suggestions}
          keyExtractor={(item) => `${item.type}:${item.id}`}
          keyboardShouldPersistTaps="always"
          style={styles.list}
          renderItem={({ item }) =>
            item.type === 'hashtag' ? (
              <HashtagRow item={item as HashtagSuggestion} onPress={() => onSelect(item)} />
            ) : (
              <EntityRow item={item as EntityTagSuggestion} onPress={() => onSelect(item)} />
            )
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    maxHeight: 220,
  },
  list: {
    maxHeight: 220,
  },
  loadingRow: {
    paddingVertical: space.md,
    alignItems: 'center',
  },
  emptyRow: {
    paddingVertical: space.md,
    alignItems: 'center',
  },
  emptyText: {
    ...t.small,
    color: color.mute,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  avatarWrap: {},
  avatar: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
  },
  avatarFallback: {
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hashtagIcon: {
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    ...t.bodyStrong,
    color: color.ink,
  },
  rowSub: {
    ...t.small,
    color: color.mute,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: color.ink,
    borderRadius: 4,
  },
  hashtagChip: {
    backgroundColor: `${color.signal}15`,
  },
  chipText: {
    ...t.stamp,
    color: color.onInk,
    fontSize: 10,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.haze,
    marginLeft: 52 + space.md,
  },
});
