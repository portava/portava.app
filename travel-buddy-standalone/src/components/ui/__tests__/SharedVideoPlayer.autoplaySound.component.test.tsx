/**
 * SharedVideoPlayer — videos play on their own, with sound, and stop when the
 * screen is covered (2026-11-04: "videos should play on auto and the videos
 * have no sound right now").
 *
 *   1. autoplay + muted={false} (the post screen) starts PLAYING and UNMUTED.
 *   2. On web an autoplaying player starts muted (browsers refuse a video with
 *      sound until the viewer taps), and the speaker button unmutes it.
 *   3. Turning autoplay off pauses the video and turning it back on resumes
 *      it: the post screen passes its focus as autoplay, so a sound-on video
 *      stops while another screen is on top (app/post/[id].tsx).
 */
import React from 'react';
import { Platform } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { SharedVideoPlayer } from '../SharedVideoPlayer.tsx';

const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);
let mockLastVideoProps: { shouldPlay?: boolean; isMuted?: boolean } = {};

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((props: any, ref: React.Ref<any>) => {
    mockLastVideoProps = { shouldPlay: props.shouldPlay, isMuted: props.isMuted };
    React.useImperativeHandle(ref, () => ({
      playAsync: jest.fn().mockResolvedValue(undefined),
      pauseAsync: jest.fn().mockResolvedValue(undefined),
      setStatusAsync: mockSetStatusAsync,
    }), []);
    return <View testID="mock-video" />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

const originalOS = Platform.OS;
function setOS(os: string) {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLastVideoProps = {};
  setOS('ios');
});
afterAll(() => setOS(originalOS));

describe('SharedVideoPlayer — autoplay and sound', () => {
  it('the post screen player (autoplay, muted={false}) plays at once WITH sound in the app', async () => {
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay muted={false} />);
    expect(mockLastVideoProps).toEqual({ shouldPlay: true, isMuted: false });
    expect(screen.getByLabelText('Mute')).toBeTruthy();
  });

  it('on web an autoplaying player starts muted, and the speaker button turns the sound on', async () => {
    setOS('web');
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay muted={false} />);
    expect(mockLastVideoProps).toEqual({ shouldPlay: true, isMuted: true });
    await act(async () => { fireEvent.press(screen.getByLabelText('Unmute')); });
    expect(mockSetStatusAsync).toHaveBeenCalledWith({ isMuted: false });
    expect(screen.getByLabelText('Mute')).toBeTruthy();
  });

  it('on web a player the viewer starts by tapping keeps its sound setting', async () => {
    setOS('web');
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" muted={false} />);
    expect(mockLastVideoProps.isMuted).toBe(false);
  });

  it('restores the sound control after a native failure and allows retry', async () => {
    mockSetStatusAsync.mockRejectedValueOnce(new Error('Audio session unavailable'));
    await render(<SharedVideoPlayer uri="https://example.com/video.mp4" muted />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Unmute')); });
    expect(screen.getByLabelText('Unmute')).toBeTruthy();
    expect(screen.getByText('Sound could not be changed. Try again.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Unmute')); });
    expect(screen.getByLabelText('Mute')).toBeTruthy();
    expect(screen.queryByText('Sound could not be changed. Try again.')).toBeNull();
  });

  it('an old sound command cannot change a replacement video', async () => {
    let reject: (error: Error) => void = () => {};
    mockSetStatusAsync.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const view = await render(<SharedVideoPlayer uri="https://example.com/first.mp4" muted />);
    await act(async () => { fireEvent.press(screen.getByLabelText('Unmute')); });
    await act(async () => { view.rerender(<SharedVideoPlayer uri="https://example.com/second.mp4" muted={false} />); });
    await act(async () => { reject(new Error('Retired command')); });
    expect(screen.getByLabelText('Mute')).toBeTruthy();
    expect(screen.queryByText('Sound could not be changed. Try again.')).toBeNull();
  });

  it('autoplay turned off pauses the video, and turned back on resumes it (the post screen covered, then back)', async () => {
    const view = await render(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay muted={false} />);
    expect(mockLastVideoProps.shouldPlay).toBe(true);
    await act(async () => { view.rerender(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay={false} muted={false} />); });
    expect(mockLastVideoProps.shouldPlay).toBe(false);
    await act(async () => { view.rerender(<SharedVideoPlayer uri="https://example.com/video.mp4" autoplay muted={false} />); });
    expect(mockLastVideoProps).toEqual({ shouldPlay: true, isMuted: false });
  });
});
