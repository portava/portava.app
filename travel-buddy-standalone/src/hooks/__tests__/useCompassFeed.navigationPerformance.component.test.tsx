import { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { useCompassFeed } from '../compass/useCompassFeed.ts';
import { fetchCompassSection, getCachedFeed, setCachedFeed, type CompassFeedResponse } from '../../services/compass.ts';

let mockUserId = 'owner-a';
// NOTE: isolate authentication and transport; the real hook and its focus-like consumer run below.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUserId, isAuthed: true }) }));
// NOTE: no native auth client should be constructed by these scheduling tests.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
jest.mock('../../services/compass.ts', () => ({
  ...jest.requireActual('../../services/compass.ts'),
  fetchCompassSection: jest.fn(), getCachedFeed: jest.fn(), setCachedFeed: jest.fn(),
}));

const feed = (id: string): CompassFeedResponse => ({
  sections: [{ name: 'for_you', total: 1, items: [{ id, type: 'place', category: 'food' }] }],
  nextCursor: null, fallback: false, compassEnabled: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve: (value: T) => resolve(value) };
}
function useFocusedFeed(city: string) {
  const result = useCompassFeed({ city });
  // useFocusEffect re-runs a focused callback when its dependencies change.
  useEffect(() => { result.refreshIfStale(); }, [result.refreshIfStale]);
  return result;
}
beforeEach(() => {
  jest.resetAllMocks(); mockUserId = 'owner-a';
  jest.mocked(getCachedFeed).mockResolvedValue(null);
  jest.mocked(setCachedFeed).mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

it('opens with one request and does not repeat after data or a fresh focus arrives', async () => {
  const response = deferred<Awaited<ReturnType<typeof fetchCompassSection>>>();
  jest.mocked(fetchCompassSection).mockReturnValue(response.promise);
  const view = await renderHook(() => useFocusedFeed('Cebu'));
  const refresh = view.result.current.refresh;
  const refreshIfStale = view.result.current.refreshIfStale;
  await act(async () => { view.result.current.refresh(); view.result.current.refreshIfStale(); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(1);
  await act(async () => { response.resolve({ ok: true, data: feed('first') }); });
  expect(view.result.current.data?.sections[0].items[0].id).toBe('first');
  expect(view.result.current.refresh).toBe(refresh);
  expect(view.result.current.refreshIfStale).toBe(refreshIfStale);
  await act(async () => { view.result.current.refreshIfStale(); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(1);
});

it('refreshes stale focus data while manual refresh bypasses freshness', async () => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(fetchCompassSection).mockResolvedValue({ ok: true, data: feed('first') });
  const view = await renderHook(() => useFocusedFeed('Cebu'));
  await act(async () => { view.result.current.refresh(); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(now + 60_001);
  await act(async () => { view.result.current.refreshIfStale(); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(3);
});

it('ignores old city responses and allows the new city request immediately', async () => {
  const old = deferred<Awaited<ReturnType<typeof fetchCompassSection>>>();
  jest.mocked(fetchCompassSection).mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, data: feed('Da Nang') });
  const view = await renderHook(({ city }: { city: string }) => useFocusedFeed(city), { initialProps: { city: 'Cebu' } });
  await view.rerender({ city: 'Da Nang' });
  await act(async () => { old.resolve({ ok: true, data: feed('Cebu') }); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(2);
  expect(view.result.current.data?.sections[0].items[0].id).toBe('Da Nang');
  expect(setCachedFeed).toHaveBeenCalledTimes(1);
});

it('does not let a late disk cache overwrite a completed network read', async () => {
  const cache = deferred<CompassFeedResponse | null>();
  jest.mocked(getCachedFeed).mockReturnValue(cache.promise);
  jest.mocked(fetchCompassSection).mockResolvedValue({ ok: true, data: feed('fresh') });
  const view = await renderHook(() => useFocusedFeed('Cebu'));
  await act(async () => { cache.resolve(feed('old')); });
  expect(view.result.current.data?.sections[0].items[0].id).toBe('fresh');
  expect(fetchCompassSection).toHaveBeenCalledTimes(1);
});

it('does not display the previous account’s feed while the next account loads', async () => {
  const next = deferred<Awaited<ReturnType<typeof fetchCompassSection>>>();
  jest.mocked(fetchCompassSection).mockResolvedValueOnce({ ok: true, data: feed('owner-a') }).mockReturnValueOnce(next.promise);
  const view = await renderHook(() => useFocusedFeed('Cebu'));
  mockUserId = 'owner-b';
  await view.rerender(undefined);
  expect(view.result.current.data).toBeNull();
  await act(async () => { next.resolve({ ok: true, data: feed('owner-b') }); });
  expect(view.result.current.data?.sections[0].items[0].id).toBe('owner-b');
  expect(setCachedFeed).toHaveBeenLastCalledWith('owner-b', expect.any(Object));
});

it('permits a failed request to retry on the next focus without a request loop', async () => {
  jest.mocked(fetchCompassSection).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ ok: true, data: feed('retried') });
  const view = await renderHook(() => useFocusedFeed('Cebu'));
  expect(fetchCompassSection).toHaveBeenCalledTimes(1);
  expect(view.result.current.error).toBe('network_error');
  await act(async () => { view.result.current.refreshIfStale(); });
  expect(fetchCompassSection).toHaveBeenCalledTimes(2);
  expect(view.result.current.error).toBeNull();
});
