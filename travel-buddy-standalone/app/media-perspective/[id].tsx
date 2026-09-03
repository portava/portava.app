/**
 * /media-perspective/[id] — the §14 CONTEXTUAL media viewer route.
 *
 * A NEW, additive route for the World-first Media shell. Where the generic
 * viewer at /media-viewer/[id] pages a flat feed of grid items, this one shows
 * a perspective in the context of its entity and lets the user move between the
 * entity's OTHER perspectives (the entry-context collection) — never a global
 * stranger feed (§46.2). The generic viewer and the media tab are untouched.
 *
 * The entry-context collection is staged by the mosaic that opened it
 * (setPerspectiveViewerContext) and read here once on mount. A deep-link with no
 * staged context reads null and the screen renders a clean empty state (§33/§39).
 */
import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';

import { MediaPerspectiveViewerScreen } from '../../src/features/media/screens/MediaPerspectiveViewerScreen.tsx';
import {
  getPerspectiveViewerContext,
  clearPerspectiveViewerContext,
  type PerspectiveViewerHandoff,
} from '../../src/features/media/state/perspectiveViewerContext.ts';

export default function MediaPerspectiveRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  // Snapshot the staged entry-context collection on mount (singleton bridge).
  const [handoff] = useState<PerspectiveViewerHandoff | null>(() => getPerspectiveViewerContext());

  // Clear the staged context so it never leaks into a later open.
  useEffect(() => {
    return () => {
      clearPerspectiveViewerContext();
    };
  }, []);

  const initialMediaId = handoff?.initialMediaId ?? id ?? null;

  return (
    <>
      <StatusBar style="light" />
      <MediaPerspectiveViewerScreen
        input={handoff?.input ?? null}
        initialMediaId={initialMediaId}
        onClose={() => router.back()}
        onViewPlace={(placeId) => router.push(`/place/${placeId}` as never)}
        onAskCompass={() => router.push('/(tabs)/ai' as never)}
      />
    </>
  );
}
