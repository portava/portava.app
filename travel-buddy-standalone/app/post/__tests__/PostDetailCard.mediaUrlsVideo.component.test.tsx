/**
 * PostDetailCard — a post that reaches the detail screen with NO media item still plays its video
 * (owner-reported 2026-10-24: "video media still not playing").
 *
 * Production post e4bbf335 had its upload only in `media_urls` (`post-media/<uid>/<ts>.mov`), no
 * post_media row, and `media_type = 'video/quicktime'`. The server answered `media: []`, and the
 * screen chose its player from `media[0].media_type`, so the `.mov` went to an image component.
 *
 *   V1  e4bbf335's shape on an older server (media: []) ⇒ SharedVideoPlayer, handed the .mov
 *   V2  the same shape with NO recognisable extension ⇒ the post's own declared type decides
 *   V3  CONTROL: an image ref with media: [] ⇒ no player
 *   V4  the fixed server's answer (a synthesized item, id null) ⇒ SharedVideoPlayer with its poster
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock expo-router so useLocalSearchParams returns a predictable id.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'post-abc' }),
  router: { push: jest.fn(), back: jest.fn() },
}));

// Mock SessionContext — the screen only needs userId.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-1', isAuthed: true }),
}));

// Mock the posts service — tests control the resolved PostRow.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/posts', () => ({
  getPostById: jest.fn(),
}));

// Mock nav-bar collapse — NavBarFiller and the scroll handler aren't relevant
// to media-rendering behaviour.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => undefined,
}));

// Mock CommentsSection — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CommentsSheet', () => ({
  CommentsSection: () => null,
}));

// Mock ReportPostSheet — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportPostSheet', () => ({
  ReportPostSheet: () => null,
}));

// Mock ScreenHeader — not under test.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ScreenHeader', () => ({
  ScreenHeader: () => null,
}));

// Mock KeyboardSafeScrollView — not under test.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

// Mock commentCountStore — no side-effects needed.
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  emitCommentCount: jest.fn(),
}));

// Mock expo-av so Video doesn't try to load native modules.
jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Video = React.forwardRef(({ testID, ...rest }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      playAsync: jest.fn(),
      pauseAsync: jest.fn(),
      setStatusAsync: jest.fn(),
    }));
    return <View testID={testID ?? 'mock-video'} {...rest} />;
  });
  Video.displayName = 'Video';
  return {
    Video,
    ResizeMode: { COVER: 'cover', CONTAIN: 'contain' },
  };
});

// Mock SharedVideoPlayer with a stable testID so we can assert its presence /
// absence without relying on expo-av internals.
jest.mock('../../../src/components/ui/SharedVideoPlayer', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SharedVideoPlayer: (props: any) => {
      (globalThis as any).__lastPlayerProps = props;
      return <View testID="shared-video-player" accessibilityLabel="Play video" />;
    },
  };
});

// Mock MediaStampOverlay with a stable testID for absence assertions.
jest.mock('../../../src/components/StampOverlayBadge', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    MediaStampOverlay: () => <View testID="stamp-overlay" />,
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { getPostById } from '../../../src/services/posts';
import PostDetail from '../[id]';

const mockGetPostById = getPostById as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePost(overrides: Partial<any> = {}): any {
  return {
    id: 'post-abc',
    authorId: 'user-1',
    tripId: null,
    content: 'A great trip!',
    mediaUrls: ['https://example.com/media.mp4'],
    media: [
      {
        url: 'https://example.com/media.mp4',
        media_type: 'video',
        thumbnail_url: 'https://example.com/thumb.jpg',
        width: 1080,
        height: 1920,
        stamp_overlay: null,
      },
    ],
    visibility: 'public',
    status: 'published',
    createdAt: new Date('2025-01-01T12:00:00Z').toISOString(),
    updatedAt: new Date('2025-01-01T12:00:00Z').toISOString(),
    locationName: 'Rome',
    locationCity: 'Rome',
    locationCountry: 'IT',
    author: { id: 'user-1', name: 'Alice', handle: 'alice', avatarUrl: null },
    likeCount: 3,
    commentCount: 1,
    shareCount: 0,
    likedByMe: false,
    savedByMe: false,
    saveCount: 0,
    canLike: true,
    canComment: true,
    canShare: true,
    filterId: 'none',
    filterIntensity: 0,
    tags: [],
    hashtagUsages: [],
    ...overrides,
  };
}

function postOk(post: any) {
  return { ok: true as const, data: post };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostDetailCard — a post with no media item', () => {
  const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';

  it('V1 e4bbf335 on an older server (media: []) mounts SharedVideoPlayer with the .mov', async () => {
    mockGetPostById.mockResolvedValue(postOk(makePost({ media: [], mediaUrls: [MOV], mediaType: 'video/quicktime', hasVideo: false })));
    await render(<PostDetail />);
    await waitFor(() => expect(screen.getByTestId('shared-video-player')).toBeTruthy());
    expect((globalThis as any).__lastPlayerProps.uri).toBe(MOV);
    expect((globalThis as any).__lastPlayerProps.poster).toBe(`${MOV}.poster.jpg`);
  });

  it('V2 a ref with no recognisable extension plays when the post declares a video type', async () => {
    mockGetPostById.mockResolvedValue(postOk(makePost({ media: [], mediaUrls: ['post-media/u/clip'], mediaType: 'video/quicktime' })));
    await render(<PostDetail />);
    await waitFor(() => expect(screen.getByTestId('shared-video-player')).toBeTruthy());
  });

  it('V3 CONTROL: an image ref with media: [] renders no player', async () => {
    mockGetPostById.mockResolvedValue(postOk(makePost({ media: [], mediaUrls: ['post-media/u/photo.jpg'], mediaType: 'video/quicktime' })));
    await render(<PostDetail />);
    await waitFor(() => expect(screen.getByText('A great trip!')).toBeTruthy());
    expect(screen.queryByTestId('shared-video-player')).toBeNull();
  });

  it("V4 the fixed server's synthesized item (id null, source media_urls) mounts the player with its poster", async () => {
    mockGetPostById.mockResolvedValue(postOk(makePost({
      mediaUrls: [MOV],
      media: [{ id: null, source: 'media_urls', url: MOV, media_type: 'video', thumbnail_url: `${MOV}.poster.jpg`, stamp_overlay: null }],
    })));
    await render(<PostDetail />);
    await waitFor(() => expect(screen.getByTestId('shared-video-player')).toBeTruthy());
    expect((globalThis as any).__lastPlayerProps.uri).toBe(MOV);
    expect((globalThis as any).__lastPlayerProps.poster).toBe(`${MOV}.poster.jpg`);
  });
});
