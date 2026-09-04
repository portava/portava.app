/**
 * useWallFeed — in-flight guard regression (D12).
 *
 * The per-request generation guard in doFetch()'s finally block must gate BOTH
 * the loading-flag resets AND the `inFlightRef` release. If a superseded
 * (stale-gen) request that resolves were allowed to clear `inFlightRef` while a
 * NEWER request is still running, a refresh in that window would supersede the
 * newer request and strand `loading` true — a permanent spinner instead of the
 * empty state. This proves a stale-gen resolution leaves the guard held so the
 * newer request is the one that resolves `loading`.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWallFeed } from '../useWallFeed.ts';
import { fetchWall } from '../../services/wallApi.ts';
import type { FetchWallResult } from '../../services/wallApi.ts';
import type { WallMode } from '../../types/wallProjection.ts';

// NOTE: intentional stub — wallApi imports the native supabase client + the API
// token seam at module load. fetchWall is the only member useWallFeed touches
// and is the seam under test (deferred by the test to control resolution
// ordering); this exhaustive factory is complete.
jest.mock('../../services/wallApi', () => ({
  fetchWall: jest.fn(),
}));

const fetchWallMock = fetchWall as jest.Mock;

/** A healthy, well-formed Wall response with `items` and no next cursor. */
function okResult(items: unknown[] = []): FetchWallResult {
  return {
    ok: true,
    degraded: false,
    data: {
      mode: 'for_you',
      liveForYou: [],
      items: items as never,
      caughtUp: false,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useWallFeed — stale-gen resolution keeps the in-flight guard', () => {
  it('a superseded request resolving does not release the guard while a newer request runs', async () => {
    const resolvers: Array<(r: FetchWallResult) => void> = [];
    fetchWallMock.mockImplementation(
      () => new Promise<FetchWallResult>((resolve) => { resolvers.push(resolve); }),
    );

    const { result, rerender } = await renderHook(
      ({ mode }: { mode: WallMode }) => useWallFeed(mode),
      { initialProps: { mode: 'for_you' as WallMode } },
    );

    // Request #1 (gen A) is in flight for the first session.
    await waitFor(() => expect(fetchWallMock).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);

    // A new session starts (mode change): the effect cleanup clears inFlightRef,
    // so Request #2 (gen B) is allowed to begin.
    await act(async () => { rerender({ mode: 'following' as WallMode }); });
    await waitFor(() => expect(fetchWallMock).toHaveBeenCalledTimes(2));

    // The STALE Request #1 resolves now, AFTER #2 started. Its result is dropped
    // for gen mismatch — and it must NOT release inFlightRef, because #2 is still
    // running.
    await act(async () => { resolvers[0](okResult([])); });

    // Because the guard is still held by #2, a refresh in this window is a
    // no-op: it must not start a THIRD request that would supersede #2.
    await act(async () => { result.current.refresh(); });
    expect(fetchWallMock).toHaveBeenCalledTimes(2);

    // #2 resolves to an empty feed → loading resolves to false (empty state),
    // never a permanent spinner.
    await act(async () => { resolvers[1](okResult([])); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(0);
  });
});
