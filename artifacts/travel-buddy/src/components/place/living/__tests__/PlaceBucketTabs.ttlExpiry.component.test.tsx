/**
 * PlaceBucketTabs — weekTimelineCache TTL expiry
 *
 * Confirms that a weekTimelineCache entry whose expiresAt is in the past is
 * NOT served to the component. After the TTL elapses getPlaceTimeline must be
 * called again and the new (fresh) posts must replace the stale ones.
 *
 * Strategy: pin Date.now() to a fixed value throughout phase 1 so that
 * expiresAt = FIXED_NOW + TTL is deterministic. Then advance Date.now() to
 * FIXED_NOW + TTL + 1 before phase 2 — guaranteed to be past the expiry.
 * Unmount and re-mount with the same placeId: the component must bypass the
 * stale entry and call getPlaceTimeline exactly once more.
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

/** WEEK_TIMELINE_CACHE_TTL_MS as declared in LivingDestinationPage (5 minutes). */
const WEEK_TIMELINE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * A fixed timestamp used as the frozen "now" during phase 1.
 * Because Date.now() is pinned here, expiresAt = FIXED_NOW + TTL exactly.
 */
const FIXED_NOW = 1_700_000_000_000; // arbitrary past epoch ms

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

describe('PlaceBucketTabs — weekTimelineCache TTL expiry', () => {
  let dateSpy: jest.SpyInstance;

  afterEach(() => {
    dateSpy?.mockRestore();
    mockGetTimeline.mockReset();
  });

  it('re-fetches when the cached entry is expired — stale posts are not shown', async () => {
    const stalePosts = [makeTimelinePost('s1', 'Stale post from last hour')];
    const freshPosts = [makeTimelinePost('f1', 'Fresh post after TTL')];

    // ── Phase 1: pin time to FIXED_NOW and warm the cache ────────────────────
    // Date.now() is frozen so expiresAt = FIXED_NOW + TTL exactly (no drift).
    dateSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

    mockGetTimeline.mockResolvedValueOnce(
      makeTimelineResponse('place-ttl', stalePosts),
    );

    const { getByText: getStale, unmount } = await render(
      <LivingDestinationPage
        place={makePlace('place-ttl', 'TTL Place')}
        living={makeLiving('place-ttl')}
      />,
    );

    fireEvent.press(getStale('Top This Week'));

    // Wait until stale posts appear — cache entry is now written with
    // expiresAt = FIXED_NOW + WEEK_TIMELINE_CACHE_TTL_MS.
    await waitFor(() => expect(getStale('Stale post from last hour')).toBeTruthy());
    expect(mockGetTimeline).toHaveBeenCalledWith('place-ttl', 'week');

    unmount();

    // ── Advance time to 1 ms past the TTL boundary ───────────────────────────
    // FIXED_NOW + TTL + 1 > expiresAt = FIXED_NOW + TTL, so the entry is expired.
    dateSpy.mockReturnValue(FIXED_NOW + WEEK_TIMELINE_CACHE_TTL_MS + 1);

    mockGetTimeline.mockClear();
    mockGetTimeline.mockResolvedValueOnce(
      makeTimelineResponse('place-ttl', freshPosts),
    );

    // ── Phase 2: re-mount same placeId — expired entry must not be served ────
    const { getByText: getFresh, queryByText: queryFresh } = await render(
      <LivingDestinationPage
        place={makePlace('place-ttl', 'TTL Place')}
        living={makeLiving('place-ttl')}
      />,
    );

    fireEvent.press(getFresh('Top This Week'));

    // getPlaceTimeline must be called — the expired entry is bypassed.
    await waitFor(() =>
      expect(mockGetTimeline).toHaveBeenCalledWith('place-ttl', 'week'),
    );
    expect(mockGetTimeline).toHaveBeenCalledTimes(1);

    // Fresh posts must be visible; stale posts must be absent.
    await waitFor(() => expect(getFresh('Fresh post after TTL')).toBeTruthy());
    expect(queryFresh('Stale post from last hour')).toBeNull();
  });
});
