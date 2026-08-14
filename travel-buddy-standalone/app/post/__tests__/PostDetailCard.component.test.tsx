/**
 * PostDetailCard — media rendering tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## What's covered
 *
 * 1. A video PostRow (media[0].media_type === 'video') renders SharedVideoPlayer.
 * 2. An image PostRow (media[0].media_type === 'image') renders Image instead.
 * 3. The stamp overlay is absent for video items — it only applies to images.
 *
 * ## Why these tests exist
 *
 * app/post/[id].tsx branches on media_type to render either SharedVideoPlayer or
 * Image + MediaStampOverlay. Without tests the branch can silently regress
 * (e.g. a future refactor falling back to Image for all media, leaving video
 * posts stuck on a static frame).
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
    SharedVideoPlayer: (props: any) => (
      <View testID="shared-video-player" accessibilityLabel="Play video" />
    ),
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PostDetailCard media rendering', () => {
  it('renders SharedVideoPlayer for a video post', async () => {
    mockGetPostById.mockResolvedValue(postOk(makePost({ media: [{ url: 'https://example.com/video.mp4', media_type: 'video', thumbnail_url: null, stamp_overlay: null }] })));

    await render(<PostDetail />);

    await waitFor(() =>
      expect(screen.getByTestId('shared-video-player')).toBeTruthy(),
    );
  });

  it('renders Image (not SharedVideoPlayer) for an image post', async () => {
    mockGetPostById.mockResolvedValue(
      postOk(
        makePost({
          media: [
            {
              url: 'https://example.com/photo.jpg',
              media_type: 'image',
              thumbnail_url: null,
              stamp_overlay: null,
            },
          ],
          mediaUrls: ['https://example.com/photo.jpg'],
        }),
      ),
    );

    await render(<PostDetail />);

    // The image branch renders MediaStampOverlay alongside the Image component.
    // Waiting for stamp-overlay confirms the image path was taken.
    await waitFor(() =>
      expect(screen.getByTestId('stamp-overlay')).toBeTruthy(),
    );

    // SharedVideoPlayer must NOT be present for an image post.
    expect(screen.queryByTestId('shared-video-player')).toBeNull();
  });

  it('renders the location placeholder when media array and mediaUrls are empty', async () => {
    mockGetPostById.mockResolvedValue(
      postOk(
        makePost({
          media: [],
          mediaUrls: [],
          locationCity: 'Tokyo',
        }),
      ),
    );

    await render(<PostDetail />);

    // The placeholder branch renders the city label as uppercased text.
    await waitFor(() =>
      expect(screen.getByText('TOKYO')).toBeTruthy(),
    );

    // The MapPin icon is rendered inside the placeholder view.
    // Multiple icon-MapPin instances may exist (e.g. post header + placeholder);
    // confirm at least one is present.
    expect(screen.getAllByTestId('icon-MapPin').length).toBeGreaterThan(0);

    // Neither video nor image media components should be present.
    expect(screen.queryByTestId('shared-video-player')).toBeNull();
    expect(screen.queryByTestId('stamp-overlay')).toBeNull();
  });

  it('stamp overlay is absent for a video post', async () => {
    mockGetPostById.mockResolvedValue(
      postOk(
        makePost({
          media: [
            {
              url: 'https://example.com/video.mp4',
              media_type: 'video',
              thumbnail_url: null,
              stamp_overlay: null,
            },
          ],
        }),
      ),
    );

    await render(<PostDetail />);

    await waitFor(() =>
      expect(screen.getByTestId('shared-video-player')).toBeTruthy(),
    );

    // MediaStampOverlay is only rendered alongside image media, never video.
    expect(screen.queryByTestId('stamp-overlay')).toBeNull();
  });
});

// ── Re-focus fetch: Edited label ──────────────────────────────────────────────

/**
 * Verifies that the '· Edited' label appears on the post detail card after the
 * screen regains focus and the refreshed post has updatedAt > createdAt.
 *
 * PostDetail uses useFocusEffect to re-fetch on every focus event.  This
 * describe block replaces useFocusEffect with a controllable stub so the test
 * can simulate the author returning from the edit screen without a full
 * navigation stack.
 */
describe('PostDetailCard — Edited label on re-focus', () => {
  // Holds the callback passed by PostDetail to useFocusEffect.
  // Calling it re-runs the fetch, simulating screen regaining focus.
  let fireFocus: () => void = () => {};
  let focusSpy: jest.SpyInstance;

  beforeEach(() => {
    fireFocus = () => {};
    // Override useFocusEffect on the mocked expo-router module so we can
    // capture and re-trigger the fetch callback without a real navigator.
    const routerMod = require('expo-router');
    focusSpy = jest.spyOn(routerMod, 'useFocusEffect').mockImplementation(
      (cb: () => (() => void) | void) => {
        // Store so the test can fire a second focus event.
        fireFocus = () => { cb(); };
        // Fire once on mount to replicate the initial screen-enter behaviour.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        React.useEffect(() => { cb(); }, []);
      },
    );
  });

  afterEach(() => {
    // Restore only this spy — jest.restoreAllMocks() would break the
    // jest.mock() factory registered at the top of the file.
    focusSpy.mockRestore();
  });

  it('shows · Edited after the screen regains focus with an updated post', async () => {
    // First fetch: post not yet edited (updatedAt === createdAt).
    const basePost = makePost();
    // Second fetch (re-focus): post updated one hour after creation.
    const editedPost = makePost({
      updatedAt: new Date('2025-01-01T13:00:00Z').toISOString(),
    });

    mockGetPostById
      .mockResolvedValueOnce(postOk(basePost))
      .mockResolvedValueOnce(postOk(editedPost));

    await render(<PostDetail />);

    // Initial load — post is not edited yet; label must be absent.
    await waitFor(() =>
      expect(screen.queryByText('· Edited')).toBeNull(),
    );

    // Simulate the author navigating back from the edit screen.  The real
    // useFocusEffect fires here; our stub lets us trigger it manually.
    // await act(async …) flushes the entire promise chain (setLoading → fetch
    // → setPost) inside React's act context so state updates are committed
    // before the assertion runs.
    await act(async () => { fireFocus(); });

    // After the re-focus fetch resolves, the Edited label must be visible.
    expect(screen.getByText('· Edited')).toBeTruthy();
  });
});
