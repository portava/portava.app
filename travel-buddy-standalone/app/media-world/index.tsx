/**
 * /media-world — the World-first Media shell route (Media v2 Phase 2).
 *
 * A NEW, additive entry point for the redesigned Media surface (the 6-lens
 * World shell). The existing Watch/Grid/Gems media tab at /(tabs)/media is
 * deliberately left untouched — this route is reached from a dev-flagged entry
 * on that tab (and via deep-link) so the new shell can be exercised without
 * demoting the old surface (demotion is a later, deliberate step).
 *
 * The shell degrades gracefully: while the parallel backend projection
 * endpoints are landing, every lens renders a clean empty/loading state and
 * never throws.
 *
 * Deep-link params (census-media §19): `lens` opens a lens directly, and
 * `experienceId` hands the EXPERIENCES lens an Event or Trip to resolve — how
 * an Event or Trip surface, or a search result, sends the viewer here.
 */
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { MediaWorldShell } from '../../src/features/media/screens/MediaWorldShell.tsx';
import { useActiveLocation } from '../../src/hooks/useActiveLocation.ts';

export default function MediaWorldRoute() {
  const { locationState } = useActiveLocation();
  const params = useLocalSearchParams<{ lens?: string; experienceId?: string }>();
  const coords = locationState.ok ? locationState.coords : null;
  const cityId = locationState.place?.canonicalId ?? locationState.place?.id ?? null;
  const cityName = locationState.place?.city ?? null;
  const experienceIds = typeof params.experienceId === 'string' && params.experienceId ? [params.experienceId] : undefined;

  return (
    <>
      <StatusBar style="light" />
      <MediaWorldShell
        cityId={cityId}
        cityName={cityName}
        lat={coords?.lat ?? null}
        lng={coords?.lng ?? null}
        initialLens={typeof params.lens === 'string' ? params.lens : null}
        experienceIds={experienceIds}
      />
    </>
  );
}
