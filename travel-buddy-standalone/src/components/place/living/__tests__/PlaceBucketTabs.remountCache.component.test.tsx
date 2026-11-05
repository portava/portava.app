/** Living destination navigation and current-source reads. Reopening a week
 * view must revalidate policy; no client image/caption cache grants access. */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
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

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { ...jest.requireActual('expo-router').router, push: jest.fn() } }));

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

describe('PlaceBucketTabs — current policy on remount', () => {
  beforeEach(() => {
    mockGetTimeline.mockReset();
  });

  it('revalidates week posts on remount and never replays stale private content', async () => {
    const id = 'place-remount-current';
    mockGetTimeline.mockResolvedValueOnce(makeTimelineResponse(id, [makeTimelinePost('old', 'Previously visible')]));
    const first = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={makeLiving(id)} />);
    await fireEvent.press(first.getByText('Top This Week'));
    await waitFor(() => expect(first.getByText('Previously visible')).toBeTruthy());
    expect(mockGetTimeline).toHaveBeenCalledWith(id, 'week', expect.objectContaining({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }));
    await first.unmount();
    let resolve!: (value: ReturnType<typeof makeTimelineResponse>) => void;
    mockGetTimeline.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const second = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={makeLiving(id)} />);
    await fireEvent.press(second.getByText('Top This Week'));
    expect(second.queryByText('Previously visible')).toBeNull();
    expect(mockGetTimeline).toHaveBeenCalledTimes(2);
    await act(async () => resolve(makeTimelineResponse(id, [])));
    expect(second.queryByText('Previously visible')).toBeNull();
  });
});

it('place bucket post thumbnails navigate to the post detail with fullscreen media', async () => {
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
  router.push.mockClear();
  const id = 'place-post-navigation';
  const living = makeLiving(id);
  living.buckets = [{ bucket: 'food', posts: [{ id: 'post-123', mediaUrl: 'https://example.com/original.jpg', thumbnailUrl: null, caption: 'Dinner' }], postCount: 8, isThin: false }];
  const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={living} />);
  await fireEvent.press(view.getByText('Food'));
  await fireEvent.press(view.getByLabelText('Open place post'));
  expect(router.push).toHaveBeenCalledWith('/post/post-123');
});


it('featured posts use canonical postId and never invent navigation IDs from list positions', async () => {
  const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
  router.push.mockClear();
  const id = 'place-featured-navigation';
  const living = makeLiving(id);
  living.bestOf = { videos: [], photos: [
    { postId: 'featured-post', mediaUrl: 'https://example.com/original.jpg', caption: 'Real post' },
    { mediaUrl: 'https://example.com/legacy.jpg', caption: 'Missing source' },
  ], viewpoints: [], foodNearby: [], experiences: [] };
  const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={living} />);
  expect(view.queryByText('Missing source')).toBeNull();
  await fireEvent.press(view.getByLabelText('Open place post'));
  expect(router.push).toHaveBeenCalledWith('/post/featured-post');
});


it('similar-photo groups open the original gallery, not thumbnail URLs or database IDs', async () => {
  const id = 'dedup-gallery'; const living = makeLiving(id);
  living.dedupGroups = [{ groupId: 'group', memberCount: 2, sampleUrls: ['https://example.com/thumb.jpg'], samples: [
    { mediaId: 'one', postId: 'post-one', mediaUrl: 'https://example.com/original.jpg', thumbnailUrl: 'https://example.com/thumb.jpg', mediaType: 'image' },
    { mediaId: 'two', postId: 'post-two', mediaUrl: 'https://example.com/second.jpg', thumbnailUrl: null, mediaType: 'image' },
  ] }];
  const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={living} />);
  await fireEvent.press(view.getByText('Similar community photos'));
  await fireEvent.press(view.getAllByLabelText('View photo full screen')[0]);
  expect(view.getByLabelText('Close full-screen photo')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Next photo'));
  await fireEvent.press(view.getByLabelText('Close full-screen photo'));
  expect(view.queryByLabelText('Close full-screen photo')).toBeNull();
});

it('similar-photo read failures remain visible instead of claiming no photos', async () => {
  const living = makeLiving('dedup-failure'); living.dedupStatus = 'unavailable';
  const view = await render(<LivingDestinationPage place={makePlace(living.placeId, 'Place')} living={living} />);
  expect(view.getByText('Similar photos are temporarily unavailable. Reopen this place to retry.')).toBeTruthy();
});


it('week request failure remains retryable rather than caching empty success', async () => {
  mockGetTimeline.mockReset(); mockGetTimeline.mockResolvedValueOnce(null);
  const id = 'week-error'; const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={makeLiving(id)} />);
  await fireEvent.press(view.getByText('Top This Week'));
  await waitFor(() => expect(view.getByLabelText('Retry week posts')).toBeTruthy());
  mockGetTimeline.mockResolvedValueOnce(makeTimelineResponse(id, [makeTimelinePost('new', 'After retry')]));
  await fireEvent.press(view.getByLabelText('Retry week posts'));
  await waitFor(() => expect(view.getByText('After retry')).toBeTruthy());
});

it('superseded timeline responses cannot replace the selected period, and failure clears the prior period', async () => {
  mockGetTimeline.mockReset();
  let resolveOld!: (value: ReturnType<typeof makeTimelineResponse>) => void;
  mockGetTimeline.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const id = 'timeline-race'; const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={makeLiving(id)} />);
  await fireEvent.press(view.getByText('This Week'));
  mockGetTimeline.mockResolvedValueOnce({ ...makeTimelineResponse(id, [makeTimelinePost('month', 'Current month')]), slice: 'month' });
  await fireEvent.press(view.getByText('This Month'));
  await waitFor(() => expect(view.getByText('Current month')).toBeTruthy());
  await act(async () => resolveOld(makeTimelineResponse(id, [makeTimelinePost('week', 'Stale week')])));
  expect(view.queryByText('Stale week')).toBeNull();
  mockGetTimeline.mockResolvedValueOnce(null);
  await fireEvent.press(view.getByText('Last Year'));
  await waitFor(() => expect(view.getByLabelText('Retry timeline posts')).toBeTruthy());
  expect(view.queryByText('Current month')).toBeNull();
  mockGetTimeline.mockResolvedValueOnce({ ...makeTimelineResponse(id, []), slice: 'year' });
  await fireEvent.press(view.getByLabelText('Retry timeline posts'));
  await waitFor(() => expect(view.queryByLabelText('Retry timeline posts')).toBeNull());
});

it('aborts and ignores a week result after unmount', async () => {
  mockGetTimeline.mockReset();
  let resolve!: (value: ReturnType<typeof makeTimelineResponse>) => void;
  mockGetTimeline.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const id = 'week-unmount'; const view = await render(<LivingDestinationPage place={makePlace(id, 'Place')} living={makeLiving(id)} />);
  await fireEvent.press(view.getByText('Top This Week'));
  const context = mockGetTimeline.mock.calls[0][2]!;
  await view.unmount(); expect(context.signal?.aborted).toBe(true);
  await act(async () => resolve(makeTimelineResponse(id, [makeTimelinePost('late', 'Retired response')])));
});
