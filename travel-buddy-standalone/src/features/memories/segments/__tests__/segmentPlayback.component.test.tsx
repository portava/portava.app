/**
 * SharedVideoPlayer's `segment` window — census-highlights-memories H184 (B58
 * MEM-SEGMENTS): a logical segment is played from the SAME video object, starting
 * at startMs and stopping at endMs, through the existing expo-av player. No new
 * native module, no second player.
 *
 * Pins:
 *   - with a segment, expo-av is told to start at startMs and to report progress
 *     every 100 ms, and never to loop the whole file;
 *   - reaching endMs pauses, rewinds to startMs and ends ONCE (a second report
 *     past the end does not fire again); a report back inside the window re-arms;
 *   - a first loaded position far from startMs (the native side ignored the
 *     initial position) is re-seeked once;
 *   - WITHOUT a segment the player is exactly what it was: no initial position,
 *     no interval, its own loop, and no pause or seek at any position.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { SharedVideoPlayer, segmentWindowEnded, SEGMENT_PROGRESS_INTERVAL_MS } from '../../../../components/ui/SharedVideoPlayer.tsx';

const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);
const mockSetPositionAsync = jest.fn().mockResolvedValue(undefined);
let mockStatusCallback: ((s: any) => void) | null = null;
let mockVideoProps: Record<string, unknown> = {};

// NOTE: intentionally exhaustive — expo-av's real module needs the native
// ExponentAV module; this stand-in captures the props and the status callback.
jest.mock('expo-av', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const Video = R.forwardRef(({ onPlaybackStatusUpdate, ...rest }: any, ref: any) => {
    mockStatusCallback = onPlaybackStatusUpdate ?? null;
    mockVideoProps = rest;
    R.useImperativeHandle(ref, () => ({
      playAsync: mockPlayAsync, pauseAsync: mockPauseAsync, setStatusAsync: mockSetStatusAsync, setPositionAsync: mockSetPositionAsync,
    }));
    return <View testID="mock-video" />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

// NOTE: intentionally exhaustive — the hydrate hook signs private-bucket references over the network.
jest.mock('../../../../services/mediaUrl.ts', () => ({
  useHydratedMedia: (uris: Array<string | null>) => ({ resolved: Object.fromEntries(uris.filter(Boolean).map((u) => [u, `https://signed.test/${u}`])) }),
}));

const URI = 'post-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1760000000000.mp4';
const loaded = (positionMillis: number, isPlaying = true, extra: Record<string, unknown> = {}) =>
  ({ isLoaded: true, isPlaying, positionMillis, didJustFinish: false, ...extra });

beforeEach(() => { jest.clearAllMocks(); mockStatusCallback = null; mockVideoProps = {}; });

describe('SharedVideoPlayer with a segment window', () => {
  it('starts at startMs, reports every 100 ms, never loops the whole file, and plays the same reference', async () => {
    await render(<SharedVideoPlayer uri={URI} segment={{ startMs: 4000, endMs: 9000 }} loop autoplay />);
    expect(mockVideoProps.positionMillis).toBe(4000);
    expect(mockVideoProps.progressUpdateIntervalMillis).toBe(SEGMENT_PROGRESS_INTERVAL_MS);
    expect(mockVideoProps.isLooping).toBe(false);
    expect((mockVideoProps.source as { uri: string }).uri).toBe(`https://signed.test/${URI}`);
  });

  it('at endMs it pauses, rewinds to startMs and ends ONCE; inside the window again it re-arms', async () => {
    const onEnd = jest.fn();
    await render(<SharedVideoPlayer uri={URI} segment={{ startMs: 4000, endMs: 9000 }} onEnd={onEnd} autoplay />);
    await act(async () => { mockStatusCallback!(loaded(4000)); });
    await act(async () => { mockStatusCallback!(loaded(8900)); });
    expect(mockPauseAsync).not.toHaveBeenCalled();
    await act(async () => { mockStatusCallback!(loaded(9050)); });
    expect(mockPauseAsync).toHaveBeenCalledTimes(1);
    expect(mockSetPositionAsync).toHaveBeenLastCalledWith(4000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    await act(async () => { mockStatusCallback!(loaded(9100, false)); });
    expect(mockPauseAsync).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    await act(async () => { mockStatusCallback!(loaded(4000, false)); });
    await act(async () => { mockStatusCallback!(loaded(9000)); });
    expect(mockPauseAsync).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it('a first loaded position far from startMs is re-seeked once', async () => {
    await render(<SharedVideoPlayer uri={URI} segment={{ startMs: 4000, endMs: 9000 }} />);
    await act(async () => { mockStatusCallback!(loaded(0, false)); });
    expect(mockSetPositionAsync).toHaveBeenCalledWith(4000);
    expect(mockSetPositionAsync).toHaveBeenCalledTimes(1);
    await act(async () => { mockStatusCallback!(loaded(0, false)); });
    expect(mockSetPositionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('SharedVideoPlayer without a segment is unchanged', () => {
  it('no initial position, no interval, its own loop, and no pause or seek at any position', async () => {
    const onEnd = jest.fn();
    await render(<SharedVideoPlayer uri={URI} loop onEnd={onEnd} />);
    expect('positionMillis' in mockVideoProps).toBe(false);
    expect('progressUpdateIntervalMillis' in mockVideoProps).toBe(false);
    expect(mockVideoProps.isLooping).toBe(true);
    for (const p of [0, 9050, 600000]) await act(async () => { mockStatusCallback!(loaded(p)); });
    expect(mockPauseAsync).not.toHaveBeenCalled();
    expect(mockSetPositionAsync).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('segmentWindowEnded is false without a window and at any position before its end', () => {
    expect(segmentWindowEnded(null, 99999)).toBe(false);
    expect(segmentWindowEnded({ startMs: 0, endMs: 10 }, 9)).toBe(false);
    expect(segmentWindowEnded({ startMs: 0, endMs: 10 }, 10)).toBe(true);
    expect(segmentWindowEnded({ startMs: 0, endMs: 10 }, undefined)).toBe(false);
  });
});
