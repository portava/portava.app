/**
 * HiddenGemsMediaScreen — the §4 "Hidden Gems Media" screen and the HIDDEN GEMS
 * lens (spec §3 / §4 / §5 / §16 / §16.2 / §40 / §46.1; census-media §19).
 *
 * It renders the §16 gem-STATE projection served by `GET /media/gems`
 * (MediaGemStateService) — derived state, bounded evidence, and an order from
 * `rankGems`, in which saves and visits are not inputs (§16.2). It replaces the
 * pre-existing `components/media/GemsFeed`, which the World shell used to mount
 * here and which is a ranked SOCIAL feed over `GET /media/gems-feed`.
 *
 * It honours all three §5 modes for this lens:
 *   • OVERVIEW — the §3 lens output as sections: Recently confirmed · Worth the
 *     detour · Still hidden · Seasonal · Access changed · Visit gently;
 *   • VISUAL   — a two-column mosaic of the gems' own imagery, each tile carrying
 *     the §46.1 contour treatment;
 *   • MAP      — the one Media Map, gems only, drawn as §46.1 contoured zones
 *     (approximate) or contoured markers (place-level), restricted to the gems
 *     this lens itself disclosed.
 *
 * "The gem table did not answer" is never rendered as "no gems here": an
 * undetermined list is an error state, and a partially-determined one says so.
 */
import React, { useCallback, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import type { HiddenGemLensItem, HiddenGemLensProjection } from '../types/hiddenGemMedia.ts';
import type { ProjectionResult } from '../types/media.ts';
import { fetchGems } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { gemLensReadState, isGemLensEmpty, sectionGemLens } from '../state/gemLens.ts';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import { HiddenGemCard } from '../components/HiddenGemCard.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { MediaMapScreen } from './MediaMapScreen.tsx';

export interface HiddenGemsMediaScreenProps {
  mode: PresentationMode;
  /** Coarse city label — the scope `GET /media/gems` reads. */
  city?: string | null;
  /** Coarse viewport centre for Map mode. */
  center?: { lat: number; lng: number } | null;
  onOpenGem?: (gemId: string) => void;
}

/** Gems-only map: the lens contributes no perspective clusters. */
const NO_CLUSTERS = (): Promise<ProjectionResult<MediaMapCluster[]>> =>
  Promise.resolve({ ok: true as const, data: [] });

export function HiddenGemsMediaScreen({ mode, city = null, center = null, onOpenGem }: HiddenGemsMediaScreenProps) {
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => fetchGems({ city, signal: opts.signal }),
    [city],
  );
  const { state, reload } = useLensProjection<HiddenGemLensProjection>(fetcher, isGemLensEmpty, [city]);
  const lens = state.data;
  const readState = gemLensReadState(lens);
  const gemIds = useMemo(() => new Set((lens?.gems ?? []).map((g) => g.gemId)), [lens]);
  const open = useCallback((g: HiddenGemLensItem) => onOpenGem?.(g.gemId), [onOpenGem]);

  if (state.status !== 'ready' || !lens || readState === 'list_unreadable') {
    const unreadable = state.status === 'error' || (state.status === 'ready' && readState === 'list_unreadable');
    return (
      <LensStateView
        status={unreadable ? 'error' : state.status === 'idle' ? 'loading' : state.status}
        title={unreadable ? 'Hidden gems could not be read' : 'No hidden gems here yet'}
        message={
          unreadable
            ? 'We could not read gem conditions right now. That is not the same as there being none here.'
            : 'Hidden gems appear here once they are confirmed and safe to share. Protected places never do.'
        }
        onRetry={reload}
      />
    );
  }

  if (mode === 'map') {
    return (
      <MediaMapScreen
        city={city}
        center={center}
        loadClusters={NO_CLUSTERS}
        includeGems
        allowGemIds={gemIds}
        reloadKey={lens.generatedAt ?? ''}
        title="Hidden Gems"
        emptyTitle="No hidden gems on the map yet"
        emptyMessage="Gems appear as contoured areas once the map can place them — never as an exact point."
        onOpenGem={onOpenGem}
      />
    );
  }

  const partial =
    readState === 'state_partial' ? (
      <Text style={styles.partial} testID="gem-lens-partial">
        Some gem conditions could not be read just now — states shown may be incomplete.
      </Text>
    ) : null;

  if (mode === 'visual') {
    const left: HiddenGemLensItem[] = [];
    const right: HiddenGemLensItem[] = [];
    lens.gems.forEach((g, i) => (i % 2 === 0 ? left : right).push(g));
    return (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="gem-lens-visual">
        {partial}
        <View style={styles.columns}>
          <View style={styles.column}>
            {left.map((g) => (
              <HiddenGemCard key={g.gemId} gem={g} variant="tile" onOpen={open} />
            ))}
          </View>
          <View style={styles.column}>
            {right.map((g) => (
              <HiddenGemCard key={g.gemId} gem={g} variant="tile" onOpen={open} />
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  // OVERVIEW (the lens default).
  const sections = sectionGemLens(lens.gems);
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="gem-lens-overview">
      <Text style={styles.intro}>Protected discovery — shown by current condition, never by popularity.</Text>
      {partial}
      {sections.map((section) => (
        <View key={section.key} style={styles.section} testID={`gem-section-${section.key}`}>
          <Text style={styles.heading}>{section.label}</Text>
          <View style={styles.sectionBody}>
            {section.gems.map((g) => (
              <HiddenGemCard key={g.gemId} gem={g} onOpen={open} />
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.lg, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg },
  partial: { color: color.warn, fontSize: 12, lineHeight: 17, paddingHorizontal: space.lg },
  section: { gap: space.sm },
  sectionBody: { gap: space.sm },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
  columns: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  column: { flex: 1, gap: space.sm },
});
