import { act, renderHook } from '@testing-library/react-native';
import { useQuickMedia } from '../useQuickMedia.ts';
import { fetchQuickMedia, type FetchQuickMediaResult } from '../../services/wallApi.ts';
// NOTE: exhaustive network seam; fake responses never access a real user's media.
jest.mock('../../services/wallApi.ts', () => ({ fetchQuickMedia: jest.fn() }));
const fetchMock = fetchQuickMedia as jest.Mock;
const ok = (id: string, until: number): FetchQuickMediaResult => ({ ok: true, degraded: false, items: [{ id, ownerUserId: id, actor: { userId: id, displayName: 'Traveler' }, postId: id, createdAt: new Date().toISOString(), expiresAt: new Date(until).toISOString(), media: { mediaId: id, kind: 'image' } }] });
beforeEach(() => { jest.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => jest.useRealTimers());
it('expires stories while the screen remains mounted', async () => {
  fetchMock.mockResolvedValue(ok('story', Date.now() + 10_000));
  const view = await renderHook(() => useQuickMedia());
  expect(view.result.current.entries).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(20_000); });
  expect(view.result.current.entries).toHaveLength(0);
  await view.unmount();
});
it('disable cancels an active read and a late result cannot restore the row', async () => {
  let resolve!: (result: FetchQuickMediaResult) => void;
  fetchMock.mockReturnValue(new Promise<FetchQuickMediaResult>(done => { resolve = done; }));
  const view = await renderHook<ReturnType<typeof useQuickMedia>, { enabled: boolean }>(({ enabled }) => useQuickMedia({ enabled }), { initialProps: { enabled: true } });
  const signal = fetchMock.mock.calls[0][0].signal;
  await view.rerender({ enabled: false });
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(ok('late', Date.now() + 60_000)); });
  expect(view.result.current.entries).toEqual([]); expect(view.result.current.loading).toBe(false);
  await view.unmount();
});
