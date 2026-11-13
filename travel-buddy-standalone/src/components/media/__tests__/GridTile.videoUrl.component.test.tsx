/**
 * GridTile.videoUrl.component.test.tsx
 *
 * Covers:
 *   1. Protected video refs wait for authenticated signing before mounting.
 *   2. When videoUrl is null (image tile), no Video component is rendered.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { screen, render, act } from '@testing-library/react-native';

// ── expo-av — capture the source prop passed to Video ─────────────────────────
// NOTE: native player spy — the source must be loadable and authorized.
// Variable prefixed 'mock' so Jest hoisting can see it from the factory closure.
let mockCapturedVideoSource: { uri: string } | null = null;
let mockResolved: Record<string, string | null> = {};
// NOTE: controlled async signing boundary; player admission runs for real.
jest.mock('../../../services/mediaUrl.ts', () => ({ useHydratedMedia: () => ({ resolved: mockResolved, loading: false }) }));
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef((props: any, _ref: any) => {
    mockCapturedVideoSource = props.source ?? null;
    return <View testID="expo-av-video" />;
  });
  Video.displayName = 'Video';
  return { Video, ResizeMode: { COVER: 'cover' } };
});

// ── useInViewAutoplay — stub ──────────────────────────────────────────────────
// NOTE: intentional stub — autoplay lifecycle not under test.
jest.mock('../../../hooks/useInViewAutoplay.ts', () => ({
  useInViewAutoplay: () => {},
}));

// ── useSmartVideoFit — stub returning fixed values ────────────────────────────
// NOTE: intentional stub — resize-mode calculation not under test.
jest.mock('../../../hooks/useSmartVideoFit.ts', () => ({
  useSmartVideoFit: () => ({
    resizeMode: 'cover' as const,
    needsLetterbox: false,
    onReadyForDisplay: () => {},
  }),
}));

// ── VideoBlurBackdrop — stub ──────────────────────────────────────────────────
// NOTE: intentional stub — letterbox backdrop not under test.
jest.mock('../../ui/VideoBlurBackdrop.tsx', () => ({
  VideoBlurBackdrop: () => null,
}));

// ── DisplayMediaImage — stub ──────────────────────────────────────────────────
// NOTE: intentional stub — poster image rendering not under test.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: () => null,
}));

// lucide-react-native is covered by the global Proxy mock in jest.config moduleNameMapper.

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { MediaGridItem } from '../../../types/media.ts';

const RELAY_VIDEO_URL = '/api/media/file/post-media/test-video.mp4';
const SIGNED_VIDEO_URL = 'https://storage.example.com/signed/test-video.mp4?token=checked';

function makeVideoItem(overrides: Partial<MediaGridItem> = {}): MediaGridItem {
  return {
    id: 'video-1',
    mediaType: 'video',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    posterUrl: 'https://example.com/poster.jpg',
    width: 1080,
    height: 1920,
    durationMs: 12000,
    contentType: null,
    creatorId: 'creator-1',
    locationLabel: null,
    placeId: null,
    viewCount: 100,
    qualifiedViewCount: 80,
    processingStatus: null,
    videoUrl: RELAY_VIDEO_URL,
    ...overrides,
  };
}

function makeImageItem(): MediaGridItem {
  return {
    id: 'image-1',
    mediaType: 'image',
    thumbnailUrl: 'https://example.com/img.jpg',
    posterUrl: 'https://example.com/img.jpg',
    width: 1080,
    height: 1080,
    durationMs: null,
    contentType: null,
    creatorId: 'creator-1',
    locationLabel: null,
    placeId: null,
    viewCount: 50,
    qualifiedViewCount: 0,
    processingStatus: null,
    videoUrl: null,
  };
}

// ── Import (after mocks) ──────────────────────────────────────────────────────

import { GridTile } from '../GridTile.tsx';

// ─────────────────────────────────────────────────────────────────────────────

describe('GridTile — authenticated video playback', () => {
  beforeEach(() => {
    mockCapturedVideoSource = null;
    mockResolved = {};
  });

  it('waits for a signed URL before mounting the player', async () => {
    const item = makeVideoItem();
    const ui = await render(<GridTile item={item} index={0} cellWidth={120} cellHeight={160} onPress={() => {}} />);
    expect(screen.queryByTestId('expo-av-video')).toBeNull();
    mockResolved = { [RELAY_VIDEO_URL]: SIGNED_VIDEO_URL };
    await ui.rerender(<GridTile item={item} index={0} cellWidth={120} cellHeight={160} onPress={() => {}} />);
    expect(screen.getByTestId('expo-av-video')).toBeTruthy();
    expect(mockCapturedVideoSource!.uri).toBe(SIGNED_VIDEO_URL);
    mockResolved = { [RELAY_VIDEO_URL]: null };
    await ui.rerender(<GridTile item={item} index={0} cellWidth={120} cellHeight={160} onPress={() => {}} />);
    expect(screen.queryByTestId('expo-av-video')).toBeNull();
  });

  it('no Video component is rendered for an image tile (videoUrl is null)', async () => {
    const item = makeImageItem();

    await act(async () => {
      render(
        <GridTile
          item={item}
          index={0}
          cellWidth={120}
          cellHeight={160}
          onPress={() => {}}
          isVisible={false}
        />,
      );
    });

    expect(screen.queryByTestId('expo-av-video')).toBeNull();
  });
});
