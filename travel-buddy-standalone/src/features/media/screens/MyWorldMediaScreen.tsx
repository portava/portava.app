/**
 * MyWorldMediaScreen — the MY WORLD lens (spec §5/§29/§30/§31).
 *
 * The owner's own library and personal experience history. The §43 /media/me
 * projection returns real, bucketed collections (All · Posts · Postcards ·
 * Memories · Trips · Tagged · Hidden Gems) plus owner-only operational buckets
 * (Drafts · Archived · Uploads · Processing) — this lens drives its filter chips
 * from those buckets and their true counts, and renders the selected bucket as a
 * Grid / Timeline (Map is deferred). Passport remains the primary Postcard
 * surface — this lens does not duplicate the full Passport media product (§29).
 *
 * It also renders the §31 / §31.1 Memory Integration surface — the owner's OWN
 * derived memory groupings + Hidden Gem Memory lines — as a private "Your travel
 * memory" section (MyWorldMemorySection), clearly framed as owner-only. This is
 * the viewer's OWN My World; another user's is never rendered here.
 *
 * Degrades cleanly (§33/§39): 404 / empty ⇒ clean empty state, never a throw.
 * No precise-location map, no fake-live (§46.2).
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import type { MyWorldBucket, MyWorldLibrary } from '../types/myWorld.ts';
import { fetchMyWorld, isMyWorldEmpty } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { MyWorldMemorySection } from '../components/MyWorldMemorySection.tsx';

export interface MyWorldMediaScreenProps {
  mode: PresentationMode;
  onOpenMedia?: (media: MediaProjection) => void;
}

/** Friendly ordering of §30 buckets; anything unlisted keeps server order after. */
const BUCKET_ORDER = [
  'all',
  'posts',
  'postcards',
  'memories',
  'trips',
  'tagged',
  'gems',
  'drafts',
  'archived',
  'uploads',
  'processing',
];

function orderedBuckets(buckets: MyWorldBucket[]): MyWorldBucket[] {
  return [...buckets].sort((a, b) => {
    const ia = BUCKET_ORDER.indexOf(a.key);
    const ib = BUCKET_ORDER.indexOf(b.key);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

export function MyWorldMediaScreen({ mode, onOpenMedia }: MyWorldMediaScreenProps) {
  const [selectedKey, setSelectedKey] = useState<string>('all');

  const fetcher = useCallback((opts: { signal: AbortSignal }) => fetchMyWorld({ signal: opts.signal }), []);
  const { state, reload } = useLensProjection<MyWorldLibrary>(fetcher, isMyWorldEmpty, []);

  const buckets = useMemo(() => orderedBuckets(state.data?.buckets ?? []), [state.data]);
  const active = buckets.find((b) => b.key === selectedKey) ?? buckets[0] ?? null;
  const media = active?.media ?? [];
  const memory = state.data?.memory ?? null;

  return (
    <View style={styles.wrap}>
      {buckets.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {buckets.map((b) => {
            const isActive = active?.key === b.key;
            return (
              <Pressable
                key={b.key}
                style={[styles.chip, isActive && styles.chipActive]}
                onPress={() => setSelectedKey(b.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{b.label}</Text>
                {b.count > 0 ? (
                  <Text style={[styles.chipCount, isActive && styles.chipTextActive]}>{b.count}</Text>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {mode === 'map' ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderTitle}>Your world on the map</Text>
          <Text style={styles.placeholderBody}>
            A map of everywhere you&apos;ve been arrives with the Media Map phase. Your library and
            memory live in the Grid and Timeline views.
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
        // Ready with content (empty ⇒ status 'empty' ⇒ handled above). Render the
        // private §31 memory section first, then the selected bucket's Grid /
        // Timeline. The memory section shows regardless of which bucket is active,
        // and self-hides when there is nothing to remember.
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {memory ? <MyWorldMemorySection memory={memory} /> : null}

          {mode === 'timeline' && media.length > 0 ? (
            <Text style={styles.modeNote}>Newest first — your captures over time.</Text>
          ) : null}

          {media.length > 0 ? (
            <PerspectiveMosaic media={media} onOpen={onOpenMedia} />
          ) : (
            <View style={styles.bucketEmpty}>
              <Text style={styles.placeholderTitle}>Nothing in {active?.label ?? 'this collection'} yet</Text>
              <Text style={styles.placeholderBody}>
                {active && active.count > 0
                  ? `${active.label} lives in its own space — ${active.count} item${active.count === 1 ? '' : 's'} to open there.`
                  : 'Pick another collection, or add media to fill this one.'}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  chips: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  chipCount: { color: color.faint, fontSize: 12, fontWeight: '700' },
  content: { paddingVertical: space.sm, gap: space.md, paddingBottom: space.xxxl },
  modeNote: { color: color.onInkMute, fontSize: 12, paddingHorizontal: space.lg },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  bucketEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  placeholderTitle: { color: color.onInk, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  placeholderBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
