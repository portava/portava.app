import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, Alert,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Calendar, Trash2, Star, MessageSquarePlus } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import {
  TravelEmptyState, TravelErrorState, TravelLoadingState,
} from '../../src/components/primitives';
import { Stamp } from '../../src/components/ui';
import {
  getMySavedBuddies, unsaveBuddy, type BuddyProfile,
} from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function SavedBuddyRow({ buddy, onBook, onCustom, onViewHistory, onRemove }: {
  buddy: BuddyProfile;
  onBook: () => void;
  onCustom: () => void;
  onViewHistory: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardMain}
        onPress={() => router.push(`/(rent-a-buddy)/buddy/${buddy.id}` as any)}
      >
        <View style={styles.avatarWrap}>
          <Text style={styles.avatarInitial}>{buddy.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{buddy.displayName ?? 'Local Buddy'}</Text>
          <Text style={styles.city}>{buddy.city}{buddy.country ? `, ${buddy.country}` : ''}</Text>
          <View style={styles.tagsRow}>
            {buddy.categories.slice(0, 2).map(cat => (
              <Stamp key={cat} label={cat} tone="deep" rotate={0} />
            ))}
          </View>
          <View style={styles.ratingRow}>
            <Star size={11} color={color.warn} fill={color.warn} />
            <Text style={styles.rating}>
              {buddy.averageRating != null ? buddy.averageRating.toFixed(1) : '—'}
            </Text>
            {buddy.reviewCount > 0 && (
              <Text style={styles.ratingCount}>({buddy.reviewCount} reviews)</Text>
            )}
            {buddy.hourlyRateUsd != null && (
              <Text style={styles.price}>· From ${buddy.hourlyRateUsd}/hr</Text>
            )}
          </View>
        </View>
      </Pressable>

      <View style={styles.cardActions}>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, styles.actionBtnPrimary, pressed && { opacity: layout.pressedOpacity }]}
          onPress={onBook}
        >
          <Text style={styles.actionBtnTextPrimary}>Book again</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={onCustom}
        >
          <MessageSquarePlus size={13} color={color.deep} />
          <Text style={[styles.actionBtnText, { color: color.deep }]}>Custom</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={onViewHistory}
        >
          <Calendar size={13} color={color.ink} />
          <Text style={styles.actionBtnText}>History</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, { borderRightWidth: 0 }, pressed && { opacity: layout.pressedOpacity }]}
          onPress={onRemove}
        >
          <Trash2 size={13} color={color.signal} />
          <Text style={[styles.actionBtnText, { color: color.signal }]}>Remove</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function RentABuddySaved() {
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState<BuddyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    const res = await getMySavedBuddies();
    setLoading(false);
    setRefreshing(false);
    if (!res.ok) { setError(res.error); return; }
    setSaved(res.data.saved);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRemove = (buddy: BuddyProfile) => {
    Alert.alert(
      'Remove saved Buddy?',
      `Remove ${buddy.displayName ?? 'this Buddy'} from your saved list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            const res = await unsaveBuddy(buddy.id);
            if (res.ok) setSaved(prev => prev.filter(b => b.id !== buddy.id));
          },
        },
      ]
    );
  };

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Saved Buddies</Text>
        {saved.length > 0 && <Text style={styles.headerCount}>{saved.length}</Text>}
      </View>

      {loading ? (
        <TravelLoadingState label="Loading saved Buddies…" />
      ) : error ? (
        <TravelErrorState title="Couldn't load saved Buddies" sub={error} onRetry={() => load()} />
      ) : (
        <FlatList
          data={saved}
          keyExtractor={b => b.id}
          contentContainerStyle={{ padding: space.lg, paddingBottom: 40 + insets.bottom, gap: space.md }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(true); }}
              tintColor={color.signal}
            />
          }
          ListEmptyComponent={
            <TravelEmptyState
              title="No saved Buddies yet"
              sub="After a great meetup, save a Buddy to book again quickly. Your saved Buddies appear here."
              action="Find a Buddy"
              onAction={() => router.push('/(rent-a-buddy)/search' as any)}
            />
          }
          renderItem={({ item }) => (
            <SavedBuddyRow
              buddy={item}
              onBook={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: item.id } })}
              onCustom={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: item.id } })}
              onViewHistory={() => router.push(`/(rent-a-buddy)/buddy/${item.id}` as any)}
              onRemove={() => handleRemove(item)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink, flex: 1 },
  headerCount: { ...t.stamp, color: color.mute, fontFamily: 'Courier' },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden',
  },
  cardMain: { flexDirection: 'row', gap: space.md, padding: space.lg },
  avatarWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  avatarInitial: { fontSize: 22, fontWeight: '700', color: color.onInk },
  name: { ...t.bodyStrong, color: color.ink },
  city: { ...t.small, color: color.mute, marginTop: 2 },
  tagsRow: { flexDirection: 'row', gap: space.xs, marginTop: space.xs },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.xs },
  rating: { ...t.small, fontWeight: '700', color: color.ink },
  ratingCount: { ...t.small, color: color.mute },
  price: { ...t.small, color: color.mute },
  cardActions: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: color.haze,
  },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: space.md,
    borderRightWidth: 1, borderRightColor: color.haze,
  },
  actionBtnPrimary: { backgroundColor: color.signal },
  actionBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  actionBtnTextPrimary: { ...t.small, fontWeight: '800', color: color.onInk },
});
