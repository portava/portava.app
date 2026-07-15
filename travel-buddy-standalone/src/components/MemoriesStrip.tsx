import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, Image, StyleSheet, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { BookImage } from 'lucide-react-native';
import { getMemoryFeed, type Memory } from '../services/memories';
import { color, space, radius, type as t } from '../theme/tokens';

interface MemoriesStripProps {
  limit?: number;
}

export function MemoriesStrip({ limit = 8 }: MemoriesStripProps) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getMemoryFeed(limit).then((res) => {
      if (cancelled) return;
      if (res.ok) setMemories(res.memories);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [limit]);

  if (loading) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator size="small" color={color.signal} />
      </View>
    );
  }

  if (!memories.length) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <BookImage size={13} color={color.signal} />
        <Text style={styles.header}>Traveler Memories</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
      >
        {memories.map((m) => (
          <Pressable
            key={m.id}
            style={styles.card}
            onPress={() => router.push(`/memory/${m.id}` as any)}
          >
            {m.cover?.mediaUrl ? (
              <Image source={{ uri: m.cover.mediaUrl }} style={styles.cover} />
            ) : (
              <View style={[styles.cover, styles.coverPlaceholder]}>
                <BookImage size={22} color={color.onInk} />
              </View>
            )}
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {m.title ?? 'Untitled Memory'}
              </Text>
              {m.owner?.name ? (
                <Text style={styles.cardOwner} numberOfLines={1}>
                  {m.owner.name}
                </Text>
              ) : null}
              {m.likeCount != null && m.likeCount > 0 ? (
                <Text style={styles.cardLikes}>♥ {m.likeCount}</Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const CARD_W = 130;

const styles = StyleSheet.create({
  wrap: {
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  loadingRow: {
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  header: {
    ...t.small,
    color: color.mute,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  list: {
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  card: {
    width: CARD_W,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  cover: {
    width: CARD_W,
    height: 80,
    backgroundColor: color.haze,
  },
  coverPlaceholder: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    padding: space.sm,
    gap: 2,
  },
  cardTitle: {
    ...t.small,
    fontWeight: '700',
    color: color.ink,
    fontSize: 12,
  },
  cardOwner: {
    fontSize: 11,
    color: color.mute,
  },
  cardLikes: {
    fontSize: 10,
    color: color.signal,
    fontWeight: '600',
  },
});
