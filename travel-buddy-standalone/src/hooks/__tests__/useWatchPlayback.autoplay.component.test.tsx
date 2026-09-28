/**
 * useWatchPlayback — the playback manager's autoplay option (census-media §34,
 * F2: MEDIA_WATCH_TAP_TO_PLAY_ENABLED). Omitted — today — the manager plays
 * the item that becomes active. `autoplay: false` — tap-to-play — it still
 * pauses the item that stops being active, and starts nothing itself.
 */
import { act, renderHook } from '@testing-library/react-native';

// NOTE: intentional stub — the manager's focus effect needs a navigator.
jest.mock('expo-router', () => ({
  useFocusEffect: (_cb: () => void) => {},
}));

import { useWatchPlayback } from '../useWatchPlayback.ts';

function fakeVideo() {
  return {
    current: {
      playAsync: jest.fn().mockResolvedValue(undefined),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('useWatchPlayback — autoplay option', () => {
  it('omitted (today): the newly active item is played, the previous one paused', async () => {
    const { result } = await renderHook(() => useWatchPlayback());
    const a = fakeVideo();
    const b = fakeVideo();
    result.current.registerRef('a', a as any);
    result.current.registerRef('b', b as any);
    await act(async () => { await result.current.setActiveId('a'); });
    expect(a.current.playAsync).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.setActiveId('b'); });
    expect(a.current.pauseAsync).toHaveBeenCalledTimes(1);
    expect(b.current.playAsync).toHaveBeenCalledTimes(1);
  });

  it('autoplay: false (tap-to-play): nothing is started; the previous item is still paused', async () => {
    const { result } = await renderHook(() => useWatchPlayback({ autoplay: false }));
    const a = fakeVideo();
    const b = fakeVideo();
    result.current.registerRef('a', a as any);
    result.current.registerRef('b', b as any);
    await act(async () => { await result.current.setActiveId('a'); });
    await act(async () => { await result.current.setActiveId('b'); });
    expect(a.current.playAsync).not.toHaveBeenCalled();
    expect(b.current.playAsync).not.toHaveBeenCalled();
    expect(a.current.pauseAsync).toHaveBeenCalledTimes(1);
  });
});
