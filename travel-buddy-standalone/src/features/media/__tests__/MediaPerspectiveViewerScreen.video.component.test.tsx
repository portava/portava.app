import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockSetItem = jest.fn<Promise<void>, [string, string]>();
const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockReplayAsync = jest.fn().mockResolvedValue(undefined);
const mockGetStatusAsync = jest.fn().mockResolvedValue({
  isLoaded: true,
  positionMillis: 20_000,
});
const mockSetPositionAsync = jest.fn().mockResolvedValue(undefined);
let latestVideoProps: any;

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((props: any, ref: React.Ref<any>) => {
    latestVideoProps = props;
    React.useImperativeHandle(ref, () => ({
      playAsync: mockPlayAsync,
      pauseAsync: mockPauseAsync,
      replayAsync: mockReplayAsync,
      getStatusAsync: mockGetStatusAsync,
      setPositionAsync: mockSetPositionAsync,
    }));
    return <View testID="mock-perspective-video" />;
  });
  Video.displayName = 'Video';
  return {
    Video,
    ResizeMode: { CONTAIN: 'contain' },
  };
});

// NOTE: intentionally exhaustive — the video screen only needs deterministic
// insets, and loading the native safe-area implementation is unnecessary here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/**
 * The signed-URL layer, stood in for so the private-bucket path is deterministic
 * and makes no network call. It behaves like the real one on the three inputs
 * that matter: an absolute URL passes through untouched, a `post-media/...`
 * reference resolves to a signed URL, and one the server refuses resolves to
 * null.
 *
 */
const mockSignFailures = new Set<string>();
// NOTE: intentionally exhaustive — this factory replaces the whole module
// deliberately. `useHydratedMedia` is the only export the screen under test
// uses, and spreading requireActual here would pull in the real
// batchSignUrls/fetch stack, which is precisely what these tests must not run.
jest.mock('../../../services/mediaUrl.ts', () => ({
  useHydratedMedia: (urls: (string | null | undefined)[]) => {
    const resolved: Record<string, string | null> = {};
    for (const u of urls) {
      if (!u) continue;
      if (mockSignFailures.has(u)) resolved[u] = null;
      else if (u.includes('://')) resolved[u] = u;
      else resolved[u] = `https://signed.example.test/${u}?token=signed`;
    }
    return { resolved, loading: false };
  },
}));

// NOTE: intentionally exhaustive — the media screen's image is outside the
// scope of these video-control tests and is replaced with a render no-op.
jest.mock('../../../components/CachedImage.tsx', () => ({
  CachedImage: () => null,
}));
// NOTE: intentionally exhaustive — avatar rendering is outside the scope of
// these video-control tests and is replaced with a render no-op.
jest.mock('../../../components/ui/Avatar.tsx', () => ({
  Avatar: () => null,
}));
// NOTE: intentionally exhaustive — stamp controls are outside the scope of
// these video-control tests and are replaced with a render no-op.
jest.mock('../../../components/stamps/StampButton.tsx', () => ({
  StampButton: () => null,
}));
// NOTE: intentionally exhaustive — intelligence details are outside the scope
// of these video-control tests and are replaced with a render no-op.
jest.mock('../components/IntelligenceStrip.tsx', () => ({
  IntelligenceStrip: () => null,
}));
// NOTE: intentionally exhaustive — contributor trust details are outside the
// scope of these video-control tests and are replaced with a render no-op.
jest.mock('../components/ContributorTrustChips.tsx', () => ({
  ContributorTrustChips: () => null,
}));

import { MediaPerspectiveViewerScreen } from '../screens/MediaPerspectiveViewerScreen.tsx';
import type { MediaProjection } from '../types/media.ts';

function makeVideo(): MediaProjection {
  return {
    id: 'media-video-1',
    mediaType: 'video',
    url: 'https://cdn.example.test/perspective.mp4',
    thumbnailUrl: 'https://cdn.example.test/perspective.jpg',
    durationMs: 60_000,
    observationClass: 'observed',
    freshness: 'fresh',
    ageMinutes: 4,
    perspectiveKey: 'street',
    freshnessLabel: '4 min ago',
    note: 'The entrance is getting busy.',
    contributor: null,
    place: { id: 'place-1', name: 'An Thuong' },
  };
}

function makeBareBucketVideo(): MediaProjection {
  // What post-media rows ACTUALLY hold after the bucket-privacy cutover: a bare
  // `<bucket>/<path>` reference with no scheme.
  return { ...makeVideo(), url: 'post-media/owner-1/perspective.mp4' };
}

function renderVideo() {
  return render(
    <MediaPerspectiveViewerScreen
      input={{
        kind: 'place',
        entityId: 'place-1',
        entityLabel: 'An Thuong',
        groups: [{ key: 'street', label: 'Street', count: 1 }],
        media: [makeVideo()],
      }}
      initialMediaId="media-video-1"
      onClose={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  latestVideoProps = undefined;
  (AsyncStorage as any).getItem = mockGetItem;
  (AsyncStorage as any).setItem = mockSetItem;
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
  mockGetStatusAsync.mockResolvedValue({ isLoaded: true, positionMillis: 20_000 });
  mockSignFailures.clear();
});

function renderMedia(media: MediaProjection) {
  return render(
    <MediaPerspectiveViewerScreen
      input={{
        kind: 'place',
        entityId: 'place-1',
        entityLabel: 'An Thuong',
        groups: [{ key: 'street', label: 'Street', count: 1 }],
        media: [media],
      }}
      initialMediaId={media.id}
      onClose={jest.fn()}
    />,
  );
}

/**
 * REGRESSION — the reference handed to <Video> must be HYDRATED.
 *
 * `MediaProjection.url` may be a bare `post-media/<uid>/<file>.mp4`: post-media
 * is a PRIVATE bucket and that is the stored form. expo-av cannot parse a
 * reference with no scheme and reports nothing useful for one, so passing
 * `media.url` through untouched renders a permanently blank frame with no
 * error state — the same defect components/ui/SharedVideoPlayer documents
 * having shipped once already.
 *
 * Remove useHydratedMedia from PerspectiveFrame and the first assertion goes
 * red: <Video> receives the bare path.
 */
describe('MediaPerspectiveViewerScreen video source hydration', () => {
  it('signs a bare private-bucket reference before handing it to the player', async () => {
    renderMedia(makeBareBucketVideo());
    await waitFor(() => expect(latestVideoProps).toBeTruthy());
    expect(latestVideoProps.source.uri).toBe(
      'https://signed.example.test/post-media/owner-1/perspective.mp4?token=signed',
    );
    expect(latestVideoProps.source.uri).not.toBe('post-media/owner-1/perspective.mp4');
  });

  it('leaves an already-absolute URL untouched', async () => {
    renderMedia(makeVideo());
    await waitFor(() => expect(latestVideoProps).toBeTruthy());
    expect(latestVideoProps.source.uri).toBe('https://cdn.example.test/perspective.mp4');
  });

  it('shows the retry affordance instead of an empty player when signing is refused', async () => {
    const media = makeBareBucketVideo();
    mockSignFailures.add(media.url as string);
    renderMedia(media);
    await waitFor(() => expect(screen.getByLabelText('Retry video playback')).toBeTruthy());
    // No player is mounted for a reference the server refused to sign.
    expect(latestVideoProps).toBeUndefined();
  });
});

describe('MediaPerspectiveViewerScreen video controls', () => {
  it('does not autoplay and exposes play/pause controls', async () => {
    renderVideo();

    await waitFor(() => expect(screen.getByLabelText('Play video')).toBeTruthy());
    expect(latestVideoProps.shouldPlay).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play video'));
    });
    expect(mockPlayAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Pause video')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Pause video'));
    });
    expect(mockPauseAsync).toHaveBeenCalledTimes(1);
  });

  it('persists mute state through AsyncStorage', async () => {
    renderVideo();

    await waitFor(() => expect(screen.getByLabelText('Unmute video')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Unmute video'));
    });

    expect(mockSetItem).toHaveBeenCalledWith('media:muted', 'false');
    expect(screen.getByLabelText('Mute video')).toBeTruthy();
  });

  it('restores persisted mute state and supports retry after playback error', async () => {
    mockGetItem.mockResolvedValue('false');
    renderVideo();

    await waitFor(() => expect(screen.getByLabelText('Mute video')).toBeTruthy());
    await act(async () => {
      latestVideoProps.onPlaybackStatusUpdate({ isLoaded: false, error: 'decoder failed' });
    });
    expect(screen.getByLabelText('Retry video playback')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Retry video playback'));
    });
    expect(mockReplayAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Pause video')).toBeTruthy();
  });

  it('seeks by ten seconds and toggles captions with accessible controls', async () => {
    renderVideo();

    await waitFor(() => expect(screen.getByLabelText('Forward 10 seconds')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Forward 10 seconds'));
    });
    expect(mockSetPositionAsync).toHaveBeenCalledWith(30_000);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Rewind 10 seconds'));
    });
    expect(mockSetPositionAsync).toHaveBeenCalledWith(10_000);

    expect(screen.getByLabelText('Show captions')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Show captions'));
    });
    expect(screen.getByText('The entrance is getting busy.')).toBeTruthy();
    expect(screen.getByLabelText('Hide captions')).toBeTruthy();
  });
});