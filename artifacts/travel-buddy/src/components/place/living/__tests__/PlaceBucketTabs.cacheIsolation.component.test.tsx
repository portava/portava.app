/**
 * PlaceBucketTabs — weekTimelineCache isolation across different places
 *
 * Confirms that the module-level weekTimelineCache is keyed strictly by
 * placeId, so navigating from place-A to place-B in the same session
 * does NOT serve place-A's cached week-timeline to place-B.
 *
 * Specifically:
 *  - After the cache is warm for "place-A", rendering with "place-B"
 *    still calls getPlaceTimeline exactly once for "place-B".
 *  - The grid shows place-B posts, not place-A posts.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { LivingDestinationPage } from '../LivingDestinationPage.tsx';
import type { PlaceLivingResponse } from '../../../../types/placeLiving.ts';
import type { CanonicalPlace } from '../../../../types/canonicalPlace.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// lucide-react-native, expo-router, and @react-native-async-storage/async-storage
// are globally mocked via jest.config.js moduleNameMapper — no per-file mocks needed.

// NOTE: intentionally exhaustive — expo-linear-gradient pulls a native gradient
// module that is unavailable under jest-expo; a plain View wrapper is sufficient.
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// NOTE: intentionally exhaustive — CachedImage wraps expo-image which pulls in
// native modules unavailable under jest-expo; a stub View is sufficient because
// assertions target caption text, not image rendering.
jest.mock('../../../CachedImage.tsx', () => {
  const { View } = require('react-native');
  return {
    CachedImage: () => require('react').createElement(View, null),
  };
});

// NOTE: intentionally exhaustive — only getPlaceTimeline is needed; the rest of
// the places service imports Supabase native internals that crash under jest-expo.
jest.mock('../../../../services/places.ts', () => ({
  getPlaceTimeline: jest.fn(),
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

import { getPlaceTimeline } from '../../../../services/places.ts';
const mockGetTimeline = getPlaceTimeline as jest.MockedFunction<typeof getPlaceTimeline>;

function makeTimelinePost(id: string, caption: string) {
  return {
    id,
    caption,
    mediaUrl:     null,
    thumbnailUrl: null,
    authorId:     null,
    createdAt:    null,
    like_count:   1,
  };
}

function makeTimelineResponse(placeId: string, posts: ReturnType<typeof makeTimelinePost>[]) {
  return {
    placeId,
    slice:        'week' as const,
    posts,
    total:        posts.length,
    crowdLevel:   null,
    weatherBrief: null,
  };
}

function makeLiving(placeId: string): PlaceLivingResponse {
  return {
    placeId,
    sparseMode:   false, // ensures PlaceBucketTabs renders (not sparse-mode fallback)
    hero:         { imageUrl: null, videoUrl: null },
    rating:       null,
    bestTime:     null,
    crowdLevel:   null,
    weather:      null,
    directionsUrl: null,
    officialInfo: {
      hours:       null,
      isOpenNow:   null,
      address:     null,
      phone:       null,
      website:     null,
      priceLevel:  null,
      rating:      null,
      reviewCount: null,
      bookingUrl:  null,
      attribution: [],
    },
    aiSummary:      null,
    buckets:        [],
    timeline:       { slice: 'today', posts: [], crowdLevel: null, weatherBrief: null },
    bestOf:         null,
    dedupGroups:    [],
    topContributor: null,
    thinBuckets:    [],
    generatedAt:    '2026-01-01T00:00:00Z',
  };
}

function makePlace(id: string, name: string): CanonicalPlace {
  return {
    id,
    name,
    category:     'attraction',
    coordinates:  { lat: 0, lng: 0 },
    address:      null,
    city:         null,
    neighborhood: null,
    countryCode:  null,
    status:       'active',
    detailRoute:  `/place/${id}`,
    attribution:  [],
    sources:      [],
    fieldFreshness: {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceBucketTabs — weekTimelineCache isolation', () => {
  beforeEach(() => {
    mockGetTimeline.mockReset();
  });

  it('fetches place-B data even when place-A cache is warm — posts from place-A do not bleed through', async () => {
    const postsA = [makeTimelinePost('a1', 'Sunrise at Place A')];
    const postsB = [makeTimelinePost('b1', 'Sunset at Place B')];

    mockGetTimeline.mockImplementation((placeId: string) =>
      Promise.resolve(
        makeTimelineResponse(
          placeId,
          placeId === 'place-A' ? postsA : postsB,
        ),
      ),
    );

    // ── Phase 1: warm the cache for place-A ──────────────────────────────────
    const {
      getByText: getA,
      unmount: unmountA,
    } = await render(
      <LivingDestinationPage
        place={makePlace('place-A', 'Place A')}
        living={makeLiving('place-A')}
      />,
    );

    // Switch PlaceBucketTabs to the "Top This Week" tab
    fireEvent.press(getA('Top This Week'));

    // Wait until place-A posts appear — confirming the cache entry was written
    await waitFor(() => expect(getA('Sunrise at Place A')).toBeTruthy());
    expect(mockGetTimeline).toHaveBeenCalledWith('place-A', 'week');

    unmountA();

    // ── Phase 2: render place-B — cache must NOT be served for it ────────────
    mockGetTimeline.mockClear(); // reset call count; implementation stays intact

    const {
      getByText: getB,
      queryByText: queryB,
    } = await render(
      <LivingDestinationPage
        place={makePlace('place-B', 'Place B')}
        living={makeLiving('place-B')}
      />,
    );

    fireEvent.press(getB('Top This Week'));

    // getPlaceTimeline must be called exactly once for place-B — not skipped
    await waitFor(() =>
      expect(mockGetTimeline).toHaveBeenCalledWith('place-B', 'week'),
    );
    expect(mockGetTimeline).toHaveBeenCalledTimes(1);

    // place-B posts must appear; place-A posts must be absent
    await waitFor(() => expect(getB('Sunset at Place B')).toBeTruthy());
    expect(queryB('Sunrise at Place A')).toBeNull();
  });
});
