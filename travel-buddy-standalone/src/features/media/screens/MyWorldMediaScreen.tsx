/**
 * MyWorldMediaScreen — the MY WORLD lens (spec §5/§29/§30/§31).
 *
 * The owner's own library and personal experience history. The §43 /media/me
 * projection returns real, bucketed collections (All · Posts · Postcards ·
 * Memories · Trips · Tagged · Hidden Gems) plus owner-only operational buckets
 * (Drafts · Archived · Uploads · Processing) — this lens drives its filter chips
 * from those buckets and their true counts, and renders the selected bucket as a
 * Grid / Timeline / Map. Passport remains the primary Postcard surface — this
 * lens does not duplicate the full Passport media product (§29).
 *
 * It also renders the §31 / §31.1 Memory Integration surface — the owner's OWN
 * derived memory groupings + Hidden Gem Memory lines — as a private "Your travel
 * memory" section (MyWorldMemorySection), clearly framed as owner-only. This is
 * the viewer's OWN My World; another user's is never rendered here.
 *
 * census-media §19 added three things: the MAP mode (the one Media Map, placing
 * the owner's own published + tagged media by canonical place — `myMediaStore.
 * mapMediaOf`), "SEARCH MY WORLD" (§30: `GET /media/search?scope=me` through
 * MediaSearchScreen), and bucket/search state moved into `state/myMediaStore`.
 * Degrades cleanly (§33/§39): 404 / empty ⇒ clean empty state, never a throw.
 */
import React, { useCallback, useMemo, useReducer } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import type { MyWorldLibrary } from '../types/myWorld.ts';
import { fetchMyWorld, isMyWorldEmpty } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { MyWorldMemorySection } from '../components/MyWorldMemorySection.tsx'; import { FailedUploadsSection } from '../components/FailedUploadsSection.tsx';
import {
  INITIAL_MY_MEDIA_STATE,
  activeBucket,
  mapMediaOf,
  myMediaReducer,
  orderedBuckets,
} from '../state/myMediaStore.ts';
import { clustersFromOwnMedia, type MediaMapCluster } from '../state/mediaMapStore.ts';
import { MediaMapScreen } from './MediaMapScreen.tsx';
import { MediaSearchScreen } from './MediaSearchScreen.tsx';

export interface MyWorldMediaScreenProps {
  mode: PresentationMode;
  onOpenMedia?: (media: MediaProjection) => void;
  /** Map mode: the viewer's coarse location, the viewport centre. */
  center?: { lat: number; lng: number } | null;
  /** Map mode: open one of your own places' perspectives (§14 Map entry). */
  onOpenCluster?: (cluster: MediaMapCluster) => void;
  onOpenPlace?: (placeId: string) => void;
}

export function MyWorldMediaScreen({ mode, onOpenMedia, center = null, onOpenCluster, onOpenPlace }: MyWorldMediaScreenProps) {
  const [my, dispatch] = useReducer(myMediaReducer, INITIAL_MY_MEDIA_STATE);

  const fetcher = useCallback((opts: { signal: AbortSignal }) => fetchMyWorld({ signal: opts.signal }), []);
  const { state, reload } = useLensProjection<MyWorldLibrary>(fetcher, isMyWorldEmpty, []);

  const buckets = useMemo(() => orderedBuckets(state.data?.buckets ?? []), [state.data]);
  const active = activeBucket(buckets, my.selectedKey);
  const media = active?.media ?? [];
  const memory = state.data?.memory ?? null;

  // Map mode positions YOUR places — the owner's published + tagged media,
  // clustered by the canonical place each projection already names.
  const ownClusters = useMemo(() => clustersFromOwnMedia(mapMediaOf(buckets)), [buckets]);
  const loadOwnClusters = useMemo(
    () => () => Promise.resolve({ ok: true as const, data: ownClusters }),
    [ownClusters],
  );

  if (my.searchOpen) {
    return (
      <View style={styles.wrap}>
        <View style={styles.searchHeader}>
          <Text style={styles.searchTitle}>Search my world</Text>
          <Pressable
            onPress={() => dispatch({ type: 'close_search' })}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            testID="my-world-search-close"
          >
            <X size={20} color={color.onInk} strokeWidth={2} />
          </Pressable>
        </View>
        <MediaSearchScreen initialScope="me" fixedScope onOpenMedia={onOpenMedia} onOpenPlace={onOpenPlace} />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Pressable
          style={styles.searchChip}
          onPress={() => dispatch({ type: 'open_search' })}
          accessibilityRole="button"
          accessibilityLabel="Search my world"
          testID="my-world-search-open"
        >
          <Search size={14} color={color.onInk} strokeWidth={2.2} />
          <Text style={styles.chipText}>Search my world</Text>
        </Pressable>
        {buckets.map((b) => {
          const isActive = active?.key === b.key;
          return (
            <Pressable
              key={b.key}
              style={[styles.chip, isActive && styles.chipActive]}
              onPress={() => dispatch({ type: 'select_bucket', key: b.key })}
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

      {mode === 'map' ? (
        <MediaMapScreen
          center={center}
          loadClusters={loadOwnClusters}
          reloadKey={state.data?.generatedAt ?? String(ownClusters.length)}
          title="My World"
          emptyTitle="Your world on the map"
          emptyMessage="Places you capture gather here — by place, never a precise point. Your library and memory live in Grid and Timeline."
          onOpenCluster={onOpenCluster}
        />
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
          {memory ? <MyWorldMemorySection memory={memory} /> : null}<FailedUploadsSection />

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
  searchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.24)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  chipCount: { color: color.faint, fontSize: 12, fontWeight: '700' },
  content: { paddingVertical: space.sm, gap: space.md, paddingBottom: space.xxxl },
  modeNote: { color: color.onInkMute, fontSize: 12, paddingHorizontal: space.lg },
  bucketEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  searchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
  },
  searchTitle: { color: color.onInk, fontSize: 16, fontWeight: '800' },
  placeholderTitle: { color: color.onInk, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  placeholderBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
