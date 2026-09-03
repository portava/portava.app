/**
 * QuickMediaRow — the lightweight top row of short-lived stories / quick media
 * (Wall spec §18).
 *
 * A quiet, optional strip of quick media from followed people. It is NOT the
 * main Media system and must not compete visually with Live For You (spec §18),
 * so it stays small and understated, and renders nothing when there is nothing
 * to show (keeping the feed uncluttered). Content is supplied by the caller;
 * the shell keeps it presentational.
 */

import React from 'react';
import { View, Text, Pressable, ScrollView, Image, StyleSheet } from 'react-native';
import { color, space, radius, type as t, avatar } from '../../../theme/tokens.ts';

export interface QuickMediaEntry {
  id: string;
  label: string;
  avatarUrl?: string | null;
  /** True for the viewer's own "add" affordance. */
  isSelf?: boolean;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function QuickMediaRow({
  entries,
  onOpen,
}: {
  entries: QuickMediaEntry[];
  onOpen?: (entry: QuickMediaEntry) => void;
}) {
  if (!entries || entries.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.row}
      testID="wall-quick-media"
      accessibilityRole="list"
    >
      {entries.map((entry) => (
        <Pressable
          key={entry.id}
          style={s.item}
          onPress={() => onOpen?.(entry)}
          accessibilityRole="button"
          accessibilityLabel={entry.label}
        >
          <View style={[s.ring, entry.isSelf && s.ringSelf]}>
            {entry.avatarUrl ? (
              <Image source={{ uri: entry.avatarUrl }} style={s.avatarImg} />
            ) : (
              <Text style={s.initials}>{entry.isSelf ? '+' : initialsOf(entry.label)}</Text>
            )}
          </View>
          <Text style={s.label} numberOfLines={1}>
            {entry.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  item: { alignItems: 'center', width: 64 },
  ring: {
    width: avatar.s56,
    height: avatar.s56,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.signal,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ringSelf: { borderColor: color.haze, borderStyle: 'dashed' },
  avatarImg: { width: '100%', height: '100%' },
  initials: { ...t.bodyStrong, color: color.mute, fontWeight: '700' },
  label: { ...t.small, color: color.mute, marginTop: space.xs },
});
