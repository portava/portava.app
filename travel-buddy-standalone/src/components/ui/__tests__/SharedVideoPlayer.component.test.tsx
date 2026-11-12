import { enterPostPlaybackLayer, PostPlaybackLayer } from '../../../hooks/usePostPlaybackLayer.ts';
/**
 * SharedVideoPlayer — unit tests (mocked expo-av).
 *
 * Verifies:
 *   - Poster image renders when not playing
 *   - Play button overlay is shown when not playing
 *   - Tapping the play zone calls playAsync on the Video ref
 *   - Error fallback renders when the video reports an error
 */
import React from 'react';
import { Platform } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { SharedVideoPlayer } from '../SharedVideoPlayer.tsx';

// ---------------------------------------------------------------------------
// Mock expo-av
// ---------------------------------------------------------------------------
const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);
let capturedStatusCallback: ((s: any) => void) | null = null;
const mockDubbingSession = jest.fn();

jest.mock('../../media/MediaDubbingSession.tsx', () => {
  const actual = jest.requireActual('../../media/MediaDubbingSession.tsx');
  return { ...actual, useMediaDubbingSession: (options: unknown) => {
    mockDubbingSession(options);
    return actual.useMediaDubbingSession(options);
  } };
});

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');

  const Video = React.forwardRef(
    (
      { onPlaybackStatusUpdate, testID, ...rest }: any,
      ref: React.Ref<any>,
    ) => {
      // Capture the callback so tests can fire status updates
      capturedStatusCallback = onPlaybackStatusUpdate ?? null;

      React.useImperativeHandle(ref, () => ({
        playAsync: mockPlayAsync,
        pauseAsync: mockPauseAsync,
        setStatusAsync: mockSetStatusAsync,
        setPositionAsync: mockSetStatusAsync,
      }), []);

      return <View testID={testID ?? 'mock-video'} {...rest} />;
    },
  );
  Video.displayName = 'Video';

  return {
    Video,
    ResizeMode: { COVER: 'cover', CONTAIN: 'contain' },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  capturedStatusCallback = null;
});

describe('SharedVideoPlayer', () => {
  it('opens directly over the current screen at the inline playback position and returns to its caller on close', async () => {
    const onClose = jest.fn();
    const onPositionChange = jest.fn();
    await render(<SharedVideoPlayer uri="https://example.com/modal.mp4" fullscreenOnly autoplay muted={false} initialPositionMillis={12000} onClose={onClose} onPositionChange={onPositionChange} />);
    expect(screen.getByLabelText('Close full-screen video')).toBeTruthy();
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
    expect(screen.getByTestId('mock-video').props.status.positionMillis).toBe(12000);
    await fireEvent(screen.getByTestId('mock-video'), 'load');
    await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: true, positionMillis: 15000, durationMillis: 60000 }); });
    expect(onPositionChange).toHaveBeenCalledWith(15000);
    await fireEvent.press(screen.getByLabelText('Close full-screen video'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('retires every covered decoder and restores only the prior layer, position and manual pause on close', async () => {
    const first = Symbol('post A'), second = Symbol('post B');
    const tree = (a: boolean, b: boolean) => <>
      <SharedVideoPlayer uri="https://example.com/feed.mp4" autoplay />
      {a && <PostPlaybackLayer.Provider value={first}><SharedVideoPlayer uri="https://example.com/post-a.mp4" autoplay /></PostPlaybackLayer.Provider>}
      {b && <PostPlaybackLayer.Provider value={second}><SharedVideoPlayer uri="https://example.com/post-b.mp4" autoplay /></PostPlaybackLayer.Provider>}
    </>;
    const view = await render(tree(false, false));
    await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: true, positionMillis: 9000, durationMillis: 30000 }); });
    await fireEvent.press(screen.getByLabelText('Pause video'));
    let closeA!: () => void, closeB!: () => void;
    await act(async () => { closeA = enterPostPlaybackLayer(first); });
    await view.rerender(tree(true, false));
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
    expect(screen.getByTestId('mock-video').props.source.uri).toBe('https://example.com/post-a.mp4');
    await act(async () => { closeB = enterPostPlaybackLayer(second); });
    await view.rerender(tree(true, true));
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
    expect(screen.getByTestId('mock-video').props.source.uri).toBe('https://example.com/post-b.mp4');
    await act(async () => closeB());
    await view.rerender(tree(true, false));
    expect(screen.getByTestId('mock-video').props.source.uri).toBe('https://example.com/post-a.mp4');
    await act(async () => closeA());
    await view.rerender(tree(false, false));
    expect(screen.getByTestId('mock-video').props.status.positionMillis).toBe(9000);
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
  });

  it('renders the play overlay when not playing (autoplay=false)', async () => {
    await render(
      <SharedVideoPlayer uri="https://example.com/video.mp4" />,
    );
    expect(screen.getByTestId('icon-Play')).toBeTruthy();
  });

  it('shows the poster image when paused and posterUri is provided', async () => {
    await render(
      <SharedVideoPlayer
        uri="https://example.com/video.mp4"
        poster="https://example.com/poster.jpg"
      />,
    );
    // Poster image carries testID="poster-image" when visible (not playing → poster shown)
    expect(screen.getByTestId('poster-image')).toBeTruthy();
  });

  it('calls playAsync when the tap zone is pressed while paused', async () => {
    await render(
      <SharedVideoPlayer uri="https://example.com/video.mp4" />,
    );
    // RNTL v14 uses getByLabelText for accessibilityLabel queries
    const tapZone = screen.getByLabelText('Play video');
    await act(async () => {
      fireEvent.press(tapZone);
    });
    expect(mockPlayAsync).toHaveBeenCalledTimes(1);
  });

  it('calls setStatusAsync to toggle mute when the mute button is pressed', async () => {
    await render(
      <SharedVideoPlayer uri="https://example.com/video.mp4" muted />,
    );
    // RNTL v14 uses getByLabelText for accessibilityLabel queries
    const muteBtn = screen.getByLabelText('Unmute');
    await act(async () => {
      fireEvent.press(muteBtn);
    });
    expect(mockSetStatusAsync).toHaveBeenCalledWith({ isMuted: false });
  });

  it('withdraws play intent before native pause finishes and ignores late playing status', async () => {
    let finishPause: (() => void) | undefined;
    mockPauseAsync.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPause = resolve; }));
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay />);
    const previousStatus = capturedStatusCallback;
    await act(async () => { fireEvent.press(screen.getByLabelText('Pause video')); });
    expect(mockDubbingSession.mock.lastCall[0].controlSource.shouldPlay).toBe(false);
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
    await act(async () => { previousStatus?.({ isLoaded: true, isPlaying: true, positionMillis: 150, durationMillis: 5000 }); });
    expect(mockDubbingSession.mock.lastCall[0].controlSource.shouldPlay).toBe(false);
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
    await act(async () => { finishPause?.(); });
  });

  it('keeps play intent false after a rejected native pause', async () => {
    mockPauseAsync.mockRejectedValueOnce(new Error('native pause failed'));
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Pause video')); });
    expect(mockDubbingSession.mock.lastCall[0].controlSource.shouldPlay).toBe(false);
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
  });

  it('shows error fallback when the video reports a load error', async () => {
    await render(
      <SharedVideoPlayer uri="https://example.com/broken.mp4" />,
    );
    // Fire an error-status update — await act so React flushes setHasError(true)
    await act(async () => {
      capturedStatusCallback?.({ isLoaded: false, error: 'load error' });
    });
    expect(screen.getByText('Video unavailable')).toBeTruthy();
  });

  it('hides the play overlay when status reports isPlaying=true', async () => {
    await render(
      <SharedVideoPlayer uri="https://example.com/video.mp4" />,
    );
    // Initially play overlay is present
    expect(screen.getByTestId('icon-Play')).toBeTruthy();

    // await act so React flushes setIsPlaying(true) before the assertion
    await act(async () => {
      capturedStatusCallback?.({
        isLoaded: true,
        isPlaying: true,
        positionMillis: 0,
        durationMillis: 5000,
        didJustFinish: false,
      });
    });

    // Play overlay should be gone
    expect(screen.queryByTestId('icon-Play')).toBeNull();
  });

  it('calls onEnd when video finishes and loop=false', async () => {
    const onEnd = jest.fn();
    await render(
      <SharedVideoPlayer
        uri="https://example.com/video.mp4"
        loop={false}
        onEnd={onEnd}
      />,
    );
    // await act so React flushes the didJustFinish callback before assertion
    await act(async () => {
      capturedStatusCallback?.({
        isLoaded: true,
        isPlaying: false,
        positionMillis: 5000,
        durationMillis: 5000,
        didJustFinish: true,
      });
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});


describe('Full-screen video', () => {
  it('moves one player into full screen and back at the playback position, preserving sound', async () => {
    await render(<SharedVideoPlayer uri="https://example.com/full.mp4" autoplay muted={false} />);
    const inlineStatus = capturedStatusCallback;
    await act(async () => { inlineStatus?.({ isLoaded: true, isPlaying: true, positionMillis: 12000, durationMillis: 60000 }); });
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
    expect(screen.getByTestId('mock-video').props.status.positionMillis).toBe(12000);
    expect(screen.getByTestId('mock-video').props.isMuted).toBe(false);
    expect(screen.getByTestId('mock-video').props.resizeMode).toBe('contain');
    expect(screen.getByTestId('mock-video').props.videoStyle).toEqual({ width: '100%', height: '100%' });
    await fireEvent(screen.getByTestId('mock-video'), 'load');
    expect(screen.getByTestId('mock-video').props.status).toEqual({});
    await fireEvent.press(screen.getByLabelText('Mute'));
    expect(screen.getByTestId('mock-video').props.status).toEqual({});
    await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: true, positionMillis: 19000, durationMillis: 60000 }); });
    await act(async () => { inlineStatus?.({ isLoaded: false, error: 'retired inline decoder' }); });
    expect(screen.queryByText('Video unavailable')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Close full-screen video'));
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
    expect(screen.getByTestId('mock-video').props.status.positionMillis).toBe(19000);
    expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
  });

  it('supports full-screen seeking and preserves paused intent', async () => {
    await render(<SharedVideoPlayer uri="https://example.com/full.mp4" />);
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: false, positionMillis: 1000, durationMillis: 10000 }); });
    await fireEvent(screen.getByTestId('fullscreen-video-seek'), 'slidingComplete', 4000);
    expect(mockSetStatusAsync).toHaveBeenCalledWith(4000);
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
    await fireEvent.press(screen.getByLabelText('Close full-screen video'));
    expect(screen.getByTestId('mock-video').props.shouldPlay).toBe(false);
  });

  it('closes the full-screen view when the source is replaced', async () => {
    const ui = await render(<SharedVideoPlayer uri="https://example.com/old.mp4" />);
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    const oldStatus = capturedStatusCallback;
    await ui.rerender(<SharedVideoPlayer uri="https://example.com/new.mp4" />);
    expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
    await act(async () => { oldStatus?.({ isLoaded: false, error: 'old source' }); });
    expect(screen.queryByText('Video unavailable')).toBeNull();
  });

  it('keeps the inline player and reports failure when native pause rejects', async () => {
    mockPauseAsync.mockRejectedValueOnce(new Error('cannot pause'));
    await render(<SharedVideoPlayer uri="https://example.com/full.mp4" />);
    await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: true, positionMillis: 1000, durationMillis: 10000 }); });
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
    expect(screen.getByText('Couldn’t change the video view. Try again.')).toBeTruthy();
  });

  it('opens an already paused video without issuing a redundant native pause', async () => {
    mockPauseAsync.mockImplementationOnce(() => new Promise(() => {}));
    await render(<SharedVideoPlayer uri="https://example.com/paused.mp4" />);
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    expect(screen.getByLabelText('Close full-screen video')).toBeTruthy();
    expect(mockPauseAsync).not.toHaveBeenCalled();
  });

  it('restores Web position after load without letting initial zero overwrite the pending seek', async () => {
    const prior = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      await render(<SharedVideoPlayer uri="https://example.com/web.mp4" />);
      await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: false, positionMillis: 4500, durationMillis: 10000 }); });
      await fireEvent.press(screen.getByLabelText('View video full screen'));
      await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: false, positionMillis: 0, durationMillis: 10000 }); });
      await fireEvent(screen.getByTestId('mock-video'), 'load');
      expect(mockSetStatusAsync).toHaveBeenCalledWith(4500);
      expect(screen.getByTestId('mock-video').props.status).toEqual({});
      await fireEvent.press(screen.getByLabelText('Close full-screen video'));
      await fireEvent(screen.getByTestId('mock-video'), 'load');
      expect(mockSetStatusAsync).toHaveBeenLastCalledWith(4500);
    } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: prior }); }
  });

  it('offers a bounded Web resume retry without resetting the saved position', async () => {
    const prior = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      await render(<SharedVideoPlayer uri="https://example.com/retry.mp4" />);
      await act(async () => { capturedStatusCallback?.({ isLoaded: true, isPlaying: false, positionMillis: 7000, durationMillis: 10000 }); });
      await fireEvent.press(screen.getByLabelText('View video full screen'));
      mockSetStatusAsync.mockRejectedValueOnce(new Error('seek failed'));
      await fireEvent(screen.getByTestId('mock-video'), 'load');
      expect(screen.getByLabelText('Retry playback position')).toBeTruthy();
      await fireEvent.press(screen.getByLabelText('Retry playback position'));
      expect(mockSetStatusAsync).toHaveBeenLastCalledWith(7000);
      expect(screen.queryByLabelText('Retry playback position')).toBeNull();
    } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: prior }); }
  });
});

 it('closes a fullscreen modal immediately even if native pause never finishes', async () => {
    await render(<SharedVideoPlayer uri="https://example.com/close.mp4" />);
    await fireEvent.press(screen.getByLabelText('View video full screen'));
    mockPauseAsync.mockImplementationOnce(() => new Promise(() => {}));
    await fireEvent.press(screen.getByLabelText('Close full-screen video'));
    expect(screen.queryByLabelText('Close full-screen video')).toBeNull();
    expect(screen.getAllByTestId('mock-video')).toHaveLength(1);
 });
