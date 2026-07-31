/**
 * PlaceBucketTabs — weekTimelineCache remount cache hit
 *
 * Confirms that the module-level weekTimelineCache serves a warm entry on
 * remount: when the same placeId is visited twice within the TTL, exactly one
 * network call is made. The second mount reads from cache and shows the same
 * posts without triggering getPlaceTimeline again.
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

function makeTimelineResponse(
  placeId: string,
  posts: ReturnType<typeof makeTimelinePost>[],
) {
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

describe('PlaceBucketTabs — weekTimelineCache remount hit', () => {
  beforeEach(() => {
    mockGetTimeline.mockReset();
  });

  it('serves the cached week-timeline on remount — getPlaceTimeline is called exactly once total', async () => {
    // Use a placeId that is unique to this test file so it never collides
    // with entries written by other test files in the same jest worker.
    const PLACE_ID   = 'place-remount-cache-test';
    const PLACE_NAME = 'Remount Cache Place';

    const posts = [makeTimelinePost('rc1', 'Canyon at dawn')];

    mockGetTimeline.mockImplementation((placeId: string) =>
      Promise.resolve(makeTimelineResponse(placeId, posts)),
    );

    // ── Phase 1: first mount — populates the cache ────────────────────────────
    const { getByText: get1, unmount: unmount1 } = await render(
      <LivingDestinationPage
        place={makePlace(PLACE_ID, PLACE_NAME)}
        living={makeLiving(PLACE_ID)}
      />,
    );

    // Activate the "Top This Week" tab
    fireEvent.press(get1('Top This Week'));

    // Wait until the post caption appears — confirms the cache entry was written
    await waitFor(() => expect(get1('Canyon at dawn')).toBeTruthy());
    expect(mockGetTimeline).toHaveBeenCalledTimes(1);
    expect(mockGetTimeline).toHaveBeenCalledWith(PLACE_ID, 'week');

    unmount1();

    // ── Phase 2: second mount within TTL — must hit the cache ─────────────────
    // Reset the call counter only; keep the implementation intact in case
    // a cache miss somehow occurs (the test would then see the right posts
    // but would fail on the call-count assertion below).
    mockGetTimeline.mockClear();

    const { getByText: get2 } = await render(
      <LivingDestinationPage
        place={makePlace(PLACE_ID, PLACE_NAME)}
        living={makeLiving(PLACE_ID)}
      />,
    );

    // Activate the same tab on the second mount
    fireEvent.press(get2('Top This Week'));

    // The post must be visible immediately from the cache (no loading spinner)
    await waitFor(() => expect(get2('Canyon at dawn')).toBeTruthy());

    // The network should NOT have been called again
    expect(mockGetTimeline).toHaveBeenCalledTimes(0);
  });
});
