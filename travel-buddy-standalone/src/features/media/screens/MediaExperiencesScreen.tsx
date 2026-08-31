/**
 * MediaExperiencesScreen — the EXPERIENCES lens (spec §5/§23).
 *
 * Media organized around real-world experiences. Overview/Visual render the
 * experience mosaic; Map is deferred to the later Media Map phase. Degrades to a
 * clean empty state while the /media/experiences endpoint is landing.
 */
import React, { useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { MediaExperienceProjection } from '../types/mediaExperience.ts';
import { fetchExperiences } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { ExperienceMosaic } from '../components/ExperienceMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaExperiencesScreenProps {
  mode: PresentationMode;
  cityId?: string | null;
  onOpenExperience?: (experience: MediaExperienceProjection) => void;
}

export function MediaExperiencesScreen({ mode, cityId, onOpenExperience }: MediaExperiencesScreenProps) {
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => fetchExperiences({ cityId, signal: opts.signal }),
    [cityId],
  );
  const { state, reload } = useLensProjection<MediaExperienceProjection[]>(
    fetcher,
    (data) => data.length === 0,
    [cityId],
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
        message="Sunsets, festivals, and nights out will appear here as they gather perspectives."
        onRetry={reload}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.intro}>Happening around you — grouped by experience, not by creator.</Text>
      <ExperienceMosaic experiences={state.data} onOpen={onOpenExperience} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.md, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg },
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
