import { act, renderHook } from '@testing-library/react-native';
import { useLiveForYou } from '../useLiveForYou.ts';
import { fetchLiveForYou, type FetchLiveResult } from '../../services/wallApi.ts';
import { setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';

// NOTE: the network seam is controlled here to exercise delayed/failed responses;
// importing its real Supabase client would require a configured native session.
jest.mock('../../services/wallApi.ts', () => ({ fetchLiveForYou: jest.fn() }));
const fetchMock = fetchLiveForYou as jest.Mock;
const ok = (id: string): FetchLiveResult => ({
  ok: true, degraded: false,
  liveForYou: [{ id, validUntil: new Date(Date.now() + 300_000).toISOString() } as never],
});
let pending: Array<(value: FetchLiveResult) => void>;

beforeEach(() => {
  setDiscoveryViewerFromSession('viewer-a');
  pending = [];
  fetchMock.mockReset().mockImplementation(() => new Promise<FetchLiveResult>((resolve) => pending.push(resolve)));
});

it('starts a changed limit immediately and aborts the superseded request', async () => {
  const { result, rerender, unmount } = await renderHook<ReturnType<typeof useLiveForYou>, { limit: number }>(({ limit }) => useLiveForYou({ limit }), { initialProps: { limit: 4 } });
  const oldSignal = fetchMock.mock.calls[0][0].signal;
  await act(async () => { rerender({ limit: 2 }); });
  expect(oldSignal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { pending[0](ok('old')); });
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(async () => { pending[1](ok('new')); });
  expect(result.current.items[0].id).toBe('new');
  expect(result.current.loading).toBe(false);
  unmount();
});

it('coalesces manual refreshes into one follow-up instead of dropping them', async () => {
  const { result, unmount } = await renderHook(() => useLiveForYou());
  await act(async () => { result.current.refresh(); result.current.refresh(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { pending[0](ok('first')); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1](ok('fresh')); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.items[0].id).toBe('fresh');
  unmount();
});

it('clears prior-account items and rejects its delayed response', async () => {
  const { result, unmount } = await renderHook(() => useLiveForYou());
  await act(async () => { pending[0](ok('account-a')); });
  await act(async () => { result.current.refresh(); });
  const oldSignal = fetchMock.mock.calls[1][0].signal;
  await act(async () => { setDiscoveryViewerFromSession('viewer-b'); });
  expect(result.current.items).toEqual([]);
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { pending[1](ok('late-account-a')); });
  expect(result.current.items).toEqual([]);
  await act(async () => { pending[2](ok('account-b')); });
  expect(result.current.items[0].id).toBe('account-b');
  unmount();
});

it('does not launch a queued refresh after disable or unmount', async () => {
  const { result, rerender, unmount } = await renderHook<ReturnType<typeof useLiveForYou>, { enabled: boolean }>(({ enabled }) => useLiveForYou({ enabled }), { initialProps: { enabled: true } });
  const signal = fetchMock.mock.calls[0][0].signal;
  await act(async () => { result.current.refresh(); rerender({ enabled: false }); });
  expect(signal.aborted).toBe(true);
  await act(async () => { pending[0](ok('late')); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.current.loading).toBe(false);
  expect(result.current.items).toEqual([]);
  unmount();
});

it('handles a thrown transport error and can retry', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  const { result, unmount } = await renderHook(() => useLiveForYou());
  await act(async () => {});
  expect(result.current.degraded).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toContain('could not load');
  await act(async () => { result.current.refresh(); });
  await act(async () => { pending[0](ok('recovered')); });
  expect(result.current.error).toBeNull();
  expect(result.current.items[0].id).toBe('recovered');
  unmount();
});
