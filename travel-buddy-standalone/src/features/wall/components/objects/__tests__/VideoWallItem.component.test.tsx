/**
 * Component test: inline video autoplay policy (Wall spec §11/§36).
 *
 * Proves the CLIENT autoplay policy the Wall owns:
 *   - the inline player autoplays (muted) only while the item is on-screen, and
 *     pauses when scrolled off (§11);
 *   - reduce-motion falls back to the still poster and never mounts the player
 *     (§36);
 *   - the user's autoplay preference is honored (§36);
 *   - the server never decides: `autoplayEligible: false` is "no server opinion",
 *     NOT a veto, so a visible video still autoplays (§11). The server used to
 *     stamp `false` on EVERY video while this client read it as a hard veto,
 *     which made inline Wall autoplay unreachable on every item;
 * plus a direct unit test of the pure resolveVideoAutoplay policy.
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite. wallItemShared
// (imported transitively by VideoWallItem) imports it.
jest.mock('../../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

// NOTE: exhaustive-by-design stub — the real SharedVideoPlayer wraps expo-av's
// Video (a native module unavailable in jest-expo). This stub renders the
// autoplay/muted props it receives so the test can assert the Wall's
// viewability + reduced-motion policy without a native video runtime.
jest.mock('../../../../../components/ui/SharedVideoPlayer.tsx', () => {
  const ReactLocal = require('react');
  const { View, Text } = require('react-native');
  return {
    SharedVideoPlayer: ({ autoplay, muted }: { autoplay?: boolean; muted?: boolean }) =>
      ReactLocal.createElement(
        View,
        { testID: 'shared-video-player' },
        ReactLocal.createElement(Text, { testID: 'autoplay-state' }, autoplay ? 'playing' : 'paused'),
        ReactLocal.createElement(Text, { testID: 'muted-state' }, muted ? 'muted' : 'unmuted'),
      ),
  };
});

import { VideoWallItem } from '../VideoWallItem.tsx';
import { WallItemVisibilityProvider } from '../../../hooks/useWallItemVisibility.tsx';
import { resolveVideoAutoplay } from '../../../services/videoAutoplayPolicy.ts';
import type { VideoProjection } from '../../../types/wallProjection.ts';

const NOW = new Date().toISOString();

function videoProjection(overrides: Partial<VideoProjection> = {}): VideoProjection {
  return {
    projectionId: 'v1',
    canonicalObjectId: 'c-v1',
    objectType: 'video',
    inlinePlayback: true,
    publishedAt: NOW,
    visibility: 'public',
    text: 'A short clip',
    media: [
      {
        mediaId: 'm1',
        kind: 'video',
        url: 'post-media/u1/clip.mp4',
        thumbnailUrl: 'post-media/u1/clip.jpg',
      },
    ],
    actions: [],
    ...overrides,
  };
}

function renderVideo(visibleIds: Set<string>, projection = videoProjection()) {
  return render(
    <WallItemVisibilityProvider visibleIds={visibleIds}>
      <VideoWallItem projection={projection} />
    </WallItemVisibilityProvider>,
  );
}

let reduceMotionSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  // Default: reduce-motion OFF unless a test overrides it.
  reduceMotionSpy = jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
});
afterEach(() => {
  reduceMotionSpy.mockRestore();
});

describe('VideoWallItem inline autoplay policy (§11/§36)', () => {
  it('autoplays muted while on-screen and pauses when scrolled off', async () => {
    const view = await renderVideo(new Set(['v1']));

    // On-screen → the inline player mounts and autoplays, always muted.
    await waitFor(() => expect(screen.getByTestId('shared-video-player')).toBeTruthy());
    expect(screen.getByTestId('autoplay-state')).toHaveTextContent('playing');
    expect(screen.getByTestId('muted-state')).toHaveTextContent('muted');

    // Scroll it off-screen (no longer in the viewable set) → playback pauses,
    // but the player stays mounted (pause/resume, not unmount).
    view.rerender(
      <WallItemVisibilityProvider visibleIds={new Set()}>
        <VideoWallItem projection={videoProjection()} />
      </WallItemVisibilityProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('autoplay-state')).toHaveTextContent('paused'),
    );
    expect(screen.getByTestId('shared-video-player')).toBeTruthy();
  });

  it('falls back to the poster and never mounts the player under reduced motion', async () => {
    reduceMotionSpy.mockResolvedValue(true);
    renderVideo(new Set(['v1']));

    // Poster play affordance is present; the inline player is never mounted.
    await waitFor(() => expect(screen.getByLabelText('Play video')).toBeTruthy());
    expect(screen.queryByTestId('shared-video-player')).toBeNull();
  });

  it.each([
    ['false (no server opinion)', false as boolean | undefined],
    ['absent', undefined],
    ['true (playable)', true as boolean | undefined],
  ])(
    'autoplays a visible video when the server hint is %s — the server never decides',
    async (_label, autoplayEligible) => {
      renderVideo(
        new Set(['v1']),
        videoProjection({
          media: [
            {
              mediaId: 'm1',
              kind: 'video',
              url: 'post-media/u1/clip.mp4',
              thumbnailUrl: 'post-media/u1/clip.jpg',
              ...(autoplayEligible === undefined ? {} : { autoplayEligible }),
            },
          ],
        }),
      );

      await waitFor(() => expect(screen.getByTestId('shared-video-player')).toBeTruthy());
      expect(screen.getByTestId('autoplay-state')).toHaveTextContent('playing');
      expect(screen.getByTestId('muted-state')).toHaveTextContent('muted');
    },
  );

  it('reduced motion still wins over a server hint of true', async () => {
    reduceMotionSpy.mockResolvedValue(true);
    renderVideo(
      new Set(['v1']),
      videoProjection({
        media: [
          {
            mediaId: 'm1',
            kind: 'video',
            url: 'post-media/u1/clip.mp4',
            thumbnailUrl: 'post-media/u1/clip.jpg',
            autoplayEligible: true,
          },
        ],
      }),
    );

    await waitFor(() => expect(screen.getByLabelText('Play video')).toBeTruthy());
    expect(screen.queryByTestId('shared-video-player')).toBeNull();
  });
});

describe('resolveVideoAutoplay (pure policy)', () => {
  it('autoplays (muted) only when visible, motion allowed and the user permits', () => {
    expect(resolveVideoAutoplay({ visible: true, reduceMotion: false })).toEqual({
      autoplay: true,
      muted: true,
    });
  });
  it('never autoplays off-screen', () => {
    expect(resolveVideoAutoplay({ visible: false, reduceMotion: false }).autoplay).toBe(false);
  });
  it('never autoplays under reduced motion', () => {
    expect(resolveVideoAutoplay({ visible: true, reduceMotion: true }).autoplay).toBe(false);
  });
  it('honors an explicit user autoplay-off preference', () => {
    expect(
      resolveVideoAutoplay({ visible: true, reduceMotion: false, userAutoplayEnabled: false })
        .autoplay,
    ).toBe(false);
  });
  it('reduced motion and the user setting both win over everything else', () => {
    expect(
      resolveVideoAutoplay({ visible: true, reduceMotion: true, userAutoplayEnabled: true })
        .autoplay,
    ).toBe(false);
    expect(
      resolveVideoAutoplay({ visible: true, reduceMotion: false, userAutoplayEnabled: false })
        .autoplay,
    ).toBe(false);
  });
  it('is always muted, whatever it decides', () => {
    expect(resolveVideoAutoplay({ visible: true, reduceMotion: false }).muted).toBe(true);
    expect(resolveVideoAutoplay({ visible: false, reduceMotion: true }).muted).toBe(true);
  });
});
