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
 * Map is deferred to the later Media Map phase. Degrades cleanly (§33/§39): an
 * unavailable/blocked experience is dropped, an all-failed load shows retry.
 */
import React, { useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaExperienceProjection, ExperienceChain } from '../types/mediaExperience.ts';
import { fetchExperiencesByIds, buildExperienceChain } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { ExperienceMosaic } from '../components/ExperienceMosaic.tsx';
import { FreshnessBadge } from '../components/FreshnessBadge.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaExperiencesScreenProps {
  mode: PresentationMode;
  /**
   * Canonical Event / Trip ids to resolve as experiences (§43 resolves one id at
   * a time; the lens fans out over these). Empty → the honest empty state.
   */
  experienceIds?: string[];
  onOpenExperience?: (experience: MediaExperienceProjection) => void;
}

export function MediaExperiencesScreen({
  mode,
  experienceIds,
  onOpenExperience,
}: MediaExperiencesScreenProps) {
  const ids = experienceIds ?? EMPTY_IDS;
  const idsKey = ids.join(',');
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => fetchExperiencesByIds(ids, { signal: opts.signal }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey],
  );
  const { state, reload } = useLensProjection<MediaExperienceProjection[]>(
    fetcher,
    (data) => data.length === 0,
    [idsKey],
  );

  if (mode === 'map') {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderTitle}>Experiences on the map</Text>
        <Text style={styles.placeholderBody}>
          Geographic experience clusters arrive with the Media Map phase.
        </Text>
      </View>
    );
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
