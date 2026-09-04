/**
 * useWallFeed — first-page cache + offline stale fallback (Wall spec §31/§37).
 *
 * Proves the wiring, not just the primitives in wallPrefetch:
 *   • a successful first page is written to the cache for fast reopen;
 *   • when the initial fetch fails (offline) the hook serves the cached page
 *     and flags it `stale` with the saved-at time — instead of an empty feed;
 *   • a typed session intent is NOT restored from cache (§17 temporary session);
 *   • once a live page arrives the stale flag clears.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWallFeed } from '../useWallFeed.ts';
import { fetchWall } from '../../services/wallApi.ts';
import type { FetchWallResult } from '../../services/wallApi.ts';
import { clearFirstPageCache, writeFirstPageCache } from '../../services/wallPrefetch.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

// NOTE: intentional stub — wallApi imports the native supabase client + the API
// token seam at module load. fetchWall is the only member useWallFeed touches;
// this exhaustive factory is complete for that seam.
jest.mock('../../services/wallApi', () => ({
  fetchWall: jest.fn(),
}));

const fetchWallMock = fetchWall as jest.Mock;

function proj(id: string): WallProjection {
  return {
    projectionId: id,
    objectType: 'social_post',
    canonicalObjectId: `post-${id}`,
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    actions: [],
  } as WallProjection;
}

function ok(items: WallProjection[]): FetchWallResult {
  return {
    ok: true,
    degraded: false,
    data: { mode: 'for_you', liveForYou: [], items, generatedAt: '2026-09-04T00:00:00.000Z' },
  } as FetchWallResult;
}

beforeEach(async () => {
  fetchWallMock.mockReset();
  await clearFirstPageCache('for_you');
  await clearFirstPageCache('following');
});

it('writes the first page to cache on a successful load', async () => {
  fetchWallMock.mockResolvedValue(ok([proj('a'), proj('b')]));
  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.items.length).toBe(2));

  // A subsequent offline hook instance should find the page in cache.
  fetchWallMock.mockResolvedValue({ ok: false, error: 'Network error' } as FetchWallResult);
  const second = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(second.result.current.stale).toBe(true));
  expect(second.result.current.items.map((i) => i.projectionId)).toEqual(['a', 'b']);
  expect(typeof second.result.current.cachedAt).toBe('number');
});

it('serves the cached page as stale when the initial fetch fails offline', async () => {
  await writeFirstPageCache('for_you', [proj('x'), proj('y')]);
  fetchWallMock.mockResolvedValue({ ok: false, error: 'Network error' } as FetchWallResult);

  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.stale).toBe(true));
  expect(result.current.items.map((i) => i.projectionId)).toEqual(['x', 'y']);
  expect(result.current.hasMore).toBe(false);
});

it('does NOT restore the cache for a typed session intent', async () => {
  await writeFirstPageCache('for_you', [proj('x')]);
  fetchWallMock.mockResolvedValue({ ok: false, error: 'Network error' } as FetchWallResult);

  const { result } = await renderHook(() => useWallFeed('for_you', 'funny travel stories'));
  await waitFor(() => expect(fetchWallMock).toHaveBeenCalled());
  // Give the failed fetch a tick to settle; the intent session must stay empty.
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.items).toEqual([]);
  expect(result.current.stale).toBe(false);
});

it('clears the stale flag once a live page arrives on refresh', async () => {
  await writeFirstPageCache('for_you', [proj('x')]);
  fetchWallMock.mockResolvedValueOnce({ ok: false, error: 'Network error' } as FetchWallResult);

  const { result } = await renderHook(() => useWallFeed('for_you'));
  await waitFor(() => expect(result.current.stale).toBe(true));

  fetchWallMock.mockResolvedValue(ok([proj('live1')]));
  await act(async () => {
    result.current.refresh();
  });
  await waitFor(() => expect(result.current.stale).toBe(false));
  expect(result.current.items.map((i) => i.projectionId)).toEqual(['live1']);
});
