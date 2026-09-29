/**
 * MemoryBrowseLinks — the ways out of one Memory into the owner's own history
 * (HM-F11) and the saved shelf (HM-F13).
 *
 *   Your timeline        — owner only (MemoryTimelineProjection is owner-private).
 *   Your history here    — owner only, and only when the Memory has a place the
 *                          place-history route can answer for.
 *   Saved memories       — anyone: the shelf `POST /memories/:id/save` fills.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Bookmark, Clock, MapPin } from 'lucide-react-native';
import { color, space, type as t } from '../../../theme/tokens.ts';
import { memoryPlaceHistoryId } from '../../../services/memorySocial.ts';
import type { Memory } from '../../../services/memories.ts';

export function MemoryBrowseLinks({ memory, isOwner }: { memory: Memory; isOwner: boolean }) {
  const placeId = isOwner ? memoryPlaceHistoryId(memory) : null;
  const placeLabel = [memory.locationCity, memory.locationCountry].filter(Boolean).join(', ') || 'this place';
  return (
    <View style={s.wrap}>
      {isOwner ? (
        <Pressable testID="memory-open-timeline" style={s.link} onPress={() => router.push('/memory/timeline' as never)} accessibilityRole="button">
          <Clock size={14} color={color.deep} />
          <Text style={s.text}>Your timeline</Text>
        </Pressable>
      ) : null}
      {placeId ? (
        <Pressable
          testID="memory-open-place-history"
          style={s.link}
          onPress={() => router.push({ pathname: '/memory/place-history' as never, params: { placeId, label: placeLabel } } as never)}
          accessibilityRole="button"
        >
          <MapPin size={14} color={color.deep} />
          <Text style={s.text}>Your history at {placeLabel}</Text>
        </Pressable>
      ) : null}
      <Pressable testID="memory-open-saved" style={s.link} onPress={() => router.push('/memory/saved' as never)} accessibilityRole="button">
        <Bookmark size={14} color={color.deep} />
        <Text style={s.text}>Saved memories</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  link: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  text: { ...(t.small as object), color: color.deep, fontWeight: '600' },
});
