/**
 * MediaExperiencesScreen — the EXPERIENCES lens (spec §5/§23/§23.1).
 *
 * Media organized around real-world experiences (Sunset at My Khe, Beach
 * Festival, Friday Night An Thuong) — canonical Events and Trips resolved
 * through GET /media/experiences/:id (§43). The §43 surface has NO "list of
 * experiences" endpoint, so this lens resolves the specific experiences it is
 * handed (deep-link / trip / event context) and degrades to a clean empty state
 * when it has none — never a request to a route that does not exist.
 *
 * Overview/Visual render the experience mosaic plus any experience CHAIN
 * (Dinner → Rooftop → Nightclub, §23.1) derived from an experience's own places.
 * Map is the one Media Map, restricted to the experiences' own canonical places.
 * Degrades cleanly (§33/§39): an unavailable/blocked experience is dropped.
 */
import React, { useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaExperienceProjection, ExperienceChain } from '../types/mediaExperience.ts';
import { buildExperienceChain, fetchMediaMap } from '../services/mediaProjection.ts';
import { experiencesOffline } from '../../../services/media/mediaOffline.ts'; // §39 offline trip/event media
import { ExperienceMosaic } from '../components/ExperienceMosaic.tsx';
import { FreshnessBadge } from '../components/FreshnessBadge.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import { MediaMapScreen } from './MediaMapScreen.tsx';

export interface MediaExperiencesScreenProps {
  mode: PresentationMode;
  /**
   * Canonical Event / Trip ids to resolve as experiences (§43 resolves one id at
   * a time; the lens fans out over these). Empty → the honest empty state.
   */
  experienceIds?: string[];
  /** §14: tapping an experience opens its Event / Trip entry context. */
  onOpenExperience?: (experience: MediaExperienceProjection) => void;
  /** Map mode: coarse city scope and viewport centre. */
  city?: string | null; center?: { lat: number; lng: number } | null;
  onOpenCluster?: (cluster: MediaMapCluster) => void;
}

export function MediaExperiencesScreen({
  mode,
  experienceIds,
  onOpenExperience, city = null, center = null, onOpenCluster,
}: MediaExperiencesScreenProps) {
  const ids = experienceIds ?? EMPTY_IDS;
  const idsKey = ids.join(',');
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => experiencesOffline(ids, { signal: opts.signal }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey],
  );
  const { state, reload, cachedLabel } = useOfflineLens<MediaExperienceProjection[]>(
    fetcher,
    (data) => data.length === 0,
    [idsKey],
  );
  const placeKey = (state.data ?? []).flatMap((e) => e.placeIds).join(',');

  if (mode === 'map') {
    return <ExperiencesMap placeKey={placeKey} city={city} center={center} onOpenCluster={onOpenCluster} />;
  }

  if (state.status !== 'ready' || !state.data) {
    return (
      <LensStateView
        status={state.status === 'idle' ? 'loading' : state.status}
        title="No live experiences yet"
        message="Sunsets, festivals, and nights out appear here as they gather perspectives — open one from a trip or event to see it here."
        onRetry={reload}
      />
    );
  }

  const experiences = state.data;
  const chains = experiences
    .map(buildExperienceChain)
    .filter((c): c is ExperienceChain => c !== null);

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {cachedLabel ? <Text style={styles.intro}>{cachedLabel}</Text> : null}
      <Text style={styles.intro}>Happening around you — grouped by experience, not by creator.</Text>
      <ExperienceMosaic experiences={experiences} onOpen={onOpenExperience} />

      {chains.length > 0 ? (
        <View style={styles.chainSection}>
          <Text style={styles.chainHeading}>Experience routes</Text>
          {chains.map((chain) => (
            <ExperienceChainRow key={chain.id} chain={chain} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** One experience chain rendered as a place → place → place route (§23.1). */
function ExperienceChainRow({ chain }: { chain: ExperienceChain }) {
  return (
    <View style={styles.chainCard}>
      <Text style={styles.chainTitle} numberOfLines={1}>
        {chain.title}
      </Text>
      <View style={styles.chainSteps}>
        {chain.steps.map((step, i) => (
          <React.Fragment key={`${step.placeId ?? step.label}-${i}`}>
            {i > 0 ? <ChevronRight size={14} color={color.faint} strokeWidth={2.4} /> : null}
            <Text style={styles.chainStep} numberOfLines={1}>
              {step.label}
            </Text>
          </React.Fragment>
        ))}
      </View>
      <View style={styles.chainFooter}>
        <FreshnessBadge freshness={chain.freshness} />
      </View>
    </View>
  );
}

const EMPTY_IDS: string[] = [];

/**
 * EXPERIENCES → Map: the one Media Map, its clusters restricted to the canonical
 * places the lens's experiences themselves name. An experience's place the world
 * projection has no perspectives for simply has no cluster — nothing is invented.
 */
function ExperiencesMap({
  placeKey,
  city,
  center,
  onOpenCluster,
}: {
  placeKey: string;
  city: string | null;
  center: { lat: number; lng: number } | null;
  onOpenCluster?: (cluster: MediaMapCluster) => void;
}) {
  const loadClusters = useMemo(() => {
    const allowed = new Set(placeKey ? placeKey.split(',') : []);
    return (opts: { signal: AbortSignal }) =>
      fetchMediaMap({ city, signal: opts.signal }).then((r) =>
        r.ok ? { ok: true as const, data: r.data.clusters.filter((c) => allowed.has(c.placeId)) } : r,
      );
  }, [placeKey, city]);
  return (
    <MediaMapScreen
      city={city}
      center={center}
      loadClusters={loadClusters}
      reloadKey={placeKey}
      title="Experiences"
      emptyTitle="No experiences on the map yet"
      emptyMessage="Experiences appear here by the places they happen at, once those places have perspectives."
      onOpenCluster={onOpenCluster}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.md, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg },
  chainSection: { gap: space.sm, paddingHorizontal: space.lg, marginTop: space.sm },
  chainHeading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  chainCard: {
    borderRadius: radius.lg,
    backgroundColor: 'rgba(250,249,246,0.05)',
    padding: space.md,
    gap: space.xs,
  },
  chainTitle: { color: color.onInk, fontSize: 15, fontWeight: '800', letterSpacing: -0.3 },
  chainSteps: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  chainStep: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chainFooter: { flexDirection: 'row', marginTop: 2 },
});

// §39 (census-media §22): the lens reads through the offline cache and shows its
// "Cached · updated …" label. Imported at the TAIL so no cited line moves.
import { useOfflineLens } from '../../../services/media/useOfflineLens.ts';
