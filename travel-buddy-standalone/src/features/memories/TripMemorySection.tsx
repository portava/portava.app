/**
 * TripMemorySection — the "Trip Memory" block on the trip screen.
 *
 * Moved out of app/trip/[id].tsx verbatim (lane highlights, 2026-10-03) so its
 * states can be tested without mounting the whole trip screen.
 */
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { BookImage } from 'lucide-react-native';
import { CachedImage } from '../../components/CachedImage.tsx';
import { getTripMemory, createTripMemory, type Memory } from '../../services/memories.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

export function TripMemorySection({
  tripId, isOwner, tripStatus,
}: {
  tripId: string;
  isOwner: boolean;
  tripStatus?: string;
}) {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [memLoading, setMemLoading] = useState(true);
  // §28.11. Non-null when the read could not be performed. Only a `not_found`
  // means "this trip has no Memory"; a 503 or a dropped connection means
  // nobody knows, and must not become the create offer (which would write a
  // second Memory) or the sentence "No memory for this trip yet".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [memoryCoverFailed, setMemoryCoverFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMemLoading(true);
    setLoadError(null);
    getTripMemory(tripId).then((res) => {
      if (cancelled) return;
      if (res.ok) setMemory(res.memory);
      else if (res.kind === 'not_found') setMemory(null);
      else setLoadError(res.message || 'Could not load this trip’s memory.');
      setMemLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoadError('Could not load this trip’s memory.');
      setMemLoading(false);
    });
    return () => { cancelled = true; };
  }, [tripId, reloadKey]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    const res = await createTripMemory(tripId);
    if (res.ok) {
      setMemory(res.memory);
      router.push(`/memory/${res.memory.id}` as any);
    } else {
      Alert.alert('Error', res.message ?? 'Could not create memory');
    }
    setCreating(false);
  }

  if (memLoading) return null;

  if (loadError) {
    return (
      <View style={tm.wrap}>
        <Text style={tm.title}>Trip Memory</Text>
        <View style={tm.empty} testID="trip-memory-error">
          <Text style={tm.emptyText}>{loadError}</Text>
          <Pressable
            testID="trip-memory-retry"
            onPress={() => setReloadKey((k) => k + 1)}
            accessibilityRole="button"
            hitSlop={6}
          >
            <Text style={tmRecap.link}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={tm.wrap}>
      <View style={tmRecap.row}><Text style={tm.title}>Trip Memory</Text>{memory ? <Pressable testID="trip-open-recap" onPress={() => router.push(`/trip/${tripId}/recap` as any)} accessibilityRole="button" hitSlop={6}><Text style={tmRecap.link}>View trip recap</Text></Pressable> : null}</View>
      {memory ? (
        <Pressable style={tm.card} onPress={() => router.push(`/memory/${memory.id}` as any)}>
          {memory.cover?.mediaUrl && !memoryCoverFailed ? (
            <CachedImage source={{ uri: memory.cover.mediaUrl }} style={tm.cover} onError={() => setMemoryCoverFailed(true)} />
          ) : (
            <View style={[tm.cover, tm.coverEmpty]}>
              <BookImage size={28} color={color.onInk} />
            </View>
          )}
          <View style={tm.cardBody}>
            <Text style={tm.cardTitle} numberOfLines={1}>
              {memory.title ?? 'Untitled Memory'}
            </Text>
            {memory.caption ? (
              <Text style={tm.cardCaption} numberOfLines={2}>{memory.caption}</Text>
            ) : null}
            <Text style={tm.cardState}>{memory.state === 'published' ? '✓ Published' : 'Draft'}</Text>
          </View>
        </Pressable>
      ) : isOwner && tripStatus === 'completed' ? (
        <Pressable
          style={[tm.createBtn, creating && { opacity: 0.5 }]}
          onPress={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : (
            <BookImage size={16} color={color.signal} />
          )}
          <Text style={tm.createBtnText}>
            {creating ? 'Creating…' : 'Create a memory from this trip'}
          </Text>
        </Pressable>
      ) : (
        <View style={tm.empty}>
          <BookImage size={22} color={color.faint} />
          <Text style={tm.emptyText}>No memory for this trip yet</Text>
        </View>
      )}
    </View>
  );
}

const tm = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md },
  title: { ...t.title, color: color.ink, fontSize: 18 },
  card: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  cover: { width: 90, height: 90 },
  coverEmpty: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, padding: space.md, gap: 4, justifyContent: 'center' },
  cardTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  cardCaption: { ...t.small, color: color.mute, lineHeight: 16 },
  cardState: { fontSize: 11, color: color.signal, fontWeight: '600', marginTop: 2 },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: color.signal,
    borderRadius: 10,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    backgroundColor: '#FFF5F5',
  },
  createBtnText: { ...t.body, color: color.signal, fontWeight: '600' },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    padding: space.xl,
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    borderStyle: 'dashed',
  },
  emptyText: { ...t.small, color: color.faint },
});

const tmRecap = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { ...t.small, color: color.deep, fontWeight: '700' },
});
