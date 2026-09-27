/**
 * MediaWorldShell — the World-first Media shell host (spec §3/§4/§5/§40).
 *
 * Owns the persistent chrome (MediaWorldHeader + the 6-lens LensTabBar +
 * per-lens PresentationModeBar) and switches between the lens screens. This is
 * the NEW, additive Media surface — the existing Watch/Grid/Gems media tab is
 * left completely untouched; this shell is reached through its own route.
 *
 * Night-first dark foundation (§46). Reuses the existing WhyThisSheet (§47), the
 * §16 HiddenGemsMediaScreen for the HIDDEN GEMS lens (census-media §19 — it
 * replaced the pre-existing GemsFeed, a ranked social feed), the one Media Map
 * for every lens's Map mode, and the §14 contextual viewer for every open.
 *
 * Every perspective open goes through a §14 ENTRY CONTEXT (services/
 * perspectiveOpeners): Place, Event, Trip, People and Map each stage their own
 * scoped collection. None opens a global stranger feed (§46.2).
 */
import React, { useCallback, useReducer, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { color } from '../../../theme/tokens.ts';
import { HiddenGemsMediaScreen } from './HiddenGemsMediaScreen.tsx';
import { WhyThisSheet } from '../../../components/media/WhyThisSheet.tsx';
import { openClusterPerspectives, openExperiencePerspectives, openPersonPerspectives, openPlaceByIdPerspectives } from '../services/perspectiveOpeners.ts';
import { lensNavReducer, INITIAL_LENS_NAV, modesForLens, isLens, defaultModeForLens } from '../state/lens.ts'; import { mediaSignalRecorder } from '../../../services/mediaInteractions.ts'; import { emitMediaSignal } from '../telemetry/mediaTelemetry.ts';
import { cachedAsOfLabel } from '../state/freshness.ts';
import type { MediaLens, PresentationMode, CityVisualZone } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import type { PlaceCurrentView } from '../types/perspective.ts';
import { setPerspectiveViewerContext } from '../state/perspectiveViewerContext.ts';
import { useMediaWorld } from '../hooks/useMediaWorld.ts';
import { useExperienceSources } from '../hooks/useExperienceSources.ts';
import { MediaWorldHeader } from '../components/MediaWorldHeader.tsx';
import { LensTabBar } from '../components/LensTabBar.tsx';
import { PresentationModeBar } from '../components/PresentationModeBar.tsx';

import { MediaWorldScreen } from './MediaWorldScreen.tsx';
import { MediaPlacesScreen } from './MediaPlacesScreen.tsx';
import { MediaExperiencesScreen } from './MediaExperiencesScreen.tsx';
import { MediaPeopleScreen } from './MediaPeopleScreen.tsx';
import { MyWorldMediaScreen } from './MyWorldMediaScreen.tsx';

export interface MediaWorldShellProps {
  /** Coarse location inputs for the World projection (place-level only). */
  cityId?: string | null;
  /** The coarse city LABEL — the scope `/media/world`, `/media/map` and `/media/gems` read. */
  cityName?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Deep-linked lens (`/media-world?lens=experiences`). Unknown ⇒ NOW. */
  initialLens?: string | null;
  /** Deep-linked Event / Trip ids for the EXPERIENCES lens. */
  experienceIds?: string[]; /** census-media §34 (F1): drawn under the header — the Media tab's mode switcher when the shell is the tab's own mode. Absent everywhere else. */ headerAccessory?: React.ReactNode;
}

/** A generic viewer open — only for a changing-now card that names no canonical place. */
function openMediaViewer(media: MediaProjection) {
  if (!media.id) return;
  router.push(`/media-viewer/${encodeURIComponent(media.id)}` as never);
}

/**
 * §14 contextual open — stage the Place's current view as the entry-context
 * collection and route to the contextual perspective viewer so the user can
 * navigate this place's OTHER perspectives (never a global stranger feed,
 * §46.2). Falls back to the generic viewer when the media carries no id.
 */
function openPlacePerspectiveViewer({ media, view }: { media: MediaProjection; view: PlaceCurrentView }) {
  if (!media.id) return;
  setPerspectiveViewerContext({
    input: {
      kind: 'place',
      entityId: view.placeId,
      entityLabel: view.placeName,
      groups: view.groups,
      media: view.heroMedia,
    },
    initialMediaId: media.id,
  });
  router.push(`/media-perspective/${encodeURIComponent(media.id)}` as never);
}

function MediaWorldShellInner({ cityId, cityName: cityNameProp = null, lat, lng, initialLens = null, experienceIds: linkedExperienceIds, headerAccessory = null }: MediaWorldShellProps) {
  const [nav, dispatch] = useReducer(lensNavReducer, INITIAL_LENS_NAV, (s) => initialNav(s, initialLens));
  const { state: worldState, reload } = useMediaWorld({ cityId, city: cityNameProp, lat, lng });
  const [why, setWhy] = useState<{ visible: boolean; explanation: string | null }>({
    visible: false,
    explanation: null,
  });

  const world = worldState.data;
  const cityName = world?.city?.name ?? cityNameProp ?? null;
  const zones: CityVisualZone[] = world?.cityVisualState ?? [];

  const selectLens = useCallback((lens: MediaLens) => dispatch({ type: 'select_lens', lens }), []);
  const selectMode = useCallback((mode: PresentationMode) => dispatch({ type: 'select_mode', mode }), []);

  const asOf =
    nav.lens === 'now' && world?.generatedAt
      ? cachedAsOfLabel(ageMinutesFrom(world.generatedAt))
      : null;

  const modes = modesForLens(nav.lens);
  const center = lat != null && lng != null ? { lat, lng } : null;
  const experienceIds = useExperienceSources({ deepLinkedIds: linkedExperienceIds, center });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <MediaWorldHeader
        cityName={cityName}
        asOfLabel={asOf}
        onSearch={() => router.push('/media-search' as never)}
        onCompass={() => router.push('/(tabs)/ai' as never)}
      />{headerAccessory}

      <LensTabBar active={nav.lens} onSelect={selectLens} />
      <PresentationModeBar modes={modes} active={nav.mode} onSelect={selectMode} />

      <View style={styles.content}>
        {nav.lens === 'now' && (
          <MediaWorldScreen
            state={worldState}
            mode={nav.mode}
            onReload={reload}
            onSelectZone={() => { emitMediaSignal(mediaSignalRecorder, 'visual_opportunity_open', { surface: 'now_zone' }); selectLens('places'); }}
            onOpenChanging={(item) => {
              const hero = item.heroMedia?.[0];
              // §14: a changing-now card IS a place — open that place's perspectives.
              if (item.placeId || hero) emitMediaSignal(mediaSignalRecorder, 'visual_opportunity_open', { mediaId: hero?.id ?? null, placeId: item.placeId ?? null, surface: 'now_changing' });
              if (item.placeId) void openPlaceByIdPerspectives(item.placeId, hero ?? null);
              else if (hero) openMediaViewer(hero);
            }}
            // §47: offer "Why this?" only where the server supplied a reason. The
            // sheet's generic fallback sentence is an invented explanation, and a
            // card with no reason must not open it (census-media §19, MD428).
            onWhyThis={(item) => {
              if (item.whyThis) setWhy({ visible: true, explanation: item.whyThis });
            }}
            onSelectForYou={(item) => { emitMediaSignal(mediaSignalRecorder, 'visual_opportunity_open', { surface: 'now_for_you' }); selectLens(item.lens ?? 'now'); }}
            city={cityName}
            center={center}
            onOpenCluster={(c) => void openClusterPerspectives(c)}
            onOpenMedia={openMediaViewer}
          />
        )}

        {nav.lens === 'places' && (
          <MediaPlacesScreen
            mode={nav.mode}
            zones={zones}
            onOpenMedia={openMediaViewer}
            onOpenPerspective={openPlacePerspectiveViewer}
            onAskCompass={() => router.push('/(tabs)/ai' as never)}
            city={cityName}
            center={center}
            onOpenCluster={(c) => void openClusterPerspectives(c)}
            onContribute={(placeId) => router.push(`/media-contribute?placeId=${encodeURIComponent(placeId)}` as never)}
          />
        )}

        {nav.lens === 'experiences' && (
          // §43 resolves an experience per canonical Event/Trip id; there is no
          // "list experiences" endpoint, so the lens resolves the ids
          // useExperienceSources gathers — a deep-linked id, the viewer's own
          // events and trips, and events near them. Tapping one opens its §14
          // EVENT or TRIP entry context.
          <MediaExperiencesScreen
            mode={nav.mode}
            experienceIds={experienceIds}
            onOpenExperience={(exp) => openExperiencePerspectives(exp)}
            city={cityName}
            center={center}
            onOpenCluster={(c) => void openClusterPerspectives(c)}
          />
        )}

        {nav.lens === 'gems' && (
          <HiddenGemsMediaScreen
            mode={nav.mode}
            city={cityName}
            center={center}
            onOpenGem={(gemId) => { emitMediaSignal(mediaSignalRecorder, 'gem_open', { gemId, surface: 'world_gems' }); router.push(`/gems/${encodeURIComponent(gemId)}` as never); }}
          />
        )}

        {nav.lens === 'people' && (
          <MediaPeopleScreen
            onOpenMedia={openMediaViewer}
            onOpenPerson={(group, media) => openPersonPerspectives(group, media)}
          />
        )}

        {nav.lens === 'my_world' && (
          <MyWorldMediaScreen
            mode={nav.mode}
            onOpenMedia={openMediaViewer}
            center={center}
            onOpenCluster={(c) => void openClusterPerspectives(c)}
            onOpenPlace={(placeId) => router.push(`/place/${encodeURIComponent(placeId)}` as never)}
          />
        )}
      </View>

      <WhyThisSheet
        visible={why.visible} footnote={WORLD_WHY_FOOTNOTE}
        explanation={why.explanation}
        onClose={() => setWhy({ visible: false, explanation: null })}
      />
    </SafeAreaView>
  );
}

export function MediaWorldShell(props: MediaWorldShellProps) {
  return <MediaWorldShellInner {...props} />;
}

/** The shell's first lens: a deep-linked lens when it names a real one, else NOW. */
function initialNav(base: typeof INITIAL_LENS_NAV, lens: string | null): typeof INITIAL_LENS_NAV {
  if (!lens || !isLens(lens)) return base;
  return { lens, mode: defaultModeForLens(lens) };
}

/** Minutes between an ISO timestamp and now; null when unparseable. */
function ageMinutesFrom(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ink },
  content: { flex: 1 },
});

/**
 * The "Why this?" footnote on World items (census-media §28.3). The shared
 * sheet's default describes the Watch ranker ("creators you engage with"). The
 * World's §24 ranker reads no engagement: it reads what the viewer said they
 * want, their trips, their saved places, who they follow, and how fresh and
 * useful a perspective is. Its "location" is an active trip's destination,
 * never GPS (api-server lib/mediaRankingSignals.ts `locationTerm`).
 */
const WORLD_WHY_FOOTNOTE =
  "World picks are shaped by what you've said you want, the trips you're on, places you've saved, people you follow, and how fresh and useful a perspective is. Where you are means your trip's destination — never your exact location.";
