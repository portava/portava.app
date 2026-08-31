/**
 * MediaWorldScreen — the NOW / World dashboard (spec §4.1/§20).
 *
 * The DEFAULT Media page: a visual dashboard of the world, NOT a list of
 * creator posts (§4.1, §46.2). Composes:
 *   - CityVisualPulse   (city visual state: An Thuong ↑ Building …)
 *   - ForYouNowStrip    (Nightlife · 18 fresh perspectives …)
 *   - ChangingNow cards (what is shifting right now)
 *
 * Presentation modes (§5): Overview (the dashboard), Map (deferred to the later
 * Media Map phase — no precise-location UI here per the hard constraint), and
 * Time (a temporal rail with observed-vs-forecast styling, §17).
 *
 * All content comes from a projection the parent loads; this screen only reads
 * it and renders empty/loading/error cleanly.
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { WorldViewState } from '../state/worldState.ts';
import type { PresentationMode, CityVisualZone, ChangingNowItem, ForYouNowItem } from '../types/mediaContext.ts';
import { CityVisualPulse } from '../components/CityVisualPulse.tsx';
import { ForYouNowStrip } from '../components/ForYouNowStrip.tsx';
import { ChangingNowCard } from '../components/ChangingNowCard.tsx';
import { MediaTimeRail, type TimeRailSegment } from '../components/MediaTimeRail.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaWorldScreenProps {
  state: WorldViewState;
  mode: PresentationMode;
  onReload?: () => void;
  onSelectZone?: (zone: CityVisualZone) => void;
  onOpenChanging?: (item: ChangingNowItem) => void;
  onWhyThis?: (item: ChangingNowItem) => void;
  onSelectForYou?: (item: ForYouNowItem) => void;
}

export function MediaWorldScreen({
  state,
  mode,
  onReload,
  onSelectZone,
  onOpenChanging,
  onWhyThis,
  onSelectForYou,
}: MediaWorldScreenProps) {
  const world = state.data;
  const showEmptyOrLoading =
    state.status === 'loading' || state.status === 'empty' || state.status === 'error' || !world;

  if (showEmptyOrLoading) {
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
    return (
      <View style={styles.modePlaceholder}>
        <Text style={styles.placeholderTitle}>Media Map</Text>
        <Text style={styles.placeholderBody}>
          The Media Map consumes Portava&apos;s canonical Map projection and arrives in a later phase.
          It shows place-level perspective clusters — never precise locations.
        </Text>
      </View>
    );
  }

  if (mode === 'time') {
    return (
      <ScrollView contentContainerStyle={styles.timeContent}>
        <Text style={styles.sectionTitle}>Right now, and what&apos;s likely next</Text>
        <MediaTimeRail segments={buildTimeRail(world.changingNow)} />
        <Text style={styles.timeNote}>
          Earlier and Now are observed. Later is a forecast — shown as &ldquo;Likely&rdquo; and never
          presented as fact (§17).
        </Text>
      </ScrollView>
    );
  }

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

/** Derive a modest Earlier/Now/Later rail from the changing-now signal. */
function buildTimeRail(changing: ChangingNowItem[]): TimeRailSegment[] {
  const headline = changing[0];
  return [
    { key: 'earlier', label: 'EARLIER', observationClass: 'observed', note: 'Quieter' },
    {
      key: 'now',
      label: 'NOW',
      observationClass: 'observed',
      isNow: true,
      note: headline?.title ?? 'Steady',
    },
    {
      key: 'later',
      label: 'LATER',
      observationClass: 'predicted',
      note: headline?.trend === 'rising' ? 'Busier' : 'Winding down',
    },
  ];
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
  modePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  placeholderTitle: { color: color.onInk, fontSize: 18, fontWeight: '800' },
  placeholderBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  timeContent: { paddingVertical: space.xl, gap: space.lg },
  sectionTitle: {
    color: color.onInk,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.3,
    paddingHorizontal: space.lg,
  },
  timeNote: {
    color: color.onInkMute,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: space.lg,
  },
});
