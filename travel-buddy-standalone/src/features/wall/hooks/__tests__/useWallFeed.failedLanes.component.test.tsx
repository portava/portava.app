/**
 * census-wall §19 — useWallFeed carries which FEED lanes the server could not
 * read, for the whole session: a later page can add a missing lane, a new
 * session starts from its own first page, and the header strips' lanes are
 * not the feed's.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWallFeed } from '../useWallFeed.ts';
import { fetchWall } from '../../services/wallApi.ts';
import type { FetchWallResult } from '../../services/wallApi.ts';
import { clearFirstPageCache } from '../../services/wallPrefetch.ts';
import type { WallLane, WallProjection } from '../../types/wallProjection.ts';

// NOTE: intentional stub — wallApi loads the native supabase/apiToken chain at
// import. Two members are reachable here: `fetchWall`, and
// `revalidateCachedObjects` via wallPrefetch's cache revalidation.
jest.mock('../../services/wallApi', () => ({
  fetchWall: jest.fn(),
  revalidateCachedObjects: jest.fn(async () => ({ ok: false, error: 'Network error' })),
}));

const fetchWallMock = fetchWall as jest.Mock;

function proj(id: string): WallProjection {
  return {
    projectionId: id,
    objectType: 'social_post',
    canonicalObjectId: `post-${id}`,
    publishedAt: '2026-10-03T00:00:00.000Z',
    visibility: 'public',
    actions: [],
  } as WallProjection;
}

function page(items: WallProjection[], degraded?: WallLane[], nextCursor?: string): FetchWallResult {
  return {
    ok: true,
    degraded: false,
    data: {
      mode: 'for_you',
      liveForYou: [],
      items,
      nextCursor,
      generatedAt: '2026-10-03T00:00:00.000Z',
      ...(degraded ? { degraded } : {}),
    },
  } as FetchWallResult;
}

beforeEach(async () => {
  fetchWallMock.mockReset();
  await clearFirstPageCache('for_you');
});

it('a complete first page reports no failed lane', async () => {
  fetchWallMock.mockResolvedValue(page([proj('a')]));
  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.items.length).toBe(1));
  expect(result.current.failedLanes).toEqual([]);
});

it("a page's failed feed lanes are reported; the header strips' are not", async () => {
  fetchWallMock.mockResolvedValue(page([proj('a')], ['media', 'live', 'quick_media']));
  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.items.length).toBe(1));
  expect(result.current.failedLanes).toEqual(['media']);
});

it('a LATER page adds the lane it is missing; a refresh starts the session over', async () => {
  fetchWallMock.mockResolvedValueOnce(page([proj('a')], ['media'], 'c1'));
  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.items.length).toBe(1));
  expect(result.current.failedLanes).toEqual(['media']);

  fetchWallMock.mockResolvedValueOnce(page([proj('b')], ['postcards']));
  await act(async () => {
    result.current.loadMore();
  });
  await waitFor(() => expect(result.current.items.length).toBe(2));
  // The first page's items are still on screen, still without their media: the
  // session is missing BOTH, not only what the newest page reported.
  expect(result.current.failedLanes).toEqual(['media', 'postcards']);

  fetchWallMock.mockResolvedValueOnce(page([proj('c')]));
  await act(async () => {
    result.current.refresh();
  });
  await waitFor(() => expect(result.current.items.map((i) => i.projectionId)).toEqual(['c']));
  expect(result.current.failedLanes).toEqual([]);
});
