/**
 * MediaWorldShell — the World-first Media shell host (spec §3/§4/§5/§40).
 *
 * Owns the persistent chrome (MediaWorldHeader + the 6-lens LensTabBar +
 * per-lens PresentationModeBar) and switches between the lens screens. This is
 * the NEW, additive Media surface — the existing Watch/Grid/Gems media tab is
 * left completely untouched; this shell is reached through its own route.
 *
 * Night-first dark foundation (§46). Reuses the existing WhyThisSheet (§47), the
 * existing GemsFeed for the HIDDEN GEMS lens (§16), and the existing media
 * viewer for opening an item — nothing is forked.
 *
 * The whole shell is wrapped in the existing MediaStoreProvider so the reused
 * GemsFeed has the store context it expects.
 */
import React, { useCallback, useReducer, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { color } from '../../../theme/tokens.ts';
import { MediaStoreProvider } from '../../../stores/mediaStore.ts';
import { WhyThisSheet } from '../../../components/media/WhyThisSheet.tsx';
import { GemsFeed } from '../../../components/media/GemsFeed.tsx';

import { lensNavReducer, INITIAL_LENS_NAV, modesForLens } from '../state/lens.ts';
import { cachedAsOfLabel } from '../state/freshness.ts';
import type { MediaLens, PresentationMode, CityVisualZone } from '../types/mediaContext.ts';
import type { MediaProjection } from '../types/media.ts';
import { useMediaWorld } from '../hooks/useMediaWorld.ts';

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
  lat?: number | null;
  lng?: number | null;
}

/** Stable empty id list so the Experiences lens fetcher identity is stable. */
const EMPTY_EXPERIENCE_IDS: string[] = [];

function openMediaViewer(media: MediaProjection) {
  if (!media.id) return;
  router.push(`/media-viewer/${encodeURIComponent(media.id)}` as never);
}

function MediaWorldShellInner({ cityId, lat, lng }: MediaWorldShellProps) {
  const [nav, dispatch] = useReducer(lensNavReducer, INITIAL_LENS_NAV);
  const { state: worldState, reload } = useMediaWorld({ cityId, lat, lng });
  const [why, setWhy] = useState<{ visible: boolean; explanation: string | null }>({
    visible: false,
    explanation: null,
  });

  const world = worldState.data;
  const cityName = world?.city?.name ?? null;
  const zones: CityVisualZone[] = world?.cityVisualState ?? [];

  const selectLens = useCallback((lens: MediaLens) => dispatch({ type: 'select_lens', lens }), []);
  const selectMode = useCallback((mode: PresentationMode) => dispatch({ type: 'select_mode', mode }), []);

  const asOf =
    nav.lens === 'now' && world?.generatedAt
      ? cachedAsOfLabel(ageMinutesFrom(world.generatedAt))
      : null;

  const modes = modesForLens(nav.lens);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <MediaWorldHeader
        cityName={cityName}
        asOfLabel={asOf}
        onSearch={() => router.push('/search' as never)}
        onCompass={() => router.push('/(tabs)/ai' as never)}
      />

      <LensTabBar active={nav.lens} onSelect={selectLens} />
      <PresentationModeBar modes={modes} active={nav.mode} onSelect={selectMode} />

      <View style={styles.content}>
        {nav.lens === 'now' && (
          <MediaWorldScreen
            state={worldState}
            mode={nav.mode}
            onReload={reload}
            onSelectZone={() => selectLens('places')}
            onOpenChanging={(item) => {
              const hero = item.heroMedia?.[0];
              if (hero) openMediaViewer(hero);
            }}
            onWhyThis={(item) => setWhy({ visible: true, explanation: item.whyThis ?? null })}
            onSelectForYou={(item) => selectLens(item.lens ?? 'now')}
          />
        )}

        {nav.lens === 'places' && (
          <MediaPlacesScreen
            mode={nav.mode}
            zones={zones}
            onOpenMedia={openMediaViewer}
            onAskCompass={() => router.push('/(tabs)/ai' as never)}
          />
        )}

        {nav.lens === 'experiences' && (
          // §43 resolves an experience per canonical Event/Trip id; there is no
          // "list experiences" endpoint in this phase, so the lens resolves the
          // specific ids it is handed (deep-link / trip / event context) and
          // degrades to a clean empty state with none. Experience discovery is a
          // later phase; passing [] keeps the wiring real without a fake list call.
          <MediaExperiencesScreen mode={nav.mode} experienceIds={EMPTY_EXPERIENCE_IDS} />
        )}

        {nav.lens === 'gems' && (
          <GemsFeed
            onViewPlace={(item) => {
              const placeId = item.location?.canonicalPlaceId;
              if (placeId) router.push(`/place/${placeId}` as never);
            }}
          />
        )}

        {nav.lens === 'people' && <MediaPeopleScreen onOpenMedia={openMediaViewer} />}

        {nav.lens === 'my_world' && (
          <MyWorldMediaScreen mode={nav.mode} onOpenMedia={openMediaViewer} />
        )}
      </View>

      <WhyThisSheet
        visible={why.visible}
        explanation={why.explanation}
        onClose={() => setWhy({ visible: false, explanation: null })}
      />
    </SafeAreaView>
  );
}

export function MediaWorldShell(props: MediaWorldShellProps) {
  // Wrap in the existing media store so the reused GemsFeed has its context.
  return (
    <MediaStoreProvider defaultMode="gems" enabledModes={['gems']} flagsLoading={false}>
      <MediaWorldShellInner {...props} />
    </MediaStoreProvider>
  );
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
