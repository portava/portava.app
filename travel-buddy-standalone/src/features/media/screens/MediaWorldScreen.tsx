/**
 * MediaWorldScreen — the NOW / World dashboard (spec §4.1/§20).
 *
 * The DEFAULT Media page: a visual dashboard of the world, NOT a list of
 * creator posts (§4.1, §46.2). Composes:
 *   - CityVisualPulse   (city visual state: An Thuong ↑ Building …)
 *   - ForYouNowStrip    (Nightlife · 18 fresh perspectives …)
 *   - ChangingNow cards (what is shifting right now)
 *
 * Presentation modes (§5): Overview (the dashboard), Map (the one Media Map —
 * MediaMapScreen, place-level clusters positioned by the canonical Map), and
 * Time (MediaTimelineScreen: the §17 rail with observed-vs-forecast styling).
 *
 * All content comes from a projection the parent loads; this screen only reads
 * it and renders empty/loading/error cleanly.
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { WorldViewState } from '../state/worldState.ts';
import type { PresentationMode, CityVisualZone, ChangingNowItem, ForYouNowItem } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import { CityVisualPulse } from '../components/CityVisualPulse.tsx';
import { ForYouNowStrip } from '../components/ForYouNowStrip.tsx';
import { ChangingNowCard } from '../components/ChangingNowCard.tsx';
import { MediaTimelineScreen } from './MediaTimelineScreen.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { MediaMapScreen } from './MediaMapScreen.tsx';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';

export interface MediaWorldScreenProps {
  state: WorldViewState;
  mode: PresentationMode;
  onReload?: () => void;
  onSelectZone?: (zone: CityVisualZone) => void;
  onOpenChanging?: (item: ChangingNowItem) => void;
  onWhyThis?: (item: ChangingNowItem) => void;
  onSelectForYou?: (item: ForYouNowItem) => void; city?: string | null; center?: { lat: number; lng: number } | null; onOpenCluster?: (cluster: MediaMapCluster) => void; onOpenMedia?: (media: MediaProjection) => void;
}

export function MediaWorldScreen({
  state,
  mode,
  onReload,
  onSelectZone,
  onOpenChanging,
  onWhyThis,
  onSelectForYou, city = null, center = null, onOpenCluster, onOpenMedia,
}: MediaWorldScreenProps) {
  // Time mode is its own projection (GET /media/timeline), so it stands on its
  // own regardless of the World dashboard load — render it first.
  if (mode === 'time') {
    return <MediaTimelineScreen onOpenMedia={onOpenMedia} />;
  }

  const world = state.data;
  const showEmptyOrLoading =
    state.status === 'loading' || state.status === 'empty' || state.status === 'error' || !world;

  if (showEmptyOrLoading && mode !== 'map') { // Map, like Time, loads its own projection
    return (
      <LensStateView
        status={state.status === 'idle' ? 'loading' : state.status}
        title={state.status === 'error' ? 'The world is quiet right now' : 'Nothing changing yet'}
        message={
          state.status === 'error'
            ? 'We could not reach the intelligence network. Pull to try again.'
            : 'As people share perspectives around you, the city will come alive here.'
        }
        onRetry={onReload}
      />
    );
  }

  if (mode === 'map') {
    // NOW → Map: the one Media Map — world perspective counts positioned by the
    // canonical Map, plus §46.1 gem zones. Loads its own projections.
    return (
      <MediaMapScreen
        city={city ?? world?.city?.name ?? null}
        center={center}
        includeGems
        onOpenCluster={onOpenCluster}
      />
    );
  }
  if (!world) return null; // unreachable: showEmptyOrLoading covers it; narrows the type

  // Overview (default dashboard)
  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {world.cityVisualState.length > 0 ? (
        <View style={styles.section}>
          <CityVisualPulse zones={world.cityVisualState} onSelectZone={onSelectZone} />
        </View>
      ) : null}

      {world.forYouNow.length > 0 ? (
        <View style={styles.section}>
          <ForYouNowStrip items={world.forYouNow} onSelect={onSelectForYou} />
        </View>
      ) : null}

      {world.changingNow.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.heading}>Changing now</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.changingStrip}
          >
            {world.changingNow.map((item) => (
              <ChangingNowCard
                key={item.id}
                item={item}
                onPress={onOpenChanging}
                onWhyThis={onWhyThis}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  section: { paddingHorizontal: space.lg, gap: space.md },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  changingStrip: { gap: space.md, paddingRight: space.lg, paddingVertical: 2 },
});
