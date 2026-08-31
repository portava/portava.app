/**
 * MyWorldMediaScreen — the MY WORLD lens (spec §5/§29/§30).
 *
 * The owner's library and personal experience history. Sub-collections (All ·
 * Posts · Postcards · Memories · Trips · Tagged · Hidden Gems) are shown as a
 * scaffolded filter row; Grid / Timeline / Map are the presentation modes (§5).
 * Passport remains the primary Postcard surface — this lens does not duplicate
 * the full Passport media product (§29).
 *
 * Degrades cleanly while /media/me lands in the parallel backend PR.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import { fetchMyWorld } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MyWorldMediaScreenProps {
  mode: PresentationMode;
  onOpenMedia?: (media: MediaProjection) => void;
}

// §30 sub-collections (scaffolded filter chips).
const COLLECTIONS = ['All', 'Posts', 'Postcards', 'Memories', 'Trips', 'Tagged', 'Hidden Gems'] as const;

export function MyWorldMediaScreen({ mode, onOpenMedia }: MyWorldMediaScreenProps) {
  const [collection, setCollection] = useState<(typeof COLLECTIONS)[number]>('All');

  const fetcher = useCallback((opts: { signal: AbortSignal }) => fetchMyWorld({ signal: opts.signal }), []);
  const { state, reload } = useLensProjection<MediaProjection[]>(
    fetcher,
    (data) => data.length === 0,
    [],
  );

  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {COLLECTIONS.map((c) => {
          const active = c === collection;
          return (
            <Pressable
              key={c}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => setCollection(c)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{c}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {mode === 'map' ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderTitle}>Your world on the map</Text>
          <Text style={styles.placeholderBody}>
            A map of everywhere you&apos;ve been arrives with the Media Map phase.
          </Text>
        </View>
      ) : state.status !== 'ready' || !state.data ? (
        <LensStateView
          status={state.status === 'idle' ? 'loading' : state.status}
          title="Your world is waiting"
          message="Media you capture and are tagged in will gather here as your travel history."
          onRetry={reload}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {mode === 'timeline' ? (
            <Text style={styles.modeNote}>Newest first — your captures over time.</Text>
          ) : null}
          <PerspectiveMosaic media={state.data} onOpen={onOpenMedia} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  content: { paddingVertical: space.sm, gap: space.md, paddingBottom: space.xxxl },
  modeNote: { color: color.onInkMute, fontSize: 12, paddingHorizontal: space.lg },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  placeholderTitle: { color: color.onInk, fontSize: 18, fontWeight: '800' },
  placeholderBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
