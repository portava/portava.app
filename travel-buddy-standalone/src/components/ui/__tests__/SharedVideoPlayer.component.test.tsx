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
