/**
 * PostDetailCard — video playback integration test.
 *
 * Renders the REAL SharedVideoPlayer (no stub) through the PostDetailCard
 * mounting path with autoplay=false, then asserts that pressing the
 * "Play video" tap zone calls playAsync on the Video ref.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';

// ── expo-av mock (mirrors SharedVideoPlayer.component.test.tsx) ───────────────

const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockPauseAsync = jest.fn().mockResolvedValue(undefined);
const mockSetStatusAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-av', () => {
  const React = require('react');
  const { View } = require('react-native');

  const Video = React.forwardRef(
    ({ onPlaybackStatusUpdate, testID, ...rest }: any, ref: React.Ref<any>) => {
      React.useImperativeHandle(ref, () => ({
        playAsync: mockPlayAsync,
        pauseAsync: mockPauseAsync,
        setStatusAsync: mockSetStatusAsync,
      }));
      return <View testID={testID ?? 'mock-video'} {...rest} />;
    },
  );
  Video.displayName = 'Video';

  return {
    Video,
    ResizeMode: { COVER: 'cover', CONTAIN: 'contain' },
  };
});

// ── Supporting mocks (same as PostDetailCard.component.test.tsx) ──────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'post-abc' }),
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-1', isAuthed: true }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/posts', () => ({
  getPostById: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => undefined,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CommentsSheet', () => ({
  CommentsSection: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ReportPostSheet', () => ({
  ReportPostSheet: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ScreenHeader', () => ({
  ScreenHeader: () => null,
}));

jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/commentCountStore', () => ({
  emitCommentCount: jest.fn(),
}));

jest.mock('../../../src/components/StampOverlayBadge', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    MediaStampOverlay: () => <View testID="stamp-overlay" />,
  };
});

// NOTE: SharedVideoPlayer is intentionally NOT mocked here — we use the real
// component so we can verify the tap → playAsync chain end-to-end.

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { getPostById } from '../../../src/services/posts';
import PostDetail from '../[id]';

const mockGetPostById = getPostById as jest.Mock;

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeVideoPost(overrides: Partial<any> = {}): any {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PostDetailCard video playback', () => {
  it('calls playAsync when the Play video tap zone is pressed (autoplay=false)', async () => {
    mockGetPostById.mockResolvedValue({ ok: true as const, data: makeVideoPost() });

    await render(<PostDetail />);

    // Wait for the post to load and the real SharedVideoPlayer to mount
    await waitFor(() =>
      expect(screen.getByLabelText('Play video')).toBeTruthy(),
    );

    // Press the tap zone — this should call playAsync on the Video ref
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Play video'));
    });

    expect(mockPlayAsync).toHaveBeenCalledTimes(1);
  });
});
