import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { UnifiedPostComposer } from '../src/components/PulseCreate';
import type { Place } from '../src/lib/location/placeTypes';

/**
 * /create — full-screen post composer page.
 *
 * Opened by the center POST stamp button in the tab bar, the desktop sidebar
 * compose button, and the various "Add Post" empty-state CTAs, so all
 * creation entry-points behave identically. The page
 * closes (router.back) when the user dismisses it or right after the
 * post/postcard is created; each navigation mounts a fresh composer.
 *
 * Optional search params:
 *   placeId    — canonical place id to pre-tag on the post
 *   placeName  — display name for the place (shown in the location chip)
 *   bucket     — bucket hint from the place page (e.g. 'night')
 */
export default function Create() {
  // Once-guard: the composer may invoke both onSuccess and onClose for a
  // single post (see handleSubmitResult / HighlightComposer success path).
  // With the composer on a real route, dismissing twice would pop TWO
  // screens — the guard makes the second call a no-op.
  const dismissed = React.useRef(false);
  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)' as any);
    }
  }

  const { placeId, placeName, bucket } = useLocalSearchParams<{
    placeId?: string;
    placeName?: string;
    bucket?: string;
  }>();

  // Build a minimal Place snapshot from the query params so the composer
  // opens with the location chip pre-populated.
  const initialPlace: Place | null =
    placeId && placeName
      ? {
          id: placeId,
          type: 'place',
          name: placeName,
          displayName: placeName,
          country: null,
          countryCode: null,
          region: null,
          city: null,
          district: null,
          lat: null,
          lng: null,
          timezone: null,
          source: 'canonical',
          canonicalId: placeId,
        }
      : null;

  return (
    <UnifiedPostComposer
      onClose={dismiss}
      onSuccess={dismiss}
      openCameraOnMount={!initialPlace}
      initialPlace={initialPlace}
      initialBucket={bucket ?? null}
    />
  );
}
