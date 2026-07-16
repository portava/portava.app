/**
 * stamps/StampGrid — 2-column FlatList grid of PassportStampNew items.
 * Shows skeleton placeholders while loading, a retry button on error,
 * and friendly empty states when the stamp list is empty.
 */
import React from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import { StampCard } from './StampCard.tsx';
import type { PassportStampNew } from '../../services/passportStamps.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  stamps: PassportStampNew[];
  loading: boolean;
  error: string | null;
  isOwner: boolean;
  onRetry: () => void;
  onStampPress: (stamp: PassportStampNew) => void;
  emptyTitle: string;
  emptySub: string;
}

function SkeletonCard() {
  return (
    <View style={sk.card}>
      <View style={sk.artwork} />
      <View style={sk.line1} />
      <View style={sk.line2} />
    </View>
  );
}

export function StampGrid({
  stamps, loading, error, isOwner, onRetry, onStampPress, emptyTitle, emptySub,
}: Props) {
  if (loading && stamps.length === 0) {
    return (
      <View style={styles.skeletonGrid}>
        {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <AlertCircle size={28} color={color.mute} />
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryBtn} onPress={onRetry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (stamps.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{emptyTitle}</Text>
        <Text style={styles.emptySub}>{emptySub}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={stamps}
      numColumns={2}
      keyExtractor={(s) => s.id}
      scrollEnabled={false}
      columnWrapperStyle={styles.row}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <StampCard
          stamp={item}
          isOwner={isOwner}
          onPress={() => onStampPress(item)}
        />
      )}
      ListFooterComponent={loading ? <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} /> : null}
    />
  );
}

const styles = StyleSheet.create({
  list:         { paddingHorizontal: space.md, paddingBottom: space.xl },
  row:          { flex: 1 },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: space.md,
    gap: 0,
  },
  center: {
    alignItems: 'center',
    paddingVertical: space.xxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  errorText:  { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal,
  },
  retryText:  { ...t.bodyStrong, color: color.signal },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptySub:   { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18 },
});

const sk = StyleSheet.create({
  card: {
    width: '50%',
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    gap: 6,
  },
  artwork: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: color.haze,
    marginBottom: 4,
  },
  line1: { width: 60, height: 10, borderRadius: 5, backgroundColor: color.haze },
  line2: { width: 44, height: 8,  borderRadius: 4, backgroundColor: color.haze, opacity: 0.6 },
});
