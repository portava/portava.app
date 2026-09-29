/**
 * ProfileMemoryAlbums — a user's `memories` albums on their profile (HM-F14).
 *
 * `GET /users/:userId/memories` decides what this viewer may see: §23
 * canReadMemory on the "profile" surface (a stranger sees public albums, a
 * mutual follow also sees friends-only ones), the block check, published only
 * for anyone but the owner, and location protection at the owner's chosen
 * precision (enrichMemories). This component adds no filtering of its own and
 * shows only the place fields the server returned.
 *
 * It sits UNDER the Passport's `passport_memories` list on the Memories tab:
 * those are passport entries, these are Memory albums — different tables with
 * different ids — and each opens its own screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BookImage } from 'lucide-react-native';
import { CachedImage } from '../../../components/CachedImage.tsx';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { getUserMemories, type Memory } from '../../../services/memories.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; memories: Memory[]; nextCursor: string | null; loadingMore: boolean; moreError: string | null };

export function ProfileMemoryAlbums({ userId }: { userId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await getUserMemories(userId, null);
    setState(res.ok
      ? { kind: 'ready', memories: res.memories, nextCursor: res.nextCursor, loadingMore: false, moreError: null }
      : { kind: 'error', message: 'Memories could not be loaded right now.' });
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  const more = useCallback(async () => {
    if (state.kind !== 'ready' || !state.nextCursor || state.loadingMore) return;
    const cursor = state.nextCursor;
    setState({ ...state, loadingMore: true, moreError: null });
    const res = await getUserMemories(userId, cursor);
    setState((prev) => {
      if (prev.kind !== 'ready') return prev;
      if (!res.ok) return { ...prev, loadingMore: false, moreError: 'More memories could not be loaded.' };
      const seen = new Set(prev.memories.map((m) => m.id));
      return { kind: 'ready', memories: [...prev.memories, ...res.memories.filter((m) => !seen.has(m.id))], nextCursor: res.nextCursor, loadingMore: false, moreError: null };
    });
  }, [state, userId]);

  return (
    <View style={s.wrap} testID="profile-memory-albums">
      <Text style={s.head}>Memory albums</Text>
      {state.kind === 'loading' ? (
        <ActivityIndicator color={color.signal} style={s.pad} />
      ) : state.kind === 'error' ? (
        <View style={s.pad} testID="profile-memories-error">
          <Text style={s.body}>{state.message}</Text>
          <Pressable onPress={load} style={s.retry} accessibilityRole="button" testID="profile-memories-retry">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : state.memories.length === 0 ? (
        <Text style={[s.body, s.pad]} testID="profile-memories-empty">No memory albums to show.</Text>
      ) : (
        <View style={s.grid}>
          {state.memories.map((m) => {
            const place = [m.locationCity, m.locationCountry].filter(Boolean).join(', ');
            const cover = m.cover?.mediaUrl ?? m.items?.[0]?.mediaUrl ?? null;
            return (
              <Pressable key={m.id} style={s.card} onPress={() => router.push(`/memory/${m.id}` as never)} accessibilityRole="button" testID={`profile-memory-${m.id}`}>
                {cover ? <CachedImage source={{ uri: cover }} style={s.cover} /> : (
                  <View style={[s.cover, s.coverEmpty]}><BookImage size={22} color={color.mute} /></View>
                )}
                <Text style={s.title} numberOfLines={1}>{m.title || 'Untitled memory'}</Text>
                {place ? <Text style={s.caption} numberOfLines={1}>{place}</Text> : null}
              </Pressable>
            );
          })}
          {state.nextCursor ? (
            <Pressable onPress={more} disabled={state.loadingMore} style={s.more} accessibilityRole="button" testID="profile-memories-more">
              {state.loadingMore ? <ActivityIndicator size="small" color={color.signal} /> : <Text style={s.retryText}>{state.moreError ?? 'Show more'}</Text>}
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: space.lg, gap: space.sm },
  head: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  pad: { paddingVertical: space.md },
  body: { ...(t.body as object), color: color.mute },
  caption: { ...(t.small as object), color: color.mute },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  card: { width: '48%', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, overflow: 'hidden', paddingBottom: space.sm },
  cover: { width: '100%', height: 110 },
  coverEmpty: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  title: { ...(t.bodyStrong as object), color: color.ink, paddingHorizontal: space.sm, paddingTop: space.xs },
  more: { width: '100%', alignItems: 'center', paddingVertical: space.md },
  retry: { alignSelf: 'flex-start', paddingVertical: space.sm },
  retryText: { ...(t.bodyStrong as object), color: color.deep },
});
