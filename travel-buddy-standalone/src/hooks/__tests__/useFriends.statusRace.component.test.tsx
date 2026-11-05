import { act, renderHook } from '@testing-library/react-native';
import { useFriendStatus } from '../useFriends.ts';
import { getFriendStatus, sendFriendRequest } from '../../services/friends.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

jest.mock('../../services/friends.ts', () => ({
  ...jest.requireActual('../../services/friends.ts'),
  getFriendStatus: jest.fn(), sendFriendRequest: jest.fn(),
}));

const read = getFriendStatus as jest.Mock;
const send = sendFriendRequest as jest.Mock;
const status = (value: string, requestId?: string) => ({ ok: true, data: { status: value, requestId } });
let reads: Array<(value: unknown) => void>;

beforeEach(() => {
  setDiscoveryViewerFromSession('owner-a');
  reads = [];
  read.mockReset().mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
  send.mockReset().mockResolvedValue(status('pending', 'request-1'));
});

it('a delayed read cannot undo a successful friend request', async () => {
  const { result, unmount } = await renderHook(() => useFriendStatus('target-a'));
  await act(async () => { await result.current.send(); });
  expect(result.current.status).toBe('outgoing_pending');
  await act(async () => { reads[0](status('none')); });
  expect(result.current.status).toBe('outgoing_pending');
  expect(result.current.requestId).toBe('request-1');
  unmount();
});

it('changing profiles ignores the previous profile response', async () => {
  const { result, rerender, unmount } = await renderHook<ReturnType<typeof useFriendStatus>, { user: string }>(({ user }) => useFriendStatus(user), { initialProps: { user: 'target-a' } });
  await rerender({ user: 'target-b' });
  await act(async () => { reads[0](status('friends')); });
  expect(result.current.loading).toBe(true);
  expect(result.current.status).toBe('none');
  await act(async () => { reads[1](status('outgoing_pending', 'request-b')); });
  expect(result.current.requestId).toBe('request-b');
  unmount();
});

it('an old mutation cannot change a newly signed-in account', async () => {
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result, unmount } = await renderHook(() => useFriendStatus('target-a'));
  let operation!: ReturnType<typeof result.current.send>;
  await act(async () => { operation = result.current.send(); });
  await act(async () => { setDiscoveryViewerFromSession('owner-b'); });
  await act(async () => { finish(status('friends')); await operation; });
  expect(result.current.status).toBe('none');
  expect(result.current.loading).toBe(true);
  unmount();
});

it('reports thrown reads and retries instead of staying loading', async () => {
  read.mockRejectedValueOnce(new Error('offline'));
  const { result, unmount } = await renderHook(() => useFriendStatus('target-a'));
  await act(async () => {});
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toContain('Failed to load');
  let retry!: Promise<void>;
  await act(async () => { retry = result.current.reload(); });
  await act(async () => { reads[0](status('friends')); await retry; });
  expect(result.current.error).toBeNull();
  expect(result.current.status).toBe('friends');
  unmount();
});

it('prevents duplicate pending writes and preserves auto-accept', async () => {
  let finish!: (value: unknown) => void;
  send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result, unmount } = await renderHook(() => useFriendStatus('target-a'));
  let operation!: ReturnType<typeof result.current.send>;
  await act(async () => { operation = result.current.send(); await result.current.send(); });
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => { finish(status('friends')); await operation; });
  expect(result.current.status).toBe('friends');
  expect(result.current.requestId).toBeUndefined();
  unmount();
});
