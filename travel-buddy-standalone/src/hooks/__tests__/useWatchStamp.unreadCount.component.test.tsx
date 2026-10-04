/**
 * useWatchStamp — the Watch rail's stamp count when the server could not read
 * it (census-media §47).
 *
 * The Watch feed answers an unread stamp count as `likeCount: null`. The hook
 * seeded `item.stampCount ?? item.likeCount ?? 0` and stepped the visual count
 * at stamp impact with `prev + 1`, so the rail drew 0 (as nothing) and then a
 * made-up "1". Pinned here:
 *
 *   1. an unread count is seeded as null, not 0;
 *   2. the impact step keeps it null;
 *   3. once the toggle resolves, the server's measured count is drawn;
 *   4. a refused stamp rolls back to unread, never to a number;
 *   5. a measured count still steps by one at impact (unchanged).
 *
 * Run with: pnpm test:component
 */
import { renderHook, act } from '@testing-library/react-native';

type StampArgs = { onImpact: () => void; onComplete: () => void };
let lastTrigger: StampArgs | null = null;

// NOTE: intentionally exhaustive — the animation hook is reanimated-only.
jest.mock('../useStampAnimation', () => ({
  useStampAnimation: () => ({ buttonStyle: {}, countStyle: {}, playStamp: () => {}, playUnstamp: () => {} }),
}));
// NOTE: intentionally exhaustive — the provider module pulls in reanimated and
// haptics; the test drives impact and completion by hand.
jest.mock('../../context/StampAnimationContext', () => ({
  useStampAnimationContext: () => ({
    triggerStamp: (args: StampArgs) => { lastTrigger = args; },
    isAnimating: false,
    cancelStamp: () => {},
  }),
}));

const mockStamp = jest.fn();
jest.mock('../../services/stamps.ts', () => ({
  ...jest.requireActual('../../services/stamps.ts'),
  stampEntity: (...a: unknown[]) => mockStamp(...a),
  unstampEntity: jest.fn(),
}));

import { useWatchStamp } from '../useWatchStamp.ts';
import type { MediaFeedItem } from '../../types/media.ts';

function item(likeCount: number | null): MediaFeedItem {
  return {
    id: 'm1', videoUrl: 'https://x/v.mp4', posterUrl: null, duration: null,
    creator: { id: 'u1', displayName: 'U', username: 'u', avatarUrl: null },
    caption: '', hashtags: [], place: null, linkedEntity: null, audioLabel: null,
    likeCount, commentCount: 0, saveCount: 0, likedByMe: false, savedByMe: false,
  };
}

beforeEach(() => { lastTrigger = null; mockStamp.mockReset(); });

describe('useWatchStamp — an unread stamp count', () => {
  it('is seeded as null, stays null at impact, and takes the measured count after', async () => {
    mockStamp.mockResolvedValue({ ok: true, data: { isStamped: true, count: 41 } });
    const { result } = await renderHook(() => useWatchStamp(item(null)));
    expect(result.current.visualCount).toBeNull();
    await act(async () => { result.current.triggerAt(10, 10); });
    expect(lastTrigger).not.toBeNull();
    await act(async () => { lastTrigger!.onImpact(); });
    expect(result.current.visualIsStamped).toBe(true);
    expect(result.current.visualCount).toBeNull();
    await act(async () => { lastTrigger!.onComplete(); await Promise.resolve(); });
    expect(result.current.visualCount).toBe(41);
  });

  it('a refused stamp rolls back to unread, never to a number', async () => {
    mockStamp.mockResolvedValue({ ok: false, message: 'API 503' });
    const { result } = await renderHook(() => useWatchStamp(item(null)));
    await act(async () => { result.current.triggerAt(10, 10); });
    await act(async () => { lastTrigger!.onImpact(); });
    await act(async () => { lastTrigger!.onComplete(); await Promise.resolve(); });
    expect(result.current.visualIsStamped).toBe(false);
    expect(result.current.visualCount).toBeNull();
  });

  it('a measured count still steps by one at impact (unchanged)', async () => {
    mockStamp.mockResolvedValue({ ok: true, data: { isStamped: true, count: 8 } });
    const { result } = await renderHook(() => useWatchStamp(item(6)));
    expect(result.current.visualCount).toBe(6);
    await act(async () => { result.current.triggerAt(10, 10); });
    await act(async () => { lastTrigger!.onImpact(); });
    expect(result.current.visualCount).toBe(7);
    await act(async () => { lastTrigger!.onComplete(); await Promise.resolve(); });
    expect(result.current.visualCount).toBe(8);
  });
});
