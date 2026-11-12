/**
 * FeedAutoplayVideo — the feed card's own video: muted, looping, signed before
 * it mounts, invisible until its first frame, never taking a touch
 * (2026-11-04: "videos should play on auto").
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

let mockResolved: Record<string, string | null> = {};
let mockVideoProps: Record<string, any> | null = null;

// NOTE: intentionally exhaustive — the real hook signs through the API; the map stands in for its answer.
jest.mock('../../../services/mediaUrl.ts', () => ({
  useHydratedMedia: () => ({ resolved: mockResolved, loading: false }),
}));

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = (props: Record<string, any>) => {
    mockVideoProps = props;
    return React.createElement(View, { testID: 'mock-video' });
  };
  return { Video, ResizeMode: { COVER: 'cover', CONTAIN: 'contain' } };
});

import { FeedAutoplayVideo } from '../FeedAutoplayVideo.tsx';

beforeEach(() => {
  mockResolved = {};
  mockVideoProps = null;
});

describe('FeedAutoplayVideo', () => {
  it('a private video mounts no player until its signed URL is back (the poster underneath stays)', async () => {
    await render(<FeedAutoplayVideo uri="post-media/u-1/a.mov" />);
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
    expect(mockVideoProps).toBeNull();
  });

  it('once signed it plays the SIGNED URL, muted and looping, and takes no touches', async () => {
    mockResolved = { 'post-media/u-1/a.mov': 'https://cdn.test/signed/a.mov?token=t' };
    await render(<FeedAutoplayVideo uri="post-media/u-1/a.mov" />);
    expect(mockVideoProps).toMatchObject({
      source: { uri: 'https://cdn.test/signed/a.mov?token=t' },
      shouldPlay: true,
      isMuted: true,
      isLooping: true,
    });
    expect((screen.getByTestId('feed-autoplay-video') as any).props.pointerEvents).toBe('none');
  });

  it('stays invisible until the first frame is ready, then shows with its speaker-off badge', async () => {
    mockResolved = { 'post-media/u-1/a.mov': 'https://cdn.test/signed/a.mov' };
    await render(<FeedAutoplayVideo uri="post-media/u-1/a.mov" />);
    const flat = (style: unknown) => Object.assign({}, ...([] as unknown[]).concat(style as never).flat(5).filter(Boolean) as object[]);
    expect(flat((screen.getByTestId('feed-autoplay-video') as any).props.style).opacity).toBe(0);
    expect(screen.queryByLabelText('Playing without sound. Tap the video to open it full screen.')).toBeNull();
    await act(async () => { mockVideoProps!.onReadyForDisplay(); });
    expect(flat((screen.getByTestId('feed-autoplay-video') as any).props.style).opacity).toBeUndefined();
    expect(screen.getByLabelText('Playing without sound. Tap the video to open it full screen.')).toBeTruthy();
  });

  it('a video that fails to load leaves the poster alone (the player unmounts)', async () => {
    mockResolved = { 'post-media/u-1/a.mov': 'https://cdn.test/signed/a.mov' };
    await render(<FeedAutoplayVideo uri="post-media/u-1/a.mov" />);
    await act(async () => { mockVideoProps!.onError('decode'); });
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
  });

  it('a video the server refused to sign plays nothing', async () => {
    mockResolved = { 'post-media/u-1/a.mov': null };
    await render(<FeedAutoplayVideo uri="post-media/u-1/a.mov" />);
    expect(screen.queryByTestId('feed-autoplay-video')).toBeNull();
  });
});
