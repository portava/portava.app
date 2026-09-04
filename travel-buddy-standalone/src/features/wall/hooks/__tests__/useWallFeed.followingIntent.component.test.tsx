/**
 * useWallFeed — a session-intent steer is For You only (Wall spec §5/§17 / TABLE 1).
 *
 * Following is the strict-chronology trust anchor: a relevance steer must never
 * touch it. The hook used to send `sessionIntent` in BOTH modes. These tests
 * prove that (a) For You forwards the steer, (b) Following forwards null instead,
 * and (c) changing the steer while in Following does NOT restart the Following
 * session (no new fetch), so the trust anchor is never re-ordered.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWallFeed } from '../useWallFeed.ts';
import { fetchWall } from '../../services/wallApi.ts';
import type { FetchWallResult } from '../../services/wallApi.ts';
import type { WallMode } from '../../types/wallProjection.ts';

// Intentional stub — wallApi loads the native supabase client + API token seam
// at module load; fetchWall is the only member useWallFeed touches.
jest.mock('../../services/wallApi', () => ({
  fetchWall: jest.fn(),
}));

const fetchWallMock = fetchWall as jest.Mock;

function okResult(mode: WallMode): FetchWallResult {
  return {
    ok: true,
    degraded: false,
    data: {
      mode,
      liveForYou: [],
      items: [] as never,
      caughtUp: false,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchWallMock.mockImplementation((args: { mode: WallMode }) => Promise.resolve(okResult(args.mode)));
});

describe('useWallFeed — intent steer is For You only', () => {
  it('For You forwards the session intent', async () => {
    await renderHook(() => useWallFeed('for_you', 'museums'));
    await waitFor(() => expect(fetchWallMock).toHaveBeenCalledTimes(1));
    expect(fetchWallMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'for_you', sessionIntent: 'museums' }),
    );
  });

  it('Following sends null instead of the steer', async () => {
    await renderHook(() => useWallFeed('following', 'museums'));
    await waitFor(() => expect(fetchWallMock).toHaveBeenCalledTimes(1));
    expect(fetchWallMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'following', sessionIntent: null }),
    );
  });

  it('changing the steer while in Following does not restart the session', async () => {
    const { rerender } = await renderHook(
      ({ intent }: { intent: string }) => useWallFeed('following', intent),
      { initialProps: { intent: 'museums' } },
    );
    await waitFor(() => expect(fetchWallMock).toHaveBeenCalledTimes(1));

    // A new steer in Following resolves to the same effective value (null), so no
    // new session/fetch is started — the trust anchor is never re-ordered.
    await act(async () => { rerender({ intent: 'nightlife' }); });
    expect(fetchWallMock).toHaveBeenCalledTimes(1);
  });
});
